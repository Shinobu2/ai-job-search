CREATE TABLE document_packets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_snapshot_hash TEXT NOT NULL,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  evaluation_fingerprint TEXT NOT NULL,
  evidence_snapshot_hash TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL CHECK(json_valid(artifact_hashes_json)),
  ready INTEGER NOT NULL CHECK(ready IN (0,1)),
  directory TEXT NOT NULL,
  created_at TEXT NOT NULL
);
