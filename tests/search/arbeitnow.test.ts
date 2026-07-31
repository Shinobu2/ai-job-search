import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { discoverArbeitnow, type ArbeitnowSourceConfig } from "../../packages/search/src/arbeitnow";

const workspace = {
  profile: {}, evidence: { records: [] }, "document-pack": {}, search: {}, "auto-apply": {},
};

const source: ArbeitnowSourceConfig = {
  id: "arbeitnow",
  track: "datacenter",
  enabled: true,
  mode: "read_import_evaluate",
  country: "DE",
  cities: ["Frankfurt", "Eschborn"],
  keywords: ["data center technician", "NOC technician"],
  max_pages: 2,
  page_size: 20,
};

function job(slug: string, title: string, location: string | null) {
  return {
    slug,
    company_name: "Fixture GmbH",
    title,
    description: "<p>Replace <strong>server hardware</strong>.</p>",
    remote: false,
    url: `https://www.arbeitnow.com/jobs/${slug}`,
    tags: ["IT"],
    job_types: ["Full-time"],
    location,
    created_at: 1785439826,
  };
}

test("paginates Arbeitnow, filters locally by keyword and city, and deduplicates", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("?page=1")) {
      return Response.json({
        data: [
          job("frankfurt-dct", "Data Center Technician", "Frankfurt am Main"),
          job("unrelated", "Accountant", "Frankfurt"),
          job("wrong-city", "NOC Technician", "Berlin"),
        ],
        links: { next: "https://www.arbeitnow.com/api/job-board-api?page=2" },
        meta: { current_page: 1, per_page: 175 },
      });
    }
    if (url.endsWith("?page=2")) {
      return Response.json({
        data: [
          job("frankfurt-dct", "Data Center Technician", "Frankfurt am Main"),
          job("eschborn-noc", "NOC Technician", "Eschborn"),
        ],
        links: { next: null },
        meta: { current_page: 2, per_page: 175 },
      });
    }
    throw new Error(`Unexpected Arbeitnow URL: ${url}`);
  }) as unknown as typeof fetch;

  try {
    const batch = await discoverArbeitnow(source, new StorageRepository(db), workspace as never, {
      fetcher,
      evaluate: false,
      now: () => "2026-07-30T15:00:00.000Z",
    });
    expect(requests).toEqual([
      "https://www.arbeitnow.com/api/job-board-api?page=1",
      "https://www.arbeitnow.com/api/job-board-api?page=2",
    ]);
    expect(batch).toMatchObject({
      sourceId: "arbeitnow:datacenter",
      track: "datacenter",
      status: "success",
      scope: { planned: 2, completed: 2, failed: 0 },
      counters: { searched: 2, detailed: 2, imported: 2, skipped: 3, failed: 0 },
    });
    expect(batch.jobs.map((row) => row.title)).toEqual(["Data Center Technician", "NOC Technician"]);
    expect(batch.jobs.every((row) => row.actionable)).toBe(true);
    const stored = db.query("SELECT source_type, raw_content FROM job_sources ORDER BY source_locator").all() as Array<{ source_type: string; raw_content: string }>;
    expect(stored.every((row) => row.source_type === "arbeitnow_public_api")).toBe(true);
    expect(stored[0].raw_content).toContain("Replace server hardware.");
    expect(stored[0].raw_content).not.toContain("<strong>");
  } finally {
    db.close();
  }
});

test("keeps keyword matches with an unknown location and diagnoses them", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const batch = await discoverArbeitnow(
      { ...source, max_pages: 1 },
      new StorageRepository(db),
      workspace as never,
      {
        evaluate: false,
        now: () => "2026-07-30T15:30:00.000Z",
        fetcher: (async () => Response.json({
          data: [
            job("unknown-city", "NOC Technician", null),
            job("outside-city", "NOC Technician", "Berlin"),
          ],
          links: { next: null },
          meta: { current_page: 1, per_page: 175 },
        })) as unknown as typeof fetch,
      },
    );

    expect(batch.jobs).toEqual([
      expect.objectContaining({ title: "NOC Technician", location: null, actionable: true }),
    ]);
    expect(batch.diagnostics).toContainEqual(expect.objectContaining({
      stage: "parse",
      locator: "arbeitnow:unknown-city",
      code: "location_unknown",
    }));
    expect(batch.counters).toMatchObject({ imported: 1, skipped: 1, failed: 0 });
  } finally {
    db.close();
  }
});

test("finishes an invalid Arbeitnow envelope as a diagnostic failure", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const batch = await discoverArbeitnow(source, new StorageRepository(db), workspace as never, {
      evaluate: false,
      now: () => "2026-07-30T16:00:00.000Z",
      fetcher: (async () => Response.json({ data: "not-an-array" })) as unknown as typeof fetch,
    });
    expect(batch).toMatchObject({
      status: "failed",
      jobs: [],
      counters: { searched: 1, imported: 0, failed: 1 },
      diagnostics: [expect.objectContaining({ code: "invalid_envelope" })],
    });
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "failed" });
  } finally {
    db.close();
  }
});
