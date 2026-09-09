CREATE TABLE IF NOT EXISTS telemetry_mod_rules (
    id TEXT PRIMARY KEY,
    mod_key TEXT NOT NULL,
    -- An empty value represents an all-environments rule. A non-empty value is an environment ID.
    environment_id TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL CHECK (mode IN ('share', 'local_only', 'ignore')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(mod_key, environment_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_mod_rules_environment
    ON telemetry_mod_rules(environment_id, mod_key);
