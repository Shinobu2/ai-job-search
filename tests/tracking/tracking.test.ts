import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";

function addJobAndEvaluation(repository: StorageRepository, suffix = "") {
  const jobId = `j${suffix}`;
  repository.importJob({ source: { id: `s${suffix}`, sourceType: "text", rawContent: "# Role", rawHash: "a".repeat(64), importedAt: new Date().toISOString(), provenance: [{ source_type: "system", source_ref: "test" }] }, job: { id: jobId, sourceId: `s${suffix}`, rawSnapshotHash: "a".repeat(64), provenance: [{ source_type: "system", source_ref: "test" }] } });
  repository.persistEvaluation({
    id: `evaluation${suffix}`, jobId, runKey: `run${suffix}`, semanticFingerprint: "b".repeat(64), evaluatorVersion: "test", provenance: [{ source_type: "system", source_ref: "test" }],
    requirements: [{ id: `requirement${suffix}` }],
    evidenceMappings: [{ id: `mapping${suffix}`, domainId: "scope", requirementId: `requirement${suffix}`, domainRequirementId: "scope", evidenceIds: ["evidence"], evidenceSnapshotHash: "c".repeat(64), provenance: [{ source_type: "system", source_ref: "test" }] }],
    gateResults: [], fitScores: [], survivalScores: [], applicationTiers: [], recommendations: [],
  });
  return jobId;
}

test("records the current attested document packet", () => {
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db);
  addJobAndEvaluation(repository);
  expect(() => repository.recordDocumentPacket({
    id: "incomplete", jobId: "j", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "c".repeat(64),
    artifactHashes: { english_cv: "d".repeat(64) }, ready: true, directory: "workspace/documents/j",
  })).toThrow("metadata and four artifact hashes");
  expect(() => repository.recordDocumentPacket({
    id: "wrong-evidence", jobId: "j", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "9".repeat(64),
    artifactHashes: { english_cv: "d".repeat(64), german_cv: "e".repeat(64), english_cover_letter: "f".repeat(64), german_cover_letter: "1".repeat(64), metadata: "2".repeat(64) },
    ready: true, directory: "workspace/documents/j",
  })).toThrow("matching evidence snapshot");
  repository.recordDocumentPacket({
    id: "packet", jobId: "j", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "c".repeat(64),
    artifactHashes: { english_cv: "d".repeat(64), german_cv: "e".repeat(64), english_cover_letter: "f".repeat(64), german_cover_letter: "1".repeat(64), metadata: "2".repeat(64) },
    ready: true, directory: "workspace/documents/j",
  });
  expect(repository.readCurrentDocumentPacket("j")).toMatchObject({
    id: "packet", jobId: "j", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "c".repeat(64), ready: true, directory: "workspace/documents/j",
  });
  expect(repository.readCurrentDocumentPacket("j")?.artifactHashes).toEqual({ english_cv: "d".repeat(64), german_cv: "e".repeat(64), english_cover_letter: "f".repeat(64), german_cover_letter: "1".repeat(64), metadata: "2".repeat(64) });
  db.close();
});

test("enforces the repository application state machine and packet attestation", () => {
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db);
  addJobAndEvaluation(repository);

  expect(() => repository.setApplicationStatus("j", "user_submitted", { confirmed: true })).toThrow("ready_for_review");
  repository.setApplicationStatus("j", "shortlisted", { nextAction: "Review documents" });
  expect(() => repository.setApplicationStatus("j", "ready_for_review")).toThrow("attested current document packet");
  repository.recordDocumentPacket({ id: "packet", jobId: "j", evaluationFingerprint: "b".repeat(64), evidenceSnapshotHash: "c".repeat(64), artifactHashes: { english_cv: "d".repeat(64), german_cv: "e".repeat(64), english_cover_letter: "f".repeat(64), german_cover_letter: "1".repeat(64), metadata: "2".repeat(64) }, ready: true, directory: "workspace/documents/j" });
  repository.setApplicationStatus("j", "ready_for_review");
  expect(() => repository.setApplicationStatus("j", "user_submitted")).toThrow("explicit confirmation");
  repository.setApplicationStatus("j", "user_submitted", { confirmed: true, note: "Confirmed by user" });
  repository.setApplicationStatus("j", "interview", { confirmed: true });
  repository.setApplicationStatus("j", "offer", { confirmed: true });

  expect(repository.listApplications()[0]).toMatchObject({ job_id: "j", status: "offer", next_action: "Review documents", document_dir: "workspace/documents/j" });
  expect(db.query("SELECT COUNT(*) AS count FROM application_events").get()).toEqual({ count: 5 });
  expect(repository.dailyActivity(new Date().toISOString().slice(0, 10))).toMatchObject({ imported: 1, application_events: 5, statuses: { offer: 1 } });
  db.close();
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
