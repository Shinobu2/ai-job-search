import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");

async function run(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("application CLI delegates transitions and rejects forged document metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-tracking-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  try {
    const imported = await run(directory, ["job", "import", "--text", "# Technician\nCompany: Example\nLocation: Frankfurt"]);
    expect(imported.code).toBe(0);
    const id = (JSON.parse(imported.stdout) as { id: string }).id;
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "user_submitted", "--confirm", "yes"])).stderr).toContain("requires current status ready_for_review");
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "shortlisted"])).code).toBe(0);
    const packet = join(directory, "workspace", "documents", id);
    await mkdir(packet, { recursive: true });
    await writeFile(join(packet, "metadata.json"), JSON.stringify({ ready_for_submission: true }));
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "ready_for_review"])).stderr).toContain("attested current document packet");
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "user_submitted"])).stderr).toContain("explicit confirmation");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("documents CLI hashes written artifacts and records the packet attestation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-documents-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  try {
    const imported = await run(directory, ["job", "import", "--text", "# Technician\nCompany: Example\nLocation: Frankfurt\nSkills: hardware troubleshooting"]);
    const id = (JSON.parse(imported.stdout) as { id: string }).id;
    expect((await run(directory, ["job", "evaluate", "--id", id])).code).toBe(0);
    const generated = await run(directory, ["documents", "generate", "--id", id]);
    expect(generated.code).toBe(0);
    const result = JSON.parse(generated.stdout) as { packet_id: string; directory: string; hashes: Record<string, string> };
    expect(result.directory).toBe(`workspace/documents/${id}/${result.packet_id}`);
    const metadataPath = join(directory, ...result.directory.split("/"), "metadata.json");
    const metadataBytes = await readFile(metadataPath);
    const metadata = JSON.parse(metadataBytes.toString("utf8")) as { packet_id: string; job_snapshot_hash: string; evaluation_run_id: string; artifact_hashes: Record<string, string> };
    expect(metadata.packet_id).toBe(result.packet_id);
    expect(metadata.job_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.evaluation_run_id).toMatch(/^evaluation_/);
    expect(Object.keys(metadata.artifact_hashes).sort()).toEqual(["english_cover_letter", "english_cv", "german_cover_letter", "german_cv"]);
    expect(Object.values(result.hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    const db = openDatabase(join(directory, "workspace", "control-room.sqlite"));
    try {
      migrate(db);
      expect(new StorageRepository(db).readCurrentDocumentPacket(id)).toMatchObject({ id: result.packet_id, artifactHashes: result.hashes });
    } finally { db.close(); }

    const generatedAgain = await run(directory, ["documents", "generate", "--id", id]);
    expect(generatedAgain.code).toBe(0);
    const second = JSON.parse(generatedAgain.stdout) as { packet_id: string; directory: string };
    expect(second.directory).not.toBe(result.directory);
    expect(await readFile(metadataPath)).toEqual(metadataBytes);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("documents CLI removes a promoted packet when attestation recording fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-documents-cleanup-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  try {
    const imported = await run(directory, ["job", "import", "--text", "# Technician\nCompany: Example\nLocation: Frankfurt\nSkills: hardware troubleshooting"]);
    const id = (JSON.parse(imported.stdout) as { id: string }).id;
    expect((await run(directory, ["job", "evaluate", "--id", id])).code).toBe(0);
    const evidencePath = join(directory, "workspace", "evidence.yml");
    const evidence = await readFile(evidencePath, "utf8");
    await writeFile(evidencePath, evidence.replace("Personal PC hardware experience reported by candidate.", "Changed after evaluation."));
    const generated = await run(directory, ["documents", "generate", "--id", id]);
    expect(generated.code).toBe(1);
    expect(generated.stderr).toContain("matching evidence snapshot");
    expect(await readdir(join(directory, "workspace", "documents", id))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
