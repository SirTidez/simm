ALTER TABLE environments ADD COLUMN normalized_output_dir TEXT;

UPDATE environments
SET normalized_output_dir = LOWER(RTRIM(REPLACE(output_dir, '/', '\\'), '\\'))
WHERE output_dir IS NOT NULL;

DELETE FROM mod_metadata
WHERE environment_id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY normalized_output_dir
                   ORDER BY id
               ) AS rn
        FROM environments
        WHERE normalized_output_dir IS NOT NULL
          AND normalized_output_dir <> ''
    ) ranked
    WHERE rn > 1
);

DELETE FROM environments
WHERE id IN (
    SELECT id
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY normalized_output_dir
                   ORDER BY id
               ) AS rn
        FROM environments
        WHERE normalized_output_dir IS NOT NULL
          AND normalized_output_dir <> ''
    ) ranked
    WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_normalized_output_dir_unique
    ON environments(normalized_output_dir)
    WHERE normalized_output_dir IS NOT NULL
      AND normalized_output_dir <> '';

CREATE INDEX IF NOT EXISTS idx_environments_normalized_output_dir
    ON environments(normalized_output_dir);
