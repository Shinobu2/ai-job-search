CREATE TABLE applications (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  status TEXT NOT NULL CHECK(status IN ('shortlisted','ready_for_review','user_submitted','interview','offer','rejected','withdrawn')),
  next_action TEXT,
  document_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
CREATE TRIGGER application_events_no_delete BEFORE DELETE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
