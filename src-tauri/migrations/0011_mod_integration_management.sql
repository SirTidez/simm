CREATE TABLE mod_integration_requests_replacement (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    operation TEXT NOT NULL
        CHECK (operation IN ('checkForUpdate', 'requestUpdate', 'requestManagement')),
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

INSERT INTO mod_integration_requests_replacement (
    id, environment_id, operation, status, mod_file_name, mod_name,
    current_version, target_version, source, message, created_at, updated_at
)
SELECT
    id, environment_id, operation, status, mod_file_name, mod_name,
    current_version, target_version, source, message, created_at, updated_at
FROM mod_integration_requests;

DROP TABLE mod_integration_requests;
ALTER TABLE mod_integration_requests_replacement RENAME TO mod_integration_requests;

CREATE INDEX idx_mod_integration_requests_environment_status
    ON mod_integration_requests(environment_id, status, updated_at DESC);
