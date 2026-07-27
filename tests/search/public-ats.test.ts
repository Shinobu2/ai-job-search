import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { discoverGreenhouseEmployer } from "../../packages/search/src/greenhouse";
import { discoverLeverEmployer } from "../../packages/search/src/lever";

const workspace = {
  profile: {}, evidence: { records: [] }, "document-pack": {}, search: {}, "auto-apply": {},
};

test("Greenhouse public board imports an exact live posting", async () => {
  const db = openDatabase(":memory:"); migrate(db);
  try {
    const batch = await discoverGreenhouseEmployer(
      { id: "hellofresh", name: "HelloFresh", cities: ["Frankfurt"], career_url: "https://job-boards.greenhouse.io/hellofresh", ats: "greenhouse", policy: "public_ats_endpoint", enabled: true },
      new StorageRepository(db), workspace as never,
      {
        evaluate: false,
        now: () => "2026-07-26T10:00:00.000Z",
        fetcher: (async () => Response.json({ jobs: [{ id: 42, title: "Level 1 Support", location: { name: "Frankfurt" }, absolute_url: "https://job-boards.greenhouse.io/hellofresh/jobs/42", language: "en", content: "<p>Hardware support</p>" }] })) as unknown as typeof fetch,
      },
    );
    expect(batch.jobs).toEqual([expect.objectContaining({ title: "Level 1 Support", sourceUrl: "https://job-boards.greenhouse.io/hellofresh/jobs/42", actionable: true })]);
  } finally { db.close(); }
});

test("Lever public postings import an exact live posting", async () => {
  const db = openDatabase(":memory:"); migrate(db);
  try {
    const batch = await discoverLeverEmployer(
      { id: "crytek", name: "Crytek", cities: ["Frankfurt"], career_url: "https://jobs.lever.co/crytek", ats: "lever", policy: "public_ats_endpoint", enabled: true },
      new StorageRepository(db), workspace as never,
      {
        evaluate: false,
        now: () => "2026-07-26T11:00:00.000Z",
        fetcher: (async () => Response.json([{ id: "abc", text: "IT Support", categories: { location: "Frankfurt" }, descriptionPlain: "Internal support", hostedUrl: "https://jobs.lever.co/crytek/abc" }])) as unknown as typeof fetch,
      },
    );
    expect(batch.jobs).toEqual([expect.objectContaining({ title: "IT Support", sourceUrl: "https://jobs.lever.co/crytek/abc", actionable: true })]);
  } finally { db.close(); }
});
