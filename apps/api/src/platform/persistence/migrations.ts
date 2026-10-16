// Applied in order and tracked by PRAGMA user_version. A released migration is a
// frozen snapshot: never edit one, append a new migration instead. CHECK lists are
// therefore literal copies of the contract constants at the time of writing.
export const migrations: readonly string[] = [
  // 1: legacy demo schema. IF NOT EXISTS adopts databases created before versioning.
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    mode TEXT NOT NULL, status TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_phone_call ON calls(order_id)
    WHERE mode='phone' AND status IN ('queued','connecting','active','unknown');
  CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id),
    role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS transcript_call ON transcripts(call_id, id);`,

  // 2: business-system call requests.
  `CREATE TABLE call_requests (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('integration', 'practice')),
    use_case TEXT NOT NULL CHECK (use_case IN ('order_confirmation')),
    order_ref TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'in_progress', 'completed', 'exhausted', 'expired')),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
    not_before TEXT NOT NULL,
    not_after TEXT NOT NULL CHECK (not_after > not_before),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX call_requests_one_open_per_order
    ON call_requests(use_case, order_ref) WHERE status IN ('pending', 'in_progress');`,
];
