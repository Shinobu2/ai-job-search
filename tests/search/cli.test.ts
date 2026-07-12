import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateWorkspaceFile } from "../../packages/core/src/workspace";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");
const freehireFetchFixture = join(root, "tests", "search", "freehire-fetch.fixture.ts");
const jobsucheFetchFixture = join(root, "tests", "search", "jobsuche-fetch.fixture.ts");

function payload(job: unknown) {
  return new Response(JSON.stringify({ data: job }), { headers: { "content-type": "application/json" } });
}

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

test("search freehire imports, evaluates, and prints a local shortlist without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { public_slug: "fixture-dct", title: "Data Center Technician", company: "Fixture DC", location: "Frankfurt, Germany", url: "https://jobs.example/fixture-dct", description: "Skills: hardware replacement", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} };
  const excluded = { ...job, public_slug: "fixture-warehouse", title: "Warehouse Operative", url: "https://jobs.example/fixture-warehouse", description: "Warehouse conveyor work", skills: [] };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/search")) return payload([job, excluded]);
      if (path.endsWith("/fixture-dct")) return payload(job);
      if (path.endsWith("/fixture-warehouse")) return payload(excluded);
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
    expect(stdout).toContain("FreeHire discovered: 2 | actionable shortlist: 1");
    expect(stdout).toContain("Data Center Technician");
    expect(stdout).not.toContain("Warehouse Operative");
    expect(stdout).toContain("No application was submitted.");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("search jobsuche imports, evaluates, and prints a local shortlist without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-jobsuche-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { referenznummer: "10001-1002716922-S", beruf: "Data Center Technician", arbeitgeber: "Fixture DC", arbeitsort: { ort: "Frankfurt", land: "Deutschland" }, externeUrl: "https://jobs.example/fixture-dct" };
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1\ndiscovery:\n  sources:\n    - id: jobsuche\n      enabled: true\n      mode: read_import_evaluate\n      country: DE\n      cities: [Frankfurt]\n      keywords: [data center technician]\n      max_pages: 1\n      page_size: 5\n`);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/jobs")) return new Response(JSON.stringify({ stellenangebote: [job] }), { headers: { "content-type": "application/json" } });
      if (path.endsWith("/MTAwMDEtMTAwMjcxNjkyMi1T")) return new Response(JSON.stringify({ ...job, stellenangebotsTitel: job.beruf, stellenangebotsBeschreibung: "Skills: hardware replacement", arbeitsorte: [job.arbeitsort] }), { headers: { "content-type": "application/json" } });
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
    expect(stdout).toContain("Jobsuche discovered: 1 | actionable shortlist: 1 | showing: 1");
    expect(stdout).toContain("Data Center Technician");
    expect(stdout).toContain("No application was submitted.");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
