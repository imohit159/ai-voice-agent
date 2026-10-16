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

  // 3: call attempts, scheduling and the result-delivery outbox.
  `ALTER TABLE call_requests ADD COLUMN next_attempt_at TEXT;
  UPDATE call_requests SET next_attempt_at = not_before WHERE status = 'pending';
  CREATE INDEX call_requests_due ON call_requests(status, next_attempt_at);

  CREATE TABLE call_attempts (
    id TEXT PRIMARY KEY,
    call_request_id TEXT NOT NULL REFERENCES call_requests(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
    status TEXT NOT NULL CHECK (status IN
      ('dialing', 'ringing', 'in_progress', 'unknown', 'completed', 'no_answer', 'busy', 'failed')),
    provider TEXT NOT NULL,
    provider_call_id TEXT UNIQUE,
    ai_config TEXT NOT NULL CHECK (json_valid(ai_config)),
    outcome TEXT CHECK (outcome IN ('confirmed', 'cancel_requested', 'change_requested',
      'callback_requested', 'wrong_person', 'needs_follow_up')),
    outcome_summary TEXT,
    callback_at TEXT,
    failure_reason TEXT,
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    UNIQUE (call_request_id, attempt_number)
  );
  CREATE UNIQUE INDEX call_attempts_one_live_per_request ON call_attempts(call_request_id)
    WHERE status IN ('dialing', 'ringing', 'in_progress', 'unknown');
  CREATE INDEX call_attempts_live ON call_attempts(status, started_at)
    WHERE status IN ('dialing', 'ringing', 'in_progress', 'unknown');

  CREATE TABLE result_deliveries (
    event_id TEXT PRIMARY KEY,
    call_request_id TEXT NOT NULL REFERENCES call_requests(id),
    attempt_id TEXT UNIQUE REFERENCES call_attempts(id),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX result_deliveries_due ON result_deliveries(status, next_attempt_at);`,

  // 4: providers such as Plivo identify the connected call leg separately from the dial request.
  `ALTER TABLE call_attempts ADD COLUMN provider_leg_id TEXT;
  CREATE UNIQUE INDEX call_attempts_provider_leg ON call_attempts(provider_leg_id)
    WHERE provider_leg_id IS NOT NULL;`,

  // 5: voice-agent sessions and their transcripts. The legacy calls/transcripts
  // tables are no longer read but are kept until their history is archived.
  `ALTER TABLE call_attempts ADD COLUMN voice_session_started_at TEXT;
  ALTER TABLE call_attempts ADD COLUMN voice_session_ended_at TEXT;
  CREATE INDEX call_attempts_started ON call_attempts(started_at);
  CREATE TABLE transcript_entries (
    id INTEGER PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES call_attempts(id),
    role TEXT NOT NULL CHECK (role IN ('customer', 'agent')),
    text TEXT NOT NULL,
    spoken_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX transcript_entries_attempt ON transcript_entries(attempt_id, id);`,
];
