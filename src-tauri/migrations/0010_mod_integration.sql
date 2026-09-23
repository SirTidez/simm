CREATE TABLE IF NOT EXISTS mod_integration_config (
    environment_id TEXT PRIMARY KEY,
    policy TEXT NOT NULL DEFAULT 'disabled'
        CHECK (policy IN ('disabled', 'ask', 'automatic')),
    token_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mod_integration_requests (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    operation TEXT NOT NULL
        CHECK (operation IN ('checkForUpdate', 'requestUpdate')),
    status TEXT NOT NULL,
    mod_file_name TEXT NOT NULL,
    mod_name TEXT NOT NULL,
    current_version TEXT,
    target_version TEXT,
    source TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mod_integration_requests_environment_status
    ON mod_integration_requests(environment_id, status, updated_at DESC);
