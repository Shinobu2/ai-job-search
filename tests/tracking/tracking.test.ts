import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository, type DocumentPacketInput } from "../../packages/storage/src/repository";

const artifactFiles = {
  english_cv: "cv-en.md",
  german_cv: "cv-de.md",
  english_cover_letter: "cover-letter-en.md",
  german_cover_letter: "cover-letter-de.md",
  metadata: "metadata.json",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function persistEvaluation(repository: StorageRepository, jobId: string, suffix = "", fingerprint = "b".repeat(64), evidenceHash = "c".repeat(64)) {
  repository.persistEvaluation({
    id: `evaluation${suffix}`, jobId, runKey: `run${suffix}`, semanticFingerprint: fingerprint, evaluatorVersion: "test", provenance: [{ source_type: "system", source_ref: "test" }],
    requirements: [{ id: `requirement${suffix}` }],
    evidenceMappings: [{ id: `mapping${suffix}`, domainId: "scope", requirementId: `requirement${suffix}`, domainRequirementId: "scope", evidenceIds: ["evidence"], evidenceSnapshotHash: evidenceHash, provenance: [{ source_type: "system", source_ref: "test" }] }],
    gateResults: [], fitScores: [], survivalScores: [], applicationTiers: [], recommendations: [],
  });
}

function addJobAndEvaluation(repository: StorageRepository, suffix = "") {
  const jobId = `j${suffix}`;
  repository.importJob({ source: { id: `s${suffix}`, sourceType: "text", rawContent: "# Role", rawHash: "a".repeat(64), importedAt: new Date().toISOString(), provenance: [{ source_type: "system", source_ref: "test" }] }, job: { id: jobId, sourceId: `s${suffix}`, rawSnapshotHash: "a".repeat(64), provenance: [{ source_type: "system", source_ref: "test" }] } });
  persistEvaluation(repository, jobId, suffix);
  return jobId;
}

function writePacket(root: string, jobId: string, packetId: string) {
  const relativeDirectory = `workspace/documents/${jobId}/${packetId}`;
  const directory = join(root, ...relativeDirectory.split("/"));
  mkdirSync(directory, { recursive: true });
  const artifactHashes: Record<string, string> = {};
  for (const [slot, file] of Object.entries(artifactFiles)) {
    const contents = `${slot}:${packetId}\n`;
    writeFileSync(join(directory, file), contents);
    artifactHashes[slot] = sha256(contents);
  }
  return { directory, relativeDirectory, artifactHashes };
}

function packetInput(packetId: string, relativeDirectory: string, artifactHashes: Record<string, string>): DocumentPacketInput {
  return {
    id: packetId, jobId: "j", jobSnapshotHash: "a".repeat(64), evaluationRunId: "evaluation", evaluationFingerprint: "b".repeat(64),
    evidenceSnapshotHash: "c".repeat(64), artifactHashes, ready: true, directory: relativeDirectory,
  };
}

test("records a packet bound to the exact job, evaluation run, and evidence snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "career-control-room-packet-"));
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db, root);
  try {
    addJobAndEvaluation(repository);
    const files = writePacket(root, "j", "packet");
    expect(() => repository.recordDocumentPacket({ ...packetInput("stale-job", files.relativeDirectory, files.artifactHashes), jobSnapshotHash: "9".repeat(64) })).toThrow("job snapshot");
    expect(() => repository.recordDocumentPacket({ ...packetInput("wrong-run", files.relativeDirectory, files.artifactHashes), evaluationRunId: "forged" })).toThrow("evaluation run");
    expect(() => repository.recordDocumentPacket({ ...packetInput("wrong-evidence", files.relativeDirectory, files.artifactHashes), evidenceSnapshotHash: "9".repeat(64) })).toThrow("evidence snapshot");
    repository.recordDocumentPacket(packetInput("packet", files.relativeDirectory, files.artifactHashes));
    expect(repository.readCurrentDocumentPacket("j")).toMatchObject({
      id: "packet", jobId: "j", jobSnapshotHash: "a".repeat(64), evaluationRunId: "evaluation", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "c".repeat(64), ready: true,
    });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("enforces the repository application state machine and verifies current artifact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "career-control-room-state-"));
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db, root);
  try {
    addJobAndEvaluation(repository);
    expect(() => repository.setApplicationStatus("j", "user_submitted", { confirmed: true })).toThrow("ready_for_review");
    repository.setApplicationStatus("j", "shortlisted", { nextAction: "Review documents" });
    expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("attested current document packet");
    const files = writePacket(root, "j", "packet");
    repository.recordDocumentPacket(packetInput("packet", files.relativeDirectory, files.artifactHashes));
    repository.setApplicationStatus("j", "ready_for_review");
    expect(() => repository.setApplicationStatus("j", "user_submitted")).toThrow("explicit confirmation");
    repository.setApplicationStatus("j", "user_submitted", { confirmed: true, note: "Confirmed by user" });
    repository.setApplicationStatus("j", "interview", { confirmed: true });
    repository.setApplicationStatus("j", "offer", { confirmed: true });
    expect(repository.listApplications()[0]).toMatchObject({ job_id: "j", status: "offer", next_action: "Review documents", document_dir: files.relativeDirectory });
    expect(db.query("SELECT COUNT(*) AS count FROM application_events").get()).toEqual({ count: 5 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rejects modified, missing, and traversal-based artifact packets", () => {
  const root = mkdtempSync(join(tmpdir(), "career-control-room-artifacts-"));
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db, root);
  try {
    addJobAndEvaluation(repository);
    repository.setApplicationStatus("j", "shortlisted");
    const modified = writePacket(root, "j", "packet-a");
    repository.recordDocumentPacket(packetInput("packet-a", modified.relativeDirectory, modified.artifactHashes));
    writeFileSync(join(modified.directory, artifactFiles.english_cv), "modified\n");
    expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("artifact hash mismatch");

    const missing = writePacket(root, "j", "packet-b");
    repository.recordDocumentPacket(packetInput("packet-b", missing.relativeDirectory, missing.artifactHashes));
    unlinkSync(join(missing.directory, artifactFiles.metadata));
    expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("artifact file is missing");

    expect(() => repository.recordDocumentPacket(packetInput("packet-z", "../outside", missing.artifactHashes))).toThrow("safe workspace documents directory");
    expect(() => repository.recordDocumentPacket(packetInput("packet-z", "workspace/documents/other/packet-z", missing.artifactHashes))).toThrow("packet-specific document directory");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rejects a packet after a newer evaluation run with the same fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "career-control-room-stale-"));
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db, root);
  try {
    addJobAndEvaluation(repository);
    repository.setApplicationStatus("j", "shortlisted");
    const files = writePacket(root, "j", "packet");
    repository.recordDocumentPacket(packetInput("packet", files.relativeDirectory, files.artifactHashes));
    persistEvaluation(repository, "j", "-new", "b".repeat(64), "9".repeat(64));
    expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("attested current document packet");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("requires an existing application and confirmation for rejected or withdrawn", () => {
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db);
  addJobAndEvaluation(repository, "-rejected");
  addJobAndEvaluation(repository, "-withdrawn");
  expect(() => repository.setApplicationStatus("j-rejected", "rejected", { confirmed: true })).toThrow("existing application");
  repository.setApplicationStatus("j-rejected", "shortlisted");
  expect(() => repository.setApplicationStatus("j-rejected", "rejected")).toThrow("explicit confirmation");
  repository.setApplicationStatus("j-rejected", "rejected", { confirmed: true });
  repository.setApplicationStatus("j-withdrawn", "shortlisted");
  repository.setApplicationStatus("j-withdrawn", "withdrawn", { confirmed: true });
  expect(repository.listApplications().map((record) => record.status).sort()).toEqual(["rejected", "withdrawn"]);
  db.close();
});
