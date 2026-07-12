import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import type { Database } from "bun:sqlite";

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

function evaluationInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    ...overrides,
  };
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
    const input = evaluationInput();
    expect(fixture.repository.persistEvaluation(input)).toEqual({ id: "evaluation_one", existing: false });
    expect(fixture.repository.persistEvaluation({ ...input, id: "evaluation_other" })).toEqual({ id: "evaluation_one", existing: true });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM evaluation_runs").get()).toEqual({ count: 1 });
    expect(() => fixture.db.run("DELETE FROM event_history")).toThrow("append-only");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("persistEvaluation rejects evidence content outside immutable mapping references", async () => {
  const fixture = await repository();
  try {
    await importJob(fixture.repository);
    const input = evaluationInput({
      requirements: [{ id: "req_one" }],
      evidenceMappings: [{
        id: "mapping_one",
        domainId: "mapping_domain_one",
        requirementId: "req_one",
        domainRequirementId: "requirement_domain_one",
        evidenceIds: ["PC_HARDWARE"],
        evidenceSnapshotHash: "c".repeat(64),
        provenance,
        mutableEvidenceContent: "candidate CV content must never enter SQLite",
      }],
    });

    expect(() => fixture.repository.persistEvaluation(input as never)).toThrow("unsupported");
    expect(fixture.db.query("SELECT id FROM evaluation_runs WHERE id = 'evaluation_one'").get()).toBeNull();
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an evidence mapping requires a persisted requirement and rolls back its evaluation", async () => {
  const fixture = await repository();
  try {
    await importJob(fixture.repository);
    const input = evaluationInput({
      evidenceMappings: [{
        id: "mapping_missing_requirement",
        domainId: "mapping_domain_missing_requirement",
        requirementId: "req_missing",
        domainRequirementId: "requirement_domain_missing",
        evidenceIds: ["ROUTER"],
        evidenceSnapshotHash: "c".repeat(64),
        provenance,
      }],
    });

    expect(() => fixture.repository.persistEvaluation(input as never)).toThrow();
    expect(fixture.db.query("SELECT id FROM evaluation_runs WHERE id = 'evaluation_one'").get()).toBeNull();
    expect(fixture.db.query("SELECT id FROM evidence_mappings WHERE id = 'mapping_missing_requirement'").get()).toBeNull();
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("duplicate run-key lookup is protected by the same immediate transaction as the insert", async () => {
  const fixture = await repository();
  const secondConnection = openDatabase(fixture.path);
  secondConnection.exec("PRAGMA busy_timeout = 0");
  let secondWriteWasBlocked = false;
  let injected = false;
  try {
    await importJob(fixture.repository);
    const competingRepository = new StorageRepository(secondConnection);
    const primaryDatabase = {
      query(sql: string) {
        const statement = fixture.db.query(sql);
        if (sql !== "SELECT id FROM evaluation_runs WHERE run_key = ?") return statement;
        return {
          get(...bindings: Parameters<typeof statement.get>) {
            const result = statement.get(...bindings);
            if (!injected) {
              injected = true;
              try {
                competingRepository.persistEvaluation(evaluationInput({ id: "evaluation_competitor" }));
              } catch (error) {
                secondWriteWasBlocked = error instanceof Error && error.message.includes("database is locked");
              }
            }
            return result;
          },
        };
      },
      transaction: fixture.db.transaction.bind(fixture.db),
    } as unknown as Database;

    const primaryRepository = new StorageRepository(primaryDatabase);
    expect(primaryRepository.persistEvaluation(evaluationInput())).toEqual({ id: "evaluation_one", existing: false });
    expect(secondWriteWasBlocked).toBe(true);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM evaluation_runs WHERE run_key = 'run_abc'").get()).toEqual({ count: 1 });
  } finally {
    secondConnection.close();
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
