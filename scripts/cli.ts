import { runDoctor } from "./doctor";
import { setupWorkspace } from "./setup";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CapabilityRegistry } from "../packages/storage/src/capabilities";
import { openDatabase } from "../packages/storage/src/database";
import { migrate } from "../packages/storage/src/migrate";
import { loadWorkspace } from "../packages/core/src/workspace";
import { extractVacancy } from "../packages/jobs/src/extract";
import { buildEvaluationInput, evaluateVacancy } from "../packages/jobs/src/evaluate";
import { importVacancy } from "../packages/jobs/src/import";
import { renderResultCard } from "../packages/jobs/src/card";
import { StorageRepository, type StoredJob } from "../packages/storage/src/repository";

type JobFlags = { id?: string; file?: string; text?: string };

function parseFlags(arguments_: string[]): JobFlags {
  const flags: JobFlags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (!flag?.startsWith("--")) throw new Error(`Unknown argument: ${flag ?? ""}`);
    const key = flag.slice(2) as keyof JobFlags;
    if (!(key in { id: true, file: true, text: true })) throw new Error(`Unknown flag: ${flag}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flags[key] !== undefined) throw new Error(`${flag} may only be provided once`);
    flags[key] = value;
  }
  return flags;
}

function requireOnly(flags: JobFlags, allowed: Array<keyof JobFlags>, command: string): void {
  const invalid = Object.keys(flags).find((key) => !allowed.includes(key as keyof JobFlags));
  if (invalid) throw new Error(`--${invalid} is not supported by job ${command}`);
}

function openRepository(root: string): { db: ReturnType<typeof openDatabase>; repository: StorageRepository } {
  const db = openDatabase(join(root, "workspace", "control-room.sqlite"));
  migrate(db);
  return { db, repository: new StorageRepository(db) };
}

async function writeExport(root: string, jobId: string, value: unknown): Promise<string> {
  const directory = join(root, "workspace", "exports");
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${jobId}.json`);
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return join("workspace", "exports", `${jobId}.json`).replace(/\\/g, "/");
}

async function evaluateJob(root: string, repository: StorageRepository, jobId: string) {
  const job = repository.readJob(jobId);
  if (!job) throw new Error(`Unknown job ID: ${jobId}`);
  const workspace = await loadWorkspace(root);
  const result = evaluateVacancy(job as StoredJob, extractVacancy(job.rawContent), workspace, new Date().toISOString().slice(0, 10));
  repository.persistEvaluation(buildEvaluationInput(result, extractVacancy(job.rawContent), workspace));
  return { ...result, title: job.title, company: job.company };
}

async function runJob(root: string, command: string | undefined, arguments_: string[]): Promise<void> {
  if (!command) throw new Error("Usage: job <import|evaluate|export|check>");
  const flags = parseFlags(arguments_);
  const { db, repository } = openRepository(root);
  try {
    if (command === "import") {
      requireOnly(flags, ["file", "text"], command);
      if ((flags.file === undefined) === (flags.text === undefined)) throw new Error("Provide exactly one of --file or --text");
      console.log(JSON.stringify(await importVacancy({ file: flags.file, text: flags.text }, repository), null, 2));
      return;
    }
    if (command === "evaluate") {
      requireOnly(flags, ["id"], command);
      if (!flags.id) throw new Error("job evaluate requires --id");
      console.log(JSON.stringify(await evaluateJob(root, repository, flags.id), null, 2));
      return;
    }
    if (command === "export") {
      requireOnly(flags, ["id"], command);
      if (!flags.id) throw new Error("job export requires --id");
      const result = repository.readEvaluation(flags.id);
      if (!result) throw new Error(`No evaluation exists for job ID: ${flags.id}`);
      const job = repository.readJob(flags.id);
      const exported = { ...result, title: job?.title ?? null, company: job?.company ?? null };
      await writeExport(root, flags.id, exported);
      console.log(JSON.stringify(exported, null, 2));
      return;
    }
    if (command === "check") {
      requireOnly(flags, ["file", "text"], command);
      if ((flags.file === undefined) === (flags.text === undefined)) throw new Error("Provide exactly one of --file or --text");
      const imported = await importVacancy({ file: flags.file, text: flags.text }, repository);
      const result = await evaluateJob(root, repository, imported.id);
      const exportPath = await writeExport(root, imported.id, result);
      console.log(renderResultCard(result));
      console.log(`Import: ${imported.reused ? "reused" : "created"}`);
      console.log(`Export: ${exportPath}`);
      return;
    }
    throw new Error(`Unknown job command: ${command}`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "setup") {
    console.log(JSON.stringify(await setupWorkspace(process.cwd()), null, 2));
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor(process.cwd(), arguments_.includes("--strict"));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
    return;
  }
  if (command === "capabilities") {
    const db = openDatabase(join(process.cwd(), "workspace", "control-room.sqlite"));
    try {
      migrate(db);
      const registry = new CapabilityRegistry(db);
      registry.seed();
      const configured = parse(await readFile(join(process.cwd(), "workspace", "auto-apply.yml"), "utf8")) as { configured_mode?: string };
      console.log(JSON.stringify({ configured_mode: configured.configured_mode ?? "prepare_only", effective_mode: registry.getEffectiveMode(configured.configured_mode ?? "prepare_only"), capabilities: registry.list() }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  if (command === "job") {
    await runJob(process.cwd(), arguments_[0], arguments_.slice(1));
    return;
  }
  throw new Error("Usage: bun run scripts/cli.ts <setup|doctor|capabilities|job>");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
