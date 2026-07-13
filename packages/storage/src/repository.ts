import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { EvaluationResult, EvidenceMapping, Gate } from "../../jobs/src/types";

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

export type DiscoveryRunStatus = "running" | "success" | "partial" | "failed";

export interface DiscoveryRunInput {
  id: string;
  sourceId: string;
  scopeHash: string;
  startedAt?: string;
}

export interface DiscoveryRunFinishInput {
  status: Exclude<DiscoveryRunStatus, "running">;
  counters?: Record<string, number>;
  diagnostics?: unknown[];
  finishedAt?: string;
}

export interface ObservationInput {
  jobId: string;
  rawHash: string;
  canonicalUrl?: string;
  stableSourceId?: string;
  discoveryRunId?: string;
  observedAt?: string;
}

export interface CurrentVacancy {
  logicalVacancyId: string;
  stableKey: string;
  canonicalUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  consecutiveMisses: number;
  lifecycleStatus: string;
  jobId: string;
  version: number;
  title: string | null;
  company: string | null;
  location: string | null;
}

export interface StoredJob {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
}

export interface StoredJobSource extends StoredJob {
  rawContent: string;
  rawSnapshotHash: string;
}

export interface EvidenceMappingInput {
  id: string;
  domainId: string;
  requirementId: string;
  domainRequirementId: string;
  evidenceIds: string[];
  evidenceSnapshotHash: string;
  provenance: ProvenanceSnapshot[];
  mappingStatus?: string;
  credit?: number;
}

export type ApplicationStatus = "shortlisted" | "ready_for_review" | "user_submitted" | "interview" | "offer" | "rejected" | "withdrawn";
export type ApplicationRecord = { job_id: string; status: ApplicationStatus; next_action: string | null; document_dir: string | null; created_at: string; updated_at: string };
export type ApplicationEventRecord = { id: number; job_id: string; status: ApplicationStatus; actor: string; note: string | null; created_at: string };
export type ApplicationOptions = { nextAction?: string; documentDir?: string; actor?: string; note?: string; confirmed?: boolean };
export type DocumentPacketInput = {
  id: string;
  jobId: string;
  jobSnapshotHash: string;
  evaluationRunId: string;
  evaluationFingerprint: string;
  evidenceSnapshotHash: string;
  artifactHashes: Record<string, string>;
  ready: boolean;
  directory: string;
};
export type DocumentPacketRecord = DocumentPacketInput & { createdAt: string };
export type EvaluationAttestation = { evaluationRunId: string; evaluationFingerprint: string; evidenceSnapshotHash: string | null };
export type DailyActivity = { imported: number; evaluated: number; application_events: number; statuses: Record<string, number> };

const hashPattern = /^[a-f0-9]{64}$/;
const pathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const packetArtifactFiles = {
  english_cv: "cv-en.md",
  german_cv: "cv-de.md",
  english_cover_letter: "cover-letter-en.md",
  german_cover_letter: "cover-letter-de.md",
  metadata: "metadata.json",
} as const;

function isProvenance(value: unknown): value is ProvenanceSnapshot[] {
  return Array.isArray(value) && value.every((entry) => typeof entry?.source_type === "string" && typeof entry?.source_ref === "string");
}

function requireValue(value: unknown, label: string): asserts value {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
}

function requireHash(value: string, label: string): void {
  if (!hashPattern.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function requirePathSegment(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !pathSegmentPattern.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function now(): string {
  return new Date().toISOString();
}

function requireIsoTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
}

function normalizeCanonicalUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export class StorageRepository {
  constructor(private readonly db: Database, private readonly workspaceRoot?: string) {}

  startDiscoveryRun(input: DiscoveryRunInput): { id: string; status: "running" } {
    requireValue(input.id, "discoveryRun.id");
    requireValue(input.sourceId, "discoveryRun.sourceId");
    requireValue(input.scopeHash, "discoveryRun.scopeHash");
    const startedAt = input.startedAt ?? now();
    requireIsoTimestamp(startedAt, "discoveryRun.startedAt");
    this.db.query("INSERT INTO discovery_runs (id, source_id, scope_hash, status, counters_json, diagnostics_json, started_at, finished_at) VALUES (?, ?, ?, 'running', '{}', '[]', ?, NULL)")
      .run(input.id, input.sourceId, input.scopeHash, startedAt);
    return { id: input.id, status: "running" };
  }

  startDiscoveryRunAllocated(input: DiscoveryRunInput): { id: string; status: "running" } {
    const maximumAttempts = 100;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const id = attempt === 0 ? input.id : `${input.id}_${attempt}`;
      try {
        return this.startDiscoveryRun({ ...input, id });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_CONSTRAINT_PRIMARYKEY" && code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      }
    }
    throw new Error(`Unable to allocate discovery run ID after ${maximumAttempts} deterministic attempts: ${input.id}`);
  }

  finishDiscoveryRun(runId: string, input: DiscoveryRunFinishInput): void {
    requireValue(runId, "discoveryRun.id");
    const finishedAt = input.finishedAt ?? now();
    requireIsoTimestamp(finishedAt, "discoveryRun.finishedAt");
    const counters = input.counters ?? {};
    const diagnostics = input.diagnostics ?? [];
    const write = this.db.transaction(() => {
      const run = this.db.query("SELECT source_id, scope_hash, status FROM discovery_runs WHERE id = ?").get(runId) as { source_id: string; scope_hash: string; status: DiscoveryRunStatus } | null;
      if (!run) throw new Error(`Unknown discovery run: ${runId}`);
      if (run.status !== "running") throw new Error(`Discovery run ${runId} is already finished`);

      this.db.query("UPDATE discovery_runs SET status = ?, counters_json = ?, diagnostics_json = ?, finished_at = ? WHERE id = ?")
        .run(input.status, JSON.stringify(counters), JSON.stringify(diagnostics), finishedAt, runId);
      this.db.query(
        `UPDATE discovery_memberships
         SET consecutive_misses = 0
         WHERE source_id = ? AND scope_hash = ?
           AND logical_vacancy_id IN (SELECT logical_vacancy_id FROM discovery_observations WHERE run_id = ?)`,
      ).run(run.source_id, run.scope_hash, runId);
      if (input.status === "success") {
        this.db.query(
          `UPDATE discovery_memberships
           SET consecutive_misses = consecutive_misses + 1
           WHERE source_id = ? AND scope_hash = ?
             AND logical_vacancy_id NOT IN (SELECT logical_vacancy_id FROM discovery_observations WHERE run_id = ?)`,
        ).run(run.source_id, run.scope_hash, runId);
      }
      this.db.query(
        `UPDATE logical_vacancies AS vacancy
         SET consecutive_misses = (
               SELECT MIN(membership.consecutive_misses)
               FROM discovery_memberships membership
               WHERE membership.logical_vacancy_id = vacancy.id
             ),
             lifecycle_status = CASE WHEN EXISTS (
               SELECT 1 FROM discovery_memberships membership
               WHERE membership.logical_vacancy_id = vacancy.id AND membership.consecutive_misses < 2
             ) THEN 'active' ELSE 'stale' END
         WHERE EXISTS (
           SELECT 1 FROM discovery_memberships membership
           WHERE membership.logical_vacancy_id = vacancy.id
         )`,
      ).run();
    });
    write.immediate();
  }

  observeVacancy(input: ObservationInput): { logicalVacancyId: string; version: number } {
    const write = this.db.transaction(() => this.observeVacancyRows(input));
    return write.immediate() as { logicalVacancyId: string; version: number };
  }

  private observeVacancyRows(input: ObservationInput): { logicalVacancyId: string; version: number } {
    requireValue(input.jobId, "observation.jobId");
    requireHash(input.rawHash, "observation.rawHash");
    const observedAt = input.observedAt ?? now();
    requireIsoTimestamp(observedAt, "observation.observedAt");
    const canonicalUrl = input.canonicalUrl ? normalizeCanonicalUrl(input.canonicalUrl) : null;
    if (input.stableSourceId !== undefined) requireValue(input.stableSourceId, "observation.stableSourceId");
    const stableKey = canonicalUrl ?? (input.stableSourceId ? `source-id:${input.stableSourceId}` : input.rawHash);
    const logicalVacancyId = `vacancy_${createHash("sha256").update(stableKey).digest("hex")}`;

    const job = this.db.query("SELECT raw_snapshot_hash FROM jobs WHERE id = ?").get(input.jobId) as { raw_snapshot_hash: string } | null;
    if (!job) throw new Error(`Unknown job ID: ${input.jobId}`);
    if (job.raw_snapshot_hash !== input.rawHash) throw new Error("observation rawHash must match the immutable job snapshot");

    const logical = this.db.query("SELECT id FROM logical_vacancies WHERE stable_key = ?").get(stableKey) as { id: string } | null;
    if (!logical) {
      this.db.query("INSERT INTO logical_vacancies (id, stable_key, canonical_url, first_seen_at, last_seen_at, consecutive_misses, lifecycle_status) VALUES (?, ?, ?, ?, ?, 0, 'active')")
        .run(logicalVacancyId, stableKey, canonicalUrl, observedAt, observedAt);
    }
    const resolvedId = logical?.id ?? logicalVacancyId;
    const existingVersion = this.db.query("SELECT logical_vacancy_id, version FROM vacancy_versions WHERE job_id = ?").get(input.jobId) as { logical_vacancy_id: string; version: number } | null;
    if (existingVersion && existingVersion.logical_vacancy_id !== resolvedId) throw new Error(`Job ${input.jobId} is already attached to another logical vacancy`);
    let version = existingVersion?.version;
    if (version === undefined) {
      const latest = this.db.query("SELECT MAX(version) AS version FROM vacancy_versions WHERE logical_vacancy_id = ?").get(resolvedId) as { version: number | null };
      version = (latest.version ?? 0) + 1;
      this.db.query("INSERT INTO vacancy_versions (logical_vacancy_id, job_id, version, observed_at) VALUES (?, ?, ?, ?)")
        .run(resolvedId, input.jobId, version, observedAt);
    }
    this.db.query("UPDATE logical_vacancies SET last_seen_at = ?, consecutive_misses = 0, lifecycle_status = 'active' WHERE id = ?")
      .run(observedAt, resolvedId);
    if (input.discoveryRunId) {
      const run = this.db.query("SELECT status, source_id, scope_hash FROM discovery_runs WHERE id = ?").get(input.discoveryRunId) as { status: DiscoveryRunStatus; source_id: string; scope_hash: string } | null;
      if (!run) throw new Error(`Unknown discovery run: ${input.discoveryRunId}`);
      if (run.status !== "running") throw new Error(`Discovery run ${input.discoveryRunId} is already finished`);
      this.db.query(
        `INSERT INTO discovery_memberships (logical_vacancy_id, source_id, scope_hash, consecutive_misses, last_seen_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(logical_vacancy_id, source_id, scope_hash)
           DO UPDATE SET consecutive_misses = 0, last_seen_at = excluded.last_seen_at`,
      ).run(resolvedId, run.source_id, run.scope_hash, observedAt);
      this.db.query("INSERT OR IGNORE INTO discovery_observations (run_id, logical_vacancy_id, observed_at) VALUES (?, ?, ?)")
        .run(input.discoveryRunId, resolvedId, observedAt);
    }
    return { logicalVacancyId: resolvedId, version };
  }

  listCurrentVacancies(): CurrentVacancy[] {
    return this.db.query(
      `SELECT vacancy.id AS logicalVacancyId, vacancy.stable_key AS stableKey, vacancy.canonical_url AS canonicalUrl,
              vacancy.first_seen_at AS firstSeenAt, vacancy.last_seen_at AS lastSeenAt,
              vacancy.consecutive_misses AS consecutiveMisses, vacancy.lifecycle_status AS lifecycleStatus,
              version.job_id AS jobId, version.version, job.title, job.company, job.location
       FROM logical_vacancies vacancy
       JOIN vacancy_versions version ON version.logical_vacancy_id = vacancy.id
         AND version.version = (SELECT MAX(latest.version) FROM vacancy_versions latest WHERE latest.logical_vacancy_id = vacancy.id)
       JOIN jobs job ON job.id = version.job_id
       ORDER BY vacancy.last_seen_at DESC, vacancy.id`,
    ).all() as CurrentVacancy[];
  }

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

  readJob(jobId: string): StoredJobSource | null {
    return this.db.query("SELECT j.id, j.title, j.company, j.location, j.raw_snapshot_hash AS rawSnapshotHash, s.raw_content AS rawContent FROM jobs j JOIN job_sources s ON s.id = j.source_id WHERE j.id = ?").get(jobId) as StoredJobSource | null;
  }

  readEvaluation(jobId: string): EvaluationResult | null {
    const run = this.db.query("SELECT id, semantic_fingerprint FROM evaluation_runs WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as { id: string; semantic_fingerprint: string } | null;
    if (!run) return null;

    const rows = <T>(table: string): T[] => this.db.query(`SELECT payload_json FROM ${table} WHERE evaluation_run_id = ? ORDER BY rowid`).all(run.id)
      .map((row) => JSON.parse((row as { payload_json: string }).payload_json) as T);
    const legacyGateId = (reason: string): string => {
      if (/Classified as|supported archetypes/i.test(reason)) return "archetype";
      if (/shift|night/i.test(reason)) return "shift";
      if (/car/i.test(reason)) return "transport";
      if (/heavy/i.test(reason)) return "physical";
      if (/warehouse|conveyor/i.test(reason)) return "scope";
      if (/electrical|HVAC|facilities/i.test(reason)) return "facilities";
      if (/German|English|language/i.test(reason)) return "language";
      if (/senior|experience/i.test(reason)) return "experience";
      if (/salary|floor/i.test(reason)) return "salary";
      if (/deadline|expired/i.test(reason)) return "deadline";
      return "legacy_unknown";
    };
    const gates = rows<Omit<Gate, "id"> & { id: string; domain_id?: string }>("gate_results")
      .map(({ id: _storageId, domain_id, ...gate }) => {
        return { ...gate, id: typeof domain_id === "string" && domain_id.length > 0 ? domain_id : legacyGateId(gate.reason) } as Gate;
      });
    const mappings = rows<{ id: string; domain_id?: string; requirement_id: string; domain_requirement_id?: string; evidence_ids: string[]; mapping_status: EvidenceMapping["status"]; credit: number }>("evidence_mappings")
      .map((mapping) => {
        return { id: mapping.domain_id ?? mapping.id, requirementId: mapping.domain_requirement_id ?? mapping.requirement_id, evidenceIds: mapping.evidence_ids, status: mapping.mapping_status, credit: mapping.credit };
      });
    const fit = rows<{ score: number }>("fit_scores")[0]?.score;
    const survival = rows<{ score: number | null }>("survival_scores")[0]?.score;
    const tier = rows<{ tier: EvaluationResult["tier"]; confidence: EvaluationResult["confidence"] }>("application_tiers")[0];
    const recommendation = rows<{ verdict: string }>("recommendations")[0];
    const archetypeGate = gates.find((gate) => gate.id === "archetype");
    const archetype = /^Classified as (AT|BT|A|F)$/.exec(archetypeGate?.reason ?? "")?.[1] as EvaluationResult["archetype"] | undefined;
    if (fit === undefined || !tier || !recommendation || (!archetype && archetypeGate?.status !== "BLOCKED")) {
      throw new Error(`Evaluation ${run.id} is incomplete`);
    }
    return {
      jobId,
      archetype: archetype ?? "X",
      gates,
      mappings,
      fit,
      survival: survival ?? null,
      confidence: tier.confidence,
      tier: tier.tier,
      verdict: recommendation.verdict,
      fingerprint: run.semantic_fingerprint,
    };
  }

  readCurrentEvaluationAttestation(jobId: string): EvaluationAttestation | null {
    const run = this.db.query("SELECT id, semantic_fingerprint FROM evaluation_runs WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as { id: string; semantic_fingerprint: string } | null;
    if (!run) return null;
    const hashes = (this.db.query("SELECT DISTINCT evidence_snapshot_hash FROM evidence_mappings WHERE evaluation_run_id = ?").all(run.id) as Array<{ evidence_snapshot_hash: string }>).map((row) => row.evidence_snapshot_hash);
    if (hashes.length > 1) throw new Error(`Evaluation ${run.id} has inconsistent evidence snapshots`);
    return { evaluationRunId: run.id, evaluationFingerprint: run.semantic_fingerprint, evidenceSnapshotHash: hashes[0] ?? null };
  }

  importJob(input: JobImportInput): { id: string; existing: boolean } {
    this.validateJobImport(input);
    const write = this.db.transaction(() => this.insertJobRows(input));
    write.immediate();
    return { id: input.job.id, existing: false };
  }

  importJobAndObserve(input: JobImportInput, observation: ObservationInput): { id: string; existing: boolean; logicalVacancyId: string; version: number } {
    this.validateJobImport(input);
    if (observation.jobId !== input.job.id) throw new Error("observation.jobId must reference the imported job");
    if (observation.rawHash !== input.job.rawSnapshotHash) throw new Error("observation.rawHash must match the imported job snapshot");
    const write = this.db.transaction(() => {
      const existing = Boolean(this.db.query("SELECT id FROM jobs WHERE id = ?").get(input.job.id));
      if (!existing) this.insertJobRows(input);
      const observed = this.observeVacancyRows(observation);
      return { id: input.job.id, existing, ...observed };
    });
    return write.immediate() as { id: string; existing: boolean; logicalVacancyId: string; version: number };
  }

  private validateJobImport(input: JobImportInput): void {
    requireValue(input.source.id, "source.id");
    requireValue(input.job.id, "job.id");
    if (input.job.sourceId !== input.source.id) throw new Error("job.sourceId must reference source.id");
    requireHash(input.source.rawHash, "source.rawHash");
    requireHash(input.job.rawSnapshotHash, "job.rawSnapshotHash");
    if (!isProvenance(input.source.provenance) || !isProvenance(input.job.provenance)) throw new Error("source and job provenance are required");
  }

  private insertJobRows(input: JobImportInput): void {
    const hasBom = input.source.rawContent.startsWith("\ufeff");
    this.db.query(
      `INSERT INTO job_sources (id, source_type, raw_content, raw_hash, source_locator, supplied_url, imported_at, provenance_json, created_at) VALUES (?, ?, ${hasBom ? "char(65279) || ?" : "?"}, ?, ?, ?, ?, ?, ?)`,
    ).run(input.source.id, input.source.sourceType, hasBom ? input.source.rawContent.slice(1) : input.source.rawContent, input.source.rawHash, input.source.sourceLocator ?? null, input.source.suppliedUrl ?? null, input.source.importedAt, JSON.stringify(input.source.provenance), now());
    this.db.query(
      "INSERT INTO jobs (id, source_id, title, company, location, raw_snapshot_hash, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.job.id, input.job.sourceId, input.job.title ?? null, input.job.company ?? null, input.job.location ?? null, input.job.rawSnapshotHash, JSON.stringify(input.job.provenance), now());
    this.event("job.imported", "job", input.job.id, "system", null, null, { source_id: input.source.id });
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
        domain_id: row.domainId,
        requirement_id: row.requirementId,
        domain_requirement_id: row.domainRequirementId,
        evidence_ids: row.evidenceIds,
        evidence_snapshot_hash: row.evidenceSnapshotHash,
        provenance: row.provenance,
        mapping_status: row.mappingStatus ?? null,
        credit: row.credit ?? null,
      };
      query.run(row.id, input.id, row.requirementId, JSON.stringify(row.evidenceIds), row.evidenceSnapshotHash, JSON.stringify(payload), createdAt, input.evaluatorVersion, JSON.stringify(row.provenance));
    }
  }

  recordDocumentPacket(input: DocumentPacketInput): DocumentPacketRecord {
    requirePathSegment(input.id, "documentPacket.id");
    requirePathSegment(input.jobId, "documentPacket.jobId");
    requireValue(input.directory, "documentPacket.directory");
    requireValue(input.evaluationRunId, "documentPacket.evaluationRunId");
    requireHash(input.jobSnapshotHash, "documentPacket.jobSnapshotHash");
    requireHash(input.evaluationFingerprint, "documentPacket.evaluationFingerprint");
    requireHash(input.evidenceSnapshotHash, "documentPacket.evidenceSnapshotHash");
    if (typeof input.ready !== "boolean") throw new Error("documentPacket.ready must be a boolean");
    const artifactEntries = Object.entries(input.artifactHashes);
    const requiredSlots = Object.keys(packetArtifactFiles);
    if (artifactEntries.length !== requiredSlots.length || requiredSlots.some((slot) => !(slot in input.artifactHashes))) {
      throw new Error("documentPacket requires metadata and four artifact hashes");
    }
    for (const [slot, hash] of artifactEntries) {
      requireValue(slot, "documentPacket artifact slot");
      requireHash(hash, `documentPacket.artifactHashes.${slot}`);
    }
    const job = this.readJob(input.jobId);
    if (!job) throw new Error(`Unknown job ID: ${input.jobId}`);
    if (job.rawSnapshotHash !== input.jobSnapshotHash) throw new Error("document packet requires the matching job snapshot");
    const evaluation = this.db.query("SELECT id FROM evaluation_runs WHERE id = ? AND job_id = ? AND semantic_fingerprint = ?").get(input.evaluationRunId, input.jobId, input.evaluationFingerprint) as { id: string } | null;
    if (!evaluation) throw new Error("document packet requires the matching evaluation run");
    const evidenceHashes = (this.db.query("SELECT DISTINCT evidence_snapshot_hash FROM evidence_mappings WHERE evaluation_run_id = ?").all(evaluation.id) as Array<{ evidence_snapshot_hash: string }>).map((row) => row.evidence_snapshot_hash);
    if ((input.ready && evidenceHashes.length === 0) || evidenceHashes.some((hash) => hash !== input.evidenceSnapshotHash)) {
      throw new Error("document packet requires the matching evidence snapshot");
    }
    if (this.workspaceRoot) this.resolvePacketDirectory(input.directory, false, input.jobId, input.id);

    const createdAt = now();
    const write = this.db.transaction(() => {
      this.db.query("INSERT INTO document_packets (id, job_id, job_snapshot_hash, evaluation_run_id, evaluation_fingerprint, evidence_snapshot_hash, artifact_hashes_json, ready, directory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.id, input.jobId, input.jobSnapshotHash, input.evaluationRunId, input.evaluationFingerprint, input.evidenceSnapshotHash, JSON.stringify(input.artifactHashes), input.ready ? 1 : 0, input.directory, createdAt);
      this.event("document_packet.recorded", "document_packet", input.id, "system", null, null, { job_id: input.jobId, ready: input.ready });
    });
    write.immediate();
    return { ...input, createdAt };
  }

  readCurrentDocumentPacket(jobId: string): DocumentPacketRecord | null {
    const row = this.db.query("SELECT * FROM document_packets WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as {
      id: string; job_id: string; job_snapshot_hash: string; evaluation_run_id: string; evaluation_fingerprint: string; evidence_snapshot_hash: string; artifact_hashes_json: string; ready: number; directory: string; created_at: string;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      jobSnapshotHash: row.job_snapshot_hash,
      evaluationRunId: row.evaluation_run_id,
      evaluationFingerprint: row.evaluation_fingerprint,
      evidenceSnapshotHash: row.evidence_snapshot_hash,
      artifactHashes: JSON.parse(row.artifact_hashes_json) as Record<string, string>,
      ready: row.ready === 1,
      directory: row.directory,
      createdAt: row.created_at,
    };
  }

  setApplicationStatus(jobId: string, status: ApplicationStatus, options: ApplicationOptions = {}): ApplicationRecord {
    if (!this.readJob(jobId)) throw new Error(`Unknown job ID: ${jobId}`);
    const current = this.db.query("SELECT * FROM applications WHERE job_id = ?").get(jobId) as ApplicationRecord | null;
    const external = ["user_submitted", "interview", "offer", "rejected", "withdrawn"].includes(status);
    if ((status === "rejected" || status === "withdrawn") && !current) throw new Error(`${status} requires an existing application`);
    if (external && options.confirmed !== true) throw new Error(`${status} requires explicit confirmation`);

    const requiredCurrent: Partial<Record<ApplicationStatus, ApplicationStatus | null>> = {
      shortlisted: null,
      ready_for_review: "shortlisted",
      user_submitted: "ready_for_review",
      interview: "user_submitted",
      offer: "interview",
    };
    if (status in requiredCurrent && (current?.status ?? null) !== requiredCurrent[status]) {
      throw new Error(`${status} requires current status ${requiredCurrent[status] ?? "none"}`);
    }

    let documentDir = options.documentDir;
    if (status === "ready_for_review") {
      const job = this.readJob(jobId);
      const latestEvaluation = this.readCurrentEvaluationAttestation(jobId);
      const packet = this.readCurrentDocumentPacket(jobId);
      if (!job || !latestEvaluation || !packet || !packet.ready
        || packet.jobSnapshotHash !== job.rawSnapshotHash
        || packet.evaluationRunId !== latestEvaluation.evaluationRunId
        || packet.evaluationFingerprint !== latestEvaluation.evaluationFingerprint
        || packet.evidenceSnapshotHash !== latestEvaluation.evidenceSnapshotHash) {
        throw new Error("ready_for_review requires an attested current document packet");
      }
      this.verifyPacketArtifacts(packet);
      documentDir = packet.directory;
    }
    const timestamp = now();
    const write = this.db.transaction(() => {
      this.db.query(`INSERT INTO applications (job_id, status, next_action, document_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, next_action=COALESCE(excluded.next_action, applications.next_action), document_dir=COALESCE(excluded.document_dir, applications.document_dir), updated_at=excluded.updated_at`)
        .run(jobId, status, options.nextAction ?? null, documentDir ?? null, timestamp, timestamp);
      this.db.query("INSERT INTO application_events (job_id, status, actor, note, created_at) VALUES (?, ?, ?, ?, ?)").run(jobId, status, options.actor ?? "user", options.note ?? null, timestamp);
    });
    write.immediate();
    return this.db.query("SELECT * FROM applications WHERE job_id = ?").get(jobId) as ApplicationRecord;
  }

  listApplications(): ApplicationRecord[] {
    return this.db.query("SELECT * FROM applications ORDER BY updated_at DESC, job_id").all() as ApplicationRecord[];
  }

  listApplicationEvents(jobId: string): ApplicationEventRecord[] {
    return this.db.query("SELECT id, job_id, status, actor, note, created_at FROM application_events WHERE job_id = ? ORDER BY id").all(jobId) as ApplicationEventRecord[];
  }

  listEvaluatedJobIds(limit = 20): string[] {
    return (this.db.query("SELECT job_id FROM evaluation_runs GROUP BY job_id ORDER BY MAX(created_at) DESC LIMIT ?").all(limit) as Array<{ job_id: string }>).map((row) => row.job_id);
  }

  dailyActivity(isoDate: string): DailyActivity {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error("daily activity date must be YYYY-MM-DD");
    const count = (table: string, column: string) => (this.db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE substr(${column}, 1, 10) = ?`).get(isoDate) as { count: number }).count;
    const statuses = Object.fromEntries((this.db.query("SELECT status, COUNT(*) AS count FROM applications GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]));
    return { imported: count("job_sources", "imported_at"), evaluated: count("evaluation_runs", "created_at"), application_events: count("application_events", "created_at"), statuses };
  }

  private validateMapping(mapping: EvidenceMappingInput): void {
    const allowed = new Set(["id", "domainId", "requirementId", "domainRequirementId", "evidenceIds", "evidenceSnapshotHash", "provenance", "mappingStatus", "credit"]);
    if (Object.keys(mapping).some((key) => !allowed.has(key))) throw new Error("evidence mapping contains unsupported fields");
    requireValue(mapping.id, "evidenceMapping.id");
    requireValue(mapping.domainId, "evidenceMapping.domainId");
    requireValue(mapping.requirementId, "evidenceMapping.requirementId");
    requireValue(mapping.domainRequirementId, "evidenceMapping.domainRequirementId");
    if (!Array.isArray(mapping.evidenceIds) || mapping.evidenceIds.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error("evidenceMapping.evidenceIds must contain evidence IDs");
    }
    requireHash(mapping.evidenceSnapshotHash, "evidenceSnapshotHash");
    if (!isProvenance(mapping.provenance)) throw new Error("evidence mapping provenance is required");
    if (mapping.mappingStatus !== undefined && !["proven", "partial", "transferable", "missing", "unknown", "contradicted"].includes(mapping.mappingStatus)) {
      throw new Error("evidenceMapping.mappingStatus is invalid");
    }
    if (mapping.credit !== undefined && (!Number.isInteger(mapping.credit) || mapping.credit < 0 || mapping.credit > 100)) {
      throw new Error("evidenceMapping.credit must be an integer from 0 to 100");
    }
  }

  private resolvePacketDirectory(directory: string, requireExisting: boolean, jobId: string, packetId: string): string {
    if (!this.workspaceRoot) throw new Error("ready_for_review requires a workspace root for artifact verification");
    const documentsRoot = resolve(this.workspaceRoot, "workspace", "documents");
    const packetDirectory = resolve(this.workspaceRoot, directory);
    const relativeDirectory = relative(documentsRoot, packetDirectory);
    if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
      throw new Error("document packet requires a safe workspace documents directory");
    }
    if (relative(resolve(documentsRoot, jobId, packetId), packetDirectory) !== "") {
      throw new Error("document packet requires its packet-specific document directory");
    }
    if (!requireExisting) return packetDirectory;
    let realDocumentsRoot: string;
    let realPacketDirectory: string;
    try {
      realDocumentsRoot = realpathSync(documentsRoot);
      realPacketDirectory = realpathSync(packetDirectory);
    } catch {
      throw new Error("document packet artifact file is missing");
    }
    const realRelative = relative(realDocumentsRoot, realPacketDirectory);
    if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative) || lstatSync(packetDirectory).isSymbolicLink()) {
      throw new Error("document packet requires a safe workspace documents directory");
    }
    return realPacketDirectory;
  }

  private verifyPacketArtifacts(packet: DocumentPacketRecord): void {
    const directory = this.resolvePacketDirectory(packet.directory, true, packet.jobId, packet.id);
    for (const [slot, file] of Object.entries(packetArtifactFiles)) {
      const path = resolve(directory, file);
      let contents: Buffer;
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("symlink");
        contents = readFileSync(path);
      } catch {
        throw new Error(`document packet artifact file is missing: ${slot}`);
      }
      const actualHash = createHash("sha256").update(contents).digest("hex");
      if (actualHash !== packet.artifactHashes[slot]) throw new Error(`document packet artifact hash mismatch: ${slot}`);
    }
  }

  private event(eventType: string, entityType: string, entityId: string, actor: string, reason: string | null, reportHash: string | null, payload: Record<string, unknown>): void {
    this.db.query("INSERT INTO event_history (event_type, entity_type, entity_id, actor, reason, report_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(eventType, entityType, entityId, actor, reason, reportHash, JSON.stringify(payload), now());
  }
}
