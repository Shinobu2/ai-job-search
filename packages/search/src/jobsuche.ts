import { Buffer } from "node:buffer";
import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import {
  diagnosticFromError,
  discoveryRunIdentity,
  discoveryStatus,
  fetchWithRetry,
  locationActionability,
  mapBounded,
  parseJson,
  ReadFailure,
  roundRobinScopes,
} from "./scheduler";
import { emptyCounters, type DiscoveredJob, type DiscoveryBatch, type DiscoveryOptions, type SourceDiagnostic } from "./types";

export type JobsucheSourceConfig = {
  id: "jobsuche";
  enabled: boolean;
  mode: "read_import_evaluate";
  country: "DE";
  cities: string[];
  keywords: string[];
  max_pages: number;
  page_size: number;
};

type JobsucheSearchJob = {
  referenznummer?: string;
  refnr?: string;
  beruf?: string;
  arbeitgeber?: string;
  arbeitsort?: JobsucheLocation;
  externeUrl?: string;
  stellenangebotsTitel?: string;
  hauptberuf?: string;
  firma?: string;
  stellenlokationen?: Array<{ adresse?: JobsucheLocation }>;
};

type JobsucheLocation = { ort?: string; region?: string; land?: string };

type JobsucheDetail = {
  referenznummer?: string;
  refnr?: string;
  stellenangebotsTitel?: string;
  titel?: string;
  arbeitgeber?: string;
  arbeitsorte?: JobsucheLocation[];
  stellenangebotsBeschreibung?: string;
  stellenbeschreibung?: string;
  aktuelleVeroeffentlichungsdatum?: string;
  ersteVeroeffentlichungsdatum?: string;
  arbeitszeitmodelle?: string[];
  befristung?: string;
  firma?: string;
  stellenlokationen?: Array<{ adresse?: JobsucheLocation }>;
  veroeffentlichungszeitraum?: { von?: string };
  datumErsteVeroeffentlichung?: string;
  arbeitszeitSchichtNachtWochenende?: boolean;
};

type JobsucheSearchResponse = { stellenangebote?: JobsucheSearchJob[]; ergebnisliste?: JobsucheSearchJob[] };

const JOBSUCHE_BASE_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const JOBSUCHE_API_KEY = "jobboerse-jobsuche";
const MAX_DISCOVERY_RESULTS = 50;
const CONCURRENCY = 5;

async function readJson<T>(url: string, options: DiscoveryOptions, label: string): Promise<T> {
  const response = await fetchWithRetry(url, { headers: { Accept: "application/json", "X-API-Key": JOBSUCHE_API_KEY } }, options);
  return parseJson<T>(response, label);
}

function referenceNumber(job: Pick<JobsucheSearchJob, "referenznummer" | "refnr">): string | null {
  return job.referenznummer ?? job.refnr ?? null;
}

function searchUrl(keyword: string, city: string, page: number, pageSize: number): string {
  const params = new URLSearchParams({ was: keyword, wo: city, page: String(page), size: String(pageSize) });
  return `${JOBSUCHE_BASE_URL}/pc/v6/jobs?${params.toString()}`;
}

function detailUrl(refnr: string): string {
  const encrypted = Buffer.from(refnr, "utf8").toString("base64");
  return `${JOBSUCHE_BASE_URL}/pc/v4/jobdetails/${encodeURIComponent(encrypted)}`;
}

function portalUrl(refnr: string): string {
  return `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;
}

function locationText(locations: JobsucheLocation[] | undefined, fallback?: JobsucheLocation): string | null {
  const location = locations?.[0] ?? fallback;
  if (!location) return null;
  return [location.ort, location.region, location.land].filter((value, index, values) => value && values.indexOf(value) === index).join(", ") || null;
}

function realLocations(rows: Array<{ adresse?: JobsucheLocation }> | undefined): JobsucheLocation[] | undefined {
  return rows?.flatMap((row) => row.adresse ? [row.adresse] : []);
}

function skillsFromDescription(description: string): string[] {
  const rules: Array<[RegExp, string]> = [
    [/\b(?:pc |computer\/)?hardware\b|komponenten/i, "PC hardware"],
    [/\bservers?\b|serverhardware/i, "server hardware"],
    [/network|netzwerk|routers?|switches?/i, "networking"],
    [/cabling|verkabelung|kabelmanagement/i, "cabling"],
    [/troubleshoot|hardware replacement|repair|fehlersuche|reparatur|instandhaltung/i, "hardware troubleshooting"],
    [/\blinux\b/i, "Linux"],
  ];
  return rules.flatMap(([pattern, skill]) => pattern.test(description) ? [skill] : []);
}

function shiftRequirement(description: string, detail: JobsucheDetail): string {
  if (/\bkeine\s+nachtschicht\b/i.test(description)) return "day/no night requirement";
  if (/\bnachtarbeit\b|\bwechselschicht\b|\b24\s*\/\s*7\b|night shifts?|nachtschicht|schichtdienst/i.test(description)
    || detail.arbeitszeitSchichtNachtWochenende === true) return "night or rotating shifts required";
  return "unknown";
}

function canonicalText(detail: JobsucheDetail, summary: JobsucheSearchJob, refnr: string): string {
  const title = detail.stellenangebotsTitel ?? detail.titel ?? summary.stellenangebotsTitel ?? summary.beruf ?? summary.hauptberuf ?? "(untitled)";
  const company = detail.arbeitgeber ?? detail.firma ?? summary.arbeitgeber ?? summary.firma ?? "unknown";
  const location = locationText(detail.arbeitsorte ?? realLocations(detail.stellenlokationen), summary.arbeitsort ?? realLocations(summary.stellenlokationen)?.[0]) ?? "unknown";
  const description = detail.stellenangebotsBeschreibung ?? detail.stellenbeschreibung ?? "unknown";
  const physical = /physically demanding[\s\S]{0,120}extended periods|extended periods[\s\S]{0,120}physical|continuous heavy/i.test(description) ? "continuous heavy work required" : "unknown";
  const skills = skillsFromDescription(description);
  return [
    `# ${title}`,
    `Company: ${company}`,
    `Location: ${location}`,
    `Jobsuche reference number: ${refnr}`,
    `Posted: ${detail.aktuelleVeroeffentlichungsdatum ?? detail.ersteVeroeffentlichungsdatum ?? detail.veroeffentlichungszeitraum?.von ?? detail.datumErsteVeroeffentlichung ?? "unknown"}`,
    `Shift: ${shiftRequirement(description, detail)}`,
    `Physical: ${physical}`,
    `Skills: ${skills.join(", ") || "unknown"}`,
    `Working time: ${detail.arbeitszeitmodelle?.join(", ") || "unknown"}`,
    `Contract: ${detail.befristung ?? "unknown"}`,
    "Description:",
    description,
    "Jobsuche raw detail:",
    JSON.stringify(detail),
  ].join("\n");
}

function searchListings(value: JobsucheSearchResponse): JobsucheSearchJob[] {
  if (!value || typeof value !== "object") throw new ReadFailure("Jobsuche returned an invalid search envelope", "invalid_envelope", false);
  const listings = value.ergebnisliste ?? value.stellenangebote;
  if (!Array.isArray(listings)) throw new ReadFailure("Jobsuche returned an invalid search envelope", "invalid_envelope", false);
  return listings;
}

function detailRecord(value: JobsucheDetail): JobsucheDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadFailure("Jobsuche returned an invalid detail record", "invalid_envelope", false);
  return value;
}

function sortResults(rows: DiscoveredJob[]): DiscoveredJob[] {
  const tiers = { S: 0, A: 1, B: 2, C: 3 } as const;
  return [...rows].sort((left, right) => {
    const leftTier = left.evaluation ? tiers[left.evaluation.tier] : 4;
    const rightTier = right.evaluation ? tiers[right.evaluation.tier] : 4;
    return leftTier - rightTier
      || (right.evaluation?.fit ?? -1) - (left.evaluation?.fit ?? -1)
      || left.title.localeCompare(right.title)
      || left.sourceId.localeCompare(right.sourceId);
  });
}

function normalizedScope(source: JobsucheSourceConfig): unknown {
  const normalized = (values: string[]) => values.map((value) => value.trim().toLowerCase());
  return { keywords: normalized(source.keywords), cities: normalized(source.cities), country: source.country, maxPages: source.max_pages, pageSize: source.page_size };
}

export async function discoverJobsuche(
  source: JobsucheSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: DiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  if (!source.enabled) throw new Error("Jobsuche source is disabled by workspace policy");
  if (source.mode !== "read_import_evaluate") throw new Error("Jobsuche source must use read_import_evaluate mode");
  if (source.country !== "DE") throw new Error("Jobsuche source only supports country DE");

  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const { runId, scopeHash } = discoveryRunIdentity(source.id, normalizedScope(source), startedAt);
  repository.startDiscoveryRun({ id: runId, sourceId: source.id, scopeHash, startedAt });

  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const scopes = roundRobinScopes(source.keywords, source.cities);
  const active = scopes.map(() => true);
  const failedScopes = new Set<number>();
  const completedScopes = new Set<number>();
  const seen = new Map<string, JobsucheSearchJob>();

  for (let page = 1; page <= source.max_pages && active.some(Boolean); page += 1) {
    const pageScopes = scopes.map((scope, index) => ({ scope, index })).filter(({ index }) => active[index]);
    const settled = await mapBounded(pageScopes, CONCURRENCY, async ({ scope }) => {
      const url = searchUrl(scope.keyword, scope.city, page, source.page_size);
      return searchListings(await readJson<JobsucheSearchResponse>(url, options, "Jobsuche"));
    });
    settled.forEach((result, resultIndex) => {
      const { scope, index } = pageScopes[resultIndex];
      counters.searched += 1;
      if (result.status === "rejected") {
        counters.failed += 1;
        active[index] = false;
        failedScopes.add(index);
        diagnostics.push(diagnosticFromError(result.reason, result.reason instanceof ReadFailure && result.reason.code.startsWith("invalid_") ? "parse" : "search", searchUrl(scope.keyword, scope.city, page, source.page_size)));
        return;
      }
      for (const job of result.value) {
        const refnr = referenceNumber(job);
        if (refnr && !seen.has(refnr)) seen.set(refnr, job);
      }
      if (result.value.length < source.page_size || page === source.max_pages) {
        active[index] = false;
        completedScopes.add(index);
      }
    });
    if (seen.size >= MAX_DISCOVERY_RESULTS) {
      for (const { index } of pageScopes) if (!failedScopes.has(index)) completedScopes.add(index);
      break;
    }
  }

  const summaries = [...seen.entries()].slice(0, MAX_DISCOVERY_RESULTS);
  counters.detailed = summaries.length;
  const details = await mapBounded(summaries, CONCURRENCY, async ([refnr]) => detailRecord(await readJson<JobsucheDetail>(detailUrl(refnr), options, "Jobsuche")));
  const rows: DiscoveredJob[] = [];
  for (let index = 0; index < details.length; index += 1) {
    const result = details[index];
    const [refnr, summary] = summaries[index];
    if (result.status === "rejected") {
      counters.failed += 1;
      diagnostics.push(diagnosticFromError(result.reason, result.reason instanceof ReadFailure && result.reason.code.startsWith("invalid_") ? "parse" : "detail", refnr));
      continue;
    }
    const detail = result.value;
    const title = detail.stellenangebotsTitel ?? detail.titel ?? summary.stellenangebotsTitel ?? summary.beruf ?? summary.hauptberuf;
    if (!title) {
      counters.skipped += 1;
      counters.failed += 1;
      diagnostics.push({ stage: "parse", locator: refnr, code: "missing_identity", message: "Jobsuche detail is missing a title", transient: false });
      continue;
    }
    const sourceUrl = summary.externeUrl ?? portalUrl(refnr);
    const stableSourceId = `jobsuche:${refnr}`;
    const location = locationText(detail.arbeitsorte ?? realLocations(detail.stellenlokationen), summary.arbeitsort ?? realLocations(summary.stellenlokationen)?.[0]);
    try {
      const imported = await importVacancy({ text: canonicalText(detail, summary, refnr), sourceUrl, sourceId: stableSourceId, sourceType: "ba_jobsuche_api" }, repository);
      repository.observeVacancy({ discoveryRunId: runId, jobId: imported.id, stableSourceId, canonicalUrl: sourceUrl, rawHash: imported.sourceHash, observedAt: now() });
      counters.imported += 1;
      const area = locationActionability(location, source.cities);
      if (area === "out_of_area") {
        counters.skipped += 1;
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "out_of_area", message: `Location is outside configured cities: ${location}`, transient: false });
      } else if (area === "unknown") {
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "location_unknown", message: "Location is missing", transient: false });
      }

      let evaluation;
      if (options.evaluate !== false) {
        const stored = repository.readJob(imported.id);
        if (!stored) throw new Error(`Imported Jobsuche job is unavailable: ${imported.id}`);
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
        title,
        company: detail.arbeitgeber ?? detail.firma ?? summary.arbeitgeber ?? summary.firma ?? null,
        location,
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
  const scope = { planned: scopes.length, completed: completedScopes.size, failed: failedScopes.size };
  repository.finishDiscoveryRun(runId, { status, counters, diagnostics, finishedAt: now() });
  return { sourceId: source.id, status, scope, jobs: sortResults(rows), counters, diagnostics };
}
