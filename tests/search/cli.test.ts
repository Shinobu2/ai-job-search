import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");
const freehireFetchFixture = join(root, "tests", "search", "freehire-fetch.fixture.ts");

function payload(job: unknown) {
  return new Response(JSON.stringify({ data: job }), { headers: { "content-type": "application/json" } });
}

test("search freehire imports, evaluates, and prints a local shortlist without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-search-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  const job = { public_slug: "fixture-dct", title: "Data Center Technician", company: "Fixture DC", location: "Frankfurt, Germany", url: "https://jobs.example/fixture-dct", description: "Skills: hardware replacement", skills: ["Hardware"], regions: ["eu"], countries: ["DE"], cities: ["Frankfurt"], posted_at: "2026-07-12", created_at: "2026-07-12", enrichment: {} };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/search")) return payload([job]);
      if (path.endsWith("/fixture-dct")) return payload(job);
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
    expect(stdout).toContain("FreeHire shortlist: 1");
    expect(stdout).toContain("Data Center Technician");
    expect(stdout).toContain("No application was submitted.");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
