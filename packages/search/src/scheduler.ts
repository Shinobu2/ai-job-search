import type { DiscoveryOptions, SourceDiagnostic } from "./types";
import { createHash } from "node:crypto";
import type { DiscoveryCounters, DiscoveryScopeSummary, DiscoveryStatus, SearchTrack } from "./types";

const MAX_CONCURRENCY = 5;
const RETRY_DELAYS = [250, 500] as const;

type DiscoveryScopeSource = {
  track: SearchTrack;
  keywords: string[];
  cities: string[];
  country: string;
  max_pages: number;
  page_size: number;
  radius_km?: number;
  published_within_days?: number;
  working_time?: string[];
  include_temporary_work?: boolean;
};

export type DiscoveryLoopState = {
  scopes: Array<{ keyword: string; city: string }>;
  active: boolean[];
  failedScopes: Set<number>;
  completedScopes: Set<number>;
};

export function normalizedDiscoveryScope(source: DiscoveryScopeSource): unknown {
  const normalized = (values: string[]) => values.map((value) => value.trim().toLowerCase());
  return {
    track: source.track,
    keywords: normalized(source.keywords),
    cities: normalized(source.cities),
    country: source.country,
    maxPages: source.max_pages,
    pageSize: source.page_size,
    ...(source.radius_km === undefined ? {} : { radiusKm: source.radius_km }),
    ...(source.published_within_days === undefined ? {} : { publishedWithinDays: source.published_within_days }),
    ...(source.working_time === undefined ? {} : { workingTime: normalized(source.working_time) }),
    ...(source.include_temporary_work === undefined ? {} : { includeTemporaryWork: source.include_temporary_work }),
  };
}

export function createDiscoveryLoopState(keywords: string[], cities: string[]): DiscoveryLoopState {
  const scopes = roundRobinScopes(keywords, cities);
  return {
    scopes,
    active: scopes.map(() => true),
    failedScopes: new Set<number>(),
    completedScopes: new Set<number>(),
  };
}

export function discoveryScopeSummary(state: DiscoveryLoopState): DiscoveryScopeSummary {
  return {
    planned: state.scopes.length,
    completed: state.completedScopes.size,
    failed: state.failedScopes.size,
  };
}

export function assertReadableGermanSource(
  source: { enabled: boolean; mode: string; country: string; track: string },
  label: string,
): void {
  if (!source.enabled) throw new Error(`${label} source is disabled by workspace policy`);
  if (source.mode !== "read_import_evaluate") throw new Error(`${label} source must use read_import_evaluate mode`);
  if (source.country !== "DE") throw new Error(`${label} source only supports country DE`);
  if (!source.track.trim()) throw new Error(`${label} source track must be non-empty`);
}

export async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new RangeError(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function roundRobinScopes(keywords: string[], cities: string[]): Array<{ keyword: string; city: string }> {
  return keywords.flatMap((keyword) => cities.map((city) => ({ keyword, city })));
}

export class ReadFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ReadFailure";
  }
}

function networkFailure(error: unknown): ReadFailure | null {
  if (error instanceof ReadFailure) return error;
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ReadFailure(error.message || "Request timed out", "timeout", true);
  }
  if (error instanceof TypeError) return new ReadFailure(error.message || "Network request failed", "network_error", true);
  return null;
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: Pick<DiscoveryOptions, "sleep"> = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const sleep = options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs));
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    try {
      const response = await fetcher(url, {
        ...init,
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return response;
      const transient = response.status === 429 || response.status >= 500;
      const failure = new ReadFailure(
        `Read failed: ${response.status} ${response.statusText}`.trim(),
        `http_${response.status}`,
        transient,
      );
      if (transient) {
        try {
          await response.body?.cancel();
        } catch {
          // Response cleanup is best-effort and must not replace the HTTP failure.
        }
      }
      if (!transient || attempt === RETRY_DELAYS.length) throw failure;
    } catch (error) {
      const failure = networkFailure(error);
      if (!failure || !failure.transient || attempt === RETRY_DELAYS.length) throw failure ?? error;
    }
    await sleep(RETRY_DELAYS[attempt]);
  }
  throw new Error("unreachable retry state");
}

export function diagnosticFromError(
  error: unknown,
  stage: SourceDiagnostic["stage"],
  locator: string,
): SourceDiagnostic {
  const failure = error instanceof ReadFailure ? error : networkFailure(error);
  return {
    stage,
    locator,
    code: failure?.code ?? "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
    transient: failure?.transient ?? false,
  };
}

function normalizedLocation(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function locationActionability(location: string | null, cities: string[]): "actionable" | "out_of_area" | "unknown" {
  if (!location?.trim()) return "unknown";
  const normalized = ` ${normalizedLocation(location)} `;
  const inArea = cities.some((city) => {
    const wanted = normalizedLocation(city);
    if (!wanted) return false;
    if (normalized.includes(` ${wanted} `)) return true;
    return wanted.startsWith("frankfurt am main") && normalized.includes(" frankfurt ");
  });
  return inArea ? "actionable" : "out_of_area";
}

export function prioritizeByLocation<T>(
  rows: T[],
  locationOf: (row: T) => string | null,
  cities: string[],
): T[] {
  const rank = { actionable: 0, unknown: 1, out_of_area: 2 } as const;
  return rows
    .map((row, index) => ({ row, index, area: locationActionability(locationOf(row), cities) }))
    .sort((left, right) => rank[left.area] - rank[right.area] || left.index - right.index)
    .map(({ row }) => row);
}

export function parseJson<T>(response: Response, label: string): Promise<T> {
  return response.json().catch(() => {
    throw new ReadFailure(`${label} returned invalid JSON`, "invalid_json", false);
  }) as Promise<T>;
}

export function discoveryRunIdentity(sourceId: string, scope: unknown, startedAt: string): { runId: string; scopeHash: string } {
  const scopeHash = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const identity = `${sourceId}\n${scopeHash}\n${startedAt}`;
  const runHash = createHash("sha256").update(identity).digest("hex");
  return { runId: `discovery_${runHash}`, scopeHash };
}

export function discoveryStatus(counters: DiscoveryCounters, truncated = false): DiscoveryStatus {
  if (truncated) return counters.imported > 0 ? "partial" : "failed";
  if (counters.failed === 0) return "success";
  return counters.imported > 0 ? "partial" : "failed";
}
