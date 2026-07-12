import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const cli = join(root, "scripts", "cli.ts");

async function run(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("application CLI guards real-world states and records ready document directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-tracking-cli-"));
  await cp(join(root, "workspace.example"), join(directory, "workspace"), { recursive: true });
  try {
    const imported = await run(directory, ["job", "import", "--text", "# Technician\nCompany: Example\nLocation: Frankfurt"]);
    expect(imported.code).toBe(0);
    const id = (JSON.parse(imported.stdout) as { id: string }).id;
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "user_submitted", "--confirm", "yes"])).stderr).toContain("requires current status ready_for_review");
    const packet = join(directory, "workspace", "documents", id);
    await mkdir(packet, { recursive: true });
    await writeFile(join(packet, "metadata.json"), JSON.stringify({ ready_for_submission: true }));
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "ready_for_review"])).code).toBe(0);
    expect((await run(directory, ["applications", "set", "--id", id, "--status", "user_submitted"])).stderr).toContain("requires --confirm yes");
    const submitted = await run(directory, ["applications", "set", "--id", id, "--status", "user_submitted", "--confirm", "yes"]);
    expect(submitted.code).toBe(0);
    expect(JSON.parse(submitted.stdout)).toMatchObject({ status: "user_submitted", document_dir: `workspace/documents/${id}` });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
