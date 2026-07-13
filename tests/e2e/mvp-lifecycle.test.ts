import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const cliScript = join(root, "scripts", "cli.ts");

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type WorkspaceFile = { hash: string; mtimeMs: number };
type WorkspaceSnapshot = { exists: boolean; files: Record<string, WorkspaceFile> };

async function cli(directory: string, ...arguments_: string[]): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, cliScript, ...arguments_], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
  if (result.exitCode !== 0) {
    throw new Error(`CLI failed (${arguments_.join(" ")}): ${result.stderr || result.stdout}`);
  }
  expect(result.stderr).toBe("");
  return result;
}

function outputJson<T>(result: CommandResult): T {
  return JSON.parse(result.stdout) as T;
}

async function snapshotWorkspace(directory: string): Promise<WorkspaceSnapshot> {
  const files: Record<string, WorkspaceFile> = {};
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, files };
    throw error;
  }
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const [contents, details] = await Promise.all([readFile(path), stat(path)]);
        files[relative(directory, path).replaceAll("\\", "/")] = {
          hash: createHash("sha256").update(contents).digest("hex"),
          mtimeMs: details.mtimeMs,
        };
      }
    }
  }
  await visit(directory);
  return { exists: true, files };
}

test("proves the isolated synthetic MVP lifecycle through public CLI commands", async () => {
  const realWorkspace = join(root, "workspace");
  const realWorkspaceBefore = await snapshotWorkspace(realWorkspace);
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-lifecycle-"));
  try {
    await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
    await cp(join(root, "tests", "fixtures", "candidates", "synthetic", "profile.yml"), join(directory, "workspace", "profile.yml"));
    await cp(join(root, "tests", "fixtures", "candidates", "synthetic", "evidence.yml"), join(directory, "workspace", "evidence.yml"));
    await cp(join(root, "tests", "fixtures", "jobs", "synthetic-day-dct.md"), join(directory, "synthetic-day-dct.md"));
    const fixture = join(directory, "synthetic-day-dct.md");

    const imported = outputJson<{ id: string; reused: boolean }>(await cli(directory, "job", "import", "--file", fixture));
    expect(imported.reused).toBe(false);
    const reused = outputJson<{ id: string; reused: boolean }>(await cli(directory, "job", "import", "--file", fixture));
    expect(reused).toMatchObject({ id: imported.id, reused: true });

    const evaluated = outputJson<{
      jobId: string;
      verdict: string;
      tier: string;
      fingerprint: string;
      gates: Array<{ id: string; status: string; critical: boolean }>;
      mappings: Array<{ status: string; evidenceIds: string[] }>;
    }>(await cli(directory, "job", "evaluate", "--id", imported.id));
    expect(evaluated).toMatchObject({ jobId: imported.id, verdict: "PROCEED" });
    expect(Object.fromEntries(evaluated.gates.map((gate) => [gate.id, gate.status]))).toEqual({
      archetype: "PASS",
      shift: "PASS",
      transport: "PASS",
      physical: "PASS",
      scope: "PASS",
      facilities: "PASS",
      language: "PASS",
      experience: "PASS",
      salary: "PASS",
      deadline: "PASS",
    });
    expect(evaluated.gates.filter((gate) => gate.critical).every((gate) => gate.status === "PASS")).toBe(true);
    expect(evaluated.mappings.flatMap((mapping) => mapping.evidenceIds)).toContain("SYNTHETIC_UNREVIEWED_SERVER");

    const exported = outputJson<{ jobId: string; fingerprint: string }>(await cli(directory, "job", "export", "--id", imported.id));
    expect(exported).toMatchObject({ jobId: imported.id, fingerprint: evaluated.fingerprint });
    expect(JSON.parse(await readFile(join(directory, "workspace", "exports", `${imported.id}.json`), "utf8"))).toEqual(exported);

    const generated = outputJson<{
      packet_id: string;
      directory: string;
      ready_for_submission: boolean;
      missing: string[];
      hashes: Record<string, string>;
    }>(await cli(directory, "documents", "generate", "--id", imported.id));
    expect(generated).toMatchObject({ ready_for_submission: true, missing: [] });
    expect(Object.values(generated.hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);

    const packetDirectory = join(directory, ...generated.directory.split("/"));
    const metadata = JSON.parse(await readFile(join(packetDirectory, "metadata.json"), "utf8")) as {
      packet_id: string;
      job_snapshot_hash: string;
      evaluation_run_id: string;
      evaluation_fingerprint: string;
      evidence_snapshot_hash: string;
      ready_for_submission: boolean;
      missing: string[];
      artifact_hashes: Record<string, string>;
    };
    expect(metadata).toMatchObject({
      packet_id: generated.packet_id,
      evaluation_fingerprint: evaluated.fingerprint,
      ready_for_submission: true,
      missing: [],
    });
    expect(metadata.job_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.evaluation_run_id).toMatch(/^evaluation_/);
    expect(metadata.evidence_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);

    const documents = await Promise.all(["cv-en.md", "cv-de.md", "cover-letter-en.md", "cover-letter-de.md"].map((file) => readFile(join(packetDirectory, file), "utf8")));
    const documentText = documents.join("\n");
    for (const id of ["SYNTHETIC_PC_HARDWARE", "SYNTHETIC_CABLING", "SYNTHETIC_TROUBLESHOOTING"]) {
      expect(documentText).toContain(`[${id}]`);
    }
    expect(documentText).not.toContain("SYNTHETIC_UNREVIEWED_SERVER");
    expect(documentText).not.toContain("unreviewed server installation claim");

    await cli(directory, "applications", "set", "--id", imported.id, "--status", "shortlisted");
    await cli(directory, "applications", "set", "--id", imported.id, "--status", "ready_for_review");
    await cli(directory, "applications", "set", "--id", imported.id, "--status", "user_submitted", "--confirm", "yes");

    const applications = outputJson<Array<{ job_id: string; status: string; document_dir: string }>>(await cli(directory, "applications", "list"));
    expect(applications).toEqual([expect.objectContaining({
      job_id: imported.id,
      status: "user_submitted",
      document_dir: generated.directory,
    })]);
    const history = outputJson<Array<{ status: string; actor: string }>>(await cli(directory, "applications", "history", "--id", imported.id));
    expect(history.map(({ status, actor }) => ({ status, actor }))).toEqual([
      { status: "shortlisted", actor: "user" },
      { status: "ready_for_review", actor: "user" },
      { status: "user_submitted", actor: "user_confirmed_cli" },
    ]);

    const report = (await cli(directory, "report", "daily")).stdout;
    expect(report).toContain("Imported today: 1 | Evaluated today: 1 | Application updates today: 3");
    expect(report).toContain("Tracked applications: 1 | Statuses: user_submitted=1 | Best matches shown: 1");
    expect(report).toContain("## Next actions");
    expect(report).toContain("Review the top shortlist and verify shift, salary, and workplace details.");

    const capabilities = outputJson<{ configured_mode: string; effective_mode: string }>(await cli(directory, "capabilities"));
    expect(capabilities).toMatchObject({ configured_mode: "supervised_auto", effective_mode: "prepare_only" });
  } finally {
    try {
      expect(await snapshotWorkspace(realWorkspace)).toEqual(realWorkspaceBefore);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }
});
