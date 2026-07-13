CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
  counters_json TEXT NOT NULL CHECK(json_valid(counters_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE logical_vacancies (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  consecutive_misses INTEGER NOT NULL DEFAULT 0,
  lifecycle_status TEXT NOT NULL
);

CREATE TABLE vacancy_versions (
  logical_vacancy_id TEXT NOT NULL REFERENCES logical_vacancies(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  version INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(logical_vacancy_id, version)
);

CREATE TABLE discovery_observations (
  run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  logical_vacancy_id TEXT NOT NULL REFERENCES logical_vacancies(id),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id, logical_vacancy_id)
);

CREATE INDEX discovery_runs_scope_idx ON discovery_runs(source_id, scope_hash, status);
CREATE INDEX discovery_observations_vacancy_idx ON discovery_observations(logical_vacancy_id, run_id);
