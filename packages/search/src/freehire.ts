import type { WorkspaceSnapshot } from "../../core/src/types";
import { canonicalHttpUrl } from "../../core/src/canonical-url";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import {
  assertReadableGermanSource,
  createDiscoveryLoopState,
  diagnosticFromError,
  discoveryRunIdentity,
  discoveryScopeSummary,
  discoveryStatus,
  fetchWithRetry,
  locationActionability,
  mapBounded,
  normalizedDiscoveryScope,
  parseJson,
  prioritizeByLocation,
  ReadFailure,
} from "./scheduler";
import { emptyCounters, evaluationNeedsReview, type DiscoveredJob, type DiscoveryBatch, type DiscoveryOptions, type SearchTrack, type SourceDiagnostic } from "./types";

export type { DiscoveredJob, DiscoveryBatch, DiscoveryOptions } from "./types";

export type FreehireSourceConfig = {
  id: "freehire";
  track: SearchTrack;
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
  external_id?: string | null;
  company_slug?: string | null;
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
    semantic_ratio: "0.5",
  });
  params.append("countries", source.country);
  params.append("cities", city);
  return `${FREEHIRE_BASE_URL}/api/v1/jobs/search?${params.toString()}`;
}

async function readJson<T>(url: string, options: DiscoveryOptions, label: string): Promise<T> {
  const response = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, options);
  return parseJson<T>(response, label);
}

function searchEnvelope(value: Envelope<unknown[]>): unknown[] {
  if (!value || !Array.isArray(value.data)) throw new ReadFailure("FreeHire returned an invalid search envelope", "invalid_envelope", false);
  return value.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function searchRecord(value: unknown): FreehireJob | null {
  if (!isRecord(value) || typeof value.public_slug !== "string" || !value.public_slug.trim()) return null;
  return value as FreehireJob;
}

function detailEnvelope(value: Envelope<unknown>): FreehireJob {
  if (!value || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new ReadFailure("FreeHire returned an invalid detail envelope", "invalid_envelope", false);
  }
  const job = value.data as Record<string, unknown>;
  const valid = typeof job.public_slug === "string" && Boolean(job.public_slug.trim())
    && typeof job.title === "string" && Boolean(job.title.trim())
    && typeof job.url === "string" && Boolean(job.url.trim())
    && isOptionalString(job.company)
    && isOptionalString(job.location)
    && isOptionalString(job.description)
    && isOptionalString(job.posted_at)
    && Array.isArray(job.skills) && job.skills.every((skill) => typeof skill === "string");
  if (!valid) throw new ReadFailure("FreeHire returned a detail record with invalid field types", "invalid_record", false);
  return job as FreehireJob;
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

function sourceListingAliases(job: FreehireJob): string[] {
  const aliases: string[] = [];
  const company = (job.company_slug ?? job.company ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const canonicalUrl = canonicalHttpUrl(job.url);
  if (canonicalUrl) aliases.push(`url:${canonicalUrl}`);
  if (company && job.external_id?.trim()) aliases.push(`external:${company}:${job.external_id.trim().toLowerCase()}`);
  const requisition = job.url.match(/USR(\d{6,})EXTERNAL/i) ?? job.url.match(/_R(\d{6,})(?:\b|[/?#])/i);
  if (company && requisition) aliases.push(`requisition:${company}:${requisition[1]}`);
  return aliases;
}

export async function discoverFreehire(
  source: FreehireSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: DiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  assertReadableGermanSource(source, "FreeHire");

  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const batchSourceId = `${source.id}:${source.track}`;
  const identity = discoveryRunIdentity(batchSourceId, normalizedDiscoveryScope(source), startedAt);
  const runId = repository.startDiscoveryRunAllocated({ id: identity.runId, sourceId: batchSourceId, scopeHash: identity.scopeHash, startedAt }).id;

  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const loop = createDiscoveryLoopState(source.keywords, source.cities);
  const { scopes, active, failedScopes, completedScopes } = loop;
  const seen = new Map<string, FreehireJob>();
  const seenDetailAliases = new Set<string>();
  const rows: DiscoveredJob[] = [];
  let truncated = false;
  let batch: DiscoveryBatch = {
    sourceId: batchSourceId,
    track: source.track,
    status: "failed",
    scope: { planned: scopes.length, completed: 0, failed: scopes.length },
    jobs: [],
    counters,
    diagnostics,
  };

  try {
    if (scopes.length === 0) {
      counters.failed += 1;
      diagnostics.push({ stage: "search", locator: source.id, code: "empty_scope", message: "FreeHire discovery requires at least one keyword and city scope", transient: false });
    }
    for (let page = 1; page <= source.max_pages && active.some(Boolean); page += 1) {
    const pageScopes = scopes.map((scope, index) => ({ scope, index })).filter(({ index }) => active[index]);
    const settled = await mapBounded(pageScopes, CONCURRENCY, async ({ scope }) => {
      const url = searchUrl(source, scope.keyword, scope.city, page);
      return searchEnvelope(await readJson<Envelope<unknown[]>>(url, options, "FreeHire"));
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
      for (const value of result.value) {
        const job = searchRecord(value);
        if (!job) {
          counters.failed += 1;
          diagnostics.push({ stage: "parse", locator: searchUrl(source, scope.keyword, scope.city, page), code: "invalid_record", message: "FreeHire search record has an invalid public_slug", transient: false });
        } else if (!seen.has(job.public_slug)) seen.set(job.public_slug, job);
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

  const detailLimit = Math.max(0, Math.min(options.maxResults ?? MAX_DISCOVERY_RESULTS, MAX_DISCOVERY_RESULTS));
  const summaries = prioritizeByLocation(
    [...seen.values()],
    (summary) => summary.location,
    source.cities,
  ).slice(0, detailLimit);
  truncated = seen.size > summaries.length;
  if (truncated) diagnostics.push({
    stage: "search",
    locator: source.id,
    code: "result_budget_truncated",
    message: `Review budget selected ${summaries.length} of ${seen.size} discovered vacancies`,
    transient: false,
  });
  counters.detailed = summaries.length;
  const details = await mapBounded(summaries, CONCURRENCY, async (summary) => {
    const url = `${FREEHIRE_BASE_URL}/api/v1/jobs/${encodeURIComponent(summary.public_slug)}`;
    return detailEnvelope(await readJson<Envelope<unknown>>(url, options, "FreeHire"));
  });

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
      diagnostics.push({ stage: "parse", locator: summary.public_slug, code: "missing_identity", message: "FreeHire detail is missing public_slug, url, or title", transient: false });
      continue;
    }
    const stableSourceId = `freehire:${detail.public_slug}`;
    const aliases = sourceListingAliases(detail);
    const duplicate = aliases.some((alias) => seenDetailAliases.has(alias));
    for (const alias of aliases) seenDetailAliases.add(alias);
    if (duplicate) {
      counters.skipped += 1;
      diagnostics.push({ stage: "parse", locator: stableSourceId, code: "duplicate_source_listing", message: "FreeHire returned the same source vacancy under another listing identity", transient: false });
      continue;
    }
    try {
      const imported = await importVacancy({
        text: canonicalText(detail), sourceUrl: detail.url, sourceId: stableSourceId, sourceType: "freehire_public_api",
      }, repository, { discoveryRunId: runId, observedAt: now() });
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
        evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? now().slice(0, 10), { track: source.track });
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
        track: source.track,
        actionable: area !== "out_of_area",
        needs_review: evaluationNeedsReview(evaluation),
        evaluation,
      });
    } catch (error) {
      counters.failed += 1;
      diagnostics.push({ stage: "parse", locator: stableSourceId, code: "processing_failed", message: error instanceof Error ? error.message : String(error), transient: false });
    }
  }

    const status = discoveryStatus(counters, truncated);
    const scope = discoveryScopeSummary(loop);
    batch = { sourceId: batchSourceId, track: source.track, status, scope, jobs: rows, counters, diagnostics };
  } catch (error) {
    counters.failed += 1;
    diagnostics.push({ stage: "parse", locator: source.id, code: "connector_exception", message: error instanceof Error ? error.message : String(error), transient: false });
    const status = discoveryStatus(counters, truncated);
    batch = { sourceId: batchSourceId, track: source.track, status, scope: discoveryScopeSummary(loop), jobs: [...rows], counters, diagnostics };
  } finally {
    repository.finishDiscoveryRun(runId, { status: batch.status, counters, diagnostics, finishedAt: now() });
  }
  return batch;
}
