import { runDoctor } from "./doctor";
import { setupWorkspace } from "./setup";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CapabilityRegistry } from "../packages/storage/src/capabilities";
import { openDatabase } from "../packages/storage/src/database";
import { migrate } from "../packages/storage/src/migrate";
import { loadWorkspace } from "../packages/core/src/workspace";
import { extractVacancy } from "../packages/jobs/src/extract";
import { buildEvaluationInput, evaluateVacancy } from "../packages/jobs/src/evaluate";
import { importVacancy } from "../packages/jobs/src/import";
import { renderResultCard } from "../packages/jobs/src/card";
import { StorageRepository, type ApplicationStatus, type DocumentPacketRecord, type StoredJob } from "../packages/storage/src/repository";
import { discoverFreehire, type FreehireSourceConfig } from "../packages/search/src/freehire";
import { discoverJobsuche, type JobsucheSourceConfig } from "../packages/search/src/jobsuche";
import { loadEmployerRegistry } from "../packages/search/src/employer-registry";
import { discoverPersonioEmployer } from "../packages/search/src/personio";
import { type DiscoveryCounters, type SourceDiagnostic } from "../packages/search/src/types";
import { generateDocumentPacket, hashEvidenceSnapshot } from "../packages/documents/src/generate";

type JobFlags = { id?: string; file?: string; text?: string; status?: string; next?: string; note?: string; confirm?: string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseFlags(arguments_: string[]): JobFlags {
  const flags: JobFlags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (!flag?.startsWith("--")) throw new Error(`Unknown argument: ${flag ?? ""}`);
    const key = flag.slice(2) as keyof JobFlags;
    if (!(key in { id: true, file: true, text: true, status: true, next: true, note: true, confirm: true })) throw new Error(`Unknown flag: ${flag}`);
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
  return { db, repository: new StorageRepository(db, root) };
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

async function runSearch(root: string, sourceName: string | undefined, arguments_: string[]): Promise<void> {
  if (!sourceName || arguments_.length > 0 || !["freehire", "jobsuche", "ba", "employers"].includes(sourceName)) throw new Error("Usage: search <freehire|jobsuche|ba|employers>");
  if (sourceName === "employers") {
    const registry = await loadEmployerRegistry();
    const { db, repository } = openRepository(root);
    try {
      let count = 0;
      let processed = 0;
      for (const employer of registry.employers.filter((entry) => entry.enabled && entry.policy === "public_ats_endpoint" && entry.ats === "personio")) {
        try {
          const workspace = await loadWorkspace(root);
          const batch = await discoverPersonioEmployer(employer, repository, workspace, { maxResults: MODEL_REVIEW_LIMIT - processed });
          processed += batch.jobs.length;
          printDiscoveryDiagnostics(`Personio ${employer.id}`, batch.counters, batch.diagnostics);
          for (const job of batch.jobs) {
            console.log(`${job.title} — ${job.company}`);
            console.log(`Location: ${job.location ?? "unknown"}`);
            console.log(`Source: Personio ${job.sourceId} — ${job.sourceUrl}`);
            console.log(`Import: ${job.reused ? "reused" : "created"}\n`);
            count += 1;
          }
        } catch (error) {
          const diagnostic: SourceDiagnostic = { stage: "search", locator: employer.id, code: "employer_failed", message: error instanceof Error ? error.message : String(error), transient: false };
          printDiscoveryDiagnostics(`Personio ${employer.id}`, { searched: 0, detailed: 0, imported: 0, skipped: 0, failed: 1 }, [diagnostic]);
        }
        if (processed >= MODEL_REVIEW_LIMIT) break;
      }
      console.log(`Employer results for model review: ${count}`);
      console.log("No application was submitted.");
      return;
    } finally {
      db.close();
    }
  }
  const workspace = await loadWorkspace(root);
  const sourceId = sourceName === "ba" ? "jobsuche" : sourceName;
  const sources = (workspace.search as { discovery?: { sources?: Array<FreehireSourceConfig | JobsucheSourceConfig> } }).discovery?.sources ?? [];
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`workspace/search.yml does not configure ${sourceId === "freehire" ? "FreeHire" : "Jobsuche"}`);
  const { db, repository } = openRepository(root);
  try {
    const jobsuche = source.id === "jobsuche";
    const batch = jobsuche
      ? await discoverJobsuche(source, repository, workspace)
      : await discoverFreehire(source, repository, workspace);
    const sourceLabel = jobsuche ? "Jobsuche" : "FreeHire";
    const displayed = batch.jobs.slice(0, MODEL_REVIEW_LIMIT);
    console.log(`${sourceLabel} discovered: ${batch.jobs.length} | raw results for model review: ${displayed.length}`);
    printDiscoveryDiagnostics(sourceLabel, batch.counters, batch.diagnostics);
    for (const result of displayed) {
      console.log("");
      console.log(`${result.title} — ${result.company}`);
      console.log(`Location: ${result.location ?? "unknown"}`);
      console.log(`Source: ${sourceLabel} ${result.sourceId} — ${result.sourceUrl}`);
      console.log(`Import: ${result.reused ? "reused" : "created"}`);
    }
    console.log("No application was submitted.");
  } finally {
    db.close();
  }
}

const MODEL_REVIEW_LIMIT = 12;
const DIAGNOSTIC_PREVIEW_LIMIT = 3;

function printDiscoveryDiagnostics(label: string, counters: DiscoveryCounters, diagnostics: SourceDiagnostic[]): void {
  console.log(`Counters: searched=${counters.searched} detailed=${counters.detailed} imported=${counters.imported} skipped=${counters.skipped} failed=${counters.failed}`);
  if (diagnostics.length === 0) return;
  const preview = diagnostics.slice(0, DIAGNOSTIC_PREVIEW_LIMIT);
  const previewLabel = diagnostics.length > preview.length ? ` (showing ${preview.length})` : "";
  console.log(`${label} diagnostics: ${diagnostics.length}${previewLabel}`);
  for (const diagnostic of preview) {
    console.log(`- [${diagnostic.stage}] ${diagnostic.code} ${diagnostic.locator} — ${diagnostic.message}`);
  }
  const omitted = diagnostics.length - preview.length;
  if (omitted > 0) console.log(`${omitted} more diagnostic${omitted === 1 ? "" : "s"} omitted.`);
}

async function runDocuments(root: string, command: string | undefined, arguments_: string[]): Promise<void> {
  if (command !== "generate") throw new Error("Usage: documents generate --id <job-id>");
  const flags = parseFlags(arguments_);
  requireOnly(flags, ["id"], "documents generate");
  if (!flags.id) throw new Error("documents generate requires --id");
  const workspace = await loadWorkspace(root);
  const { db, repository } = openRepository(root);
  try {
    const job = repository.readJob(flags.id);
    const evaluation = repository.readEvaluation(flags.id);
    const evaluationAttestation = repository.readCurrentEvaluationAttestation(flags.id);
    if (!job || !evaluation || !evaluationAttestation) throw new Error(`Evaluated job is unavailable: ${flags.id}`);
    const packet = generateDocumentPacket({ title: job.title ?? "Unknown role", company: job.company ?? "Unknown company", evaluation, workspace: workspace as never });
    const packetId = `packet_${randomUUID()}`;
    const parentDirectory = join(root, "workspace", "documents", flags.id);
    const directory = join(parentDirectory, packetId);
    const stagingDirectory = join(parentDirectory, `.${packetId}.tmp`);
    const relativeDirectory = join("workspace", "documents", flags.id, packetId).replace(/\\/g, "/");
    await mkdir(parentDirectory, { recursive: true });
    const artifacts = {
      english_cv: { file: "cv-en.md", contents: `${packet.englishCv}\n` },
      german_cv: { file: "cv-de.md", contents: `${packet.germanCv}\n` },
      english_cover_letter: { file: "cover-letter-en.md", contents: `${packet.englishCoverLetter}\n` },
      german_cover_letter: { file: "cover-letter-de.md", contents: `${packet.germanCoverLetter}\n` },
    };
    const artifactHashes = Object.fromEntries(Object.entries(artifacts).map(([slot, artifact]) => [slot, sha256(artifact.contents)]));
    const evidenceSnapshotHash = hashEvidenceSnapshot((workspace as { evidence: unknown }).evidence);
    const metadata = {
      packet_id: packetId,
      job_snapshot_hash: job.rawSnapshotHash,
      evaluation_run_id: evaluationAttestation.evaluationRunId,
      evaluation_fingerprint: evaluation.fingerprint,
      evidence_snapshot_hash: evidenceSnapshotHash,
      artifact_hashes: artifactHashes,
      ready_for_submission: packet.ready_for_submission,
      missing: packet.missing,
    };
    const metadataContents = `${JSON.stringify(metadata, null, 2)}\n`;
    let promoted = false;
    let recorded = false;
    let storedPacket: DocumentPacketRecord;
    try {
      await mkdir(stagingDirectory);
      await Promise.all([
        ...Object.values(artifacts).map((artifact) => writeFile(join(stagingDirectory, artifact.file), artifact.contents, "utf8")),
        writeFile(join(stagingDirectory, "metadata.json"), metadataContents, "utf8"),
      ]);
      await rename(stagingDirectory, directory);
      promoted = true;
      storedPacket = repository.recordDocumentPacket({
        id: packetId,
        jobId: flags.id,
        jobSnapshotHash: job.rawSnapshotHash,
        evaluationRunId: evaluationAttestation.evaluationRunId,
        evaluationFingerprint: evaluation.fingerprint,
        evidenceSnapshotHash,
        artifactHashes: { ...artifactHashes, metadata: sha256(metadataContents) },
        ready: packet.ready_for_submission,
        directory: relativeDirectory,
      });
      recorded = true;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (promoted && !recorded) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    console.log(JSON.stringify({ job_id: flags.id, packet_id: storedPacket.id, directory: relativeDirectory, ready_for_submission: packet.ready_for_submission, missing: packet.missing, hashes: storedPacket.artifactHashes }, null, 2));
  } finally {
    db.close();
  }
}

async function runApplications(root: string, command: string | undefined, arguments_: string[]): Promise<void> {
  const flags = parseFlags(arguments_);
  const { db, repository } = openRepository(root);
  try {
    if (command === "list") {
      if (arguments_.length) throw new Error("applications list takes no flags");
      console.log(JSON.stringify(repository.listApplications(), null, 2));
      return;
    }
    if (command === "history") {
      requireOnly(flags, ["id"], "applications history");
      if (!flags.id) throw new Error("applications history requires --id");
      console.log(JSON.stringify(repository.listApplicationEvents(flags.id), null, 2));
      return;
    }
    if (command === "set") {
      requireOnly(flags, ["id", "status", "next", "note", "confirm"], "applications set");
      const statuses = ["shortlisted", "ready_for_review", "user_submitted", "interview", "offer", "rejected", "withdrawn"] as const;
      if (!flags.id || !flags.status || !statuses.includes(flags.status as ApplicationStatus)) throw new Error(`applications set requires --id and --status (${statuses.join("|")})`);
      const status = flags.status as ApplicationStatus;
      const explicitlyConfirmed = flags.confirm === "yes";
      console.log(JSON.stringify(repository.setApplicationStatus(flags.id, status, { nextAction: flags.next, note: flags.note, actor: explicitlyConfirmed ? "user_confirmed_cli" : "user", confirmed: explicitlyConfirmed }), null, 2));
      return;
    }
    throw new Error("Usage: applications <set|list|history>");
  } finally { db.close(); }
}

async function runReport(root: string, command: string | undefined): Promise<void> {
  if (command !== "daily") throw new Error("Usage: report daily");
  const { db, repository } = openRepository(root);
  try {
    const date = new Date().toISOString().slice(0, 10);
    const activity = repository.dailyActivity(date);
    const applications = repository.listApplications();
    const evaluated = repository.listEvaluatedJobIds(200).flatMap((id) => {
      const job = repository.readJob(id); const evaluation = repository.readEvaluation(id);
      return job && evaluation ? [{ id, job, evaluation }] : [];
    });
    const top = evaluated.filter(({ evaluation }) => evaluation.verdict !== "BLOCKED" && evaluation.tier !== "C").sort((a, b) => b.evaluation.fit - a.evaluation.fit).slice(0, 5);
    console.log(`# Daily job-search report — ${date}\n`);
    console.log(`Imported today: ${activity.imported} | Evaluated today: ${activity.evaluated} | Application updates today: ${activity.application_events}`);
    console.log(`Tracked applications: ${applications.length} | Statuses: ${Object.entries(activity.statuses).map(([status, count]) => `${status}=${count}`).join(", ") || "none"} | Best matches shown: ${top.length}\n`);
    console.log("## Best matches");
    console.log(top.length ? top.map(({ id, job, evaluation }) => {
      const matches = evaluation.mappings.filter((mapping) => mapping.credit > 0).length;
      const verify = evaluation.gates.filter((gate) => gate.status === "VERIFY").map((gate) => gate.reason).slice(0, 2).join("; ") || "no open verification gates";
      return `- ${job.title ?? "Unknown role"} — ${job.company ?? "Unknown company"}: ${evaluation.tier}, fit ${evaluation.fit}, ${matches} evidence matches; verify: ${verify} [${id}]`;
    }).join("\n") : "- No non-blocked matches above tier C yet.");
    console.log("\n## Next actions");
    const actions = applications.filter((item) => item.next_action).slice(0, 3).map((item) => `- ${item.next_action} [${item.job_id}]`);
    console.log(actions.length ? actions.join("\n") : "- Review the top shortlist and verify shift, salary, and workplace details.");
  } finally { db.close(); }
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
  if (command === "search") {
    await runSearch(process.cwd(), arguments_[0], arguments_.slice(1));
    return;
  }
  if (command === "documents") {
    await runDocuments(process.cwd(), arguments_[0], arguments_.slice(1));
    return;
  }
  if (command === "applications") {
    await runApplications(process.cwd(), arguments_[0], arguments_.slice(1)); return;
  }
  if (command === "report") {
    await runReport(process.cwd(), arguments_[0]); return;
  }
  throw new Error("Usage: bun run scripts/cli.ts <setup|doctor|capabilities|job|search|documents|applications|report>");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
