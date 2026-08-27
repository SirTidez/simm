CREATE TABLE IF NOT EXISTS environment_deletion_journal (
    environment_id TEXT PRIMARY KEY,
    original_path TEXT NOT NULL,
    staged_path TEXT NOT NULL UNIQUE,
    environment_data TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('planned', 'staged', 'metadata_deleted', 'restore_required')
    ),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_environment_deletion_journal_state
    ON environment_deletion_journal(state);
