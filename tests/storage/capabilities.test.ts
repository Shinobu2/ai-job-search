import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "../../packages/storage/src/capabilities";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";

async function registry() {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-capabilities-"));
  const db = openDatabase(join(directory, "control-room.sqlite"));
  migrate(db);
  const capabilityRegistry = new CapabilityRegistry(db);
  capabilityRegistry.seed();
  return { directory, db, capabilityRegistry };
}

test("registry seeds 17 capabilities and forces Stage 1 effective mode to prepare_only", async () => {
  const fixture = await registry();
  try {
    expect(fixture.capabilityRegistry.list()).toHaveLength(17);
    expect(fixture.capabilityRegistry.get("sqlite_storage")?.status).toBe("implemented");
    expect(fixture.capabilityRegistry.get("application_submission")?.status).toBe("disabled");
    expect(fixture.capabilityRegistry.getEffectiveMode("supervised_auto")).toBe("prepare_only");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
test("capabilities require explicit tested and certified transitions with passing evidence", async () => {
  const fixture = await registry();
  try {
    const metadata = { actor: "reviewer", reason: "implemented locally", reportHash: "c".repeat(64) };
    fixture.capabilityRegistry.markTested("manual_job_import", metadata);
    expect(() => fixture.capabilityRegistry.transition("manual_job_import", "certified", metadata)).toThrow("certify");
    expect(() => fixture.capabilityRegistry.certify("manual_job_import", { ...metadata, passing: false })).toThrow("passing");
    fixture.capabilityRegistry.certify("manual_job_import", { ...metadata, passing: true });
    expect(fixture.capabilityRegistry.get("manual_job_import")?.status).toBe("certified");
    expect(() => fixture.capabilityRegistry.transition("manual_job_import", "implemented", metadata)).toThrow("transition");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("disabled read capability requires an explicit audited re-enable transition", async () => {
  const fixture = await registry();
  try {
    const metadata = { actor: "reviewer", reason: "read-only adapters verified", reportHash: "d".repeat(64) };
    fixture.capabilityRegistry.transition("live_connectors", "disabled", metadata);
    expect(fixture.capabilityRegistry.transition("live_connectors", "implemented", metadata).status).toBe("implemented");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
