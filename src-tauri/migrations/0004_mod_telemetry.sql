CREATE TABLE IF NOT EXISTS telemetry_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_snapshots (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_environment_created
    ON telemetry_snapshots(environment_id, created_at DESC);
