import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy, visibleHtmlText } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import type { EmployerRegistryEntry } from "./employer-registry";
import { discoverGreenhouseEmployer } from "./greenhouse";
import { discoverLeverEmployer } from "./lever";
import { discoverPersonioEmployer } from "./personio";
import {
  diagnosticFromError,
  discoveryRunIdentity,
  discoveryStatus,
  fetchWithRetry,
  locationActionability,
  mapBounded,
  parseJson,
  prioritizeByLocation,
  ReadFailure,
} from "./scheduler";
import {
  emptyCounters,
  evaluationNeedsReview,
  type DiscoveryBatch,
  type DiscoveryOptions,
  type SourceDiagnostic,
} from "./types";

export const PUBLIC_ATS_TYPES = [
  "personio",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "recruitee",
] as const;

type JsonAtsType = "ashby" | "smartrecruiters" | "recruitee";
const MAX_SMARTRECRUITERS_PAGES = 20;

type AtsJob = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  description: string;
  sourceUrl: string | null;
  detailUrl?: string;
};

export type AtsDiscoveryOptions = DiscoveryOptions & { fetcher?: typeof fetch };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string, source: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ReadFailure(`${source} job requires ${field}`, "invalid_record", false);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifier(value: unknown, source: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return requiredText(value, "id", source);
}

function cleanHtml(value: string): string {
  const first = visibleHtmlText(value);
  return /<\/?[a-z][^>]*>/i.test(first) ? visibleHtmlText(first) : first;
}

function jobsEnvelope(value: unknown, key: "jobs" | "content" | "offers", source: string): unknown[] {
  const rows = record(value)?.[key];
  if (!Array.isArray(rows)) throw new ReadFailure(`${source} returned an invalid ${key} envelope`, "invalid_envelope", false);
  return rows;
}

function careerSlug(employer: EmployerRegistryEntry, ats: JsonAtsType): string {
  if (!employer.enabled || employer.policy !== "public_ats_endpoint" || employer.ats !== ats) {
    throw new Error(`Employer ${employer.id} is not approved for ${ats} reads`);
  }
  const career = new URL(employer.career_url);
  if (career.protocol !== "https:") throw new Error(`Employer ${employer.id} has an invalid ${ats} endpoint`);

  let slug: string | undefined;
  if (ats === "ashby" && career.hostname === "jobs.ashbyhq.com") {
    slug = career.pathname.split("/").filter(Boolean)[0];
  } else if (ats === "smartrecruiters" && career.hostname === "jobs.smartrecruiters.com") {
    slug = career.pathname.split("/").filter(Boolean)[0];
  } else if (ats === "recruitee" && career.hostname.endsWith(".recruitee.com")) {
    slug = career.hostname.slice(0, -".recruitee.com".length);
  }
  if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) throw new Error(`Employer ${employer.id} has no valid ${ats} slug`);
  return slug;
}

function endpointFor(employer: EmployerRegistryEntry, ats: JsonAtsType): string {
  const slug = careerSlug(employer, ats);
  if (ats === "ashby") {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  }
  if (ats === "smartrecruiters") {
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`;
  }
  return `https://${slug}.recruitee.com/api/offers`;
}

function parseAshby(value: unknown, employer: EmployerRegistryEntry): AtsJob[] {
  return jobsEnvelope(value, "jobs", "Ashby").map((item) => {
    const row = record(item);
    if (!row) throw new ReadFailure("Ashby returned an invalid job record", "invalid_record", false);
    const descriptionPlain = optionalText(row.descriptionPlain);
    const descriptionHtml = optionalText(row.descriptionHtml);
    return {
      id: identifier(row.id, "Ashby"),
      title: requiredText(row.title, "title", "Ashby"),
      company: employer.name,
      location: optionalText(row.location),
      description: descriptionPlain ?? (descriptionHtml ? cleanHtml(descriptionHtml) : ""),
      sourceUrl: requiredText(row.jobUrl, "jobUrl", "Ashby"),
    };
  });
}

function smartLocation(value: unknown): string | null {
  return optionalText(record(value)?.fullLocation);
}

function smartPagination(value: unknown): { offset: number; limit: number; totalFound: number } {
  const page = record(value);
  const offset = page?.offset;
  const limit = page?.limit;
  const totalFound = page?.totalFound;
  if (
    !Number.isInteger(offset)
    || (offset as number) < 0
    || !Number.isInteger(limit)
    || (limit as number) <= 0
    || !Number.isInteger(totalFound)
    || (totalFound as number) < 0
  ) {
    throw new ReadFailure("SmartRecruiters returned invalid pagination metadata", "invalid_envelope", false);
  }
  return {
    offset: offset as number,
    limit: limit as number,
    totalFound: totalFound as number,
  };
}

function parseSmartRecruiters(value: unknown, employer: EmployerRegistryEntry, endpoint: string): AtsJob[] {
  const endpointUrl = new URL(endpoint);
  return jobsEnvelope(value, "content", "SmartRecruiters").map((item) => {
    const row = record(item);
    if (!row) throw new ReadFailure("SmartRecruiters returned an invalid job record", "invalid_record", false);
    const detailUrl = requiredText(row.ref, "ref", "SmartRecruiters");
    const detail = new URL(detailUrl);
    if (detail.origin !== endpointUrl.origin || !detail.pathname.startsWith(`${endpointUrl.pathname}/`)) {
      throw new ReadFailure("SmartRecruiters returned an invalid detail ref", "invalid_record", false);
    }
    const company = optionalText(record(row.company)?.name) ?? employer.name;
    return {
      id: identifier(row.id, "SmartRecruiters"),
      title: requiredText(row.name, "name", "SmartRecruiters"),
      company,
      location: smartLocation(row.location),
      description: "",
      sourceUrl: null,
      detailUrl,
    };
  });
}

function parseSmartRecruitersDetail(value: unknown, summary: AtsJob): AtsJob {
  const row = record(value);
  if (!row) throw new ReadFailure("SmartRecruiters returned an invalid detail record", "invalid_record", false);
  const sections = record(record(row.jobAd)?.sections);
  const description = sections
    ? Object.values(sections).flatMap((value) => {
        const section = record(value);
        if (!section) return [];
        const title = optionalText(section.title);
        const text = optionalText(section.text);
        if (!text) return [];
        return [[title, cleanHtml(text)].filter((part): part is string => part !== null).join("\n")];
      }).join("\n")
    : "";
  return {
    ...summary,
    company: optionalText(record(row.company)?.name) ?? summary.company,
    location: smartLocation(row.location) ?? summary.location,
    description,
    sourceUrl: requiredText(row.postingUrl, "postingUrl", "SmartRecruiters"),
  };
}

function parseRecruitee(value: unknown, employer: EmployerRegistryEntry): AtsJob[] {
  return jobsEnvelope(value, "offers", "Recruitee").map((item) => {
    const row = record(item);
    if (!row) throw new ReadFailure("Recruitee returned an invalid job record", "invalid_record", false);
    const description = [optionalText(row.description), optionalText(row.requirements)]
      .filter((part): part is string => part !== null)
      .map(cleanHtml)
      .filter(Boolean)
      .join("\n");
    return {
      id: identifier(row.id, "Recruitee"),
      title: requiredText(row.title, "title", "Recruitee"),
      company: optionalText(row.company_name) ?? employer.name,
      location: optionalText(row.location),
      description,
      sourceUrl: requiredText(row.careers_url, "careers_url", "Recruitee"),
    };
  });
}

function parseAtsJobs(
  ats: JsonAtsType,
  value: unknown,
  employer: EmployerRegistryEntry,
  endpoint: string,
): AtsJob[] {
  if (ats === "ashby") return parseAshby(value, employer);
  if (ats === "smartrecruiters") return parseSmartRecruiters(value, employer, endpoint);
  return parseRecruitee(value, employer);
}

function canonicalText(job: AtsJob): string {
  return [
    `# ${job.title}`,
    `Company: ${job.company}`,
    ...(job.location ? [`Location: ${job.location}`] : []),
    ...(job.description ? ["Description:", job.description] : []),
  ].join("\n");
}

async function discoverJsonAtsEmployer(
  ats: JsonAtsType,
  employer: EmployerRegistryEntry,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: AtsDiscoveryOptions,
): Promise<DiscoveryBatch> {
  const endpoint = endpointFor(employer, ats);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const sourceId = `${ats}:${employer.id}`;
  const identity = discoveryRunIdentity(sourceId, { employer: employer.id, endpoint }, startedAt);
  const runId = repository.startDiscoveryRunAllocated({
    id: identity.runId,
    sourceId,
    scopeHash: identity.scopeHash,
    startedAt,
  }).id;
  const counters = emptyCounters();
  const diagnostics: SourceDiagnostic[] = [];
  const jobs: DiscoveryBatch["jobs"] = [];
  let status: DiscoveryBatch["status"] = "failed";
  let completed = 0;
  let truncated = false;

  try {
    counters.searched = 1;
    const response = await fetchWithRetry(
      endpoint,
      { headers: { Accept: "application/json" } },
      options,
      options.fetcher ?? fetch,
    );
    const firstPage = await parseJson<unknown>(response, ats);
    let candidates = parseAtsJobs(
      ats,
      firstPage,
      employer,
      endpoint,
    );
    let collectionTruncated = false;
    if (ats === "smartrecruiters") {
      const firstPagination = smartPagination(firstPage);
      let pageCount = 1;
      let totalFound = firstPagination.totalFound;
      let nextOffset = firstPagination.offset + firstPagination.limit;
      while (nextOffset < totalFound && pageCount < MAX_SMARTRECRUITERS_PAGES) {
        const pageUrl = new URL(endpoint);
        pageUrl.searchParams.set("limit", String(firstPagination.limit));
        pageUrl.searchParams.set("offset", String(nextOffset));
        counters.searched += 1;
        const pageResponse = await fetchWithRetry(
          pageUrl,
          { headers: { Accept: "application/json" } },
          options,
          options.fetcher ?? fetch,
        );
        const pageValue = await parseJson<unknown>(pageResponse, "SmartRecruiters");
        const pagePagination = smartPagination(pageValue);
        if (pagePagination.offset !== nextOffset) {
          throw new ReadFailure("SmartRecruiters pagination did not advance as requested", "invalid_envelope", false);
        }
        candidates = candidates.concat(parseSmartRecruiters(pageValue, employer, endpoint));
        totalFound = Math.max(totalFound, pagePagination.totalFound);
        nextOffset = pagePagination.offset + pagePagination.limit;
        pageCount += 1;
      }
      collectionTruncated = nextOffset < totalFound;
      if (collectionTruncated) {
        diagnostics.push({
          stage: "search",
          locator: employer.id,
          code: "source_collection_truncated",
          message: `SmartRecruiters collection exceeded ${MAX_SMARTRECRUITERS_PAGES} pages`,
          transient: false,
        });
      }
    }
    completed = 1;
    const limit = Math.max(0, Math.min(options.maxResults ?? 12, 12));
    const selected = prioritizeByLocation(candidates, (row) => row.location, employer.cities).slice(0, limit);
    truncated = collectionTruncated || candidates.length > selected.length;
    counters.detailed = selected.length;
    counters.skipped += candidates.length - selected.length;
    if (truncated) {
      diagnostics.push({
        stage: "search",
        locator: employer.id,
        code: "result_budget_truncated",
        message: `Review budget selected ${selected.length} of ${candidates.length} vacancies`,
        transient: false,
      });
    }

    let detailed = selected;
    if (ats === "smartrecruiters") {
      const results = await mapBounded(selected, 5, async (summary) => {
        const response = await fetchWithRetry(
          summary.detailUrl as string,
          { headers: { Accept: "application/json" } },
          options,
          options.fetcher ?? fetch,
        );
        return parseSmartRecruitersDetail(await parseJson<unknown>(response, "SmartRecruiters detail"), summary);
      });
      detailed = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "fulfilled") {
          detailed.push(result.value);
        } else {
          counters.failed += 1;
          diagnostics.push(diagnosticFromError(result.reason, "detail", selected[index].detailUrl as string));
        }
      }
    }

    for (const row of detailed) {
      const stableSourceId = `${ats}:${employer.id}:${row.id}`;
      try {
        const sourceUrl = row.sourceUrl as string;
        const imported = await importVacancy({
          text: canonicalText(row),
          sourceId: stableSourceId,
          sourceUrl,
          sourceType: `${ats}_public_api`,
        }, repository, { discoveryRunId: runId, observedAt: now() });
        counters.imported += 1;
        const area = locationActionability(row.location, employer.cities);
        if (area === "out_of_area") {
          counters.skipped += 1;
          diagnostics.push({
            stage: "parse",
            locator: stableSourceId,
            code: "out_of_area",
            message: `Location is outside configured cities: ${row.location}`,
            transient: false,
          });
        } else if (area === "unknown") {
          diagnostics.push({
            stage: "parse",
            locator: stableSourceId,
            code: "location_unknown",
            message: "Location is missing",
            transient: false,
          });
        }

        let evaluation;
        if (options.evaluate !== false) {
          const stored = repository.readJob(imported.id);
          if (!stored) throw new Error(`Imported ${ats} job is unavailable: ${imported.id}`);
          const extracted = extractVacancy((stored as StoredJobSource).rawContent);
          evaluation = evaluateVacancy(
            stored as StoredJob,
            extracted,
            workspace,
            options.asOf ?? now().slice(0, 10),
            { track: employer.track },
          );
          repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
        }
        jobs.push({
          id: imported.id,
          reused: imported.reused,
          sourceId: stableSourceId,
          stableSourceId,
          sourceUrl,
          title: row.title,
          company: row.company,
          location: row.location,
          logicalVacancyId: imported.logicalVacancyId,
          version: imported.version,
          track: employer.track,
          actionable: area !== "out_of_area",
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
    const parseFailure = error instanceof ReadFailure && error.code.startsWith("invalid_");
    diagnostics.push(diagnosticFromError(error, parseFailure ? "parse" : "search", employer.id));
    status = discoveryStatus(counters, truncated);
  } finally {
    repository.finishDiscoveryRun(runId, { status, counters, diagnostics, finishedAt: now() });
  }

  return {
    sourceId,
    track: employer.track,
    status,
    scope: { planned: 1, completed, failed: completed ? 0 : 1 },
    jobs,
    counters,
    diagnostics,
  };
}

export async function discoverAtsEmployer(
  employer: EmployerRegistryEntry,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: AtsDiscoveryOptions = {},
): Promise<DiscoveryBatch> {
  if (employer.ats === "greenhouse") return discoverGreenhouseEmployer(employer, repository, workspace, options);
  if (employer.ats === "lever") return discoverLeverEmployer(employer, repository, workspace, options);
  if (employer.ats === "personio") return discoverPersonioEmployer(employer, repository, workspace, options);
  if (employer.ats === "ashby" || employer.ats === "smartrecruiters" || employer.ats === "recruitee") {
    return discoverJsonAtsEmployer(employer.ats, employer, repository, workspace, options);
  }
  throw new Error(`Unsupported public ATS for employer ${employer.id}: ${employer.ats}`);
}
