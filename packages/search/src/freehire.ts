import type { WorkspaceSnapshot } from "../../core/src/types";
import { buildEvaluationInput, evaluateVacancy } from "../../jobs/src/evaluate";
import { extractVacancy } from "../../jobs/src/extract";
import { importVacancy } from "../../jobs/src/import";
import type { EvaluationResult } from "../../jobs/src/types";
import type { StoredJob, StoredJobSource, StorageRepository } from "../../storage/src/repository";

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

export type DiscoveredJob = {
  id: string;
  reused: boolean;
  sourceId: string;
  sourceUrl: string;
  title: string;
  company: string | null;
  location: string | null;
  evaluation: EvaluationResult;
};

export type DiscoveryOptions = { asOf?: string };

const FREEHIRE_BASE_URL = "https://freehire.dev";
const MAX_DISCOVERY_RESULTS = 50;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error(`FreeHire read failed: ${response.status} ${response.statusText}`);
  try {
    return await response.json() as T;
  } catch {
    throw new Error("FreeHire returned invalid JSON");
  }
}

function searchUrl(source: FreehireSourceConfig, keyword: string, page: number): string {
  const params = new URLSearchParams({ q: keyword, limit: String(source.page_size), offset: String((page - 1) * source.page_size), semantic_ratio: "0" });
  params.append("countries", source.country);
  for (const city of source.cities) params.append("cities", city);
  return `${FREEHIRE_BASE_URL}/api/v1/jobs/search?${params.toString()}`;
}

function canonicalText(job: FreehireJob): string {
  const detail = JSON.stringify(job);
  return [
    `# ${job.title || "(untitled)"}`,
    `Company: ${job.company ?? "unknown"}`,
    `Location: ${job.location ?? "unknown"}`,
    `Posted: ${job.posted_at ?? "unknown"}`,
    `Skills: ${job.skills.join(", ") || "unknown"}`,
    "Description:",
    job.description ?? "unknown",
    "FreeHire raw detail:",
    detail,
  ].join("\n");
}

function sortResults(rows: DiscoveredJob[]): DiscoveredJob[] {
  const tiers = { S: 0, A: 1, B: 2, C: 3 } as const;
  return [...rows].sort((left, right) => tiers[left.evaluation.tier] - tiers[right.evaluation.tier]
    || right.evaluation.fit - left.evaluation.fit
    || left.title.localeCompare(right.title));
}

export async function discoverFreehire(
  source: FreehireSourceConfig,
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options: DiscoveryOptions = {},
): Promise<DiscoveredJob[]> {
  if (!source.enabled) throw new Error("FreeHire source is disabled by workspace policy");
  if (source.mode !== "read_import_evaluate") throw new Error("FreeHire source must use read_import_evaluate mode");
  const seen = new Map<string, FreehireJob>();
  for (const keyword of source.keywords) {
    for (let page = 1; page <= source.max_pages; page += 1) {
      const envelope = await getJson<Envelope<FreehireJob[]>>(searchUrl(source, keyword, page));
      for (const job of envelope.data ?? []) {
        if (job.public_slug && !seen.has(job.public_slug) && seen.size < MAX_DISCOVERY_RESULTS) seen.set(job.public_slug, job);
      }
      if ((envelope.data ?? []).length < source.page_size || seen.size >= MAX_DISCOVERY_RESULTS) break;
    }
    if (seen.size >= MAX_DISCOVERY_RESULTS) break;
  }

  const rows: DiscoveredJob[] = [];
  for (const summary of seen.values()) {
    const detailEnvelope = await getJson<Envelope<FreehireJob>>(`${FREEHIRE_BASE_URL}/api/v1/jobs/${encodeURIComponent(summary.public_slug)}`);
    const detail = detailEnvelope.data;
    if (!detail?.public_slug || !detail.url) throw new Error("FreeHire detail is missing public identity");
    const sourceId = `freehire:${detail.public_slug}`;
    const imported = await importVacancy({
      text: canonicalText(detail), sourceUrl: detail.url, sourceId, sourceType: "freehire_public_api",
    }, repository);
    const stored = repository.readJob(imported.id);
    if (!stored) throw new Error(`Imported FreeHire job is unavailable: ${imported.id}`);
    const extracted = extractVacancy((stored as StoredJobSource).rawContent);
    const evaluation = evaluateVacancy(stored as StoredJob, extracted, workspace, options.asOf ?? isoToday());
    repository.persistEvaluation(buildEvaluationInput(evaluation, extracted, workspace));
    rows.push({
      id: imported.id, reused: imported.reused, sourceId, sourceUrl: detail.url, title: detail.title,
      company: detail.company, location: detail.location, evaluation,
    });
  }
  return sortResults(rows);
}
