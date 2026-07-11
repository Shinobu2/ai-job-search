CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE job_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  raw_hash TEXT NOT NULL CHECK(length(raw_hash) = 64),
  source_locator TEXT,
  supplied_url TEXT,
  imported_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES job_sources(id),
  title TEXT,
  company TEXT,
  location TEXT,
  raw_snapshot_hash TEXT NOT NULL CHECK(length(raw_snapshot_hash) = 64),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE evaluation_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_key TEXT NOT NULL UNIQUE,
  semantic_fingerprint TEXT NOT NULL CHECK(length(semantic_fingerprint) = 64),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE extracted_requirements (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE evidence_mappings (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  requirement_id TEXT,
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  evidence_snapshot_hash TEXT NOT NULL CHECK(length(evidence_snapshot_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE gate_results (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE fit_scores (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE survival_scores (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE application_tiers (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unavailable', 'implemented', 'tested', 'certified', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  report_hash TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER event_history_no_update
BEFORE UPDATE ON event_history
BEGIN
  SELECT RAISE(ABORT, 'event_history is append-only');
END;
CREATE TRIGGER event_history_no_delete
BEFORE DELETE ON event_history
BEGIN
  SELECT RAISE(ABORT, 'event_history is append-only');
END;
