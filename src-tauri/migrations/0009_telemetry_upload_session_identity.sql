CREATE TABLE IF NOT EXISTS telemetry_upload_sessions (
    session_id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL,
    FOREIGN KEY(queue_id) REFERENCES telemetry_upload_queue(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_upload_sessions_queue
    ON telemetry_upload_sessions(queue_id);
