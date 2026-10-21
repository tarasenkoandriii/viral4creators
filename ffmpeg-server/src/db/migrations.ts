/**
 * Миграции SQLite. Индекс в массиве + 1 = PRAGMA user_version после
 * применения. Существующие миграции не редактировать — только добавлять.
 *
 * Приватность: исходные URL и команды — только в payload_enc (AEAD);
 * idempotency key хранится sha256-хешем; токены выдачи — sha256-хешем.
 */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','succeeded','failed','canceled')),
  stage TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  execution_status TEXT CHECK (execution_status IN ('succeeded','failed','canceled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  queue_deadline_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  expires_at INTEGER,
  pipeline_deadline_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id TEXT,
  retry_inputs_from TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  purge_requested_at INTEGER,
  purged_at INTEGER,
  payload_enc TEXT,
  payload_key_id TEXT,
  payload_redacted INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  fingerprint_key_id TEXT NOT NULL,
  limits_revision INTEGER NOT NULL,
  progress REAL,
  input_names TEXT NOT NULL,
  output_names TEXT NOT NULL,
  inputs_metadata TEXT,
  outputs_metadata TEXT,
  ffmpeg_version TEXT,
  image_digest TEXT,
  exit_code INTEGER,
  stderr_tail TEXT,
  wall_ms INTEGER,
  cpu_ms INTEGER,
  peak_rss_kb INTEGER,
  input_bytes INTEGER,
  output_bytes INTEGER
);
CREATE INDEX jobs_status_seq ON jobs (status, seq);
CREATE INDEX jobs_client_status_seq ON jobs (client_id, status, seq);
CREATE INDEX jobs_created ON jobs (created_at);
CREATE INDEX jobs_finished ON jobs (finished_at);
CREATE INDEX jobs_expires ON jobs (expires_at) WHERE expires_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX jobs_operation ON jobs (client_operation_id, created_at);
CREATE INDEX jobs_error ON jobs (error_code, created_at);

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fingerprint_key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, key_hash)
);
CREATE INDEX idem_created ON idempotency_keys (created_at);
CREATE INDEX idem_job ON idempotency_keys (job_id);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','canceled','interrupted')),
  outcome TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  executor_started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  signal TEXT,
  wall_ms INTEGER,
  cpu_ms INTEGER,
  peak_rss_kb INTEGER,
  UNIQUE (job_id, n)
);
CREATE INDEX attempts_status ON attempts (status);

CREATE TABLE artifacts (
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  purged_at INTEGER,
  PRIMARY KEY (job_id, name)
);
CREATE INDEX artifacts_live ON artifacts (purged_at);

CREATE TABLE download_tokens (
  hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  file TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tokens_job ON download_tokens (job_id);
CREATE INDEX tokens_expires ON download_tokens (expires_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX events_job ON events (job_id, id);
CREATE INDEX events_at ON events (at);

CREATE TABLE control_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('active','paused','drained','recovery')),
  revision INTEGER NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE limits_history (
  revision INTEGER PRIMARY KEY,
  profile TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  actor TEXT,
  reason TEXT
);
`,
];
