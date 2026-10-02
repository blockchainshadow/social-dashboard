CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  password_hash TEXT NOT NULL,
  salt TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  must_rotate INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username),
  version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('initial','full','refresh')),
  item TEXT NOT NULL,
  username TEXT NOT NULL REFERENCES users(username),
  status TEXT NOT NULL CHECK(status IN ('queued','accepted','cancelled')),
  created_at TEXT NOT NULL,
  local_job_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS queued_request ON requests(handle,kind) WHERE status='queued';
