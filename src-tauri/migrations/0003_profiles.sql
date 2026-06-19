CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK (runtime IN ('IL2CPP', 'Mono')),
    is_default INTEGER NOT NULL DEFAULT 0,
    manifest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_default_runtime
    ON profiles(runtime)
    WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS idx_profiles_runtime
    ON profiles(runtime);

CREATE TABLE IF NOT EXISTS environment_profiles (
    environment_id TEXT PRIMARY KEY,
    active_profile_id TEXT NOT NULL,
    last_applied_at TEXT,
    FOREIGN KEY(active_profile_id) REFERENCES profiles(id) ON DELETE RESTRICT
);
