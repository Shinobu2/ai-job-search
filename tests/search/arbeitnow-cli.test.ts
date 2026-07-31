import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");
const preload = join(import.meta.dir, "arbeitnow-fetch.fixture.ts");

test("search arbeitnow runs a configured source without submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-arbeitnow-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await writeFile(join(directory, "workspace", "search.yml"), `schema_version: 1
discovery:
  sources:
    - id: arbeitnow
      track: support
      enabled: true
      mode: read_import_evaluate
      country: DE
      cities: [Frankfurt]
      keywords: [IT Support]
      max_pages: 1
      page_size: 20
`, "utf8");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/job-board-api") return new Response("not found", { status: 404 });
      return Response.json({
        data: [{
          slug: "it-support-frankfurt",
          company_name: "CLI Fixture GmbH",
          title: "IT Support Technician",
          description: "<p>Support workplace hardware.</p>",
          remote: false,
          url: "https://www.arbeitnow.com/jobs/it-support-frankfurt",
          tags: ["IT"],
          job_types: [],
          location: "Frankfurt",
          created_at: 1785439826,
        }],
        links: { next: null },
        meta: { current_page: 1, per_page: 175 },
      });
    },
  });

  try {
    const child = Bun.spawn([process.execPath, "--preload", preload, cli, "search", "arbeitnow", "--limit", "5"], {
      cwd: directory,
      env: { ...process.env, ARBEITNOW_TEST_ENDPOINT: server.url.toString() },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toContain("Arbeitnow support discovered: 1");
    expect(stdout).toContain("IT Support Technician — CLI Fixture GmbH");
    expect(stdout.trim().endsWith("No application was submitted.")).toBe(true);
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
