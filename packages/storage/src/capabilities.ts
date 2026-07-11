import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export type CapabilityStatus = "unavailable" | "implemented" | "tested" | "certified" | "disabled";
export interface Capability { id: string; label: string; status: CapabilityStatus }
export interface TransitionMetadata { actor: string; reason: string; reportHash: string }
export interface CertificationMetadata extends TransitionMetadata { passing: boolean }

const hashPattern = /^[a-f0-9]{64}$/;

function definitions(): Capability[] {
  const definitionsPath = join(import.meta.dir, "../../../config/capability-definitions.json");
  const parsed: unknown = JSON.parse(readFileSync(definitionsPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 17) throw new Error("Capability definitions must contain exactly 17 entries");
  return parsed as Capability[];
}

function validateMetadata(metadata: TransitionMetadata): void {
  if (!metadata.actor || !metadata.reason || !hashPattern.test(metadata.reportHash)) throw new Error("Capability transition requires actor, reason, and SHA-256 report hash");
}

export class CapabilityRegistry {
  constructor(private readonly db: Database) {}

  seed(): void {
    const insert = this.db.query("INSERT OR IGNORE INTO capabilities (id, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const timestamp = new Date().toISOString();
    for (const capability of definitions()) insert.run(capability.id, capability.label, capability.status, timestamp, timestamp);
  }

  list(): Capability[] {
    return this.db.query("SELECT id, label, status FROM capabilities ORDER BY id").all() as Capability[];
  }

  get(id: string): Capability | undefined {
    return this.db.query("SELECT id, label, status FROM capabilities WHERE id = ?").get(id) as Capability | null ?? undefined;
  }

  getEffectiveMode(_configuredMode: string): "prepare_only" {
    return "prepare_only";
  }

  transition(id: string, target: CapabilityStatus, metadata: TransitionMetadata): Capability {
    validateMetadata(metadata);
    if (target === "certified") throw new Error("Use certify() for certification");
    const current = this.getRequired(id);
    const permitted = target === "disabled" || (current.status === "unavailable" && target === "implemented") || (current.status === "implemented" && target === "tested");
    if (!permitted) throw new Error(`Invalid capability transition from ${current.status} to ${target}`);
    return this.writeTransition(current, target, metadata);
  }

  markTested(id: string, metadata: TransitionMetadata): Capability {
    return this.transition(id, "tested", metadata);
  }

  certify(id: string, metadata: CertificationMetadata): Capability {
    validateMetadata(metadata);
    if (!metadata.passing) throw new Error("Certification requires passing evidence");
    const current = this.getRequired(id);
    if (current.status !== "tested") throw new Error(`Invalid capability transition from ${current.status} to certified`);
    return this.writeTransition(current, "certified", metadata);
  }

  private getRequired(id: string): Capability {
    const capability = this.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    return capability;
  }

  private writeTransition(current: Capability, target: CapabilityStatus, metadata: TransitionMetadata): Capability {
    const write = this.db.transaction(() => {
      this.db.query("UPDATE capabilities SET status = ?, updated_at = ? WHERE id = ?").run(target, new Date().toISOString(), current.id);
      this.db.query("INSERT INTO event_history (event_type, entity_type, entity_id, actor, reason, report_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "capability.transition",
        "capability",
        current.id,
        metadata.actor,
        metadata.reason,
        metadata.reportHash,
        JSON.stringify({ from: current.status, to: target }),
        new Date().toISOString(),
      );
    });
    write.immediate();
    return { ...current, status: target };
  }
}
