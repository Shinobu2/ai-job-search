import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateWorkspaceFile } from "../../packages/core/src/workspace";
import { openDatabase } from "../../packages/storage/src/database";
import { isActionableDiscoveryJob, type DiscoveredJob } from "../../packages/search/src/types";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");
const freehireFetchFixture = join(root, "tests", "search", "freehire-fetch.fixture.ts");
const jobsucheFetchFixture = join(root, "tests", "search", "jobsuche-fetch.fixture.ts");
const personioFetchFixture = join(root, "tests", "search", "personio-fetch.fixture.ts");

function payload(job: unknown) {
  return new Response(JSON.stringify({ data: job }), { headers: { "content-type": "application/json" } });
}

function discoveryJob(overrides: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    id: "job", reused: false, sourceId: "source", stableSourceId: "source", sourceUrl: "https://jobs.example/job",
    title: "Technician", company: "Fixture", location: "Frankfurt", logicalVacancyId: "vacancy", version: 1, actionable: true,
    evaluation: { jobId: "job", archetype: "A", gates: [], mappings: [], fit: 50, survival: null, confidence: "medium", tier: "B", verdict: "PROCEED", fingerprint: "hash" },
    ...overrides,
  };
}

test("actionable discovery requires geography, supported archetype, S/A/B tier, and no blocked gate or verdict", () => {
  expect(isActionableDiscoveryJob(discoveryJob())).toBe(true);
  expect(isActionableDiscoveryJob(discoveryJob({ actionable: false }))).toBe(false);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, tier: "C" } }))).toBe(false);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, archetype: "X" } }))).toBe(false);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, verdict: "BLOCKED" } }))).toBe(false);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, gates: [{ id: "shift", status: "BLOCKED", critical: true, reason: "blocked", facts: [] }] } }))).toBe(false);
});

test("legacy schema-v1 search config remains valid until discovery is configured", () => {
  expect(() => validateWorkspaceFile("search", { schema_version: 1 })).not.toThrow();
});

test("search schema accepts a read-only Jobsuche source without breaking FreeHire configuration", () => {
  expect(() => validateWorkspaceFile("search", {
    schema_version: 1,
    discovery: { sources: [{
      id: "jobsuche", enabled: true, mode: "read_import_evaluate", country: "DE",
      cities: ["Frankfurt"], keywords: ["data center technician"], max_pages: 1, page_size: 5,
    }] },
  })).not.toThrow();
});

test("search freehire prints imported jobs for model review without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { public_slug: "fixture-dct", title: "Data Center Technician", company: "Fixture DC", location: "Frankfurt, Germany", url: "https://jobs.example/fixture-dct", description: "Skills: hardware replacement", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} };
  const excluded = { ...job, public_slug: "fixture-warehouse", title: "Warehouse Operative", url: "https://jobs.example/fixture-warehouse", description: "Warehouse conveyor work", skills: [] };
  const outside = { ...job, public_slug: "fixture-munich", title: "Munich Technician", location: "Munich, Germany", url: "https://jobs.example/fixture-munich", cities: ["Munich"] };
  const failed = { ...job, public_slug: "fixture-failed", title: "Unavailable detail", url: "https://jobs.example/fixture-failed" };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/search")) return payload([job, excluded, outside, failed]);
      if (path.endsWith("/fixture-dct")) return payload(job);
      if (path.endsWith("/fixture-warehouse")) return payload(excluded);
      if (path.endsWith("/fixture-munich")) return payload(outside);
      if (path.endsWith("/fixture-failed")) return new Response("unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, "--preload", freehireFetchFixture, cli, "search", "freehire"], {
      cwd: directory,
      env: { ...process.env, FREEHIRE_TEST_ENDPOINT: server.url.toString() },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("FreeHire discovered: 3 | raw results for model review: 3");
    expect(stdout).toContain("Counters: searched=28 detailed=4 imported=3 skipped=1 failed=1");
    expect(stdout).toContain("[detail] http_503 fixture-failed");
    expect(stdout).toContain("Data Center Technician — Fixture DC");
    expect(stdout).toContain("Warehouse Operative");
    expect(stdout).toContain("Munich Technician");
    expect(stdout).toContain("No application was submitted.");
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 3 }); }
    finally { db.close(); }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search jobsuche prints imported jobs for model review without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-jobsuche-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { referenznummer: "10001-1002716922-S", beruf: "Data Center Technician", arbeitgeber: "Fixture DC", arbeitsort: { ort: "Frankfurt", land: "Deutschland" }, externeUrl: "https://jobs.example/fixture-dct" };
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1\ndiscovery:\n  sources:\n    - id: jobsuche\n      enabled: true\n      mode: read_import_evaluate\n      country: DE\n      cities: [Frankfurt]\n      keywords: [data center technician]\n      max_pages: 1\n      page_size: 5\n`);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/jobs")) return new Response(JSON.stringify({ stellenangebote: [job] }), { headers: { "content-type": "application/json" } });
      if (path.endsWith("/MTAwMDEtMTAwMjcxNjkyMi1T")) return new Response(JSON.stringify({ ...job, stellenangebotsTitel: job.beruf, stellenangebotsBeschreibung: "Skills: hardware replacement\nNachtarbeit ist erforderlich.", arbeitsorte: [job.arbeitsort] }), { headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, "--preload", jobsucheFetchFixture, cli, "search", "jobsuche"], {
      cwd: directory,
      env: { ...process.env, JOBSUCHE_TEST_ENDPOINT: server.url.toString() },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Jobsuche discovered: 1 | raw results for model review: 1");
    expect(stdout).toContain("Counters: searched=1 detailed=1 imported=1 skipped=0 failed=0");
    expect(stdout).toContain("Data Center Technician — Fixture DC");
    expect(stdout).toContain("No application was submitted.");
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 }); }
    finally { db.close(); }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search employers prints imported jobs for model review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-personio-filter-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(`<workzag-jobs>
      <position><id>c</id><name>Data Center Technician</name><office>Frankfurt</office><jobDescriptions><jobDescription><value>Hardware support</value></jobDescription></jobDescriptions></position>
      <position><id>x</id><name>Warehouse Operative</name><office>Frankfurt</office></position>
      <position><id>blocked</id><name>Data Center Technician 24/7</name><office>Frankfurt</office></position>
    </workzag-jobs>`, { status: 200 }),
  });
  try {
    const child = Bun.spawn([process.execPath, "--preload", personioFetchFixture, cli, "search", "employers"], {
      cwd: directory,
      env: { ...process.env, PERSONIO_TEST_ENDPOINT: server.url.toString() },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Employer results for model review: 3");
    expect(stdout).toContain("Data Center Technician — maincubes");
    expect(stdout).toContain("Warehouse Operative — maincubes");
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 3 }); }
    finally { db.close(); }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search employers reports a source outage and still prints the no-submit guarantee", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-personio-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const server = Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) });
  try {
    const child = Bun.spawn([process.execPath, "--preload", personioFetchFixture, cli, "search", "employers"], {
      cwd: directory,
      env: { ...process.env, PERSONIO_TEST_ENDPOINT: server.url.toString() },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Personio maincubes diagnostics: 1");
    expect(stdout).toContain("[search] http_503 maincubes");
    expect(stdout).toContain("Employer results for model review: 0");
    expect(stdout.trim().endsWith("No application was submitted.")).toBe(true);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
