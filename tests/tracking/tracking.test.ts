import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";

test("tracks only user-confirmed application state with append-only events", () => {
  const db = openDatabase(":memory:"); migrate(db); const repository = new StorageRepository(db);
  repository.importJob({ source: { id: "s", sourceType: "text", rawContent: "# Role", rawHash: "a".repeat(64), importedAt: new Date().toISOString(), provenance: [{ source_type: "system", source_ref: "test" }] }, job: { id: "j", sourceId: "s", rawSnapshotHash: "a".repeat(64), provenance: [{ source_type: "system", source_ref: "test" }] } });
  repository.setApplicationStatus("j", "shortlisted", { nextAction: "Review documents" });
  repository.setApplicationStatus("j", "user_submitted", { note: "Confirmed by user" });
  expect(repository.listApplications()[0]).toMatchObject({ job_id: "j", status: "user_submitted", next_action: "Review documents" });
  expect(db.query("SELECT COUNT(*) AS count FROM application_events").get()).toEqual({ count: 2 });
  expect(repository.dailyActivity(new Date().toISOString().slice(0, 10))).toMatchObject({ imported: 1, application_events: 2, statuses: { user_submitted: 1 } });
  db.close();
});
