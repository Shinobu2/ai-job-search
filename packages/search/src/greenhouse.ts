import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import type { EmployerRegistryEntry } from "./employer-registry";
import { diagnosticFromError, discoveryRunIdentity, discoveryStatus, fetchWithRetry, locationActionability, parseJson, prioritizeByLocation } from "./scheduler";
import { emptyCounters, type DiscoveryBatch, type DiscoveryOptions, type SourceDiagnostic } from "./types";

type GreenhouseJob = {
  id: string;
  title: string;
  location: string | null;
  absoluteUrl: string;
  content: string;
  language: string | null;
};

export type GreenhouseDiscoveryOptions = DiscoveryOptions & { fetcher?: typeof fetch };

function boardToken(employer: EmployerRegistryEntry): string {
  if (!employer.enabled || employer.policy !== "public_ats_endpoint" || employer.ats !== "greenhouse") {
    throw new Error(`Employer ${employer.id} is not approved for Greenhouse reads`);
  }
  const career = new URL(employer.career_url);
  if (career.protocol !== "https:" || !["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(career.hostname)) {
    throw new Error(`Employer ${employer.id} has an invalid Greenhouse endpoint`);
  }
  const token = career.pathname.split("/").filter(Boolean)[0];
  if (!token || !/^[a-z0-9_-]+$/i.test(token)) throw new Error(`Employer ${employer.id} has no Greenhouse board token`);
  return token;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function parseGreenhouseJobs(value: unknown): GreenhouseJob[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { jobs?: unknown }).jobs)) throw new Error("Greenhouse returned an invalid jobs envelope");
  return (value as { jobs: unknown[] }).jobs.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Greenhouse returned an invalid job record");
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : "";
    const location = row.location && typeof row.location === "object" && typeof (row.location as { name?: unknown }).name === "string"
      ? (row.location as { name: string }).name
      : null;
    if (!id || typeof row.title !== "string" || typeof row.absolute_url !== "string") throw new Error("Greenhouse job requires id, title and absolute_url");
    return {
      id,
      title: row.title,
      location,
      absoluteUrl: row.absolute_url,
      content: typeof row.content === "string" ? textFromHtml(row.content) : "",
      language: typeof row.language === "string" ? row.language : null,
    };
  });
}

function canonicalText(job: GreenhouseJob, employer: EmployerRegistryEntry): string {
  return [
    `# ${job.title}`,
    `Company: ${employer.name}`,
    `Location: ${job.location ?? "unknown"}`,
    `Working language: ${job.language ?? "unknown"}`,
    "Description:",
    job.content || "unknown",
  ].join("\n");
}

export async function discoverGreenhouseEmployer(
  employer: EmployerRegistryEntry,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: GreenhouseDiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  const token = boardToken(employer);
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const sourceId = `greenhouse:${employer.id}`;
  const identity = discoveryRunIdentity(sourceId, { employer: employer.id, endpoint }, startedAt);
  const runId = repository.startDiscoveryRunAllocated({ id: identity.runId, sourceId, scopeHash: identity.scopeHash, startedAt }).id;
  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const jobs: DiscoveryBatch["jobs"] = [];
  let status: DiscoveryBatch["status"] = "failed";

  try {
    counters.searched = 1;
    const response = await fetchWithRetry(endpoint, { headers: { Accept: "application/json" } }, options, options.fetcher ?? fetch);
    const rows = parseGreenhouseJobs(await parseJson<unknown>(response, "Greenhouse"));
    const ordered = prioritizeByLocation(rows, (job) => job.location, employer.cities);
    const selected = ordered.slice(0, Math.max(0, Math.min(options.maxResults ?? 12, 12)));
    counters.detailed = selected.length;
    counters.skipped += rows.length - selected.length;
    for (const row of selected) {
      const stableSourceId = `greenhouse:${employer.id}:${row.id}`;
      try {
        const imported = await importVacancy(
          { text: canonicalText(row, employer), sourceId: stableSourceId, sourceUrl: row.absoluteUrl, sourceType: "greenhouse_public_api" },
          repository,
          { discoveryRunId: runId, observedAt: now() },
        );
        counters.imported += 1;
        const area = locationActionability(row.location, employer.cities);
        if (area === "out_of_area") {
          counters.skipped += 1;
          diagnostics.push({ stage: "parse", locator: stableSourceId, code: "out_of_area", message: `Location is outside configured cities: ${row.location}`, transient: false });
        }
        let evaluation;
        if (options.evaluate !== false) {
          const stored = repository.readJob(imported.id);
          if (!stored) throw new Error(`Imported Greenhouse job is unavailable: ${imported.id}`);
          const extracted = extractVacancy((stored as StoredJobSource).rawContent);
          evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? now().slice(0, 10));
          repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
        }
        jobs.push({
          id: imported.id, reused: imported.reused, sourceId: stableSourceId, stableSourceId, sourceUrl: row.absoluteUrl,
          title: row.title, company: employer.name, location: row.location, logicalVacancyId: imported.logicalVacancyId,
          version: imported.version, actionable: area !== "out_of_area", evaluation,
        });
      } catch (error) {
        counters.failed += 1;
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "processing_failed", message: error instanceof Error ? error.message : String(error), transient: false });
      }
    }
    status = discoveryStatus(counters);
  } catch (error) {
    counters.failed += 1;
    diagnostics.push(diagnosticFromError(error, "search", employer.id));
    status = discoveryStatus(counters);
  } finally {
    repository.finishDiscoveryRun(runId, { status, counters, diagnostics, finishedAt: now() });
  }
  return { sourceId, status, scope: { planned: 1, completed: status === "failed" ? 0 : 1, failed: status === "failed" ? 1 : 0 }, jobs, counters, diagnostics };
}
