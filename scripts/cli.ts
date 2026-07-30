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
import { dateOnlyInTimeZone } from "../packages/core/src/availability";
import { prepareApplicationAnswerMatrix } from "../packages/core/src/application-answers";
import { extractVacancy } from "../packages/jobs/src/extract";
import { buildEvaluationInput, evaluateVacancy } from "../packages/jobs/src/evaluate";
import { importVacancy } from "../packages/jobs/src/import";
import { renderResultCard } from "../packages/jobs/src/card";
import { StorageRepository, type ApplicationStatus, type DocumentPacketRecord, type StoredJob } from "../packages/storage/src/repository";
import { discoverFreehire, type FreehireSourceConfig } from "../packages/search/src/freehire";
import { discoverJobsuche, type JobsucheSourceConfig } from "../packages/search/src/jobsuche";
import { loadEmployerRegistry } from "../packages/search/src/employer-registry";
import { discoverPersonioEmployer } from "../packages/search/src/personio";
import { discoverGreenhouseEmployer } from "../packages/search/src/greenhouse";
import { discoverLeverEmployer } from "../packages/search/src/lever";
import { isActionableDiscoveryJob, type DiscoveryCounters, type SearchTrack, type SourceDiagnostic } from "../packages/search/src/types";
import { generateDocumentPacket, hashEvidenceSnapshot } from "../packages/documents/src/generate";
import { buildAtsDocx, lintAtsDocx } from "../packages/documents/src/ats-docx";

type FlagKey = "id" | "file" | "text" | "status" | "next" | "note" | "confirm" | "dryRun" | "limit" | "strict" | "track";
type FlagKind = "string" | "boolean" | "number";

export type CliFlags = {
  id?: string;
  file?: string;
  text?: string;
  status?: string;
  next?: string;
  note?: string;
  confirm?: boolean;
  dryRun?: boolean;
  limit?: number;
  strict?: boolean;
  track?: string;
};

const FLAG_DEFINITIONS: Record<FlagKey, { option: string; kind: FlagKind }> = {
  id: { option: "--id", kind: "string" },
  file: { option: "--file", kind: "string" },
  text: { option: "--text", kind: "string" },
  status: { option: "--status", kind: "string" },
  next: { option: "--next", kind: "string" },
  note: { option: "--note", kind: "string" },
  confirm: { option: "--confirm", kind: "boolean" },
  dryRun: { option: "--dry-run", kind: "boolean" },
  limit: { option: "--limit", kind: "number" },
  strict: { option: "--strict", kind: "boolean" },
  track: { option: "--track", kind: "string" },
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function postingWorkingLanguage(rawContent: string): "en" | "de" {
  if (/(?:working language|arbeitssprache)\s*:?\s*(?:german|deutsch)\b/i.test(rawContent)
    && !/\benglish\s+(?:accepted|allowed|sufficient|alternative)\b/i.test(rawContent)) return "de";
  return "en";
}

export function searchProfileSummary(profile: unknown): string | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const profileRecord = profile as Record<string, unknown>;
  const availability = profileRecord.availability && typeof profileRecord.availability === "object" && !Array.isArray(profileRecord.availability)
    ? profileRecord.availability as Record<string, unknown>
    : {};
  const legal = profileRecord.legal && typeof profileRecord.legal === "object" && !Array.isArray(profileRecord.legal)
    ? profileRecord.legal as Record<string, unknown>
    : {};
  const verifiedValue = (field: unknown): unknown => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return null;
    const record = field as Record<string, unknown>;
    return ["user_confirmed", "document_verified"].includes(String(record.verification_status))
      ? record.value
      : null;
  };
  const authorizationValue = verifiedValue(legal.work_authorization);
  const authorization = authorizationValue && typeof authorizationValue === "object" && !Array.isArray(authorizationValue)
    ? authorizationValue as Record<string, unknown>
    : {};
  const verifiedAvailableFrom = verifiedValue(availability.available_from);
  const availableFrom = typeof verifiedAvailableFrom === "string"
    ? verifiedAvailableFrom
    : typeof authorization.available_from === "string" ? authorization.available_from : null;
  const parts: string[] = [];
  if (availableFrom) parts.push(`Available from: ${availableFrom}`);
  if (typeof authorization.basis === "string" && authorization.basis.trim()) {
    parts.push(`Work authorization: ${authorization.basis}`);
  }
  if (typeof authorization.sponsorship_required === "boolean") {
    parts.push(`Sponsorship required: ${authorization.sponsorship_required ? "yes" : "no"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function parseFlags(arguments_: string[], allowed: readonly FlagKey[], command: string): CliFlags {
  const flags: Record<string, string | number | boolean> = {};
  const allowedOptions = allowed.map((key) => FLAG_DEFINITIONS[key].option);
  const allowedMessage = allowedOptions.length ? allowedOptions.join(", ") : "(none)";
  for (let index = 0; index < arguments_.length;) {
    const option = arguments_[index];
    if (!option?.startsWith("--")) {
      throw new Error(`Unknown argument ${option ?? ""} for ${command}. Allowed flags: ${allowedMessage}`);
    }
    const key = allowed.find((candidate) => FLAG_DEFINITIONS[candidate].option === option);
    if (!key) throw new Error(`Unknown flag ${option} for ${command}. Allowed flags: ${allowedMessage}`);
    if (flags[key] !== undefined) throw new Error(`${option} may only be provided once`);
    const definition = FLAG_DEFINITIONS[key];
    if (definition.kind === "boolean") {
      flags[key] = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (definition.kind === "number") {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) throw new Error(`${option} requires a number`);
      flags[key] = numericValue;
    } else {
      flags[key] = value;
    }
    index += 2;
  }
  return flags as CliFlags;
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
  const allowedByCommand: Record<string, readonly FlagKey[]> = {
    import: ["file", "text"],
    evaluate: ["id"],
    export: ["id"],
    check: ["file", "text"],
  };
  const allowed = allowedByCommand[command];
  if (!allowed) throw new Error(`Unknown job command: ${command}`);
  const flags = parseFlags(arguments_, allowed, `job ${command}`);
  const { db, repository } = openRepository(root);
  try {
    if (command === "import") {
      if ((flags.file === undefined) === (flags.text === undefined)) throw new Error("Provide exactly one of --file or --text");
      console.log(JSON.stringify(await importVacancy({ file: flags.file, text: flags.text }, repository), null, 2));
      return;
    }
    if (command === "evaluate") {
      if (!flags.id) throw new Error("job evaluate requires --id");
      console.log(JSON.stringify(await evaluateJob(root, repository, flags.id), null, 2));
      return;
    }
    if (command === "export") {
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
  if (!sourceName || !["freehire", "jobsuche", "ba", "employers"].includes(sourceName)) throw new Error("Usage: search <freehire|jobsuche|ba|employers>");
  const flags = parseFlags(arguments_, ["track", "limit", "dryRun"], `search ${sourceName}`);
  const limit = flags.limit ?? MODEL_REVIEW_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
  const workspace = await loadWorkspace(root);
  const sources = (workspace.search as { discovery?: { sources?: Array<FreehireSourceConfig | JobsucheSourceConfig> } }).discovery?.sources ?? [];
  const configuredTracks = [...new Set(sources.map((source) => source.track))];
  if (configuredTracks.length === 0) throw new Error("workspace/search.yml does not configure any discovery tracks");
  if (flags.track && !configuredTracks.includes(flags.track)) {
    throw new Error(`Unknown track: ${flags.track}. Configured tracks: ${configuredTracks.join(", ")}`);
  }
  const tracks = flags.track ? [flags.track] : configuredTracks;
  const profileSummary = searchProfileSummary(workspace.profile);
  const printTrack = (track: SearchTrack) => console.log(`\nTrack: ${track}`);
  const printJob = (job: {
    title: string; company: string | null; location: string | null; sourceId: string; sourceUrl: string;
    reused: boolean; needs_review: boolean;
  }, index: number, sourceLabel: string) => {
    console.log(`${index}. ${job.title} — ${job.company}`);
    console.log(`Location: ${job.location ?? "unknown"}`);
    if (profileSummary) console.log(profileSummary);
    console.log(`Review: ${job.needs_review ? "required" : "ready"}`);
    console.log(`Source: ${sourceLabel} ${job.sourceId} — ${job.sourceUrl}`);
    console.log(`Import: ${job.reused ? "reused" : "created"}\n`);
  };
  if (sourceName === "employers") {
    const registry = await loadEmployerRegistry();
    if (flags.dryRun) {
      console.log(`Dry run: search employers | limit=${limit}`);
      for (const track of tracks) {
        printTrack(track);
        const employers = registry.employers.filter((entry) =>
          entry.track === track
          && entry.enabled
          && entry.policy === "public_ats_endpoint"
          && ["personio", "greenhouse", "lever"].includes(entry.ats));
        console.log(`Enabled public ATS employers: ${employers.length}`);
      }
      console.log("No network requests or persistence were performed.");
      console.log("No application was submitted.");
      return;
    }
    const { db, repository } = openRepository(root);
    try {
      let total = 0;
      for (const track of tracks) {
        printTrack(track);
        let index = 1;
        let processed = 0;
        const employers = registry.employers.filter((entry) =>
          entry.track === track
          && entry.enabled
          && entry.policy === "public_ats_endpoint"
          && ["personio", "greenhouse", "lever"].includes(entry.ats));
        for (const employer of employers) {
          if (processed >= limit) break;
          try {
            const discoveryEmployer = { ...employer, cities: registry.cities };
            const sourceBudget = Math.min(4, limit - processed);
            const batch = employer.ats === "greenhouse"
              ? await discoverGreenhouseEmployer(discoveryEmployer, repository, workspace, { maxResults: sourceBudget })
              : employer.ats === "lever"
                ? await discoverLeverEmployer(discoveryEmployer, repository, workspace, { maxResults: sourceBudget })
                : await discoverPersonioEmployer(discoveryEmployer, repository, workspace, { maxResults: sourceBudget });
            const atsLabel = employer.ats === "greenhouse" ? "Greenhouse" : employer.ats === "lever" ? "Lever" : "Personio";
            const reviewJobs = batch.jobs.filter(isActionableDiscoveryJob).slice(0, limit - processed);
            processed += reviewJobs.length;
            printDiscoveryDiagnostics(`${atsLabel} ${employer.id}`, batch.counters, batch.diagnostics);
            for (const job of reviewJobs) {
              printJob(job, index, atsLabel);
              index += 1;
              total += 1;
            }
          } catch (error) {
            const diagnostic: SourceDiagnostic = { stage: "search", locator: employer.id, code: "employer_failed", message: error instanceof Error ? error.message : String(error), transient: false };
            printDiscoveryDiagnostics(`${employer.ats} ${employer.id}`, { searched: 0, detailed: 0, imported: 0, skipped: 0, failed: 1 }, [diagnostic]);
          }
        }
      }
      console.log(`Employer results for model review: ${total}`);
      const manual = registry.employers.filter((entry) => entry.enabled && entry.policy === "manual_only");
      console.log("\nTrusted official manual watchlist");
      for (const track of tracks) {
        console.log(`Track: ${track}`);
        for (const source of manual.filter((entry) => entry.track === track)) {
          const kind = source.source_kind === "agency" ? "agency" : "direct employer";
          console.log(`- ${source.name} [${kind}] — ${source.career_url}`);
        }
      }
      console.log("No application was submitted.");
      return;
    } finally {
      db.close();
    }
  }
  const sourceId = sourceName === "ba" ? "jobsuche" : sourceName;
  const configured = sources.filter((candidate) =>
    candidate.id === sourceId
    && candidate.enabled
    && tracks.includes(candidate.track));
  if (configured.length === 0) throw new Error(`workspace/search.yml does not configure an enabled ${sourceId === "freehire" ? "FreeHire" : "Jobsuche"} source`);
  if (flags.dryRun) {
    console.log(`Dry run: search ${sourceName} | limit=${limit}`);
    for (const track of tracks) {
      printTrack(track);
      for (const source of configured.filter((candidate) => candidate.track === track)) {
        console.log(`- ${source.id}: ${source.keywords.length} keyword(s), ${source.cities.length} city/cities`);
      }
    }
    console.log("No network requests or persistence were performed.");
    console.log("No application was submitted.");
    return;
  }
  const { db, repository } = openRepository(root);
  try {
    for (const track of tracks) {
      printTrack(track);
      let index = 1;
      for (const source of configured.filter((candidate) => candidate.track === track)) {
        const jobsuche = source.id === "jobsuche";
        const batch = jobsuche
          ? await discoverJobsuche(source, repository, workspace, { maxResults: limit })
          : await discoverFreehire(source, repository, workspace, { maxResults: limit });
        const sourceLabel = jobsuche ? "Jobsuche" : "FreeHire";
        const displayed = batch.jobs.filter(isActionableDiscoveryJob).slice(0, limit);
        console.log(`${sourceLabel} ${track} discovered: ${batch.jobs.length} | raw results for model review: ${displayed.length}`);
        printDiscoveryDiagnostics(`${sourceLabel} ${track}`, batch.counters, batch.diagnostics);
        for (const result of displayed) {
          printJob(result, index, sourceLabel);
          index += 1;
        }
      }
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
  const flags = parseFlags(arguments_, ["id"], "documents generate");
  if (!flags.id) throw new Error("documents generate requires --id");
  const workspace = await loadWorkspace(root);
  const { db, repository } = openRepository(root);
  try {
    const job = repository.readJob(flags.id);
    const evaluation = repository.readEvaluation(flags.id);
    const evaluationAttestation = repository.readCurrentEvaluationAttestation(flags.id);
    if (!job || !evaluation || !evaluationAttestation) throw new Error(`Evaluated job is unavailable: ${flags.id}`);
    const asOfDate = dateOnlyInTimeZone(new Date(), "Europe/Berlin");
    const workingLanguage = postingWorkingLanguage(job.rawContent);
    const packet = generateDocumentPacket({ title: job.title ?? "Unknown role", company: job.company ?? "Unknown company", evaluation, workspace: workspace as never, asOfDate, workingLanguage });
    const atsDocx = await buildAtsDocx(packet.atsDocument);
    const documentQa = await lintAtsDocx(atsDocx, packet.atsDocument);
    const qaContents = `${JSON.stringify(documentQa, null, 2)}\n`;
    const qaFailures = documentQa.checks.filter((check) => check.status === "fail").map((check) => `document.qa.${check.id}`);
    const readyForSubmission = packet.ready_for_submission && qaFailures.length === 0;
    const missing = [...new Set([...packet.missing, ...qaFailures])];
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
      ats_docx: { file: "cv-ats.docx", contents: atsDocx },
      document_qa: { file: "document-qa.json", contents: qaContents },
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
      ready_for_submission: readyForSubmission,
      missing,
      working_language: workingLanguage,
      document_qa: documentQa,
      // Adaptive-availability provenance (v5 §11): when the profile carried
      // verified relocation/available-from dates, the exact text emitted in
      // the cover-letter drafts is recorded here for audit.
      as_of_date: asOfDate,
      availability_text_used: { en: packet.availabilityTextEn, de: packet.availabilityTextDe },
    };
    const metadataContents = `${JSON.stringify(metadata, null, 2)}\n`;
    let promoted = false;
    let recorded = false;
    let storedPacket: DocumentPacketRecord;
    try {
      await mkdir(stagingDirectory);
      await Promise.all([
        ...Object.values(artifacts).map((artifact) => writeFile(join(stagingDirectory, artifact.file), artifact.contents)),
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
        ready: readyForSubmission,
        directory: relativeDirectory,
      });
      recorded = true;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (promoted && !recorded) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    console.log(JSON.stringify({ job_id: flags.id, packet_id: storedPacket.id, directory: relativeDirectory, ready_for_submission: readyForSubmission, missing, hashes: storedPacket.artifactHashes }, null, 2));
  } finally {
    db.close();
  }
}

async function runApplications(root: string, command: string | undefined, arguments_: string[]): Promise<void> {
  const allowedByCommand: Record<string, readonly FlagKey[]> = {
    list: [],
    history: ["id"],
    prepare: ["id", "file"],
    set: ["id", "status", "next", "note", "confirm"],
  };
  if (!command || !allowedByCommand[command]) throw new Error("Usage: applications <set|list|history|prepare>");
  const flags = parseFlags(arguments_, allowedByCommand[command], `applications ${command}`);
  const { db, repository } = openRepository(root);
  try {
    if (command === "list") {
      console.log(JSON.stringify(repository.listApplications(), null, 2));
      return;
    }
    if (command === "history") {
      if (!flags.id) throw new Error("applications history requires --id");
      console.log(JSON.stringify(repository.listApplicationEvents(flags.id), null, 2));
      return;
    }
    if (command === "prepare") {
      if (!flags.id || !flags.file) throw new Error("applications prepare requires --id and --file");
      const packet = repository.readCurrentDocumentPacket(flags.id);
      if (!packet) throw new Error(`Application ${flags.id} requires a current document packet`);
      const input = JSON.parse(await readFile(flags.file, "utf8")) as unknown;
      const workspace = await loadWorkspace(root);
      const locale = input && typeof input === "object" && (input as { locale?: unknown }).locale === "de" ? "de" : "en";
      const asOfDate = dateOnlyInTimeZone(new Date(), "Europe/Berlin");
      const matrix = prepareApplicationAnswerMatrix(input, workspace.profile as Record<string, unknown>, asOfDate, locale);
      const directory = join(root, ...packet.directory.split("/"));
      const destination = join(directory, "application-answers.json");
      const temporary = join(directory, `.application-answers.${process.pid}.tmp`);
      await writeFile(temporary, `${JSON.stringify({ job_id: flags.id, as_of_date: asOfDate, ...matrix }, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      const nextAction = matrix.blockers.length
        ? `Resolve answer-matrix blockers: ${matrix.blockers.join("; ")}`
        : "Review prepared answer matrix; Submit still requires task-specific approval.";
      repository.updateApplicationCheckpoint(flags.id, nextAction, `Prepared ${join(packet.directory, "application-answers.json").replace(/\\/g, "/")}`);
      console.log(JSON.stringify({ job_id: flags.id, file: join(packet.directory, "application-answers.json").replace(/\\/g, "/"), blockers: matrix.blockers, submit_authorized: false }, null, 2));
      return;
    }
    if (command === "set") {
      const statuses = ["shortlisted", "ready_for_review", "user_submitted", "interview", "offer", "rejected", "withdrawn"] as const;
      if (!flags.id || !flags.status || !statuses.includes(flags.status as ApplicationStatus)) throw new Error(`applications set requires --id and --status (${statuses.join("|")})`);
      const status = flags.status as ApplicationStatus;
      const explicitlyConfirmed = flags.confirm === true;
      console.log(JSON.stringify(repository.setApplicationStatus(flags.id, status, { nextAction: flags.next, note: flags.note, actor: explicitlyConfirmed ? "user_confirmed_cli" : "user", confirmed: explicitlyConfirmed }), null, 2));
      return;
    }
    throw new Error("Usage: applications <set|list|history|prepare>");
  } finally { db.close(); }
}

async function runReport(root: string, command: string | undefined, arguments_: string[]): Promise<void> {
  if (command !== "daily") throw new Error("Usage: report daily");
  parseFlags(arguments_, [], "report daily");
  const { db, repository } = openRepository(root);
  try {
    const date = new Date().toISOString().slice(0, 10);
    const activity = repository.dailyActivity(date);
    const applications = repository.listApplications();
    const evaluated = repository.listEvaluatedJobIds(200).flatMap((id) => {
      const job = repository.readJob(id); const evaluation = repository.readEvaluation(id);
      return job && evaluation ? [{ id, job, evaluation }] : [];
    });
    const reviewQueue = evaluated.filter(({ evaluation }) =>
      evaluation.verdict !== "BLOCKED"
      && !evaluation.gates.some((gate) => gate.status === "BLOCKED")).slice(0, 5);
    console.log(`# Daily job-search report — ${date}\n`);
    console.log(`Imported today: ${activity.imported} | Evaluated today: ${activity.evaluated} | Application updates today: ${activity.application_events}`);
    console.log(`Tracked applications: ${applications.length} | Statuses: ${Object.entries(activity.statuses).map(([status, count]) => `${status}=${count}`).join(", ") || "none"} | Model-review items shown: ${reviewQueue.length}\n`);
    console.log("## Model review queue");
    console.log(reviewQueue.length ? reviewQueue.map(({ id, job, evaluation }) => {
      const matches = evaluation.mappings.filter((mapping) => mapping.evidenceIds.length > 0).length;
      const verify = evaluation.gates.filter((gate) => gate.status === "VERIFY").map((gate) => gate.reason).slice(0, 2).join("; ") || "no open verification gates";
      return `- ${job.title ?? "Unknown role"} — ${job.company ?? "Unknown company"}: ${matches} evidence candidates; verify: ${verify}; model decides Apply/Maybe/Skip [${id}]`;
    }).join("\n") : "- No non-blocked vacancies waiting for model review.");
    console.log("\n## Next actions");
    const actions = applications.filter((item) => item.next_action).slice(0, 3).map((item) => `- ${item.next_action} [${item.job_id}]`);
    console.log(actions.length ? actions.join("\n") : "- Review the model queue and verify shift, salary, and workplace details.");
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "setup") {
    parseFlags(arguments_, [], "setup");
    console.log(JSON.stringify(await setupWorkspace(process.cwd()), null, 2));
    return;
  }
  if (command === "doctor") {
    const flags = parseFlags(arguments_, ["strict"], "doctor");
    const report = await runDoctor(process.cwd(), flags.strict === true);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
    return;
  }
  if (command === "capabilities") {
    parseFlags(arguments_, [], "capabilities");
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
    await runReport(process.cwd(), arguments_[0], arguments_.slice(1)); return;
  }
  throw new Error("Usage: bun run scripts/cli.ts <setup|doctor|capabilities|job|search|documents|applications|report>");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
