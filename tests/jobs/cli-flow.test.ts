import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const bun = process.execPath;
const cli = join(root, "scripts", "cli.ts");

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  await cp(join(root, "tests", "fixtures", "jobs"), join(directory, "fixtures"), { recursive: true });
  return directory;
}

async function run(directory: string, ...arguments_: string[]): Promise<CommandResult> {
  const process = Bun.spawn([bun, cli, ...arguments_], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

function outputJson<T>(result: CommandResult): T {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

test("job commands import, evaluate, export, and reuse a local vacancy", async () => {
  const directory = await workspace();
  try {
    const fixture = join(directory, "fixtures", "dct-trainee.md");
    const imported = outputJson<{ id: string; reused: boolean }>(await run(directory, "job", "import", "--file", fixture));
    expect(imported.reused).toBe(false);

    const textImport = outputJson<{ title: string; reused: boolean }>(await run(directory, "job", "import", "--text", "# Inline role\nCompany: Example GmbH\nLocation: Berlin"));
    expect(textImport).toMatchObject({ title: "Inline role", reused: false });

    const evaluated = outputJson<{ jobId: string; fingerprint: string; gates: unknown[] }>(await run(directory, "job", "evaluate", "--id", imported.id));
    expect(evaluated.jobId).toBe(imported.id);
    expect(evaluated.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluated.gates.length).toBeGreaterThan(0);

    const exported = outputJson<{ jobId: string; fingerprint: string }>(await run(directory, "job", "export", "--id", imported.id));
    expect(exported).toMatchObject({ jobId: imported.id, fingerprint: evaluated.fingerprint });
    expect(JSON.parse(await readFile(join(directory, "workspace", "exports", `${imported.id}.json`), "utf8"))).toMatchObject(exported);

    const firstCheck = await run(directory, "job", "check", "--file", fixture);
    expect(firstCheck.exitCode).toBe(0);
    expect(firstCheck.stdout).toContain("Job evaluation");
    expect(firstCheck.stdout).toContain(`workspace/exports/${imported.id}.json`);
    const first = JSON.parse(await readFile(join(directory, "workspace", "exports", `${imported.id}.json`), "utf8"));

    const secondCheck = await run(directory, "job", "check", "--file", fixture);
    expect(secondCheck.exitCode).toBe(0);
    expect(secondCheck.stdout).toContain("reused");
    const second = JSON.parse(await readFile(join(directory, "workspace", "exports", `${imported.id}.json`), "utf8"));
    expect(second).toEqual(first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job export round-trips persisted DCT trainee domain IDs", async () => {
  const directory = await workspace();
  try {
    const imported = outputJson<{ id: string }>(await run(directory, "job", "import", "--file", join(directory, "fixtures", "dct-trainee.md")));
    const evaluated = outputJson<{ archetype: string; gates: Array<{ id: string }>; mappings: Array<{ id: string; requirementId: string }> }>(await run(directory, "job", "evaluate", "--id", imported.id));
    const exported = outputJson<{ archetype: string; gates: Array<{ id: string }>; mappings: Array<{ id: string; requirementId: string }> }>(await run(directory, "job", "export", "--id", imported.id));
    const persisted = JSON.parse(await readFile(join(directory, "workspace", "exports", `${imported.id}.json`), "utf8")) as typeof exported;

    expect(evaluated.archetype).toBe("AT");
    expect(exported.archetype).toBe("AT");
    expect(exported.gates.map((gate) => gate.id)).toEqual(evaluated.gates.map((gate) => gate.id));
    expect(exported.mappings).toEqual(evaluated.mappings);
    expect(persisted.gates.map((gate) => gate.id)).toEqual(evaluated.gates.map((gate) => gate.id));
    expect(persisted.mappings).toEqual(evaluated.mappings);
    expect(exported.gates.map((gate) => gate.id)).toEqual(["archetype", "shift", "transport", "physical", "scope", "facilities", "language", "experience", "salary", "deadline"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job check reports a domain blocker without treating it as a command failure", async () => {
  const directory = await workspace();
  try {
    const result = await run(directory, "job", "check", "--file", join(directory, "fixtures", "own-car.md"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Verdict: BLOCKED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job commands reject malformed flags and unknown job IDs clearly", async () => {
  const directory = await workspace();
  try {
    const malformed = await run(directory, "job", "import", "--file");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("requires a value");

    const unknown = await run(directory, "job", "evaluate", "--id", "job_missing");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown job ID: job_missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job import accepts one URL or a newline-delimited URL file without changing --file", async () => {
  const directory = await workspace();
  const greenhouse = await readFile(join(root, "tests", "fixtures", "url-import", "greenhouse.html"), "utf8");
  const fallback = await readFile(join(root, "tests", "fixtures", "url-import", "no-json-ld.html"), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow:", { headers: { "content-type": "text/plain" } });
      if (path === "/structured") return new Response(greenhouse, { headers: { "content-type": "text/html" } });
      if (path === "/fallback") return new Response(fallback, { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const fromUrl = outputJson<{ title: string; importSource: string }>(
      await run(directory, "job", "import", "--url", `${base}/structured?utm_source=cli-test`),
    );
    expect(fromUrl).toMatchObject({ title: "Data Center Technician", importSource: "json-ld" });

    const urls = join(directory, "urls.txt");
    await writeFile(urls, `${base}/structured\n\n${base}/fallback\n`, "utf8");
    const fromUrlFile = outputJson<Array<{ title: string; importSource: string }>>(
      await run(directory, "job", "import", "--url-file", urls),
    );
    expect(fromUrlFile).toEqual([
      expect.objectContaining({ title: "Data Center Technician", importSource: "json-ld" }),
      expect.objectContaining({ title: "Fallback Support Technician", importSource: "model-fallback" }),
    ]);

    const fromFile = outputJson<{ title: string }>(
      await run(directory, "job", "import", "--file", join(directory, "fixtures", "dct-trainee.md")),
    );
    expect(fromFile.title).toBe("Data Center Technician Trainee");

    const ambiguous = await run(
      directory,
      "job",
      "import",
      "--url",
      `${base}/structured`,
      "--text",
      "Title: Ambiguous",
    );
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("Provide exactly one");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
