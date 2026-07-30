import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const allFetchFixture = join(root, "tests", "search", "all-fetch.fixture.ts");

function payload(job: unknown) {
  return new Response(JSON.stringify({ data: job }), { headers: { "content-type": "application/json" } });
}

function discoveryJob(overrides: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    id: "job", reused: false, sourceId: "source", stableSourceId: "source", sourceUrl: "https://jobs.example/job",
    title: "Technician", company: "Fixture", location: "Frankfurt", logicalVacancyId: "vacancy", version: 1,
    track: "datacenter", actionable: true, needs_review: false,
    evaluation: { jobId: "job", archetype: "A", gates: [], mappings: [], fit: 50, survival: null, confidence: "medium", tier: "B", verdict: "PROCEED", fingerprint: "hash" },
    ...overrides,
  };
}

test("actionable discovery hides only geographic or explicit hard blockers", () => {
  expect(isActionableDiscoveryJob(discoveryJob())).toBe(true);
  expect(isActionableDiscoveryJob(discoveryJob({ actionable: false }))).toBe(false);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, tier: "C" } }))).toBe(true);
  expect(isActionableDiscoveryJob(discoveryJob({ evaluation: { ...discoveryJob().evaluation!, archetype: "REVIEW", tier: "C", verdict: "VERIFY" } }))).toBe(true);
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
      id: "jobsuche", track: "datacenter", enabled: true, mode: "read_import_evaluate", country: "DE",
      cities: ["Frankfurt"], keywords: ["data center technician"], max_pages: 1, page_size: 5,
      radius_km: 80, published_within_days: 14, working_time: ["vz", "snw"],
    }] },
  })).not.toThrow();
});

test("search schema accepts an arbitrary non-empty track and still requires the field", () => {
  expect(() => validateWorkspaceFile("search", {
    schema_version: 1,
    discovery: { sources: [{
      id: "freehire", track: "welding", enabled: true, mode: "read_import_evaluate", country: "DE",
      cities: ["Frankfurt"], keywords: ["Schweisser", "MAG", "WIG"], max_pages: 1, page_size: 5,
    }] },
  })).not.toThrow();

  expect(() => validateWorkspaceFile("search", {
    schema_version: 1,
    discovery: { sources: [{
      id: "freehire", enabled: true, mode: "read_import_evaluate", country: "DE",
      cities: ["Frankfurt"], keywords: ["data center technician"], max_pages: 1, page_size: 5,
    }] },
  })).toThrow();
});

test("search flags select an arbitrary configured track and dry-run without persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-dry-run-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1
discovery:
  sources:
    - id: freehire
      track: welding
      enabled: true
      mode: read_import_evaluate
      country: DE
      cities: [Frankfurt]
      keywords: [Schweisser, MAG, WIG]
      max_pages: 1
      page_size: 5
    - id: freehire
      track: support
      enabled: true
      mode: read_import_evaluate
      country: DE
      cities: [Frankfurt]
      keywords: [IT Support]
      max_pages: 1
      page_size: 5
`);
  try {
    const child = Bun.spawn([
      process.execPath, cli, "search", "freehire",
      "--track", "welding", "--limit", "3", "--dry-run",
    ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Dry run: search freehire");
    expect(stdout).toContain("Track: welding");
    expect(stdout).toContain("limit=3");
    expect(stdout).not.toContain("Track: support");
    expect(await Bun.file(join(directory, "workspace", "control-room.sqlite")).exists()).toBe(false);

    const invalidLimit = Bun.spawn([
      process.execPath, cli, "search", "freehire", "--limit", "0", "--dry-run",
    ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await invalidLimit.exited).toBe(1);
    expect(await new Response(invalidLimit.stderr).text()).toContain("--limit must be a positive integer");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
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
    expect(stdout).toContain("Track: datacenter");
    expect(stdout).toContain("Track: bridge");
    expect(stdout).toContain("1. Data Center Technician — Fixture DC");
    expect(stdout).not.toContain("Старт: 17.08.2026 · §24 permit (no sponsorship)");
    expect(stdout).toContain("[detail] http_503 fixture-failed");
    expect(stdout).toContain("Data Center Technician — Fixture DC");
    expect(stdout).not.toContain("Warehouse Operative");
    expect(stdout).not.toContain("Munich Technician");
    expect(stdout).toContain("No application was submitted.");
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 3 }); }
    finally { db.close(); }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search freehire caps model-review output and diagnostic noise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-cli-budget-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const jobs = Array.from({ length: 13 }, (_, index) => ({
    public_slug: `fixture-dct-${index + 1}`,
    title: `Data Center Technician ${index + 1}`,
    company: "Fixture DC",
    location: "Frankfurt, Germany",
    url: `https://jobs.example/fixture-dct-${index + 1}`,
    description: "Skills: hardware replacement",
    skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"],
    posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {},
  }));
  const failed = Array.from({ length: 4 }, (_, index) => ({ ...jobs[0], public_slug: `fixture-failed-${index + 1}`, title: `Unavailable detail ${index + 1}`, url: `https://jobs.example/fixture-failed-${index + 1}` }));
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/search")) return payload([...jobs, ...failed]);
      const job = jobs.find((candidate) => path.endsWith(`/${candidate.public_slug}`));
      if (job) return payload(job);
      if (path.includes("/fixture-failed-")) return new Response("unavailable", { status: 503 });
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
    expect(stdout).toContain("FreeHire datacenter discovered: 12 | raw results for model review: 12");
    expect(stdout).toContain("FreeHire bridge discovered: 12 | raw results for model review: 12");
    expect(stdout.match(/Source: FreeHire/g)).toHaveLength(24);
    expect(stdout).not.toContain("fixture-failed");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search jobsuche prints imported jobs for model review without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-jobsuche-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { referenznummer: "10001-1002716922-S", beruf: "Data Center Technician", arbeitgeber: "Fixture DC", arbeitsort: { ort: "Frankfurt", land: "Deutschland" }, externeUrl: "https://jobs.example/fixture-dct" };
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1\ndiscovery:\n  sources:\n    - id: jobsuche\n      track: datacenter\n      enabled: true\n      mode: read_import_evaluate\n      country: DE\n      cities: [Frankfurt]\n      keywords: [data center technician]\n      radius_km: 80\n      published_within_days: 14\n      working_time: [vz, snw]\n      max_pages: 1\n      page_size: 5\n`);
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
    expect(stdout).toContain("Track: datacenter");
    expect(stdout).toContain("Jobsuche datacenter discovered: 1 | raw results for model review: 1");
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
      <position><id>outside</id><name>Munich Technician</name><office>Munich</office></position>
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
    expect(stdout).toContain("Employer results for model review: 2");
    expect(stdout).toContain("Data Center Technician — maincubes");
    expect(stdout).not.toContain("Warehouse Operative — maincubes");
    expect(stdout).not.toContain("Munich Technician — maincubes");
    expect(stdout).toContain("Trusted official manual watchlist");
    expect(stdout).toContain("Amadeus Fire");
    expect(stdout).toContain("https://www.amadeus-fire.de/jobsuche");
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try { expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 4 }); }
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

test("search all aggregates enabled batch counters and maps success, partial, and failed exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-all-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1
discovery:
  sources:
    - id: freehire
      track: datacenter
      enabled: true
      mode: read_import_evaluate
      country: DE
      cities: [Frankfurt]
      keywords: [data center technician]
      max_pages: 1
      page_size: 5
    - id: jobsuche
      track: datacenter
      enabled: true
      mode: read_import_evaluate
      country: DE
      cities: [Frankfurt]
      keywords: [data center technician]
      radius_km: 80
      published_within_days: 14
      working_time: [vz]
      max_pages: 1
      page_size: 5
`);
  const first = {
    public_slug: "all-one",
    title: "Data Center Technician",
    company: "Fixture DC",
    location: "Frankfurt, Germany",
    url: "https://jobs.example/all-one",
    description: "Skills: hardware replacement",
    skills: ["Hardware"],
    regions: ["eu"],
    countries: ["DE"],
    cities: ["Frankfurt"],
    posted_at: "2026-07-12",
    created_at: "2026-07-12",
    enrichment: {},
  };
  const second = { ...first, public_slug: "all-two", url: "https://jobs.example/all-two" };
  let mode: "partial" | "failed" | "success" = "partial";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/jobs/search")) {
        if (mode === "failed") return new Response("{invalid", { headers: { "content-type": "application/json" } });
        return payload(mode === "partial" ? [first, second] : []);
      }
      if (path.endsWith("/all-one")) return payload(first);
      if (path.endsWith("/jobs")) return new Response(JSON.stringify({ stellenangebote: [] }), { headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    },
  });
  const runAll = async () => {
    const child = Bun.spawn([
      process.execPath, "--preload", allFetchFixture, cli,
      "search", "all", "--limit", "1",
    ], {
      cwd: directory,
      env: {
        ...process.env,
        FREEHIRE_TEST_ENDPOINT: server.url.toString(),
        JOBSUCHE_TEST_ENDPOINT: server.url.toString(),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  };
  try {
    const partial = await runAll();
    expect(partial.exitCode).toBe(2);
    expect(partial.stderr).toBe("");
    expect(partial.stdout).toContain("| Source | Track | Status | Searched | Detailed | Imported | Skipped | Failed |");
    expect(partial.stdout).toContain("| freehire:datacenter | datacenter | partial | 1 | 1 | 1 | 0 | 0 |");
    expect(partial.stdout).toContain("| jobsuche:datacenter | datacenter | success | 1 | 0 | 0 | 0 | 0 |");
    expect(partial.stdout).toContain("| TOTAL | - | partial | 2 | 1 | 1 | 0 | 0 |");

    mode = "failed";
    const failed = await runAll();
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe("");
    expect(failed.stdout).toContain("| freehire:datacenter | datacenter | failed | 1 | 0 | 0 | 0 | 1 |");
    expect(failed.stdout).toContain("| TOTAL | - | failed | 2 | 0 | 0 | 0 | 1 |");

    mode = "success";
    const success = await runAll();
    expect(success.exitCode).toBe(0);
    expect(success.stderr).toBe("");
    expect(success.stdout).toContain("| TOTAL | - | success | 2 | 0 | 0 | 0 | 0 |");

    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["search:all"]).toBe("bun run scripts/cli.ts search all");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
