CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    output_dir TEXT NOT NULL,
    data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_environments_output_dir
    ON environments(output_dir);

CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    encrypted TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_metadata (
    environment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (environment_id, kind, file_name)
);

CREATE INDEX IF NOT EXISTS idx_mod_metadata_env_kind
    ON mod_metadata(environment_id, kind);
