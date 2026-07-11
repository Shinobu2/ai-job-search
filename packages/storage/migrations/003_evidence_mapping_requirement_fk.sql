CREATE TABLE evidence_mappings_with_requirement_fk (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  requirement_id TEXT REFERENCES extracted_requirements(id),
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  evidence_snapshot_hash TEXT NOT NULL CHECK(length(evidence_snapshot_hash) = 64),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);

INSERT INTO evidence_mappings_with_requirement_fk (
  id, evaluation_run_id, requirement_id, evidence_ids_json,
  evidence_snapshot_hash, payload_json, created_at, evaluator_version,
  provenance_json
)
SELECT
  id, evaluation_run_id, requirement_id, evidence_ids_json,
  evidence_snapshot_hash, payload_json, created_at, evaluator_version,
  provenance_json
FROM evidence_mappings;

DROP TABLE evidence_mappings;
ALTER TABLE evidence_mappings_with_requirement_fk RENAME TO evidence_mappings;
