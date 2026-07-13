import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import type { EmployerRegistryEntry } from "./employer-registry";
import { diagnosticFromError, discoveryRunIdentity, discoveryStatus, fetchWithRetry, locationActionability, ReadFailure } from "./scheduler";
import { emptyCounters, type DiscoveryBatch, type DiscoveryCounters, type DiscoveryOptions, type DiscoveryScopeSummary, type DiscoveryStatus, type SourceDiagnostic } from "./types";

export type PersonioJob = { id: string; title: string; location: string | null; locations: string[]; description: string };
export type PersonioReadBatch = {
  sourceId: string;
  status: DiscoveryStatus;
  scope: DiscoveryScopeSummary;
  jobs: PersonioJob[];
  counters: DiscoveryCounters;
  diagnostics: SourceDiagnostic[];
};
export type PersonioDiscoveryOptions = DiscoveryOptions & { fetcher?: typeof fetch; maxResults?: number };

type XmlText = { kind: "text"; value: string; cdata: boolean };
type XmlNode = { kind: "node"; name: string; children: Array<XmlNode | XmlText> };

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(\d+);|&#x([\da-f]+);/gi, (entity, decimal?: string, hexadecimal?: string) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&nbsp;": " " } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function parseXml(xml: string): XmlNode {
  const document: XmlNode = { kind: "node", name: "#document", children: [] };
  const stack = [document];
  let cursor = 0;
  while (cursor < xml.length) {
    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0) throw new Error("Malformed XML: unclosed comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0) throw new Error("Malformed XML: unclosed CDATA");
      stack.at(-1)?.children.push({ kind: "text", value: xml.slice(cursor + 9, end), cdata: true });
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end < 0) throw new Error("Malformed XML: unclosed processing instruction");
      cursor = end + 2;
      continue;
    }
    if (xml[cursor] !== "<") {
      const end = xml.indexOf("<", cursor);
      const value = xml.slice(cursor, end < 0 ? xml.length : end);
      stack.at(-1)?.children.push({ kind: "text", value: decodeEntities(value), cdata: false });
      cursor = end < 0 ? xml.length : end;
      continue;
    }
    const end = xml.indexOf(">", cursor + 1);
    if (end < 0) throw new Error("Malformed XML: unclosed tag");
    const token = xml.slice(cursor + 1, end).trim();
    if (!token || token.startsWith("!")) throw new Error("Malformed XML: unsupported declaration");
    if (token.startsWith("/")) {
      const name = token.slice(1).trim().toLowerCase();
      const current = stack.pop();
      if (!current || current === document || current.name !== name) throw new Error(`Malformed XML: unexpected closing tag ${name}`);
    } else {
      const selfClosing = token.endsWith("/");
      const name = token.replace(/\/$/, "").trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (!name || !/^[a-z_][\w:.-]*$/i.test(name)) throw new Error("Malformed XML: invalid tag name");
      const node: XmlNode = { kind: "node", name, children: [] };
      stack.at(-1)?.children.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: unclosed tag ${stack.at(-1)?.name}`);
  const roots = document.children.filter((child): child is XmlNode => child.kind === "node");
  if (roots.length !== 1) throw new Error("Malformed XML: expected one root element");
  return roots[0];
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  return node.children.flatMap((child) => child.kind === "node"
    ? [...(child.name === name ? [child] : []), ...descendants(child, name)]
    : []);
}

function fragmentText(value: string): string {
  if (!value.includes("<")) return decodeEntities(value);
  try {
    return nodeText(parseXml(`<fragment>${value}</fragment>`));
  } catch {
    return decodeEntities(value);
  }
}

function nodeText(node: XmlNode): string {
  return node.children.map((child) => child.kind === "node" ? nodeText(child) : child.cdata ? fragmentText(child.value) : child.value)
    .join(" ").replace(/\s+/g, " ").trim();
}

function firstDirect(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child): child is XmlNode => child.kind === "node" && child.name === name);
}

export function parsePersonioXml(xml: string): PersonioJob[] {
  const root = parseXml(xml);
  return descendants(root, "position").flatMap((position) => {
    const idNode = firstDirect(position, "id");
    const titleNode = firstDirect(position, "name");
    const id = idNode ? nodeText(idNode) : "";
    const title = titleNode ? nodeText(titleNode) : "";
    if (!id || !title) return [];
    const locations = position.children
      .filter((child): child is XmlNode => child.kind === "node" && child.name === "office")
      .map(nodeText).filter(Boolean);
    const description = descendants(position, "jobdescription")
      .flatMap((entry) => {
        const value = firstDirect(entry, "value");
        return value ? [nodeText(value)] : [];
      })
      .filter(Boolean).join("\n");
    return [{ id, title, location: locations[0] ?? null, locations, description }];
  });
}

function endpointFor(employer: EmployerRegistryEntry): URL {
  if (!employer.enabled || employer.policy !== "public_ats_endpoint" || employer.ats !== "personio") throw new Error(`Employer ${employer.id} is not approved for Personio reads`);
  const career = new URL(employer.career_url);
  if (career.protocol !== "https:" || !career.hostname.endsWith(".jobs.personio.de")) throw new Error(`Employer ${employer.id} has an invalid Personio endpoint`);
  return new URL("/xml", career.origin);
}

export async function readPersonioEmployer(
  employer: EmployerRegistryEntry,
  fetcher: typeof fetch = fetch,
  options: Pick<DiscoveryOptions, "sleep"> = {},
): Promise<PersonioReadBatch> {
  const endpoint = endpointFor(employer);
  const counters = emptyCounters();
  counters.searched = 1;
  try {
    const response = await fetchWithRetry(endpoint, { headers: { Accept: "application/xml" } }, options, fetcher);
    let jobs: PersonioJob[];
    try {
      jobs = parsePersonioXml(await response.text());
    } catch (error) {
      throw new ReadFailure(error instanceof Error ? error.message : String(error), "invalid_xml", false);
    }
    counters.detailed = jobs.length;
    return { sourceId: `personio:${employer.id}`, status: "success", scope: { planned: 1, completed: 1, failed: 0 }, jobs, counters, diagnostics: [] };
  } catch (error) {
    counters.failed = 1;
    const parseFailure = error instanceof ReadFailure && error.code === "invalid_xml";
    const diagnostics = [diagnosticFromError(error, parseFailure ? "parse" : "search", employer.id)];
    return { sourceId: `personio:${employer.id}`, status: "failed", scope: { planned: 1, completed: 0, failed: 1 }, jobs: [], counters, diagnostics };
  }
}

function canonicalText(job: PersonioJob, employer: EmployerRegistryEntry): string {
  return [
    `# ${job.title}`,
    `Company: ${employer.name}`,
    `Location: ${job.location ?? "unknown"}`,
    `Locations: ${job.locations.join(", ") || "unknown"}`,
    "Description:",
    job.description || "unknown",
  ].join("\n");
}

export async function discoverPersonioEmployer(
  employer: EmployerRegistryEntry,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: PersonioDiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  const endpoint = endpointFor(employer);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const sourceId = `personio:${employer.id}`;
  const normalizedScope = { employer: employer.id.toLowerCase(), cities: employer.cities.map((city) => city.trim().toLowerCase()), endpoint: endpoint.toString() };
  const { runId, scopeHash } = discoveryRunIdentity(sourceId, normalizedScope, startedAt);
  repository.startDiscoveryRun({ id: runId, sourceId, scopeHash, startedAt });

  const read = await readPersonioEmployer(employer, options.fetcher ?? fetch, options);
  const counters = { ...read.counters };
  const diagnostics = [...read.diagnostics];
  const rows: DiscoveryBatch["jobs"] = [];
  const limit = Math.max(0, Math.min(options.maxResults ?? 25, 25));
  const selected = read.jobs.slice(0, limit);
  counters.skipped += Math.max(0, read.jobs.length - selected.length);

  for (const job of selected) {
    const stableSourceId = `personio:${employer.id}:${job.id}`;
    const sourceUrl = new URL(`/job/${encodeURIComponent(job.id)}`, endpoint.origin).toString();
    try {
      const imported = await importVacancy({ text: canonicalText(job, employer), sourceId: stableSourceId, sourceUrl, sourceType: "personio_public_xml" }, repository);
      repository.observeVacancy({ discoveryRunId: runId, jobId: imported.id, stableSourceId, canonicalUrl: sourceUrl, rawHash: imported.sourceHash, observedAt: now() });
      counters.imported += 1;
      const area = locationActionability(job.locations.join(", ") || null, employer.cities);
      if (area === "out_of_area") {
        counters.skipped += 1;
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "out_of_area", message: `Location is outside configured cities: ${job.locations.join(", ")}`, transient: false });
      } else if (area === "unknown") {
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "location_unknown", message: "Location is missing", transient: false });
      }

      let evaluation;
      if (options.evaluate !== false) {
        const stored = repository.readJob(imported.id);
        if (!stored) throw new Error(`Imported Personio job is unavailable: ${imported.id}`);
        const extracted = extractVacancy((stored as StoredJobSource).rawContent);
        evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? now().slice(0, 10));
        repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
      }
      rows.push({
        id: imported.id,
        reused: imported.reused,
        sourceId: stableSourceId,
        stableSourceId,
        sourceUrl,
        title: job.title,
        company: employer.name,
        location: job.location,
        logicalVacancyId: imported.logicalVacancyId,
        version: imported.version,
        actionable: area !== "out_of_area",
        evaluation,
      });
    } catch (error) {
      counters.failed += 1;
      diagnostics.push({ stage: "parse", locator: stableSourceId, code: "processing_failed", message: error instanceof Error ? error.message : String(error), transient: false });
    }
  }

  const status = discoveryStatus(counters);
  repository.finishDiscoveryRun(runId, { status, counters, diagnostics, finishedAt: now() });
  return { sourceId, status, scope: read.scope, jobs: rows, counters, diagnostics };
}
