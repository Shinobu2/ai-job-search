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

test("FreeHire discovery bounds configured reads, preserves public identity, and reuses existing jobs", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const requested: string[] = [];
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
  }) as typeof fetch;
  try {
    const repository = new StorageRepository(db);
    const first = await discoverFreehire(source, repository, workspace as never, { fetch: fetchFixture, baseUrl: "https://freehire.test", asOf: "2026-07-12" });
    const second = await discoverFreehire(source, repository, workspace as never, { fetch: fetchFixture, baseUrl: "https://freehire.test", asOf: "2026-07-12" });

    expect(requested.filter((url) => url.includes("/search?")).length).toBe(2);
    expect(requested.filter((url) => url.includes("/search?")).every((url) => url.includes("countries=DE"))).toBe(true);
    expect(requested.find((url) => url.includes("/search?"))).toContain("cities=Frankfurt");
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ sourceId: "freehire:northstar-dct", sourceUrl: "https://jobs.example/northstar-dct", reused: false, title: "Data Center Technician" });
    expect(second.every((result) => result.reused)).toBe(true);
    const stored = db.query("SELECT source_locator, supplied_url, raw_content FROM job_sources").get() as { source_locator: string; supplied_url: string; raw_content: string };
    expect(stored).toMatchObject({ source_locator: "source-id:freehire:northstar-dct", supplied_url: "https://jobs.example/northstar-dct" });
    expect(stored.raw_content).toContain("hardware replacement");
    expect(db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get()).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM extracted_requirements").get()).toEqual({ count: 2 });
  } finally {
    db.close();
  }
});

test("FreeHire discovery refuses disabled or non-read configuration before network access", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    await expect(discoverFreehire({ ...source, enabled: false }, new StorageRepository(db), workspace as never, { fetch: async () => { throw new Error("must not fetch"); } })).rejects.toThrow("disabled");
    await expect(discoverFreehire({ ...source, mode: "submit" as never }, new StorageRepository(db), workspace as never, { fetch: async () => { throw new Error("must not fetch"); } })).rejects.toThrow("read_import_evaluate");
  } finally {
    db.close();
  }
});
