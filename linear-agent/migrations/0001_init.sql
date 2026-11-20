-- Webhook events, unique on their dedup key (created:<session>, prompted:<activity>, delivery:<id>).
-- project_id: NULL = not looked up yet or the lookup failed; '' = the issue has no project.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  delivery_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('created', 'prompted')),
  session_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  identifier TEXT,
  title TEXT,
  url TEXT,
  prompt TEXT,
  signal TEXT,
  project_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project_id ON events (project_id, id);
