CREATE INDEX IF NOT EXISTS idx_jobs_source_id ON jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_job_id ON evaluation_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_event_history_entity ON event_history(entity_type, entity_id);
