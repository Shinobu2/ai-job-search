import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { discoverJobsuche, type JobsucheSourceConfig } from "../../packages/search/src/jobsuche";

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

const source: JobsucheSourceConfig = {
  id: "jobsuche", enabled: true, mode: "read_import_evaluate", country: "DE",
  cities: ["Frankfurt"], keywords: ["data center technician"], max_pages: 1, page_size: 5,
};

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("Jobsuche reads bounded official search and details, then preserves refnr, source URL, and raw detail", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const requested: Array<{ url: string; headers: Headers; redirect: RequestRedirect | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (url.includes("/pc/v6/jobs?")) {
      return response({ ergebnisliste: [{ referenznummer: "expired-ref", stellenangebotsTitel: "Expired listing" }, {
        referenznummer: "10001-1002716922-S", stellenangebotsTitel: "Data Center Technician", firma: "Fixture DC",
        stellenlokationen: [{ adresse: { ort: "Frankfurt", land: "Deutschland" } }], externeUrl: "https://jobs.example/dct",
      }] });
    }
    if (url.endsWith("/MTAwMDEtMTAwMjcxNjkyMi1T")) {
      return response({
        referenznummer: "10001-1002716922-S", stellenangebotsTitel: "Data Center Technician",
        firma: "Fixture DC", stellenlokationen: [{ adresse: { ort: "Frankfurt", land: "Deutschland" } }],
        stellenangebotsBeschreibung: "Skills: hardware replacement\nMust work night shifts and perform physically demanding work over extended periods.",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const repository = new StorageRepository(db);
    const first = await discoverJobsuche(source, repository, workspace as never, { asOf: "2026-07-12" });
    const second = await discoverJobsuche(source, repository, workspace as never, { asOf: "2026-07-12" });

    expect(requested).toHaveLength(6);
    expect(requested.filter((request) => request.url.includes("/pc/v6/jobs?")).every((request) => request.url.includes("was=data+center+technician") && request.url.includes("wo=Frankfurt") && request.url.includes("page=1") && request.url.includes("size=5"))).toBe(true);
    expect(requested.every((request) => request.headers.get("X-API-Key") === "jobboerse-jobsuche" && request.redirect === "error")).toBe(true);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({ sourceId: "jobsuche:10001-1002716922-S", stableSourceId: "jobsuche:10001-1002716922-S", sourceUrl: "https://jobs.example/dct", reused: false, title: "Data Center Technician", actionable: true, logicalVacancyId: expect.stringContaining("vacancy_"), version: 1 });
    expect(second.jobs[0]?.reused).toBe(true);
    expect(first.status).toBe("partial");
    expect(first.scope).toEqual({ planned: 1, completed: 1, failed: 0 });
    expect(first.counters).toEqual({ searched: 1, detailed: 2, imported: 1, skipped: 0, failed: 1 });
    const stored = db.query("SELECT source_locator, supplied_url, raw_content FROM job_sources").get() as { source_locator: string; supplied_url: string; raw_content: string };
    expect(stored).toMatchObject({ source_locator: "source-id:jobsuche:10001-1002716922-S", supplied_url: "https://jobs.example/dct" });
    expect(stored.raw_content).toContain("10001-1002716922-S");
    expect(stored.raw_content).toContain("hardware replacement");
    expect(stored.raw_content).toContain("Shift: night or rotating shifts required");
    expect(stored.raw_content).toContain("Skills: PC hardware, hardware troubleshooting");
    expect(first.jobs[0]?.evaluation?.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "VERIFY" }));
    expect(requested.some((entry) => entry.url.includes(encodeURIComponent(Buffer.from("expired-ref").toString("base64"))))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche completes every keyword-city page round before starting the next page", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const order: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/jobs")) {
      order.push(`${url.searchParams.get("was")}:${url.searchParams.get("wo")}:${url.searchParams.get("page")}`);
      return response({ ergebnisliste: url.searchParams.get("page") === "1" ? [{ referenznummer: `${url.searchParams.get("was")}-${url.searchParams.get("wo")}` }] : [] });
    }
    const ref = Buffer.from(decodeURIComponent(url.pathname.split("/").at(-1) as string), "base64").toString("utf8");
    return response({ referenznummer: ref, stellenangebotsTitel: ref, firma: "Fixture", arbeitsorte: [{ ort: ref.endsWith("Frankfurt") ? "Frankfurt" : "Eschborn" }], stellenangebotsBeschreibung: "Skills: hardware" });
  }) as unknown as typeof fetch;
  try {
    const batch = await discoverJobsuche(
      { ...source, keywords: ["network", "data"], cities: ["Frankfurt", "Eschborn"], max_pages: 2, page_size: 1 },
      new StorageRepository(db), workspace as never,
    );
    expect(order).toEqual([
      "network:Frankfurt:1", "network:Eschborn:1", "data:Frankfurt:1", "data:Eschborn:1",
      "network:Frankfurt:2", "network:Eschborn:2", "data:Frankfurt:2", "data:Eschborn:2",
    ]);
    expect(batch.counters).toMatchObject({ searched: 8, detailed: 4, imported: 4, failed: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche preserves good details and diagnoses one terminal detail outage", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/pc/v6/jobs?")) return response({ ergebnisliste: [{ referenznummer: "good" }, { referenznummer: "bad" }] });
    if (url.endsWith(`/${encodeURIComponent(Buffer.from("good").toString("base64"))}`)) return response({ referenznummer: "good", stellenangebotsTitel: "Technician", firma: "Fixture", arbeitsorte: [{ ort: "Frankfurt" }] });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const batch = await discoverJobsuche(source, new StorageRepository(db), workspace as never, { sleep: async () => {} });
    expect(batch.jobs.map((job) => job.sourceId)).toEqual(["jobsuche:good"]);
    expect(batch.counters).toEqual({ searched: 1, detailed: 2, imported: 1, skipped: 0, failed: 1 });
    expect(batch.diagnostics).toEqual([expect.objectContaining({ stage: "detail", locator: "bad", code: "http_503", transient: true })]);
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "partial" });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche retries 429, 5xx, and transient network failures with the bounded delays", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const delays: number[] = [];
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("network reset");
    if (attempts === 2) return new Response("busy", { status: 429 });
    return response({ ergebnisliste: [] });
  }) as unknown as typeof fetch;
  try {
    const batch = await discoverJobsuche(source, new StorageRepository(db), workspace as never, { sleep: async (delay) => { delays.push(delay); } });
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(batch.diagnostics).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche treats malformed JSON as a parse failure and does not retry it", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => { attempts += 1; return new Response("{broken", { status: 200 }); }) as unknown as typeof fetch;
  try {
    const batch = await discoverJobsuche(source, new StorageRepository(db), workspace as never, { sleep: async () => { throw new Error("parse failures must not retry"); } });
    expect(attempts).toBe(1);
    expect(batch.jobs).toEqual([]);
    expect(batch.diagnostics).toEqual([expect.objectContaining({ stage: "parse", locator: expect.stringContaining("page=1"), code: "invalid_json", transient: false })]);
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "failed" });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_runs WHERE status = 'running'").get()).toEqual({ count: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche invalid records are diagnosed, fail all-invalid batches, and make mixed batches partial", async () => {
  for (const mixed of [false, true]) {
    const db = openDatabase(":memory:");
    migrate(db);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/pc/v6/jobs?")) return response({ ergebnisliste: mixed ? [{ beruf: "missing reference" }, { referenznummer: "good" }] : [{ beruf: "missing reference" }] });
      return response({ referenznummer: "good", stellenangebotsTitel: "Technician", firma: "Fixture", arbeitsorte: [{ ort: "Frankfurt" }] });
    }) as typeof fetch;
    try {
      const batch = await discoverJobsuche(source, new StorageRepository(db), workspace as never);
      expect(batch.status).toBe(mixed ? "partial" : "failed");
      expect(batch.jobs).toHaveLength(mixed ? 1 : 0);
      expect(batch.counters.failed).toBe(1);
      expect(batch.diagnostics).toContainEqual(expect.objectContaining({ stage: "parse", code: "invalid_record" }));
      expect(db.query("SELECT COUNT(*) AS count FROM discovery_runs WHERE status = 'running'").get()).toEqual({ count: 0 });
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  }
});

test("Jobsuche empty planned scopes fail diagnostically without network access", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
  try {
    const batch = await discoverJobsuche({ ...source, cities: [] }, new StorageRepository(db), workspace as never);
    expect(batch.status).toBe("failed");
    expect(batch.diagnostics).toEqual([expect.objectContaining({ code: "empty_scope" })]);
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "failed" });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche stores out-of-area and unknown-location jobs but marks only the former non-actionable", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/pc/v6/jobs?")) return response({ ergebnisliste: [{ referenznummer: "outside" }, { referenznummer: "unknown" }] });
    const ref = Buffer.from(decodeURIComponent(url.split("/").at(-1) as string), "base64").toString("utf8");
    return response({ referenznummer: ref, stellenangebotsTitel: ref, firma: "Fixture", arbeitsorte: ref === "outside" ? [{ ort: "Munich" }] : undefined });
  }) as typeof fetch;
  try {
    const batch = await discoverJobsuche(source, new StorageRepository(db), workspace as never);
    expect(batch.jobs.map(({ sourceId, actionable }) => ({ sourceId, actionable }))).toEqual([
      { sourceId: "jobsuche:outside", actionable: false },
      { sourceId: "jobsuche:unknown", actionable: true },
    ]);
    expect(batch.diagnostics.map((entry) => entry.code)).toEqual(["out_of_area", "location_unknown"]);
    expect(batch.counters).toMatchObject({ imported: 2, skipped: 1, failed: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_observations").get()).toEqual({ count: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche shift normalization respects explicit negation and rotation phrases", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const originalFetch = globalThis.fetch;
  const descriptions: Record<string, string> = {
    no_night: "Regelarbeitszeit, keine Nachtschicht.",
    night_work: "Nachtarbeit ist erforderlich.",
    rotating: "Arbeit in Wechselschicht.",
    always: "Betrieb und Rufbereitschaft 24/7.",
  };
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/pc/v6/jobs?")) return response({ ergebnisliste: Object.keys(descriptions).map((referenznummer) => ({ referenznummer })) });
    const ref = Buffer.from(decodeURIComponent(url.split("/").at(-1) as string), "base64").toString("utf8");
    return response({ referenznummer: ref, stellenangebotsTitel: ref, firma: "Fixture", arbeitsorte: [{ ort: "Frankfurt" }], stellenangebotsBeschreibung: descriptions[ref] });
  }) as typeof fetch;
  try {
    await discoverJobsuche(source, new StorageRepository(db), workspace as never);
    const rows = db.query("SELECT source_locator AS locator, raw_content AS raw FROM job_sources ORDER BY source_locator").all() as Array<{ locator: string; raw: string }>;
    const raw = Object.fromEntries(rows.map((row) => [row.locator, row.raw]));
    expect(raw["source-id:jobsuche:no_night"]).toContain("Shift: day/no night requirement");
    for (const ref of ["night_work", "rotating", "always"]) {
      expect(raw[`source-id:jobsuche:${ref}`]).toContain("Shift: night or rotating shifts required");
    }
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Jobsuche refuses disabled or non-read configuration before network access", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    await expect(discoverJobsuche({ ...source, enabled: false }, new StorageRepository(db), workspace as never)).rejects.toThrow("disabled");
    await expect(discoverJobsuche({ ...source, mode: "submit" as never }, new StorageRepository(db), workspace as never)).rejects.toThrow("read_import_evaluate");
  } finally {
    db.close();
  }
});
