import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy, visibleHtmlText } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import {
  assertReadableGermanSource,
  diagnosticFromError,
  discoveryRunIdentity,
  discoveryStatus,
  fetchWithRetry,
  locationActionability,
  normalizedDiscoveryScope,
  parseJson,
  ReadFailure,
} from "./scheduler";
import {
  emptyCounters,
  evaluationNeedsReview,
  type DiscoveryBatch,
  type DiscoveryOptions,
  type SearchTrack,
  type SourceDiagnostic,
} from "./types";

const ARBEITNOW_ENDPOINT = "https://www.arbeitnow.com/api/job-board-api";
const MAX_RESULTS = 50;

export type ArbeitnowSourceConfig = {
  id: "arbeitnow";
  track: SearchTrack;
  enabled: boolean;
  mode: "read_import_evaluate";
  country: "DE";
  cities: string[];
  keywords: string[];
  max_pages: number;
  page_size: number;
};

export type ArbeitnowDiscoveryOptions = DiscoveryOptions & { fetcher?: typeof fetch };

type ArbeitnowJob = {
  slug: string;
  company: string;
  title: string;
  description: string;
  remote: boolean | null;
  url: string;
  tags: string[];
  jobTypes: string[];
  location: string | null;
};

type ArbeitnowPage = { rows: unknown[]; hasNext: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanHtml(value: string): string {
  const first = visibleHtmlText(value);
  const decoded = /<\/?[a-z][^>]*>/i.test(first) ? visibleHtmlText(first) : first;
  return decoded
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function parsePage(value: unknown): ArbeitnowPage {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.data)) {
    throw new ReadFailure("Arbeitnow returned an invalid data envelope", "invalid_envelope", false);
  }
  const links = record(envelope.links);
  const next = links?.next;
  if (next !== undefined && next !== null && typeof next !== "string") {
    throw new ReadFailure("Arbeitnow returned an invalid pagination envelope", "invalid_envelope", false);
  }
  return { rows: envelope.data, hasNext: typeof next === "string" && next.length > 0 };
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ReadFailure(`Arbeitnow job requires ${field}`, "invalid_record", false);
  return text;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function parseJob(value: unknown): ArbeitnowJob {
  const row = record(value);
  if (!row) throw new ReadFailure("Arbeitnow returned an invalid job record", "invalid_record", false);
  return {
    slug: requiredText(row.slug, "slug"),
    company: requiredText(row.company_name, "company_name"),
    title: requiredText(row.title, "title"),
    description: typeof row.description === "string" ? cleanHtml(row.description) : "",
    remote: typeof row.remote === "boolean" ? row.remote : null,
    url: requiredText(row.url, "url"),
    tags: textArray(row.tags),
    jobTypes: textArray(row.job_types),
    location: typeof row.location === "string" && row.location.trim() ? row.location.trim() : null,
  };
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchesSource(job: ArbeitnowJob, source: ArbeitnowSourceConfig): boolean {
  const haystack = normalized([
    job.title,
    job.description,
    ...job.tags,
    ...job.jobTypes,
  ].join(" "));
  const keywordMatch = source.keywords.some((keyword) => {
    const wanted = normalized(keyword);
    return wanted.length > 0 && haystack.includes(wanted);
  });
  return keywordMatch && locationActionability(job.location, source.cities) !== "out_of_area";
}

function canonicalText(job: ArbeitnowJob): string {
  return [
    `# ${job.title}`,
    `Company: ${job.company}`,
    ...(job.location ? [`Location: ${job.location}`] : []),
    ...(job.remote === null ? [] : [`Remote: ${job.remote}`]),
    ...(job.tags.length ? [`Tags: ${job.tags.join(", ")}`] : []),
    ...(job.jobTypes.length ? [`Job types: ${job.jobTypes.join(", ")}`] : []),
    ...(job.description ? ["Description:", job.description] : []),
  ].join("\n");
}

export async function discoverArbeitnow(
  source: ArbeitnowSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: ArbeitnowDiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  assertReadableGermanSource(source, "Arbeitnow");
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const sourceId = `${source.id}:${source.track}`;
  const identity = discoveryRunIdentity(sourceId, normalizedDiscoveryScope(source), startedAt);
  const runId = repository.startDiscoveryRunAllocated({
    id: identity.runId,
    sourceId,
    scopeHash: identity.scopeHash,
    startedAt,
  }).id;
  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const discovered = new Map<string, ArbeitnowJob>();
  const jobs: DiscoveryBatch["jobs"] = [];
  let completedPages = 0;
  let failedPages = 0;
  let truncated = false;
  let status: DiscoveryBatch["status"] = "failed";

  try {
    for (let page = 1; page <= source.max_pages; page += 1) {
      const url = `${ARBEITNOW_ENDPOINT}?page=${page}`;
      counters.searched += 1;
      let parsed: ArbeitnowPage;
      try {
        const response = await fetchWithRetry(
          url,
          { headers: { Accept: "application/json" } },
          options,
          options.fetcher ?? fetch,
        );
        parsed = parsePage(await parseJson<unknown>(response, "Arbeitnow"));
        completedPages += 1;
      } catch (error) {
        counters.failed += 1;
        failedPages += 1;
        const parseFailure = error instanceof ReadFailure && error.code.startsWith("invalid_");
        diagnostics.push(diagnosticFromError(error, parseFailure ? "parse" : "search", url));
        break;
      }

      for (const value of parsed.rows) {
        try {
          const row = parseJob(value);
          if (!matchesSource(row, source) || discovered.has(row.slug)) {
            counters.skipped += 1;
            continue;
          }
          discovered.set(row.slug, row);
          if (locationActionability(row.location, source.cities) === "unknown") {
            diagnostics.push({
              stage: "parse",
              locator: `arbeitnow:${row.slug}`,
              code: "location_unknown",
              message: "Location is missing",
              transient: false,
            });
          }
        } catch (error) {
          counters.failed += 1;
          diagnostics.push(diagnosticFromError(error, "parse", url));
        }
      }
      if (!parsed.hasNext) break;
    }

    const limit = Math.max(0, Math.min(options.maxResults ?? source.page_size, MAX_RESULTS));
    const selected = [...discovered.values()].slice(0, limit);
    truncated = discovered.size > selected.length;
    counters.detailed = selected.length;
    counters.skipped += discovered.size - selected.length;
    if (truncated) {
      diagnostics.push({
        stage: "search",
        locator: source.id,
        code: "result_budget_truncated",
        message: `Review budget selected ${selected.length} of ${discovered.size} vacancies`,
        transient: false,
      });
    }

    for (const row of selected) {
      const stableSourceId = `arbeitnow:${row.slug}`;
      try {
        const imported = await importVacancy({
          text: canonicalText(row),
          sourceId: stableSourceId,
          sourceUrl: row.url,
          sourceType: "arbeitnow_public_api",
        }, repository, { discoveryRunId: runId, observedAt: now() });
        counters.imported += 1;
        let evaluation;
        if (options.evaluate !== false) {
          const stored = repository.readJob(imported.id);
          if (!stored) throw new Error(`Imported Arbeitnow job is unavailable: ${imported.id}`);
          const extracted = extractVacancy((stored as StoredJobSource).rawContent);
          evaluation = evaluateVacancy(
            stored as StoredJob,
            extracted,
            workspace,
            options.asOf ?? now().slice(0, 10),
            { track: source.track },
          );
          repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
        }
        jobs.push({
          id: imported.id,
          reused: imported.reused,
          sourceId: stableSourceId,
          stableSourceId,
          sourceUrl: row.url,
          title: row.title,
          company: row.company,
          location: row.location,
          logicalVacancyId: imported.logicalVacancyId,
          version: imported.version,
          track: source.track,
          actionable: true,
          needs_review: evaluationNeedsReview(evaluation),
          evaluation,
        });
      } catch (error) {
        counters.failed += 1;
        diagnostics.push({
          stage: "parse",
          locator: stableSourceId,
          code: "processing_failed",
          message: error instanceof Error ? error.message : String(error),
          transient: false,
        });
      }
    }
    status = discoveryStatus(counters, truncated);
  } catch (error) {
    counters.failed += 1;
    diagnostics.push({
      stage: "parse",
      locator: source.id,
      code: "connector_exception",
      message: error instanceof Error ? error.message : String(error),
      transient: false,
    });
    status = discoveryStatus(counters, truncated);
  } finally {
    repository.finishDiscoveryRun(runId, { status, counters, diagnostics, finishedAt: now() });
  }

  return {
    sourceId,
    track: source.track,
    status,
    scope: { planned: source.max_pages, completed: completedPages, failed: failedPages },
    jobs,
    counters,
    diagnostics,
  };
}
