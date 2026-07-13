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

export type { DiscoveredJob, DiscoveryBatch, DiscoveryOptions } from "./types";

export type FreehireSourceConfig = {
  id: "freehire";
  enabled: boolean;
  mode: "read_import_evaluate";
  country: "DE";
  cities: string[];
  keywords: string[];
  max_pages: number;
  page_size: number;
};

type FreehireJob = {
  public_slug: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  description: string | null;
  skills: string[];
  posted_at: string | null;
  regions: string[];
  countries: string[];
  cities: string[];
  enrichment: Record<string, unknown>;
};

type Envelope<T> = { data: T; meta?: { total?: number } };

const FREEHIRE_BASE_URL = "https://freehire.dev";
const MAX_DISCOVERY_RESULTS = 50;
const CONCURRENCY = 5;

function searchUrl(source: FreehireSourceConfig, keyword: string, city: string, page: number): string {
  const params = new URLSearchParams({
    q: keyword,
    limit: String(source.page_size),
    offset: String((page - 1) * source.page_size),
    semantic_ratio: "0",
  });
  params.append("countries", source.country);
  params.append("cities", city);
  return `${FREEHIRE_BASE_URL}/api/v1/jobs/search?${params.toString()}`;
}

async function readJson<T>(url: string, options: DiscoveryOptions, label: string): Promise<T> {
  const response = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, options);
  return parseJson<T>(response, label);
}

function searchEnvelope(value: Envelope<FreehireJob[]>): FreehireJob[] {
  if (!value || !Array.isArray(value.data)) throw new ReadFailure("FreeHire returned an invalid search envelope", "invalid_envelope", false);
  return value.data;
}

function detailEnvelope(value: Envelope<FreehireJob>): FreehireJob {
  if (!value || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new ReadFailure("FreeHire returned an invalid detail envelope", "invalid_envelope", false);
  }
  return value.data;
}

function canonicalText(job: FreehireJob): string {
  return [
    `# ${job.title || "(untitled)"}`,
    `Company: ${job.company ?? "unknown"}`,
    `Location: ${job.location ?? "unknown"}`,
    `Posted: ${job.posted_at ?? "unknown"}`,
    `Skills: ${job.skills.join(", ") || "unknown"}`,
    "Description:",
    job.description ?? "unknown",
    "FreeHire raw detail:",
    JSON.stringify(job),
  ].join("\n");
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

function normalizedScope(source: FreehireSourceConfig): unknown {
  const normalized = (values: string[]) => values.map((value) => value.trim().toLowerCase());
  return { keywords: normalized(source.keywords), cities: normalized(source.cities), country: source.country, maxPages: source.max_pages, pageSize: source.page_size };
}

export async function discoverFreehire(
  source: FreehireSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: DiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  if (!source.enabled) throw new Error("FreeHire source is disabled by workspace policy");
  if (source.mode !== "read_import_evaluate") throw new Error("FreeHire source must use read_import_evaluate mode");
  if (source.country !== "DE") throw new Error("FreeHire source only supports country DE");

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
  const seen = new Map<string, FreehireJob>();

  for (let page = 1; page <= source.max_pages && active.some(Boolean); page += 1) {
    const pageScopes = scopes.map((scope, index) => ({ scope, index })).filter(({ index }) => active[index]);
    const settled = await mapBounded(pageScopes, CONCURRENCY, async ({ scope }) => {
      const url = searchUrl(source, scope.keyword, scope.city, page);
      return searchEnvelope(await readJson<Envelope<FreehireJob[]>>(url, options, "FreeHire"));
    });
    settled.forEach((result, resultIndex) => {
      const { scope, index } = pageScopes[resultIndex];
      counters.searched += 1;
      if (result.status === "rejected") {
        counters.failed += 1;
        active[index] = false;
        failedScopes.add(index);
        diagnostics.push(diagnosticFromError(result.reason, result.reason instanceof ReadFailure && result.reason.code.startsWith("invalid_") ? "parse" : "search", searchUrl(source, scope.keyword, scope.city, page)));
        return;
      }
      for (const job of result.value) {
        if (job?.public_slug && !seen.has(job.public_slug)) seen.set(job.public_slug, job);
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

  const summaries = [...seen.values()].slice(0, MAX_DISCOVERY_RESULTS);
  counters.detailed = summaries.length;
  const details = await mapBounded(summaries, CONCURRENCY, async (summary) => {
    const url = `${FREEHIRE_BASE_URL}/api/v1/jobs/${encodeURIComponent(summary.public_slug)}`;
    return detailEnvelope(await readJson<Envelope<FreehireJob>>(url, options, "FreeHire"));
  });

  const rows: DiscoveredJob[] = [];
  for (let index = 0; index < details.length; index += 1) {
    const result = details[index];
    const summary = summaries[index];
    if (result.status === "rejected") {
      counters.failed += 1;
      diagnostics.push(diagnosticFromError(result.reason, result.reason instanceof ReadFailure && result.reason.code.startsWith("invalid_") ? "parse" : "detail", summary.public_slug));
      continue;
    }
    const detail = result.value;
    if (!detail.public_slug || !detail.url || !detail.title) {
      counters.skipped += 1;
      counters.failed += 1;
      diagnostics.push({ stage: "parse", locator: summary.public_slug, code: "missing_identity", message: "FreeHire detail is missing public_slug, url, or title", transient: false });
      continue;
    }
    const stableSourceId = `freehire:${detail.public_slug}`;
    try {
      const imported = await importVacancy({
        text: canonicalText(detail), sourceUrl: detail.url, sourceId: stableSourceId, sourceType: "freehire_public_api",
      }, repository);
      repository.observeVacancy({
        discoveryRunId: runId,
        jobId: imported.id,
        stableSourceId,
        canonicalUrl: detail.url,
        rawHash: imported.sourceHash,
        observedAt: now(),
      });
      counters.imported += 1;
      const area = locationActionability(detail.location, source.cities);
      if (area === "out_of_area") {
        counters.skipped += 1;
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "out_of_area", message: `Location is outside configured cities: ${detail.location}`, transient: false });
      } else if (area === "unknown") {
        diagnostics.push({ stage: "parse", locator: stableSourceId, code: "location_unknown", message: "Location is missing", transient: false });
      }

      let evaluation;
      if (options.evaluate !== false) {
        const stored = repository.readJob(imported.id);
        if (!stored) throw new Error(`Imported FreeHire job is unavailable: ${imported.id}`);
        const extracted = extractVacancy((stored as StoredJobSource).rawContent);
        evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? now().slice(0, 10));
        repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
      }
      rows.push({
        id: imported.id,
        reused: imported.reused,
        sourceId: stableSourceId,
        stableSourceId,
        sourceUrl: detail.url,
        title: detail.title,
        company: detail.company,
        location: detail.location,
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
