import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("job export preserves the persisted DCT trainee archetype and domain gate IDs", async () => {
  const directory = await workspace();
  try {
    const imported = outputJson<{ id: string }>(await run(directory, "job", "import", "--file", join(directory, "fixtures", "dct-trainee.md")));
    const evaluated = outputJson<{ archetype: string; gates: Array<{ id: string }> }>(await run(directory, "job", "evaluate", "--id", imported.id));
    const exported = outputJson<{ archetype: string; gates: Array<{ id: string }> }>(await run(directory, "job", "export", "--id", imported.id));

    expect(evaluated.archetype).toBe("AT");
    expect(exported.archetype).toBe("AT");
    expect(exported.gates.map((gate) => gate.id)).toEqual(evaluated.gates.map((gate) => gate.id));
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
