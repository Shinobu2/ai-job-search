import { Buffer } from "node:buffer";
import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";
import type { DiscoveredJob, DiscoveryOptions } from "./freehire";

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
};

type JobsucheSearchResponse = { stellenangebote?: JobsucheSearchJob[] };

const JOBSUCHE_BASE_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const JOBSUCHE_API_KEY = "jobboerse-jobsuche";
const MAX_DISCOVERY_RESULTS = 50;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-API-Key": JOBSUCHE_API_KEY },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Jobsuche read failed: ${response.status} ${response.statusText}`);
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Jobsuche returned invalid JSON");
  }
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

function canonicalText(detail: JobsucheDetail, summary: JobsucheSearchJob, refnr: string): string {
  const title = detail.stellenangebotsTitel ?? detail.titel ?? summary.beruf ?? "(untitled)";
  const company = detail.arbeitgeber ?? summary.arbeitgeber ?? "unknown";
  const location = locationText(detail.arbeitsorte, summary.arbeitsort) ?? "unknown";
  const description = detail.stellenangebotsBeschreibung ?? detail.stellenbeschreibung ?? "unknown";
  return [
    `# ${title}`,
    `Company: ${company}`,
    `Location: ${location}`,
    `Jobsuche reference number: ${refnr}`,
    `Posted: ${detail.aktuelleVeroeffentlichungsdatum ?? detail.ersteVeroeffentlichungsdatum ?? "unknown"}`,
    `Working time: ${detail.arbeitszeitmodelle?.join(", ") || "unknown"}`,
    `Contract: ${detail.befristung ?? "unknown"}`,
    "Description:",
    description,
    "Jobsuche raw detail:",
    JSON.stringify(detail),
  ].join("\n");
}

function sortResults(rows: DiscoveredJob[]): DiscoveredJob[] {
  const tiers = { S: 0, A: 1, B: 2, C: 3 } as const;
  return [...rows].sort((left, right) => tiers[left.evaluation.tier] - tiers[right.evaluation.tier]
    || right.evaluation.fit - left.evaluation.fit
    || left.title.localeCompare(right.title));
}

export async function discoverJobsuche(
  source: JobsucheSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: DiscoveryOptions = {},
): Promise<DiscoveredJob[]> {
  if (!source.enabled) throw new Error("Jobsuche source is disabled by workspace policy");
  if (source.mode !== "read_import_evaluate") throw new Error("Jobsuche source must use read_import_evaluate mode");
  if (source.country !== "DE") throw new Error("Jobsuche source only supports country DE");

  const seen = new Map<string, JobsucheSearchJob>();
  for (const keyword of source.keywords) {
    for (const city of source.cities) {
      for (let page = 1; page <= source.max_pages; page += 1) {
        const result = await getJson<JobsucheSearchResponse>(searchUrl(keyword, city, page, source.page_size));
        const listings = result.stellenangebote ?? [];
        for (const job of listings) {
          const refnr = referenceNumber(job);
          if (refnr && !seen.has(refnr) && seen.size < MAX_DISCOVERY_RESULTS) seen.set(refnr, job);
        }
        if (listings.length < source.page_size || seen.size >= MAX_DISCOVERY_RESULTS) break;
      }
      if (seen.size >= MAX_DISCOVERY_RESULTS) break;
    }
    if (seen.size >= MAX_DISCOVERY_RESULTS) break;
  }

  const rows: DiscoveredJob[] = [];
  for (const [refnr, summary] of seen) {
    const detail = await getJson<JobsucheDetail>(detailUrl(refnr));
    const title = detail.stellenangebotsTitel ?? detail.titel ?? summary.beruf;
    if (!title) throw new Error("Jobsuche detail is missing a title");
    const sourceUrl = summary.externeUrl ?? portalUrl(refnr);
    const sourceId = `jobsuche:${refnr}`;
    const imported = await importVacancy({
      text: canonicalText(detail, summary, refnr), sourceUrl, sourceId, sourceType: "ba_jobsuche_api",
    }, repository);
    const stored = repository.readJob(imported.id);
    if (!stored) throw new Error(`Imported Jobsuche job is unavailable: ${imported.id}`);
    const extracted = extractVacancy((stored as StoredJobSource).rawContent);
    const evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? isoToday());
    repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
    rows.push({
      id: imported.id, reused: imported.reused, sourceId, sourceUrl, title,
      company: detail.arbeitgeber ?? summary.arbeitgeber ?? null,
      location: locationText(detail.arbeitsorte, summary.arbeitsort), evaluation,
    });
  }
  return sortResults(rows);
}
