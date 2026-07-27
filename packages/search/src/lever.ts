import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import type { EmployerRegistryEntry } from "./employer-registry";
import { diagnosticFromError, discoveryRunIdentity, discoveryStatus, fetchWithRetry, locationActionability, parseJson, prioritizeByLocation } from "./scheduler";
import { emptyCounters, type DiscoveryBatch, type DiscoveryOptions, type SourceDiagnostic } from "./types";

type LeverJob = {
  id: string;
  title: string;
  location: string | null;
  description: string;
  hostedUrl: string;
};

export type LeverDiscoveryOptions = DiscoveryOptions & { fetcher?: typeof fetch };

function siteFor(employer: EmployerRegistryEntry): { site: string; apiHost: string } {
  if (!employer.enabled || employer.policy !== "public_ats_endpoint" || employer.ats !== "lever") {
    throw new Error(`Employer ${employer.id} is not approved for Lever reads`);
  }
  const career = new URL(employer.career_url);
  if (career.protocol !== "https:" || !["jobs.lever.co", "jobs.eu.lever.co"].includes(career.hostname)) {
    throw new Error(`Employer ${employer.id} has an invalid Lever endpoint`);
  }
  const site = career.pathname.split("/").filter(Boolean)[0];
  if (!site || !/^[a-z0-9_-]+$/i.test(site)) throw new Error(`Employer ${employer.id} has no Lever site name`);
  return { site, apiHost: career.hostname === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co" };
}

export function parseLeverJobs(value: unknown): LeverJob[] {
  if (!Array.isArray(value)) throw new Error("Lever returned an invalid jobs envelope");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Lever returned an invalid job record");
    const row = item as Record<string, unknown>;
    const categories = row.categories && typeof row.categories === "object" ? row.categories as Record<string, unknown> : {};
    const location = typeof categories.location === "string" ? categories.location : null;
    if (typeof row.id !== "string" || typeof row.text !== "string" || typeof row.hostedUrl !== "string") {
      throw new Error("Lever job requires id, text and hostedUrl");
    }
    const description = [row.descriptionPlain, row.additionalPlain].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
    return { id: row.id, title: row.text, location, description, hostedUrl: row.hostedUrl };
  });
}

function canonicalText(job: LeverJob, employer: EmployerRegistryEntry): string {
  return [
    `# ${job.title}`,
    `Company: ${employer.name}`,
    `Location: ${job.location ?? "unknown"}`,
    "Description:",
    job.description || "unknown",
  ].join("\n");
}

export async function discoverLeverEmployer(
  employer: EmployerRegistryEntry,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: LeverDiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  const { site, apiHost } = siteFor(employer);
  const limit = Math.max(0, Math.min(options.maxResults ?? 12, 12));
  const endpoint = `https://${apiHost}/v0/postings/${encodeURIComponent(site)}?mode=json`;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const sourceId = `lever:${employer.id}`;
  const identity = discoveryRunIdentity(sourceId, { employer: employer.id, endpoint }, startedAt);
  const runId = repository.startDiscoveryRunAllocated({ id: identity.runId, sourceId, scopeHash: identity.scopeHash, startedAt }).id;
  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const jobs: DiscoveryBatch["jobs"] = [];
  let status: DiscoveryBatch["status"] = "failed";

  try {
    counters.searched = 1;
    const response = await fetchWithRetry(endpoint, { headers: { Accept: "application/json" } }, options, options.fetcher ?? fetch);
    const rows = parseLeverJobs(await parseJson<unknown>(response, "Lever"));
    const selected = prioritizeByLocation(rows, (row) => row.location, employer.cities).slice(0, limit);
    counters.detailed = selected.length;
    counters.skipped += rows.length - selected.length;
    for (const row of selected) {
      const stableSourceId = `lever:${employer.id}:${row.id}`;
      try {
        const imported = await importVacancy(
          { text: canonicalText(row, employer), sourceId: stableSourceId, sourceUrl: row.hostedUrl, sourceType: "lever_public_api" },
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
          if (!stored) throw new Error(`Imported Lever job is unavailable: ${imported.id}`);
          const extracted = extractVacancy((stored as StoredJobSource).rawContent);
          evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? now().slice(0, 10));
          repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
        }
        jobs.push({
          id: imported.id, reused: imported.reused, sourceId: stableSourceId, stableSourceId, sourceUrl: row.hostedUrl,
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
