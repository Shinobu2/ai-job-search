import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import type { EmployerRegistryEntry } from "../../packages/search/src/employer-registry";
import { discoverAtsEmployer } from "../../packages/search/src/ats";

const workspace = {
  profile: {}, evidence: { records: [] }, "document-pack": {}, search: {}, "auto-apply": {},
};

function employer(ats: string, careerUrl: string): EmployerRegistryEntry {
  return {
    id: `fixture-${ats}`,
    name: `Fixture ${ats}`,
    track: "support",
    cities: ["Frankfurt"],
    career_url: careerUrl,
    ats,
    policy: "public_ats_endpoint",
    enabled: true,
  };
}

function repository() {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, storage: new StorageRepository(db) };
}

test("normalizes live-shaped Ashby, SmartRecruiters, and Recruitee records", async () => {
  const fixture = repository();
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("posting-api/job-board/fixture-ashby")) {
      return Response.json({
        jobs: [{
          id: "ashby-1",
          title: "Data Center Technician",
          location: "Frankfurt, Germany",
          descriptionPlain: "Replace server hardware.",
          descriptionHtml: "<p>Replace server hardware.</p>",
          jobUrl: "https://jobs.ashbyhq.com/fixture-ashby/ashby-1",
          applyUrl: "https://jobs.ashbyhq.com/fixture-ashby/ashby-1/application",
          publishedAt: "2026-07-20T10:00:00.000Z",
        }],
        apiVersion: "1",
      });
    }
    if (url.endsWith("/companies/FixtureSmart/postings")) {
      return Response.json({
        offset: 0,
        limit: 100,
        totalFound: 1,
        content: [{
          id: "smart-1",
          name: "IT Support Specialist",
          company: { identifier: "fixturesmart", name: "Fixture Smart GmbH" },
          location: { city: "Frankfurt", region: "Hesse", country: "de", fullLocation: "Frankfurt, Hesse, Germany" },
          releasedDate: "2026-07-19T10:00:00.000Z",
          ref: "https://api.smartrecruiters.com/v1/companies/FixtureSmart/postings/smart-1",
        }],
      });
    }
    if (url.endsWith("/companies/FixtureSmart/postings/smart-1")) {
      return Response.json({
        id: "smart-1",
        name: "IT Support Specialist",
        company: { name: "Fixture Smart GmbH" },
        location: { fullLocation: "Frankfurt, Hesse, Germany" },
        postingUrl: "https://jobs.smartrecruiters.com/fixturesmart/smart-1-it-support-specialist",
        applyUrl: "https://jobs.smartrecruiters.com/fixturesmart/smart-1-it-support-specialist?oga=true",
        jobAd: {
          sections: {
            jobDescription: { title: "Job Description", text: "<p>Support workplace devices.</p>" },
            qualifications: { title: "Qualifications", text: "<ul><li>Hardware knowledge</li></ul>" },
          },
        },
      });
    }
    if (url === "https://fixture-recruitee.recruitee.com/api/offers") {
      return Response.json({
        offers: [{
          id: 42,
          title: "NOC Technician",
          company_name: "Fixture Recruitee GmbH",
          location: "Frankfurt, Germany",
          description: "<p>Monitor infrastructure.</p>",
          requirements: "<ul><li>Networking basics</li></ul>",
          careers_url: "https://fixture-recruitee.recruitee.com/o/noc-technician",
          careers_apply_url: "https://fixture-recruitee.recruitee.com/o/noc-technician/c/new",
          published_at: "2026-07-18 10:00:00 UTC",
          updated_at: "2026-07-20 10:00:00 UTC",
        }],
      });
    }
    throw new Error(`Unexpected ATS URL: ${url}`);
  }) as unknown as typeof fetch;

  try {
    const ashby = await discoverAtsEmployer(
      employer("ashby", "https://jobs.ashbyhq.com/fixture-ashby"),
      fixture.storage,
      workspace as never,
      { fetcher, evaluate: false, now: () => "2026-07-30T10:00:00.000Z" },
    );
    const smart = await discoverAtsEmployer(
      employer("smartrecruiters", "https://jobs.smartrecruiters.com/FixtureSmart"),
      fixture.storage,
      workspace as never,
      { fetcher, evaluate: false, now: () => "2026-07-30T11:00:00.000Z" },
    );
    const recruitee = await discoverAtsEmployer(
      employer("recruitee", "https://fixture-recruitee.recruitee.com"),
      fixture.storage,
      workspace as never,
      { fetcher, evaluate: false, now: () => "2026-07-30T12:00:00.000Z" },
    );

    expect(ashby.jobs).toEqual([expect.objectContaining({
      title: "Data Center Technician",
      company: "Fixture ashby",
      location: "Frankfurt, Germany",
      sourceUrl: "https://jobs.ashbyhq.com/fixture-ashby/ashby-1",
    })]);
    expect(smart.jobs).toEqual([expect.objectContaining({
      title: "IT Support Specialist",
      company: "Fixture Smart GmbH",
      location: "Frankfurt, Hesse, Germany",
      sourceUrl: "https://jobs.smartrecruiters.com/fixturesmart/smart-1-it-support-specialist",
    })]);
    expect(recruitee.jobs).toEqual([expect.objectContaining({
      title: "NOC Technician",
      company: "Fixture Recruitee GmbH",
      location: "Frankfurt, Germany",
      sourceUrl: "https://fixture-recruitee.recruitee.com/o/noc-technician",
    })]);
    expect(requests).toContain("https://api.smartrecruiters.com/v1/companies/FixtureSmart/postings/smart-1");
    expect(fixture.db.query("SELECT source_type FROM job_sources ORDER BY source_type").all()).toEqual([
      { source_type: "ashby_public_api" },
      { source_type: "recruitee_public_api" },
      { source_type: "smartrecruiters_public_api" },
    ]);
  } finally {
    fixture.db.close();
  }
});

test("delegates Greenhouse and turns one employer 404 into a failed batch", async () => {
  const fixture = repository();
  try {
    const greenhouse = await discoverAtsEmployer(
      employer("greenhouse", "https://job-boards.greenhouse.io/fixture-greenhouse"),
      fixture.storage,
      workspace as never,
      {
        evaluate: false,
        now: () => "2026-07-30T13:00:00.000Z",
        fetcher: (async () => Response.json({
          jobs: [{
            id: 7,
            title: "Hardware Technician",
            location: { name: "Frankfurt" },
            absolute_url: "https://job-boards.greenhouse.io/fixture-greenhouse/jobs/7",
            content: "<p>Repair hardware</p>",
          }],
        })) as unknown as typeof fetch,
      },
    );
    expect(greenhouse.jobs).toEqual([expect.objectContaining({ title: "Hardware Technician" })]);

    const failed = await discoverAtsEmployer(
      employer("ashby", "https://jobs.ashbyhq.com/missing-board"),
      fixture.storage,
      workspace as never,
      {
        evaluate: false,
        now: () => "2026-07-30T14:00:00.000Z",
        fetcher: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
      },
    );
    expect(failed).toMatchObject({
      status: "failed",
      jobs: [],
      counters: { failed: 1 },
      diagnostics: [expect.objectContaining({ stage: "search", code: "http_403" })],
    });
  } finally {
    fixture.db.close();
  }
});

test("paginates a SmartRecruiters collection before choosing review candidates", async () => {
  const fixture = repository();
  const requests: string[] = [];
  const summary = (id: string, title: string) => ({
    id,
    name: title,
    company: { name: "Fixture Smart GmbH" },
    location: { fullLocation: "Frankfurt, Germany" },
    ref: `https://api.smartrecruiters.com/v1/companies/FixtureSmart/postings/${id}`,
  });
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/companies/FixtureSmart/postings")) {
      return Response.json({ offset: 0, limit: 1, totalFound: 2, content: [summary("one", "First Support Role")] });
    }
    if (url.endsWith("/companies/FixtureSmart/postings?limit=1&offset=1")) {
      return Response.json({ offset: 1, limit: 1, totalFound: 2, content: [summary("two", "Second Support Role")] });
    }
    const id = url.split("/").at(-1) as string;
    return Response.json({
      ...summary(id, id === "one" ? "First Support Role" : "Second Support Role"),
      postingUrl: `https://jobs.smartrecruiters.com/fixturesmart/${id}`,
      applyUrl: `https://jobs.smartrecruiters.com/fixturesmart/${id}?oga=true`,
      jobAd: { sections: { jobDescription: { title: "Job Description", text: "<p>Support hardware.</p>" } } },
    });
  }) as unknown as typeof fetch;

  try {
    const batch = await discoverAtsEmployer(
      employer("smartrecruiters", "https://jobs.smartrecruiters.com/FixtureSmart"),
      fixture.storage,
      workspace as never,
      { fetcher, evaluate: false, now: () => "2026-07-30T15:00:00.000Z" },
    );
    expect(batch.jobs.map((job) => job.title)).toEqual(["First Support Role", "Second Support Role"]);
    expect(batch.counters.searched).toBe(2);
    expect(requests).toContain("https://api.smartrecruiters.com/v1/companies/FixtureSmart/postings?limit=1&offset=1");
  } finally {
    fixture.db.close();
  }
});

test("honors an ATS maxResults budget above twelve", async () => {
  const fixture = repository();
  const jobs = Array.from({ length: 13 }, (_, index) => ({
    id: `ashby-${index + 1}`,
    title: `Support Technician ${index + 1}`,
    location: "Frankfurt, Germany",
    descriptionPlain: "Support workplace hardware.",
    jobUrl: `https://jobs.ashbyhq.com/fixture-ashby/ashby-${index + 1}`,
  }));
  try {
    const batch = await discoverAtsEmployer(
      employer("ashby", "https://jobs.ashbyhq.com/fixture-ashby"),
      fixture.storage,
      workspace as never,
      {
        maxResults: 13,
        evaluate: false,
        now: () => "2026-07-30T16:00:00.000Z",
        fetcher: (async () => Response.json({ jobs, apiVersion: "1" })) as unknown as typeof fetch,
      },
    );

    expect(batch.status).toBe("success");
    expect(batch.jobs).toHaveLength(13);
  } finally {
    fixture.db.close();
  }
});
