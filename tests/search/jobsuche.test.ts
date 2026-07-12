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
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sourceId: "jobsuche:10001-1002716922-S", sourceUrl: "https://jobs.example/dct", reused: false, title: "Data Center Technician" });
    expect(second[0]?.reused).toBe(true);
    const stored = db.query("SELECT source_locator, supplied_url, raw_content FROM job_sources").get() as { source_locator: string; supplied_url: string; raw_content: string };
    expect(stored).toMatchObject({ source_locator: "source-id:jobsuche:10001-1002716922-S", supplied_url: "https://jobs.example/dct" });
    expect(stored.raw_content).toContain("10001-1002716922-S");
    expect(stored.raw_content).toContain("hardware replacement");
    expect(stored.raw_content).toContain("Shift: night or rotating shifts required");
    expect(stored.raw_content).toContain("Skills: PC hardware, hardware troubleshooting");
    expect(first[0]?.evaluation.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "VERIFY" }));
    expect(requested.some((entry) => entry.url.includes(encodeURIComponent(Buffer.from("expired-ref").toString("base64"))))).toBe(true);
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
