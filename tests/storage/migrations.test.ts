import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../packages/storage/src/migrate";
import { openDatabase } from "../../packages/storage/src/database";

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-storage-"));
  return { directory, path: join(directory, "control-room.sqlite") };
}

test("migrations create the Stage 1 schema, enforce foreign keys, and are repeatable", async () => {
  const temporary = await temporaryDatabase();
  const db = openDatabase(temporary.path);
  try {
    const first = migrate(db);
    const second = migrate(db);

    expect(first.applied).toEqual(["001_stage1.sql", "002_capabilities.sql", "003_evidence_mapping_requirement_fk.sql", "004_application_tracking.sql", "005_document_packets.sql", "006_discovery_ledger.sql"]);
    expect(second.applied).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_history'").get()).toBeDefined();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_packets'").get()).toBeDefined();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_runs'").get()).toBeDefined();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logical_vacancies'").get()).toBeDefined();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vacancy_versions'").get()).toBeDefined();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_observations'").get()).toBeDefined();
    expect((db.query("PRAGMA table_info(document_packets)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "id", "job_id", "job_snapshot_hash", "evaluation_run_id", "evaluation_fingerprint", "evidence_snapshot_hash", "artifact_hashes_json", "ready", "directory", "created_at",
    ]);
    expect((db.query("PRAGMA table_info(discovery_runs)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "id", "source_id", "scope_hash", "status", "counters_json", "diagnostics_json", "started_at", "finished_at",
    ]);
    expect((db.query("PRAGMA table_info(logical_vacancies)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "id", "stable_key", "canonical_url", "first_seen_at", "last_seen_at", "consecutive_misses", "lifecycle_status",
    ]);
    expect((db.query("PRAGMA table_info(vacancy_versions)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "logical_vacancy_id", "job_id", "version", "observed_at",
    ]);
    expect(() =>
      db.run(
        "INSERT INTO jobs (id, source_id, raw_snapshot_hash, provenance_json, created_at) VALUES (?, ?, ?, ?, ?)",
        ["job_missing_source", "missing", "a".repeat(64), "[]", "2026-07-11T00:00:00.000Z"],
      ),
    ).toThrow();
  } finally {
    db.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
test("migrations reject an applied migration whose file checksum changes", async () => {
  const temporary = await temporaryDatabase();
  const db = openDatabase(temporary.path);
  try {
    migrate(db);
    const sourcePath = join(import.meta.dir, "../../packages/storage/migrations/002_capabilities.sql");
    const original = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, `${original}\n-- checksum test mutation\n`, "utf8");
    try {
      expect(() => migrate(db)).toThrow("checksum");
    } finally {
      await writeFile(sourcePath, original, "utf8");
    }
  } finally {
    db.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
