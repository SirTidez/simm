ALTER TABLE environments ADD COLUMN normalized_output_dir TEXT;

UPDATE environments
-- Keep the migration itself platform-neutral. Startup reconciliation applies
-- Windows case/separator folding only in Windows builds; POSIX builds retain
-- case-sensitive path identity.
SET normalized_output_dir = RTRIM(output_dir, '/')
WHERE output_dir IS NOT NULL;

-- Preserve every displaced row and its metadata before merging duplicate
-- install-path identities into the deterministic keeper.
CREATE TABLE IF NOT EXISTS environment_duplicate_quarantine (
    id TEXT PRIMARY KEY,
    keeper_environment_id TEXT NOT NULL,
    output_dir TEXT NOT NULL,
    normalized_output_dir TEXT NOT NULL,
    data TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS environment_duplicate_mod_metadata_quarantine (
    environment_id TEXT NOT NULL,
    keeper_environment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    data TEXT NOT NULL,
    quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (environment_id, kind, file_name)
);

INSERT OR IGNORE INTO environment_duplicate_quarantine (
    id, keeper_environment_id, output_dir, normalized_output_dir, data, reason
)
SELECT duplicate.id,
       keeper.id,
       duplicate.output_dir,
       duplicate.normalized_output_dir,
       duplicate.data,
       'duplicate normalized install path'
FROM environments duplicate
JOIN environments keeper
  ON keeper.normalized_output_dir = duplicate.normalized_output_dir
 AND keeper.id = (
     SELECT MIN(candidate.id)
     FROM environments candidate
     WHERE candidate.normalized_output_dir = duplicate.normalized_output_dir
 )
WHERE duplicate.normalized_output_dir IS NOT NULL
  AND duplicate.normalized_output_dir <> ''
  AND duplicate.id <> keeper.id;

INSERT OR IGNORE INTO environment_duplicate_mod_metadata_quarantine (
    environment_id, keeper_environment_id, kind, file_name, data
)
SELECT metadata.environment_id,
       quarantined.keeper_environment_id,
       metadata.kind,
       metadata.file_name,
       metadata.data
FROM mod_metadata metadata
JOIN environment_duplicate_quarantine quarantined
  ON quarantined.id = metadata.environment_id;

INSERT OR IGNORE INTO mod_metadata (environment_id, kind, file_name, data)
SELECT quarantined.keeper_environment_id,
       metadata.kind,
       metadata.file_name,
       metadata.data
FROM mod_metadata metadata
JOIN environment_duplicate_quarantine quarantined
  ON quarantined.id = metadata.environment_id;

DELETE FROM mod_metadata
WHERE environment_id IN (SELECT id FROM environment_duplicate_quarantine);

DELETE FROM environments
WHERE id IN (SELECT id FROM environment_duplicate_quarantine);

CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_normalized_output_dir_unique
    ON environments(normalized_output_dir)
    WHERE normalized_output_dir IS NOT NULL
      AND normalized_output_dir <> '';

CREATE INDEX IF NOT EXISTS idx_environments_normalized_output_dir
    ON environments(normalized_output_dir);
