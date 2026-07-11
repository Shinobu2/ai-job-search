import type { Database } from "bun:sqlite";

export interface ProvenanceSnapshot {
  source_type: string;
  source_ref: string;
}

export interface JobImportInput {
  source: {
    id: string;
    sourceType: string;
    rawContent: string;
    rawHash: string;
    sourceLocator?: string;
    suppliedUrl?: string;
    importedAt: string;
    provenance: ProvenanceSnapshot[];
  };
  job: {
    id: string;
    sourceId: string;
    title?: string;
    company?: string;
    location?: string;
    rawSnapshotHash: string;
    provenance: ProvenanceSnapshot[];
  };
}

export interface EvaluationInput {
  id: string;
  jobId: string;
  runKey: string;
  semanticFingerprint: string;
  evaluatorVersion: string;
  provenance: ProvenanceSnapshot[];
  requirements: Array<Record<string, unknown> & { id: string }>;
  evidenceMappings: EvidenceMappingInput[];
  gateResults: Array<Record<string, unknown> & { id: string }>;
  fitScores: Array<Record<string, unknown> & { id: string }>;
  survivalScores: Array<Record<string, unknown> & { id: string }>;
  applicationTiers: Array<Record<string, unknown> & { id: string }>;
  recommendations: Array<Record<string, unknown> & { id: string }>;
}

export interface StoredJob {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
}

export interface EvidenceMappingInput {
  id: string;
  requirementId: string;
  evidenceIds: string[];
  evidenceSnapshotHash: string;
  provenance: ProvenanceSnapshot[];
}

const hashPattern = /^[a-f0-9]{64}$/;

function isProvenance(value: unknown): value is ProvenanceSnapshot[] {
  return Array.isArray(value) && value.every((entry) => typeof entry?.source_type === "string" && typeof entry?.source_ref === "string");
}

function requireValue(value: unknown, label: string): asserts value {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
}

function requireHash(value: string, label: string): void {
  if (!hashPattern.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function now(): string {
  return new Date().toISOString();
}

export class StorageRepository {
  constructor(private readonly db: Database) {}

  findJobByCanonicalUrl(canonicalUrl: string): StoredJob | null {
    return this.db.query("SELECT j.id, j.title, j.company, j.location FROM jobs j JOIN job_sources s ON s.id = j.source_id WHERE s.supplied_url = ?").get(canonicalUrl) as StoredJob | null;
  }

  findJobBySourceId(sourceId: string): StoredJob | null {
    return this.db.query("SELECT j.id, j.title, j.company, j.location FROM jobs j JOIN job_sources s ON s.id = j.source_id WHERE s.source_locator = ?").get(`source-id:${sourceId}`) as StoredJob | null;
  }

  findJobByNormalizedTriple(title: string, company: string, location: string): StoredJob | null {
    const rows = this.db.query("SELECT id, title, company, location FROM jobs").all() as StoredJob[];
    const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    return rows.find((row) => row.title !== null && row.company !== null && row.location !== null
      && normalize(row.title) === normalize(title)
      && normalize(row.company) === normalize(company)
      && normalize(row.location) === normalize(location)) ?? null;
  }

  findJobByRawHash(rawHash: string): StoredJob | null {
    return this.db.query("SELECT j.id, j.title, j.company, j.location FROM jobs j JOIN job_sources s ON s.id = j.source_id WHERE s.raw_hash = ?").get(rawHash) as StoredJob | null;
  }

  importJob(input: JobImportInput): { id: string; existing: boolean } {
    requireValue(input.source.id, "source.id");
    requireValue(input.job.id, "job.id");
    if (input.job.sourceId !== input.source.id) throw new Error("job.sourceId must reference source.id");
    requireHash(input.source.rawHash, "source.rawHash");
    requireHash(input.job.rawSnapshotHash, "job.rawSnapshotHash");
    if (!isProvenance(input.source.provenance) || !isProvenance(input.job.provenance)) throw new Error("source and job provenance are required");

    const write = this.db.transaction(() => {
      const hasBom = input.source.rawContent.startsWith("\ufeff");
      this.db.query(
        `INSERT INTO job_sources (id, source_type, raw_content, raw_hash, source_locator, supplied_url, imported_at, provenance_json, created_at) VALUES (?, ?, ${hasBom ? "char(65279) || ?" : "?"}, ?, ?, ?, ?, ?, ?)`,
      ).run(input.source.id, input.source.sourceType, hasBom ? input.source.rawContent.slice(1) : input.source.rawContent, input.source.rawHash, input.source.sourceLocator ?? null, input.source.suppliedUrl ?? null, input.source.importedAt, JSON.stringify(input.source.provenance), now());
      this.db.query(
        "INSERT INTO jobs (id, source_id, title, company, location, raw_snapshot_hash, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.job.id, input.job.sourceId, input.job.title ?? null, input.job.company ?? null, input.job.location ?? null, input.job.rawSnapshotHash, JSON.stringify(input.job.provenance), now());
      this.event("job.imported", "job", input.job.id, "system", null, null, { source_id: input.source.id });
    });
    write.immediate();
    return { id: input.job.id, existing: false };
  }

  persistEvaluation(input: EvaluationInput): { id: string; existing: boolean } {
    requireValue(input.id, "evaluation.id");
    requireValue(input.jobId, "evaluation.jobId");
    requireValue(input.runKey, "evaluation.runKey");
    requireValue(input.evaluatorVersion, "evaluation.evaluatorVersion");
    requireHash(input.semanticFingerprint, "evaluation.semanticFingerprint");
    if (!isProvenance(input.provenance)) throw new Error("evaluation provenance is required");
    for (const group of [input.requirements, input.evidenceMappings, input.gateResults, input.fitScores, input.survivalScores, input.applicationTiers, input.recommendations]) {
      if (!Array.isArray(group) || group.some((row) => typeof row.id !== "string" || row.id.length === 0)) throw new Error("every derived row requires an id");
    }
    for (const mapping of input.evidenceMappings) this.validateMapping(mapping);

    const write = this.db.transaction(() => {
      const existing = this.db.query("SELECT id FROM evaluation_runs WHERE run_key = ?").get(input.runKey) as { id: string } | null;
      if (existing) return { id: existing.id, existing: true };
      const createdAt = now();
      this.db.query(
        "INSERT INTO evaluation_runs (id, job_id, run_key, semantic_fingerprint, created_at, evaluator_version, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.jobId, input.runKey, input.semanticFingerprint, createdAt, input.evaluatorVersion, JSON.stringify(input.provenance));
      this.insertDerived("extracted_requirements", input.requirements, input, createdAt);
      this.insertMappings(input.evidenceMappings, input, createdAt);
      this.insertDerived("gate_results", input.gateResults, input, createdAt);
      this.insertDerived("fit_scores", input.fitScores, input, createdAt);
      this.insertDerived("survival_scores", input.survivalScores, input, createdAt);
      this.insertDerived("application_tiers", input.applicationTiers, input, createdAt);
      this.insertDerived("recommendations", input.recommendations, input, createdAt);
      this.event("evaluation.persisted", "evaluation_run", input.id, "system", null, null, { run_key: input.runKey });
      return { id: input.id, existing: false };
    });
    return write.immediate() as { id: string; existing: boolean };
  }

  private insertDerived(table: string, rows: Array<Record<string, unknown> & { id: string }>, input: EvaluationInput, createdAt: string): void {
    const query = this.db.query(`INSERT INTO ${table} (id, evaluation_run_id, payload_json, created_at, evaluator_version, provenance_json) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of rows) query.run(row.id, input.id, JSON.stringify(row), createdAt, input.evaluatorVersion, JSON.stringify(input.provenance));
  }

  private insertMappings(rows: EvaluationInput["evidenceMappings"], input: EvaluationInput, createdAt: string): void {
    const query = this.db.query("INSERT INTO evidence_mappings (id, evaluation_run_id, requirement_id, evidence_ids_json, evidence_snapshot_hash, payload_json, created_at, evaluator_version, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      const payload = {
        id: row.id,
        requirement_id: row.requirementId,
        evidence_ids: row.evidenceIds,
        evidence_snapshot_hash: row.evidenceSnapshotHash,
        provenance: row.provenance,
      };
      query.run(row.id, input.id, row.requirementId, JSON.stringify(row.evidenceIds), row.evidenceSnapshotHash, JSON.stringify(payload), createdAt, input.evaluatorVersion, JSON.stringify(row.provenance));
    }
  }

  private validateMapping(mapping: EvidenceMappingInput): void {
    const allowed = new Set(["id", "requirementId", "evidenceIds", "evidenceSnapshotHash", "provenance"]);
    if (Object.keys(mapping).some((key) => !allowed.has(key))) throw new Error("evidence mapping contains unsupported fields");
    requireValue(mapping.id, "evidenceMapping.id");
    requireValue(mapping.requirementId, "evidenceMapping.requirementId");
    if (!Array.isArray(mapping.evidenceIds) || mapping.evidenceIds.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error("evidenceMapping.evidenceIds must contain evidence IDs");
    }
    requireHash(mapping.evidenceSnapshotHash, "evidenceSnapshotHash");
    if (!isProvenance(mapping.provenance)) throw new Error("evidence mapping provenance is required");
  }

  private event(eventType: string, entityType: string, entityId: string, actor: string, reason: string | null, reportHash: string | null, payload: Record<string, unknown>): void {
    this.db.query("INSERT INTO event_history (event_type, entity_type, entity_id, actor, reason, report_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(eventType, entityType, entityId, actor, reason, reportHash, JSON.stringify(payload), now());
  }
}
