CREATE TABLE IF NOT EXISTS telemetry_sessions (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    data TEXT NOT NULL,
    FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_environment_started
    ON telemetry_sessions(environment_id, started_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    severity TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES telemetry_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_environment_occurred
    ON telemetry_events(environment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_occurred
    ON telemetry_events(session_id, occurred_at ASC);
