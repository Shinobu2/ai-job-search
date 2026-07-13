import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { discoverFreehire, type FreehireSourceConfig } from "../../packages/search/src/freehire";

const workspace = {
  profile: {
    constraints: { night_shifts: { value: "unknown", verification_status: "unknown", provenance: [] }, continuous_heavy_work: { value: "unknown", verification_status: "unknown", provenance: [] } },
    transport: { has_car: { value: null, verification_status: "unknown", provenance: [] } },
    languages: { english: { value: null, verification_status: "unknown", provenance: [] }, german: { value: null, verification_status: "unknown", provenance: [] } },
    compensation: { net_monthly_estimate: { value: null, verification_status: "unknown", provenance: [] } },
  },
  evidence: { records: [] },
  "document-pack": {}, search: {}, "auto-apply": {},
};

const source: FreehireSourceConfig = {
  id: "freehire", enabled: true, mode: "read_import_evaluate" as const, country: "DE",
  cities: ["Frankfurt", "Eschborn"], keywords: ["data center technician"], max_pages: 1, page_size: 5,
};

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function freehireJob(public_slug: string) {
  return {
    public_slug,
    title: `Data Center Technician ${public_slug}`,
    company: "Fixture DC",
    location: "Frankfurt, Germany",
    url: `https://jobs.example/${public_slug}`,
    description: "Skills: hardware replacement\nShift: day",
    skills: ["Hardware"],
    regions: ["eu"],
    countries: ["DE"],
    cities: ["Frankfurt"],
    posted_at: "2026-07-12",
    created_at: "2026-07-12",
    enrichment: {},
  };
}

test("FreeHire discovery bounds configured reads, preserves public identity, and reuses existing jobs", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  const fetchFixture = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/search?")) {
      return response({ data: [
        { public_slug: "northstar-dct", title: "Data Center Technician", company: "NorthStar", location: "Frankfurt, Germany", url: "https://jobs.example/northstar-dct", description: "ignored search summary", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} },
        { public_slug: "orbit-dct", title: "Data Center Technician II", company: "Orbit", location: "Eschborn, Germany", url: "https://jobs.example/orbit-dct", description: "ignored search summary", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Eschborn"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} },
      ], meta: { total: 2 } });
    }
    if (url.endsWith("/northstar-dct")) {
      return response({ data: { public_slug: "northstar-dct", title: "Data Center Technician", company: "NorthStar", location: "Frankfurt, Germany", url: "https://jobs.example/northstar-dct", description: "<p>Skills: hardware replacement</p><p>Shift: day</p>", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} } });
    }
    if (url.endsWith("/orbit-dct")) {
      return response({ data: { public_slug: "orbit-dct", title: "Data Center Technician II", company: "Orbit", location: "Eschborn, Germany", url: "https://jobs.example/orbit-dct", description: "<p>Skills: hardware replacement</p><p>Shift: day</p>", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Eschborn"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchFixture;
  try {
    const repository = new StorageRepository(db);
    const first = await discoverFreehire(source, repository, workspace as never, { asOf: "2026-07-12" });
    const second = await discoverFreehire(source, repository, workspace as never, { asOf: "2026-07-12" });

    expect(requested.filter((url) => url.includes("/search?")).length).toBe(4);
    expect(requested.filter((url) => url.includes("/search?")).every((url) => url.includes("countries=DE"))).toBe(true);
    expect(requested.find((url) => url.includes("/search?"))).toContain("cities=Frankfurt");
    expect(first.jobs).toHaveLength(2);
    expect(first.jobs[0]).toMatchObject({ sourceId: "freehire:northstar-dct", stableSourceId: "freehire:northstar-dct", sourceUrl: "https://jobs.example/northstar-dct", reused: false, title: "Data Center Technician", actionable: true, logicalVacancyId: expect.stringContaining("vacancy_"), version: 1 });
    expect(second.jobs.every((result) => result.reused)).toBe(true);
    expect(first.status).toBe("success");
    expect(first.scope).toEqual({ planned: 2, completed: 2, failed: 0 });
    expect(first.counters).toEqual({ searched: 2, detailed: 2, imported: 2, skipped: 0, failed: 0 });
    expect(first.diagnostics).toEqual([]);
    const stored = db.query("SELECT source_locator, supplied_url, raw_content FROM job_sources").get() as { source_locator: string; supplied_url: string; raw_content: string };
    expect(stored).toMatchObject({ source_locator: "source-id:freehire:northstar-dct", supplied_url: "https://jobs.example/northstar-dct" });
    expect(stored.raw_content).toContain("hardware replacement");
    expect(db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get()).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM extracted_requirements").get()).toEqual({ count: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire discovery uses the fixed HTTPS endpoint and refuses redirects", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const requested: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const originalBaseUrl = process.env.FREEHIRE_API_URL;
  const originalFetch = globalThis.fetch;
  process.env.FREEHIRE_API_URL = "https://untrusted.example";
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    requested.push({ url: String(input), redirect: init?.redirect });
    return response({ data: [] });
  }) as typeof fetch;
  try {
    await discoverFreehire(source, new StorageRepository(db), workspace as never, { asOf: "2026-07-12" });

    expect(requested).toEqual([
      { url: "https://freehire.dev/api/v1/jobs/search?q=data+center+technician&limit=5&offset=0&semantic_ratio=0&countries=DE&cities=Frankfurt", redirect: "error" },
      { url: "https://freehire.dev/api/v1/jobs/search?q=data+center+technician&limit=5&offset=0&semantic_ratio=0&countries=DE&cities=Eschborn", redirect: "error" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.FREEHIRE_API_URL;
    else process.env.FREEHIRE_API_URL = originalBaseUrl;
    db.close();
  }
});

test("FreeHire discovery deduplicates public slugs across keyword queries and pages", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const fixtures = Object.fromEntries(["shared", "network-one", "network-two", "data-center-one"].map((slug) => [slug, freehireJob(slug)]));
  const searchRequests: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) {
      searchRequests.push(url.toString());
      const key = `${url.searchParams.get("q")}:${url.searchParams.get("offset")}`;
      const pages: Record<string, string[]> = {
        "network:0": ["shared", "network-one"],
        "network:2": ["shared", "network-two"],
        "data-center:0": ["shared", "data-center-one"],
        "data-center:2": [],
      };
      return response({ data: (pages[key] ?? []).map((slug) => fixtures[slug]) });
    }
    const slug = url.pathname.split("/").at(-1) as string;
    return response({ data: fixtures[slug] });
  }) as typeof fetch;
  try {
    const results = await discoverFreehire(
      { ...source, keywords: ["network", "data-center"], max_pages: 2, page_size: 2 },
      new StorageRepository(db),
      workspace as never,
      { asOf: "2026-07-12" },
    );

    expect(searchRequests.map((value) => {
      const url = new URL(value);
      return `${url.searchParams.get("q")}:${url.searchParams.get("cities")}:${url.searchParams.get("offset")}`;
    })).toEqual([
      "network:Frankfurt:0", "network:Eschborn:0", "data-center:Frankfurt:0", "data-center:Eschborn:0",
      "network:Frankfurt:2", "network:Eschborn:2", "data-center:Frankfurt:2", "data-center:Eschborn:2",
    ]);
    expect(results.jobs.map((result) => result.sourceId).sort()).toEqual([
      "freehire:data-center-one",
      "freehire:network-one",
      "freehire:network-two",
      "freehire:shared",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire discovery caps fixture imports at 50 jobs", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const fixtures = Array.from({ length: 51 }, (_, index) => freehireJob(`cap-${index}`));
  let detailRequests = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) return response({ data: fixtures });
    detailRequests += 1;
    return response({ data: fixtures.find((job) => url.pathname.endsWith(`/${job.public_slug}`)) });
  }) as typeof fetch;
  try {
    const results = await discoverFreehire(
      { ...source, keywords: ["cap"], max_pages: 2, page_size: 60 },
      new StorageRepository(db),
      workspace as never,
      { asOf: "2026-07-12" },
    );

    expect(results.jobs).toHaveLength(50);
    expect(detailRequests).toBe(50);
    expect(results.jobs.some((result) => result.sourceId === "freehire:cap-50")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire preserves good jobs and records a terminal detail outage as a partial run", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const good = freehireJob("good");
  const bad = freehireJob("bad");
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) return response({ data: [good, bad] });
    if (url.pathname.endsWith("/good")) return response({ data: good });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const batch = await discoverFreehire(
      { ...source, cities: ["Frankfurt"] }, new StorageRepository(db), workspace as never,
      { asOf: "2026-07-12", sleep: async () => {} },
    );

    expect(batch.jobs.map((job) => job.sourceId)).toEqual(["freehire:good"]);
    expect(batch.status).toBe("partial");
    expect(batch.counters).toEqual({ searched: 1, detailed: 2, imported: 1, skipped: 0, failed: 1 });
    expect(batch.diagnostics).toEqual([expect.objectContaining({ stage: "detail", locator: "bad", code: "http_503", transient: true })]);
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "partial" });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_observations").get()).toEqual({ count: 1 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire retries transient search failures twice but never retries ordinary 4xx", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const delays: number[] = [];
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) return new Response("busy", { status: 429 });
    if (attempts === 2) return new Response("down", { status: 500 });
    return response({ data: [] });
  }) as unknown as typeof fetch;
  try {
    const batch = await discoverFreehire(
      { ...source, cities: ["Frankfurt"] }, new StorageRepository(db), workspace as never,
      { sleep: async (delay) => { delays.push(delay); } },
    );
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(batch.counters.searched).toBe(1);
    expect(batch.diagnostics).toEqual([]);
  } finally {
    globalThis.fetch = (async () => { attempts += 1; return new Response("bad request", { status: 400 }); }) as unknown as typeof fetch;
    const failed = await discoverFreehire(
      { ...source, cities: ["Frankfurt"] }, new StorageRepository(db), workspace as never,
      { sleep: async () => { throw new Error("must not sleep"); } },
    );
    expect(attempts).toBe(4);
    expect(failed.diagnostics).toEqual([expect.objectContaining({ stage: "search", code: "http_400", transient: false })]);
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire treats malformed JSON as a parse failure instead of an empty success", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{broken", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    const batch = await discoverFreehire({ ...source, cities: ["Frankfurt"] }, new StorageRepository(db), workspace as never);
    expect(batch.jobs).toEqual([]);
    expect(batch.status).toBe("failed");
    expect(batch.counters.failed).toBe(1);
    expect(batch.diagnostics).toEqual([expect.objectContaining({ stage: "parse", code: "invalid_json", transient: false })]);
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "failed" });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire can import a reused snapshot without evaluating it and uses injected ledger timestamps", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const fixture = freehireJob("metadata");
  globalThis.fetch = (async (input: string | URL) => response({ data: String(input).includes("/search?") ? [fixture] : fixture })) as typeof fetch;
  try {
    const repository = new StorageRepository(db);
    const first = await discoverFreehire({ ...source, cities: ["Frankfurt"] }, repository, workspace as never, { now: () => "2026-07-13T10:00:00.000Z" });
    const evaluations = db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get();
    const second = await discoverFreehire({ ...source, cities: ["Frankfurt"] }, repository, workspace as never, {
      evaluate: false,
      now: () => "2026-07-13T11:00:00.000Z",
    });
    expect(first.jobs[0]?.evaluation).toBeDefined();
    expect(second.jobs[0]).toMatchObject({ reused: true, evaluation: undefined, logicalVacancyId: first.jobs[0]?.logicalVacancyId, version: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get()).toEqual(evaluations);
    expect(db.query("SELECT started_at AS startedAt, finished_at AS finishedAt FROM discovery_runs WHERE started_at = '2026-07-13T11:00:00.000Z'").get()).toEqual({
      startedAt: "2026-07-13T11:00:00.000Z", finishedAt: "2026-07-13T11:00:00.000Z",
    });
    expect(db.query("SELECT observed_at AS observedAt FROM discovery_observations WHERE run_id = (SELECT id FROM discovery_runs WHERE started_at = '2026-07-13T11:00:00.000Z')").get()).toEqual({ observedAt: "2026-07-13T11:00:00.000Z" });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_runs").get()).toEqual({ count: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire imports and observes out-of-area and unknown locations before marking actionability", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const outside = { ...freehireJob("outside"), location: "Munich, Germany", cities: ["Munich"] };
  const unknown = { ...freehireJob("unknown"), location: null, cities: [] };
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) return response({ data: [outside, unknown] });
    return response({ data: url.pathname.endsWith("/outside") ? outside : unknown });
  }) as typeof fetch;
  try {
    const batch = await discoverFreehire({ ...source, cities: ["Frankfurt"] }, new StorageRepository(db), workspace as never);
    expect(batch.jobs.map(({ sourceId, actionable }) => ({ sourceId, actionable }))).toEqual([
      { sourceId: "freehire:outside", actionable: false },
      { sourceId: "freehire:unknown", actionable: true },
    ]);
    expect(batch.counters).toMatchObject({ imported: 2, skipped: 1, failed: 0 });
    expect(batch.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["out_of_area", "location_unknown"]);
    expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_observations").get()).toEqual({ count: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("FreeHire discovery refuses disabled or non-read configuration before network access", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    await expect(discoverFreehire({ ...source, enabled: false }, new StorageRepository(db), workspace as never)).rejects.toThrow("disabled");
    await expect(discoverFreehire({ ...source, mode: "submit" as never }, new StorageRepository(db), workspace as never)).rejects.toThrow("read_import_evaluate");
  } finally {
    db.close();
  }
});
