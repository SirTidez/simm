CREATE TABLE IF NOT EXISTS telemetry_upload_queue (
    id TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_upload_queue_state_created
    ON telemetry_upload_queue(state, created_at DESC);
