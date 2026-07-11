import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";

const provenance = [{ source_type: "system", source_ref: "storage-test" }];
const sourceHash = "a".repeat(64);

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-storage-"));
  const path = join(directory, "control-room.sqlite");
  const db = openDatabase(path);
  migrate(db);
  return { directory, path, db, repository: new StorageRepository(db) };
}

async function importJob(repository: StorageRepository, suffix = "one") {
  return repository.importJob({
    source: {
      id: `source_${suffix}`,
      sourceType: "pasted_text",
      rawContent: "Technician trainee",
      rawHash: sourceHash,
      importedAt: "2026-07-11T00:00:00.000Z",
      provenance,
    },
    job: {
      id: `job_${suffix}`,
      sourceId: `source_${suffix}`,
      rawSnapshotHash: sourceHash,
      provenance,
    },
  });
}

test("importJob persists a source and job atomically across a reopen", async () => {
  const fixture = await repository();
  try {
    await importJob(fixture.repository);
    fixture.db.close();

    const reopened = openDatabase(fixture.path);
    try {
      expect(reopened.query("SELECT id FROM jobs WHERE id = 'job_one'").get()).toEqual({ id: "job_one" });
      expect(reopened.query("SELECT event_type FROM event_history WHERE entity_id = 'job_one'").get()).toEqual({ event_type: "job.imported" });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
test("a child write failure rolls an import back without a partial source", async () => {
  const fixture = await repository();
  try {
    await importJob(fixture.repository, "existing");
    expect(() =>
      fixture.repository.importJob({
        source: {
          id: "source_rolled_back",
          sourceType: "pasted_text",
          rawContent: "Other source",
          rawHash: sourceHash,
          importedAt: "2026-07-11T00:00:00.000Z",
          provenance,
        },
        job: { id: "job_existing", sourceId: "source_rolled_back", rawSnapshotHash: sourceHash, provenance },
      }),
    ).toThrow();
    expect(fixture.db.query("SELECT id FROM job_sources WHERE id = 'source_rolled_back'").get()).toBeNull();
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("persistEvaluation returns the existing immutable run for a repeated run key", async () => {
  const fixture = await repository();
  try {
    await importJob(fixture.repository);
    const input = {
      id: "evaluation_one",
      jobId: "job_one",
      runKey: "run_abc",
      semanticFingerprint: "b".repeat(64),
      evaluatorVersion: "stage1-test",
      provenance,
      requirements: [],
      evidenceMappings: [],
      gateResults: [],
      fitScores: [],
      survivalScores: [],
      applicationTiers: [],
      recommendations: [],
    };
    expect(fixture.repository.persistEvaluation(input)).toEqual({ id: "evaluation_one", existing: false });
    expect(fixture.repository.persistEvaluation({ ...input, id: "evaluation_other" })).toEqual({ id: "evaluation_one", existing: true });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get()).toEqual({ count: 1 });
    expect(() => fixture.db.run("DELETE FROM event_history")).toThrow("append-only");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
