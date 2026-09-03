use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::migrate::MigrateError;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::fs;

use crate::types::{Environment, EnvironmentType, ModMetadata, Settings};

const MIGRATION_FLAG_KEY: &str = "storage.migrated";
const APP_VERSION_KEY: &str = "app.version";
const SQLITE_SIDE_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];
const DEFAULT_DATABASE_BACKUP_COUNT: usize = 10;

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    #[cfg(windows)]
    {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        // POSIX file systems are ordinarily case-sensitive.  Do not collapse
        // `/tmp/Game` and `/tmp/game` merely because a Windows build needs
        // case-insensitive identity.
        trimmed.to_string()
    }
}

#[cfg(test)]
pub async fn initialize_pool() -> Result<Arc<SqlitePool>> {
    let (pool, _) = initialize_pool_with_startup_state().await?;
    Ok(pool)
}

pub async fn initialize_pool_with_startup_state() -> Result<(Arc<SqlitePool>, bool)> {
    let db_path = get_database_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).context("Failed to create database directory")?;
    }

    migrate_legacy_database_if_needed(&db_path)?;
    let database_preexisted = db_path.exists();

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .context("Failed to open SQLite database")?;

    let migrator = sqlx::migrate!();
    maybe_create_startup_backup(&pool, &migrator, database_preexisted).await?;
    reconcile_historical_migration_checksums(&pool, &migrator).await?;
    if let Err(err) = migrator.run(&pool).await {
        match err {
            MigrateError::VersionMismatch(version) => {
                if migration_schema_invariant(&pool, version).await? {
                    log::warn!(
                        "Database migration version mismatch detected for version {}; proceeding because that migration's schema invariant is satisfied",
                        version
                    );
                } else {
                    return Err(MigrateError::VersionMismatch(version))
                        .context("Failed to run database migrations");
                }
            }
            other => return Err(other).context("Failed to run database migrations"),
        }
    }

    ensure_additive_schema(&pool).await?;
    migrate_from_files(&pool).await?;
    set_app_meta_value(&pool, APP_VERSION_KEY, current_app_version()).await?;

    Ok((Arc::new(pool), !database_preexisted))
}

pub fn get_database_path() -> Result<PathBuf> {
    let data_dir = get_data_dir()?;
    Ok(data_dir.join("data.db"))
}

pub fn get_data_dir() -> Result<PathBuf> {
    if let Some(override_path) = get_data_dir_override() {
        return Ok(override_path);
    }

    let (simm_dir, _) = crate::utils::directory_init::initialize_simm_directory()
        .context("Failed to initialize SIMM data directory")?;

    Ok(simm_dir)
}

pub fn get_backups_dir() -> Result<PathBuf> {
    let backups_dir = get_data_dir()?.join("backups");
    std::fs::create_dir_all(&backups_dir).context("Failed to create backups directory")?;
    Ok(backups_dir)
}

fn get_data_dir_override() -> Option<PathBuf> {
    if let Ok(override_dir) = std::env::var("SIMMRUST_DATA_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    None
}

fn legacy_database_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in legacy_data_dirs() {
        paths.push(dir.join("data.db"));
        paths.push(dir.join("simmrust.db"));
    }

    paths
}

fn sqlite_bundle_path(base: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        return base.to_path_buf();
    }

    PathBuf::from(format!("{}{}", base.to_string_lossy(), suffix))
}

fn legacy_migration_marker_path(target_db_path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.legacy-migration",
        target_db_path.to_string_lossy()
    ))
}

fn file_sha256(path: &Path) -> Result<[u8; 32]> {
    let mut file = std::fs::File::open(path).with_context(|| {
        format!(
            "Failed to open database member {} for verification",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).with_context(|| {
            format!(
                "Failed to read database member {} for verification",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn database_members_match(source: &Path, destination: &Path) -> Result<bool> {
    let source_metadata = std::fs::metadata(source).with_context(|| {
        format!(
            "Failed to inspect source database member {}",
            source.display()
        )
    })?;
    let destination_metadata = match std::fs::metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to inspect destination database member {}",
                    destination.display()
                )
            })
        }
    };
    if source_metadata.len() != destination_metadata.len() {
        return Ok(false);
    }
    Ok(file_sha256(source)? == file_sha256(destination)?)
}

fn write_legacy_migration_marker(marker_path: &Path, source_db_path: &Path) -> Result<()> {
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path)
        .with_context(|| {
            format!(
                "Failed to create legacy database migration marker {}",
                marker_path.display()
            )
        })?;
    marker
        .write_all(source_db_path.to_string_lossy().as_bytes())
        .context("Failed to write legacy database migration source identity")?;
    marker
        .sync_all()
        .context("Failed to durably flush legacy database migration marker")?;
    Ok(())
}

fn current_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn sanitize_backup_fragment(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut last_was_separator = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            sanitized.push('-');
            last_was_separator = true;
        }
    }

    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "backup".to_string()
    } else {
        trimmed.to_string()
    }
}

fn backup_file_name(reason: &str) -> String {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
    format!(
        "SIMM-db-backup-{}-{}.db",
        sanitize_backup_fragment(reason),
        timestamp
    )
}

fn backup_file_sort_key(path: &Path) -> std::time::SystemTime {
    let parsed_from_name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .and_then(|stem| stem.strip_prefix("SIMM-db-backup-"))
        .and_then(|stem| stem.get(stem.len().saturating_sub(19)..))
        .and_then(|timestamp| {
            chrono::NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S-%3f").ok()
        })
        .map(|naive| chrono::DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
        .map(std::time::SystemTime::from);

    parsed_from_name.unwrap_or_else(|| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    })
}

fn sqlite_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let cleaned = version.trim().trim_start_matches(['v', 'V']);
    let parts: Vec<u64> = cleaned
        .split('.')
        .map(str::trim)
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;

    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn is_version_increase(previous: &str, current: &str) -> bool {
    match (parse_version_parts(previous), parse_version_parts(current)) {
        (Some(previous_parts), Some(current_parts)) => {
            let max_len = previous_parts.len().max(current_parts.len());
            for index in 0..max_len {
                let previous_value = previous_parts.get(index).copied().unwrap_or(0);
                let current_value = current_parts.get(index).copied().unwrap_or(0);
                match current_value.cmp(&previous_value) {
                    std::cmp::Ordering::Greater => return true,
                    std::cmp::Ordering::Less => return false,
                    std::cmp::Ordering::Equal => continue,
                }
            }
            false
        }
        _ => previous != current,
    }
}

async fn table_exists(pool: &SqlitePool, table_name: &str) -> Result<bool> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table_name)
            .fetch_optional(pool)
            .await
            .context("Failed to inspect database tables")?;

    Ok(exists.is_some())
}

async fn database_has_user_schema(pool: &SqlitePool) -> Result<bool> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(pool)
    .await
    .context("Failed to inspect database schema state")?;

    Ok(!tables.is_empty())
}

async fn get_app_meta_value(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    if !table_exists(pool, "app_meta").await? {
        return Ok(None);
    }

    sqlx::query_scalar("SELECT value FROM app_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .context("Failed to read app metadata")
}

async fn set_app_meta_value(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .context("Failed to write app metadata")?;

    Ok(())
}

async fn get_database_backup_limit(pool: &SqlitePool) -> Result<usize> {
    if !table_exists(pool, "settings").await? {
        return Ok(DEFAULT_DATABASE_BACKUP_COUNT);
    }

    let settings_json: Option<String> =
        sqlx::query_scalar("SELECT data FROM settings WHERE id = 1")
            .fetch_optional(pool)
            .await
            .context("Failed to read backup retention settings")?;

    let Some(settings_json) = settings_json else {
        return Ok(DEFAULT_DATABASE_BACKUP_COUNT);
    };

    let raw_value: serde_json::Value = match serde_json::from_str(&settings_json) {
        Ok(value) => value,
        Err(_) => return Ok(DEFAULT_DATABASE_BACKUP_COUNT),
    };

    let backup_count = raw_value
        .get("databaseBackupCount")
        .and_then(|value| value.as_u64())
        .or_else(|| {
            raw_value
                .get("database_backup_count")
                .and_then(|value| value.as_u64())
        })
        .unwrap_or(DEFAULT_DATABASE_BACKUP_COUNT as u64);

    Ok(backup_count.clamp(1, 100) as usize)
}

async fn prune_old_database_backups(pool: &SqlitePool) -> Result<()> {
    let retention_limit = get_database_backup_limit(pool).await?;
    let backups_dir = get_backups_dir()?;
    let mut backup_files: Vec<PathBuf> = std::fs::read_dir(&backups_dir)
        .with_context(|| format!("Failed to list backups in {}", backups_dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| {
                    name.starts_with("SIMM-db-backup-")
                        && path.extension().and_then(|ext| ext.to_str()) == Some("db")
                })
                .unwrap_or(false)
        })
        .collect();

    if backup_files.len() <= retention_limit {
        return Ok(());
    }

    backup_files.sort_by_key(|path| backup_file_sort_key(path));
    let excess_count = backup_files.len().saturating_sub(retention_limit);
    for path in backup_files.into_iter().take(excess_count) {
        std::fs::remove_file(&path)
            .with_context(|| format!("Failed to remove old backup {}", path.display()))?;
    }

    Ok(())
}

async fn database_requires_migration_backup(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<bool> {
    if !database_has_user_schema(pool).await? {
        return Ok(false);
    }

    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(true);
    }

    let applied_migrations: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(pool)
            .await
            .context("Failed to read applied migration versions")?;

    let expected_migrations: Vec<(i64, Vec<u8>)> = migrator
        .iter()
        .map(|migration| (migration.version, migration.checksum.as_ref().to_vec()))
        .collect();

    Ok(applied_migrations != expected_migrations)
}

/// Normalizes checksums for migrations that are already applied to a database with
/// SIMM's foundational schema. That allows SQLx to apply later migrations instead
/// of treating a historical migration-file revision as a permanent startup error.
async fn reconcile_historical_migration_checksums(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<()> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(());
    }

    let applied: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations")
            .fetch_all(pool)
            .await
            .context("Failed to inspect applied migration checksums")?;

    for (version, checksum) in applied {
        let Some(expected) = migrator
            .iter()
            .find(|migration| migration.version == version)
        else {
            continue;
        };
        if checksum == expected.checksum.as_ref() {
            continue;
        }

        if !migration_schema_invariant(pool, version).await? {
            log::warn!(
                "Refusing to rewrite checksum for migration {} because its schema invariant is not satisfied",
                version
            );
            continue;
        }

        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(expected.checksum.as_ref())
            .bind(version)
            .execute(pool)
            .await
            .with_context(|| format!("Failed to reconcile checksum for migration {version}"))?;
        log::info!(
            "Reconciled historical checksum for applied database migration {}",
            version
        );
    }

    Ok(())
}

async fn column_exists(pool: &SqlitePool, table: &str, column: &str) -> Result<bool> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1")
            .bind(table)
            .bind(column)
            .fetch_optional(pool)
            .await
            .with_context(|| format!("Failed to inspect columns for table {table}"))?;
    Ok(exists.is_some())
}

async fn index_exists(pool: &SqlitePool, index: &str) -> Result<bool> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
            .bind(index)
            .fetch_optional(pool)
            .await
            .with_context(|| format!("Failed to inspect database index {index}"))?;
    Ok(exists.is_some())
}

/// A checksum is reconciled only when the concrete objects introduced by that
/// exact historical migration are present. Merely having the foundational
/// table names is not sufficient evidence that an altered migration ran.
async fn migration_schema_invariant(pool: &SqlitePool, version: i64) -> Result<bool> {
    match version {
        1 => Ok(table_exists(pool, "app_meta").await?
            && column_exists(pool, "app_meta", "value").await?
            && table_exists(pool, "settings").await?
            && column_exists(pool, "settings", "data").await?
            && table_exists(pool, "environments").await?
            && column_exists(pool, "environments", "output_dir").await?
            && column_exists(pool, "environments", "data").await?
            && table_exists(pool, "secrets").await?
            && table_exists(pool, "mod_metadata").await?),
        2 => Ok(
            column_exists(pool, "environments", "normalized_output_dir").await?
                && index_exists(pool, "idx_environments_normalized_output_dir_unique").await?,
        ),
        3 => Ok(table_exists(pool, "profiles").await?
            && table_exists(pool, "environment_profiles").await?
            && index_exists(pool, "idx_profiles_default_runtime").await?),
        4 => Ok(table_exists(pool, "telemetry_preferences").await?
            && table_exists(pool, "telemetry_snapshots").await?),
        5 => Ok(table_exists(pool, "telemetry_sessions").await?
            && table_exists(pool, "telemetry_events").await?),
        6 => Ok(table_exists(pool, "telemetry_upload_queue").await?
            && index_exists(pool, "idx_telemetry_upload_queue_state_created").await?),
        7 => Ok(table_exists(pool, "telemetry_mod_rules").await?),
        8 => Ok(table_exists(pool, "environment_deletion_journal").await?
            && index_exists(pool, "idx_environment_deletion_journal_state").await?),
        _ => Ok(false),
    }
}

async fn maybe_create_startup_backup(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
    database_preexisted: bool,
) -> Result<()> {
    if !database_preexisted || !database_has_user_schema(pool).await? {
        return Ok(());
    }

    let current_version = current_app_version();
    let previous_version = get_app_meta_value(pool, APP_VERSION_KEY).await?;
    let version_increase = previous_version
        .as_deref()
        .map(|previous| is_version_increase(previous, current_version))
        .unwrap_or(true);
    let migration_backup_needed = database_requires_migration_backup(pool, migrator).await?;

    if !version_increase && !migration_backup_needed {
        return Ok(());
    }

    let reason = match (version_increase, migration_backup_needed) {
        (true, true) => "pre-upgrade-migration",
        (true, false) => "pre-version-upgrade",
        (false, true) => "pre-migration",
        (false, false) => return Ok(()),
    };

    let backup_path = create_database_backup(pool, reason).await?;
    log::info!(
        "Created automatic database backup before startup database work: {}",
        backup_path.display()
    );

    Ok(())
}

pub async fn create_database_backup(pool: &SqlitePool, reason: &str) -> Result<PathBuf> {
    let backup_path = get_backups_dir()?.join(backup_file_name(reason));
    let backup_path_str = backup_path.to_string_lossy().to_string();

    let mut connection = pool
        .acquire()
        .await
        .context("Failed to acquire database connection for backup")?;

    if let Err(error) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut *connection)
        .await
    {
        log::warn!("Failed to checkpoint SQLite WAL before backup: {}", error);
    }

    let vacuum_into = format!("VACUUM INTO {}", sqlite_quote_string(&backup_path_str));
    sqlx::query(&vacuum_into)
        .execute(&mut *connection)
        .await
        .with_context(|| {
            format!(
                "Failed to create database backup at {}",
                backup_path.display()
            )
        })?;

    log::info!(
        "Created database backup [{}] at {}",
        sanitize_backup_fragment(reason),
        backup_path.display()
    );

    if let Err(error) = prune_old_database_backups(pool).await {
        log::warn!("Failed to prune old database backups: {}", error);
    }

    Ok(backup_path)
}

pub async fn repair_database(pool: &SqlitePool) -> Result<PathBuf> {
    if !has_expected_schema(pool).await? {
        anyhow::bail!("The foundational SIMM database tables are missing. Restore a database backup before retrying repair.");
    }

    let backup_path = create_database_backup(pool, "pre-repair").await?;
    ensure_additive_schema(pool).await?;
    crate::services::settings::SettingsService::repair_corrupt_settings(pool).await?;
    let migrator = sqlx::migrate!();
    reconcile_historical_migration_checksums(pool, &migrator).await?;
    migrator
        .run(pool)
        .await
        .context("Failed to complete database migrations during repair")?;
    sqlx::query("PRAGMA optimize")
        .execute(pool)
        .await
        .context("Failed to optimize repaired database")?;

    log::info!(
        "Database repair completed using backup {}",
        backup_path.display()
    );
    Ok(backup_path)
}

fn migrate_legacy_database_if_needed(target_db_path: &Path) -> Result<()> {
    let target_normalized = normalize_path(&target_db_path.to_string_lossy());
    let marker_path = legacy_migration_marker_path(target_db_path);
    let candidates = legacy_database_paths();
    let candidate_has_bundle = |candidate: &Path| {
        let candidate_normalized = normalize_path(&candidate.to_string_lossy());
        candidate_normalized != target_normalized
            && std::iter::once("")
                .chain(SQLITE_SIDE_SUFFIXES.iter().copied())
                .any(|suffix| sqlite_bundle_path(candidate, suffix).exists())
    };

    let source = if marker_path.exists() {
        let recorded_source = std::fs::read_to_string(&marker_path).with_context(|| {
            format!(
                "Failed to read legacy database migration marker {}",
                marker_path.display()
            )
        })?;
        let recorded_source = recorded_source.trim();
        if recorded_source.is_empty() {
            anyhow::bail!("Legacy database migration marker has no source identity");
        }
        let recorded_normalized = normalize_path(recorded_source);
        let matched = candidates.into_iter().find(|candidate| {
            normalize_path(&candidate.to_string_lossy()) == recorded_normalized
                && candidate_has_bundle(candidate)
        });
        if matched.is_none() {
            anyhow::bail!(
                "Legacy database migration marker source {} is invalid or no longer available",
                recorded_source
            );
        }
        matched
    } else {
        candidates
            .into_iter()
            .find(|candidate| candidate_has_bundle(candidate))
    };

    let Some(source_db_path) = source else {
        return Ok(());
    };

    let source_main_exists = source_db_path.exists();
    // An already-created target with a complete old source is normally an
    // established current database plus stale historical files.  Resume only
    // when our marker exists (new migration) or when the old implementation
    // left sidecars after moving the source main file.
    if target_db_path.exists() && source_main_exists && !marker_path.exists() {
        return Ok(());
    }

    if let Some(parent) = target_db_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create target directory {}", parent.display()))?;
    }

    log::info!(
        "Migrating SQLite database from {} to {}",
        source_db_path.display(),
        target_db_path.display()
    );

    if !marker_path.exists() {
        write_legacy_migration_marker(&marker_path, &source_db_path)?;
    }

    // A SQLite database and its WAL/SHM/journal are one logical unit.  Never
    // remove a source member while another member is still being copied.  A
    // process death after the main database is copied therefore resumes from
    // the intact legacy bundle rather than permanently suppressing its WAL.
    let mut source_members = Vec::new();
    for suffix in std::iter::once("").chain(SQLITE_SIDE_SUFFIXES.iter().copied()) {
        let src = sqlite_bundle_path(&source_db_path, suffix);
        if src.exists() {
            source_members.push((suffix, src));
        }
    }

    if source_members.is_empty() {
        return Err(anyhow::anyhow!(
            "Legacy database migration candidate found but no files were available"
        ));
    }

    for (suffix, src) in &source_members {
        let dst = sqlite_bundle_path(target_db_path, suffix);
        let target_matches = database_members_match(src, &dst)?;
        if !target_matches {
            let staged = dst.with_extension(format!(
                "{}.migrating",
                dst.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("sqlite")
            ));
            if staged.exists() {
                std::fs::remove_file(&staged).with_context(|| {
                    format!(
                        "Failed to clear incomplete staged database file {}",
                        staged.display()
                    )
                })?;
            }
            std::fs::copy(src, &staged).with_context(|| {
                format!(
                    "Failed to stage database file from {} to {}",
                    src.display(),
                    staged.display()
                )
            })?;
            if !database_members_match(src, &staged)? {
                anyhow::bail!(
                    "Staged database file digest did not match {}",
                    src.display()
                );
            }
            // The legacy source remains untouched until every member has been
            // promoted, so replacing a stale partial target is recoverable on
            // Windows too (where rename does not replace an existing file).
            if dst.exists() {
                std::fs::remove_file(&dst).with_context(|| {
                    format!(
                        "Failed to replace incomplete database member {}",
                        dst.display()
                    )
                })?;
            }
            std::fs::rename(&staged, &dst).with_context(|| {
                format!("Failed to promote staged database file {}", dst.display())
            })?;
            if !database_members_match(src, &dst)? {
                anyhow::bail!(
                    "Promoted database file digest did not match {}",
                    src.display()
                );
            }
        }
    }

    // Only now is every destination member present and verified.  Source
    // cleanup is best effort: retaining an old bundle is safe, losing its WAL
    // before promotion is not.
    for (suffix, src) in source_members {
        let dst = sqlite_bundle_path(target_db_path, suffix);
        if !database_members_match(&src, &dst)? {
            anyhow::bail!(
                "Refusing to remove unmatched legacy database member {}",
                src.display()
            );
        }
        if let Err(error) = std::fs::remove_file(&src) {
            log::warn!(
                "Legacy database member {} was copied but could not be removed: {}",
                src.display(),
                error
            );
        }
    }

    if let Err(error) = std::fs::remove_file(&marker_path) {
        log::warn!(
            "Legacy database migration completed but marker {} could not be removed: {}",
            marker_path.display(),
            error
        );
    }

    Ok(())
}

fn legacy_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(override_path) = get_data_dir_override() {
        if let Some(base) = override_path.parent() {
            dirs.push(base.join("s1devenvmanager"));
            dirs.push(base.join("simmrust"));
            return dirs;
        }
    }

    if let Some(base) = dirs::data_dir() {
        dirs.push(base.join("s1devenvmanager"));
        dirs.push(base.join("simmrust"));
    }
    dirs
}

async fn migrate_from_files(pool: &SqlitePool) -> Result<()> {
    let migrated: Option<String> = sqlx::query_scalar("SELECT value FROM app_meta WHERE key = ?")
        .bind(MIGRATION_FLAG_KEY)
        .fetch_optional(pool)
        .await
        .context("Failed to check migration flag")?;

    if migrated.as_deref() == Some("true") {
        return Ok(());
    }

    let legacy_dirs = legacy_data_dirs();

    let mut settings_migrated = false;
    for dir in &legacy_dirs {
        let path = dir.join("settings.json");
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path).await {
                if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                    let serialized = serde_json::to_string(&settings)?;
                    sqlx::query(
                        "INSERT INTO settings (id, data) VALUES (1, ?) \
                         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                    )
                    .bind(serialized)
                    .execute(pool)
                    .await
                    .context("Failed to migrate settings")?;
                    settings_migrated = true;
                    break;
                } else {
                    log::warn!("Failed to parse settings JSON from {:?}", path);
                }
            }
        }
    }

    let mut environments: Vec<Environment> = Vec::new();
    for dir in &legacy_dirs {
        let path = dir.join("environments.json");
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path).await {
                match serde_json::from_str::<Vec<Environment>>(&content) {
                    Ok(mut envs) => {
                        for env in &mut envs {
                            if env.environment_type.is_none() {
                                env.environment_type = Some(EnvironmentType::DepotDownloader);
                            }
                        }
                        environments = envs;
                        break;
                    }
                    Err(err) => {
                        log::warn!("Failed to parse environments JSON from {:?}: {}", path, err);
                    }
                }
            }
        }
    }

    // Legacy JSON can contain duplicate path spellings.  Persist the first
    // deterministic record and record the skipped IDs before completing the
    // migration, so one conflicting row cannot trap startup in a retry loop.
    let mut imported_paths = std::collections::HashSet::new();
    let mut imported_ids = std::collections::HashSet::new();
    let mut conflicts = Vec::new();
    let mut transaction = pool
        .begin()
        .await
        .context("Failed to start legacy environment migration")?;
    for env in &environments {
        let normalized_output_dir = normalize_path(&env.output_dir);
        if !imported_ids.insert(env.id.clone())
            || !imported_paths.insert(normalized_output_dir.clone())
        {
            conflicts.push(serde_json::json!({
                "id": env.id,
                "outputDir": env.output_dir,
                "reason": "duplicate legacy environment identity or normalized path"
            }));
            continue;
        }

        let serialized = serde_json::to_string(env)?;
        let inserted = sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&env.id)
        .bind(&env.output_dir)
        .bind(&normalized_output_dir)
        .bind(&serialized)
        .execute(&mut *transaction)
        .await;

        match inserted {
            Ok(result) if result.rows_affected() == 1 => {}
            Ok(_) => conflicts.push(serde_json::json!({
                "id": env.id,
                "outputDir": env.output_dir,
                "reason": "environment id already existed"
            })),
            Err(error)
                if error
                    .to_string()
                    .to_lowercase()
                    .contains("unique constraint") =>
            {
                conflicts.push(serde_json::json!({
                    "id": env.id,
                    "outputDir": env.output_dir,
                    "reason": "normalized output path already existed"
                }));
            }
            Err(error) => return Err(error).context("Failed to migrate environments"),
        }
    }
    if !conflicts.is_empty() {
        sqlx::query(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind("storage.migrated.environment_conflicts")
        .bind(serde_json::to_string(&conflicts)?)
        .execute(&mut *transaction)
        .await
        .context("Failed to record legacy environment migration conflicts")?;
        log::warn!(
            "Skipped {} conflicting legacy environment record(s)",
            conflicts.len()
        );
    }
    transaction
        .commit()
        .await
        .context("Failed to commit legacy environment migration")?;

    let mut secrets_written = false;
    for dir in &legacy_dirs {
        secrets_written |=
            migrate_secret_file(pool, dir, "credentials.enc", "steam_credentials").await?;
        secrets_written |=
            migrate_secret_file(pool, dir, "nexus_mods_api_key.enc", "nexus_mods_api_key").await?;
    }

    let mut mod_metadata_migrated = false;
    for env in &environments {
        mod_metadata_migrated |= migrate_mod_metadata_for_env(pool, env, "mods").await?;
        mod_metadata_migrated |= migrate_mod_metadata_for_env(pool, env, "plugins").await?;
    }

    if settings_migrated || !environments.is_empty() || secrets_written || mod_metadata_migrated {
        sqlx::query(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(MIGRATION_FLAG_KEY)
        .bind("true")
        .execute(pool)
        .await
        .context("Failed to set migration flag")?;
    }

    Ok(())
}

async fn has_expected_schema(pool: &SqlitePool) -> Result<bool> {
    let tables: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(pool)
            .await
            .context("Failed to read database schema")?;

    let required = [
        "_sqlx_migrations",
        "app_meta",
        "settings",
        "environments",
        "secrets",
        "mod_metadata",
    ];

    Ok(required
        .iter()
        .all(|table| tables.contains(&table.to_string())))
}

/// Restores additive tables for legacy databases whose historical migration checksum no longer
/// matches the checked-in migration. Those databases intentionally bypass sqlx's migration
/// runner, so later profiles and telemetry migrations would otherwise never be applied.
async fn ensure_additive_schema(pool: &SqlitePool) -> Result<()> {
    const ADDITIVE_SCHEMA_STATEMENTS: &[&str] = &[
        "CREATE TABLE IF NOT EXISTS environment_duplicate_quarantine (\
            id TEXT PRIMARY KEY, \
            keeper_environment_id TEXT NOT NULL, \
            output_dir TEXT NOT NULL, \
            normalized_output_dir TEXT NOT NULL, \
            data TEXT NOT NULL, \
            reason TEXT NOT NULL, \
            quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
        )",
        "CREATE TABLE IF NOT EXISTS environment_duplicate_mod_metadata_quarantine (\
            environment_id TEXT NOT NULL, \
            keeper_environment_id TEXT NOT NULL, \
            kind TEXT NOT NULL, \
            file_name TEXT NOT NULL, \
            data TEXT NOT NULL, \
            quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, \
            PRIMARY KEY (environment_id, kind, file_name)\
        )",
        "CREATE TABLE IF NOT EXISTS settings_quarantine (\
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            settings_id INTEGER NOT NULL, \
            data TEXT NOT NULL, \
            reason TEXT NOT NULL, \
            quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
        )",
        "CREATE TABLE IF NOT EXISTS profiles (\
            id TEXT PRIMARY KEY, \
            name TEXT NOT NULL, \
            runtime TEXT NOT NULL CHECK (runtime IN ('IL2CPP', 'Mono')), \
            is_default INTEGER NOT NULL DEFAULT 0, \
            manifest TEXT NOT NULL, \
            created_at TEXT NOT NULL, \
            updated_at TEXT NOT NULL\
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_default_runtime \
            ON profiles(runtime) WHERE is_default = 1",
        "CREATE INDEX IF NOT EXISTS idx_profiles_runtime ON profiles(runtime)",
        "CREATE TABLE IF NOT EXISTS environment_deletion_journal (\
            environment_id TEXT PRIMARY KEY, \
            original_path TEXT NOT NULL, \
            staged_path TEXT NOT NULL UNIQUE, \
            environment_data TEXT NOT NULL, \
            state TEXT NOT NULL CHECK (state IN ('planned', 'staged', 'metadata_deleted', 'restore_required')), \
            last_error TEXT, \
            created_at TEXT NOT NULL, \
            updated_at TEXT NOT NULL\
        )",
        "CREATE INDEX IF NOT EXISTS idx_environment_deletion_journal_state \
            ON environment_deletion_journal(state)",
        "CREATE TABLE IF NOT EXISTS environment_profiles (\
            environment_id TEXT PRIMARY KEY, \
            active_profile_id TEXT NOT NULL, \
            last_applied_at TEXT, \
            FOREIGN KEY(active_profile_id) REFERENCES profiles(id) ON DELETE RESTRICT\
        )",
        "CREATE TABLE IF NOT EXISTS telemetry_preferences (\
            id INTEGER PRIMARY KEY CHECK (id = 1), \
            data TEXT NOT NULL, \
            updated_at TEXT NOT NULL\
        )",
        "CREATE TABLE IF NOT EXISTS telemetry_snapshots (\
            id TEXT PRIMARY KEY, \
            environment_id TEXT NOT NULL, \
            created_at TEXT NOT NULL, \
            data TEXT NOT NULL, \
            FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE\
        )",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_environment_created \
            ON telemetry_snapshots(environment_id, created_at DESC)",
        "CREATE TABLE IF NOT EXISTS telemetry_sessions (\
            id TEXT PRIMARY KEY, \
            environment_id TEXT NOT NULL, \
            started_at TEXT NOT NULL, \
            ended_at TEXT, \
            data TEXT NOT NULL, \
            FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE\
        )",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_environment_started \
            ON telemetry_sessions(environment_id, started_at DESC)",
        "CREATE TABLE IF NOT EXISTS telemetry_events (\
            id TEXT PRIMARY KEY, \
            session_id TEXT NOT NULL, \
            environment_id TEXT NOT NULL, \
            occurred_at TEXT NOT NULL, \
            severity TEXT NOT NULL, \
            fingerprint TEXT NOT NULL, \
            data TEXT NOT NULL, \
            FOREIGN KEY(session_id) REFERENCES telemetry_sessions(id) ON DELETE CASCADE, \
            FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE\
        )",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_environment_occurred \
            ON telemetry_events(environment_id, occurred_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_occurred \
            ON telemetry_events(session_id, occurred_at ASC)",
        "CREATE TABLE IF NOT EXISTS telemetry_upload_queue (\
            id TEXT PRIMARY KEY, \
            upload_id TEXT NOT NULL UNIQUE, \
            payload TEXT NOT NULL, \
            state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'failed')), \
            attempts INTEGER NOT NULL DEFAULT 0, \
            last_error_code TEXT, \
            created_at TEXT NOT NULL, \
            updated_at TEXT NOT NULL\
        )",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_upload_queue_state_created \
            ON telemetry_upload_queue(state, created_at DESC)",
        "CREATE TABLE IF NOT EXISTS telemetry_mod_rules (\
            id TEXT PRIMARY KEY, \
            mod_key TEXT NOT NULL, \
            environment_id TEXT NOT NULL DEFAULT '', \
            mode TEXT NOT NULL CHECK (mode IN ('share', 'local_only', 'ignore')), \
            created_at TEXT NOT NULL, \
            updated_at TEXT NOT NULL, \
            UNIQUE(mod_key, environment_id)\
        )",
        "CREATE INDEX IF NOT EXISTS idx_telemetry_mod_rules_environment \
            ON telemetry_mod_rules(environment_id, mod_key)",
    ];

    for statement in ADDITIVE_SCHEMA_STATEMENTS {
        sqlx::query(statement)
            .execute(pool)
            .await
            .context("Failed to ensure additive database schema")?;
    }

    // Historical `environment_profiles` rows were not linked to environments.
    // Remove only dangling mappings during startup repair; valid profile rows
    // remain intact and future environment deletion clears its mapping in the
    // same transaction as the environment record.
    sqlx::query(
        "DELETE FROM environment_profiles \
         WHERE environment_id NOT IN (SELECT id FROM environments)",
    )
    .execute(pool)
    .await
    .context("Failed to remove orphan environment profile mappings")?;

    for table in [
        "environment_duplicate_quarantine",
        "environment_duplicate_mod_metadata_quarantine",
        "settings_quarantine",
        "profiles",
        "environment_deletion_journal",
        "environment_profiles",
        "telemetry_preferences",
        "telemetry_snapshots",
        "telemetry_sessions",
        "telemetry_events",
        "telemetry_upload_queue",
        "telemetry_mod_rules",
    ] {
        if !table_exists(pool, table).await? {
            anyhow::bail!("Database repair did not restore required table {table}");
        }
    }

    let quarantined_duplicates: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM environment_duplicate_quarantine")
            .fetch_one(pool)
            .await
            .context("Failed to inspect quarantined duplicate environments")?;
    if quarantined_duplicates > 0 {
        log::warn!(
            "{} duplicate environment record(s) are preserved in the database quarantine after install-path normalization",
            quarantined_duplicates
        );
    }

    Ok(())
}

async fn migrate_secret_file(
    pool: &SqlitePool,
    dir: &Path,
    file_name: &str,
    key: &str,
) -> Result<bool> {
    let path = dir.join(file_name);
    if !path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&path)
        .await
        .with_context(|| format!("Failed to read secret file {}", path.display()))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    sqlx::query(
        "INSERT INTO secrets (key, encrypted) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET encrypted = excluded.encrypted",
    )
    .bind(key)
    .bind(trimmed)
    .execute(pool)
    .await
    .with_context(|| format!("Failed to migrate secret {}", key))?;

    Ok(true)
}

async fn migrate_mod_metadata_for_env(
    pool: &SqlitePool,
    env: &Environment,
    kind: &str,
) -> Result<bool> {
    let metadata_path = if kind == "mods" {
        Path::new(&env.output_dir)
            .join("Mods")
            .join(".mods-metadata.json")
    } else {
        Path::new(&env.output_dir)
            .join("Plugins")
            .join(".plugins-metadata.json")
    };

    if !metadata_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&metadata_path).await.with_context(|| {
        format!(
            "Failed to read {} metadata file {}",
            kind,
            metadata_path.display()
        )
    })?;
    if content.trim().is_empty() {
        return Ok(false);
    }

    let metadata: std::collections::HashMap<String, ModMetadata> =
        match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(err) => {
                log::warn!("Failed to parse {} metadata for {}: {}", kind, env.id, err);
                return Ok(false);
            }
        };

    for (file_name, meta) in metadata {
        let serialized = serde_json::to_string(&meta)?;
        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, ?, ?, ?) \
             ON CONFLICT(environment_id, kind, file_name) DO UPDATE SET data = excluded.data",
        )
        .bind(&env.id)
        .bind(kind)
        .bind(&file_name)
        .bind(serialized)
        .execute(pool)
        .await
        .context("Failed to migrate mod metadata")?;
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EnvironmentStatus, LogLevel, ModSource, Platform, Runtime};
    use serial_test::serial;
    use std::collections::HashMap;
    use tempfile::tempdir;
    use tokio::fs;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }

        fn unset(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn sample_settings(download_dir: &Path) -> Settings {
        Settings {
            default_download_dir: download_dir.to_string_lossy().to_string(),
            depot_downloader_path: Some("C:\\tools\\depotdownloader.exe".to_string()),
            steam_username: Some("tester".to_string()),
            depot_downloader_remembered_session: Some(true),
            max_concurrent_downloads: 3,
            platform: Platform::Windows,
            language: "en".to_string(),
            theme: "light".to_string(),
            melon_loader_version: Some("0.6.0".to_string()),
            auto_install_melon_loader: Some(true),
            enable_security_scanner: Some(true),
            auto_install_security_scanner: Some(true),
            block_critical_scans: Some(true),
            prompt_on_high_scans: Some(true),
            show_security_scan_badges: Some(true),
            update_check_interval: Some(30),
            auto_check_updates: Some(true),
            log_level: Some(LogLevel::Info),
            nexus_mods_api_key: None,
            nexus_mods_rate_limits: None,
            nexus_mods_game_id: Some("123".to_string()),
            nexus_mods_app_slug: Some("schedule-i".to_string()),
            thunderstore_game_id: Some("schedule-i".to_string()),
            auto_update_mods: Some(false),
            mod_update_check_interval: Some(60),
            mod_icon_cache_limit_mb: Some(500),
            database_backup_count: Some(10),
            log_retention_days: Some(7),
            app_update: None,
            experience_mode: None,
            show_advanced_game_tools: None,
            window_close_behavior: None,
            setup_guide_completed: None,
        }
    }

    fn sample_environment(output_dir: &Path) -> Environment {
        Environment {
            id: "env-1".to_string(),
            name: "Test Environment".to_string(),
            description: None,
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: output_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        }
    }

    fn sample_metadata() -> ModMetadata {
        ModMetadata {
            source: Some(ModSource::Local),
            source_id: Some("local-mod".to_string()),
            source_version: Some("1.0.0".to_string()),
            author: Some("Tester".to_string()),
            mod_name: Some("Sample Mod".to_string()),
            source_url: Some("https://example.com/mod".to_string()),
            summary: Some("Sample metadata summary".to_string()),
            icon_url: Some("https://example.com/icon.png".to_string()),
            icon_cache_path: Some("C:/Users/test/SIMM/cache/mod-icons/icon.png".to_string()),
            downloads: Some(100),
            likes_or_endorsements: Some(50),
            updated_at: Some("2026-03-05T00:00:00Z".to_string()),
            tags: Some(vec!["utility".to_string()]),
            installed_version: Some("1.0.0".to_string()),
            library_added_at: None,
            installed_at: None,
            last_update_check: None,
            metadata_last_refreshed: None,
            update_available: Some(false),
            remote_version: None,
            detected_runtime: Some(Runtime::Il2cpp),
            runtime_match: Some(true),
            mod_storage_id: Some("storage-1".to_string()),
            managed_paths: Some(vec!["C:\\mods\\sample".to_string()]),
            security_scan: None,
        }
    }

    #[tokio::test]
    #[serial]
    async fn get_data_dir_uses_override() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let data_dir = get_data_dir()?;
        assert_eq!(data_dir, override_dir);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_backups_dir_uses_the_same_data_root_override() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("custom-data-root");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let backups_dir = get_backups_dir()?;
        assert_eq!(backups_dir, override_dir.join("backups"));
        assert!(backups_dir.is_dir());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_data_dir_defaults_to_simm_home_directory() -> Result<()> {
        let temp = tempdir()?;
        let _data_guard = EnvVarGuard::unset("SIMMRUST_DATA_DIR");
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());

        let data_dir = get_data_dir()?;
        assert_eq!(data_dir, temp.path().join("SIMM"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_migrates_legacy_database_file_to_simm_directory() -> Result<()> {
        let temp = tempdir()?;
        let target_dir = temp.path().join("SIMM");
        let legacy_db_path = temp.path().join("simmrust").join("data.db");

        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", target_dir.to_string_lossy().as_ref());

        if let Some(parent) = legacy_db_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let legacy_options = SqliteConnectOptions::new()
            .filename(&legacy_db_path)
            .create_if_missing(true);
        let legacy_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(legacy_options)
            .await?;

        sqlx::query("CREATE TABLE legacy_marker (value TEXT)")
            .execute(&legacy_pool)
            .await?;
        sqlx::query("INSERT INTO legacy_marker (value) VALUES ('migrated')")
            .execute(&legacy_pool)
            .await?;

        legacy_pool.close().await;

        let pool = initialize_pool().await?;
        let target_db_path = get_database_path()?;

        assert!(target_db_path.exists());
        assert!(!legacy_db_path.exists());

        let marker: String = sqlx::query_scalar("SELECT value FROM legacy_marker LIMIT 1")
            .fetch_one(&*pool)
            .await?;
        assert_eq!(marker, "migrated");

        Ok(())
    }

    #[test]
    #[serial]
    fn legacy_database_migration_resumes_a_partial_target_with_wal_members() -> Result<()> {
        let temp = tempdir()?;
        let target_dir = temp.path().join("SIMM");
        let target = target_dir.join("data.db");
        let source = temp.path().join("simmrust").join("data.db");
        let target_wal = sqlite_bundle_path(&target, "-wal");
        let source_wal = sqlite_bundle_path(&source, "-wal");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", target_dir.to_string_lossy().as_ref());

        std::fs::create_dir_all(source.parent().expect("legacy parent"))?;
        std::fs::create_dir_all(&target_dir)?;
        // Simulate a crash that left stale main and WAL members with exactly
        // the same lengths as their legacy counterparts. Length-only resume
        // checks must not accept either member as already promoted.
        std::fs::write(&source, b"source-main")?;
        std::fs::write(&source_wal, b"source-wal")?;
        std::fs::write(&target, b"target-main")?;
        std::fs::write(&target_wal, b"target-wal")?;
        assert_eq!(
            std::fs::metadata(&source)?.len(),
            std::fs::metadata(&target)?.len()
        );
        assert_eq!(
            std::fs::metadata(&source_wal)?.len(),
            std::fs::metadata(&target_wal)?.len()
        );
        assert!(!database_members_match(&source, &target)?);
        assert!(!database_members_match(&source_wal, &target_wal)?);
        std::fs::write(
            legacy_migration_marker_path(&target),
            source.to_string_lossy().as_bytes(),
        )?;

        migrate_legacy_database_if_needed(&target)?;

        assert_eq!(std::fs::read(&target)?, b"source-main");
        assert_eq!(std::fs::read(&target_wal)?, b"source-wal");
        assert!(!source.exists());
        assert!(!source_wal.exists());
        assert!(!legacy_migration_marker_path(&target).exists());
        Ok(())
    }

    #[test]
    #[serial]
    fn legacy_database_migration_rejects_marker_for_an_unrecognized_source() -> Result<()> {
        let temp = tempdir()?;
        let target_dir = temp.path().join("SIMM");
        let target = target_dir.join("data.db");
        let source = temp.path().join("simmrust").join("data.db");
        let unrecognized_source = temp.path().join("unrecognized").join("data.db");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", target_dir.to_string_lossy().as_ref());

        std::fs::create_dir_all(source.parent().expect("legacy parent"))?;
        std::fs::create_dir_all(unrecognized_source.parent().expect("unrecognized parent"))?;
        std::fs::create_dir_all(&target_dir)?;
        std::fs::write(&source, b"legacy-main")?;
        std::fs::write(&unrecognized_source, b"untrusted!!")?;
        std::fs::write(
            legacy_migration_marker_path(&target),
            unrecognized_source.to_string_lossy().as_bytes(),
        )?;

        let error =
            migrate_legacy_database_if_needed(&target).expect_err("marker must be rejected");

        assert!(error
            .to_string()
            .contains("is invalid or no longer available"));
        assert_eq!(std::fs::read(&source)?, b"legacy-main");
        assert_eq!(std::fs::read(&unrecognized_source)?, b"untrusted!!");
        assert!(!target.exists());
        assert!(legacy_migration_marker_path(&target).exists());
        Ok(())
    }

    #[test]
    #[serial]
    fn legacy_database_migration_does_not_replace_an_established_target() -> Result<()> {
        let temp = tempdir()?;
        let target_dir = temp.path().join("SIMM");
        let target = target_dir.join("data.db");
        let source = temp.path().join("simmrust").join("data.db");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", target_dir.to_string_lossy().as_ref());

        std::fs::create_dir_all(source.parent().expect("legacy parent"))?;
        std::fs::create_dir_all(&target_dir)?;
        std::fs::write(&target, b"current")?;
        std::fs::write(&source, b"legacy")?;

        migrate_legacy_database_if_needed(&target)?;

        assert_eq!(std::fs::read(&target)?, b"current");
        assert_eq!(std::fs::read(&source)?, b"legacy");
        assert!(!legacy_migration_marker_path(&target).exists());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_creates_tables() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        let tables: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(&*pool)
                .await?;

        for table in [
            "app_meta",
            "settings",
            "environments",
            "secrets",
            "mod_metadata",
            "environment_deletion_journal",
            "telemetry_preferences",
            "telemetry_snapshots",
            "telemetry_sessions",
            "telemetry_events",
            "telemetry_upload_queue",
            "telemetry_mod_rules",
        ] {
            assert!(tables.contains(&table.to_string()));
        }

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_repairs_telemetry_schema_after_version_mismatch() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        for table in [
            "telemetry_events",
            "telemetry_sessions",
            "telemetry_snapshots",
            "telemetry_preferences",
            "telemetry_upload_queue",
            "telemetry_mod_rules",
        ] {
            sqlx::query(&format!("DROP TABLE {table}"))
                .execute(&*pool)
                .await?;
        }
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(vec![0_u8; 48])
            .bind(3_i64)
            .execute(&*pool)
            .await?;
        drop(pool);

        let repaired_pool = initialize_pool().await?;
        for table in [
            "telemetry_preferences",
            "telemetry_snapshots",
            "telemetry_sessions",
            "telemetry_events",
            "telemetry_upload_queue",
            "telemetry_mod_rules",
        ] {
            assert!(table_exists(&repaired_pool, table).await?);
        }
        let applied: Vec<(i64, Vec<u8>)> =
            sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&*repaired_pool)
                .await?;
        let expected: Vec<(i64, Vec<u8>)> = sqlx::migrate!()
            .iter()
            .map(|migration| (migration.version, migration.checksum.as_ref().to_vec()))
            .collect();
        assert_eq!(applied, expected);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn repair_database_creates_a_backup_and_restores_additive_tables() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query("DROP TABLE telemetry_events")
            .execute(&*pool)
            .await?;
        sqlx::query("DROP TABLE telemetry_sessions")
            .execute(&*pool)
            .await?;

        let backup_path = repair_database(&pool).await?;
        assert!(backup_path.exists());
        assert!(table_exists(&pool, "telemetry_sessions").await?);
        assert!(table_exists(&pool, "telemetry_events").await?);

        Ok(())
    }

    #[test]
    fn is_version_increase_detects_only_forward_changes() {
        assert!(is_version_increase("0.7.3", "0.7.4"));
        assert!(is_version_increase("0.7.4", "0.8.0"));
        assert!(!is_version_increase("0.7.4", "0.7.4"));
        assert!(!is_version_increase("0.7.5", "0.7.4"));
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_migrates_legacy_files() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let legacy_dir = temp.path().join("s1devenvmanager");
        fs::create_dir_all(&legacy_dir).await?;

        let settings = sample_settings(temp.path());
        let settings_json = serde_json::to_string(&settings)?;
        fs::write(legacy_dir.join("settings.json"), settings_json).await?;

        let env_output_dir = temp.path().join("envs").join("env-1");
        let environment = sample_environment(&env_output_dir);
        let environments_json = serde_json::to_string(&vec![environment.clone()])?;
        fs::write(legacy_dir.join("environments.json"), environments_json).await?;

        let mods_dir = env_output_dir.join("Mods");
        let plugins_dir = env_output_dir.join("Plugins");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;

        let mut mod_metadata = HashMap::new();
        mod_metadata.insert("sample-mod.dll".to_string(), sample_metadata());
        let mods_json = serde_json::to_string(&mod_metadata)?;
        let plugins_json = serde_json::to_string(&mod_metadata)?;

        fs::write(mods_dir.join(".mods-metadata.json"), &mods_json).await?;
        fs::write(plugins_dir.join(".plugins-metadata.json"), &plugins_json).await?;

        fs::write(legacy_dir.join("credentials.enc"), " secret ").await?;
        fs::write(legacy_dir.join("nexus_mods_api_key.enc"), " key ").await?;

        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;

        let stored_settings: Option<String> =
            sqlx::query_scalar("SELECT data FROM settings WHERE id = 1")
                .fetch_optional(&*pool)
                .await?;
        let stored_settings = stored_settings.expect("expected settings row");
        let stored_value: serde_json::Value = serde_json::from_str(&stored_settings)?;
        let expected_value = serde_json::to_value(&settings)?;
        assert_eq!(stored_value, expected_value);

        let stored_env: Option<String> =
            sqlx::query_scalar("SELECT data FROM environments WHERE id = ?")
                .bind("env-1")
                .fetch_optional(&*pool)
                .await?;
        let stored_env = stored_env.expect("expected environment row");
        let deserialized_env: Environment = serde_json::from_str(&stored_env)?;
        assert_eq!(deserialized_env.output_dir, environment.output_dir);
        assert_eq!(
            deserialized_env.environment_type,
            Some(EnvironmentType::DepotDownloader)
        );

        let stored_secret: Option<String> =
            sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
                .bind("steam_credentials")
                .fetch_optional(&*pool)
                .await?;
        assert_eq!(stored_secret.as_deref(), Some("secret"));

        let stored_mod: Option<String> = sqlx::query_scalar(
            "SELECT data FROM mod_metadata WHERE environment_id = ? AND kind = ? AND file_name = ?",
        )
        .bind("env-1")
        .bind("mods")
        .bind("sample-mod.dll")
        .fetch_optional(&*pool)
        .await?;
        let stored_mod = stored_mod.expect("expected mod metadata");
        let stored_mod_value: serde_json::Value = serde_json::from_str(&stored_mod)?;
        let expected_mod_value = serde_json::to_value(sample_metadata())?;
        assert_eq!(stored_mod_value, expected_mod_value);

        let migration_flag: Option<String> =
            sqlx::query_scalar("SELECT value FROM app_meta WHERE key = ?")
                .bind(MIGRATION_FLAG_KEY)
                .fetch_optional(&*pool)
                .await?;
        assert_eq!(migration_flag.as_deref(), Some("true"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_database_backup_writes_snapshot_file() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;

        sqlx::query(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind("backup-test")
        .bind("snapshot")
        .execute(&*pool)
        .await?;

        let backup_path = create_database_backup(&pool, "manual").await?;
        assert!(backup_path.exists());
        assert_eq!(
            backup_path.extension().and_then(|ext| ext.to_str()),
            Some("db")
        );

        let metadata = std::fs::metadata(&backup_path)?;
        assert!(metadata.len() > 0);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_creates_backup_when_app_version_increases() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query(
            "INSERT INTO app_meta (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(APP_VERSION_KEY)
        .bind("0.7.3")
        .execute(&*pool)
        .await?;
        pool.close().await;

        let _reopened = initialize_pool().await?;
        let backups_dir = get_backups_dir()?;
        let backup_files: Vec<_> = std::fs::read_dir(backups_dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.contains("pre-version-upgrade"))
                    .unwrap_or(false)
            })
            .collect();

        assert!(!backup_files.is_empty());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn initialize_pool_creates_backup_when_existing_db_has_no_app_version() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query("DELETE FROM app_meta WHERE key = ?")
            .bind(APP_VERSION_KEY)
            .execute(&*pool)
            .await?;
        pool.close().await;

        let _reopened = initialize_pool().await?;
        let backups_dir = get_backups_dir()?;
        let backup_files: Vec<_> = std::fs::read_dir(backups_dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.contains("pre-version-upgrade"))
                    .unwrap_or(false)
            })
            .collect();

        assert!(!backup_files.is_empty());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn database_requires_migration_backup_detects_checksum_mismatch() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(vec![0_u8; 48])
            .bind(1_i64)
            .execute(&*pool)
            .await?;

        let migrator = sqlx::migrate!();
        assert!(database_requires_migration_backup(&pool, &migrator).await?);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn checksum_reconciliation_requires_the_specific_migration_schema() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query("DROP TABLE environment_profiles")
            .execute(&*pool)
            .await?;
        let mismatched = vec![0_u8; 48];
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(&mismatched)
            .bind(3_i64)
            .execute(&*pool)
            .await?;

        let migrator = sqlx::migrate!();
        reconcile_historical_migration_checksums(&pool, &migrator).await?;
        let retained: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                .bind(3_i64)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(retained, mismatched);

        Ok(())
    }

    #[tokio::test]
    async fn normalized_path_migration_quarantines_duplicates_and_merges_metadata() -> Result<()> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::raw_sql(include_str!("../migrations/0001_init.sql"))
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
            .bind("a-keeper")
            .bind(r"C:\Games\Schedule I")
            .bind(r#"{"id":"a-keeper"}"#)
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
            .bind("b-duplicate")
            .bind("c:/games/schedule i/")
            .bind(r#"{"id":"b-duplicate"}"#)
            .execute(&pool)
            .await?;
        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, ?, ?, ?)",
        )
        .bind("b-duplicate")
        .bind("mods")
        .bind("OnlyOnDuplicate.dll")
        .bind(r#"{"enabled":true}"#)
        .execute(&pool)
        .await?;

        sqlx::raw_sql(include_str!(
            "../migrations/0002_environments_normalized_output_dir.sql"
        ))
        .execute(&pool)
        .await?;

        let active_ids: Vec<String> = sqlx::query_scalar("SELECT id FROM environments ORDER BY id")
            .fetch_all(&pool)
            .await?;
        assert_eq!(active_ids, vec!["a-keeper"]);
        let quarantined_data: String =
            sqlx::query_scalar("SELECT data FROM environment_duplicate_quarantine WHERE id = ?")
                .bind("b-duplicate")
                .fetch_one(&pool)
                .await?;
        assert_eq!(quarantined_data, r#"{"id":"b-duplicate"}"#);
        let merged_metadata: String = sqlx::query_scalar(
            "SELECT data FROM mod_metadata WHERE environment_id = ? AND file_name = ?",
        )
        .bind("a-keeper")
        .bind("OnlyOnDuplicate.dll")
        .fetch_one(&pool)
        .await?;
        assert_eq!(merged_metadata, r#"{"enabled":true}"#);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_database_backup_prunes_old_snapshots_using_settings_limit() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        sqlx::query(
            "INSERT INTO settings (id, data) VALUES (1, ?) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(
            serde_json::json!({
                "defaultDownloadDir": "C:\\Users\\SirTidez\\SIMM",
                "maxConcurrentDownloads": 2,
                "platform": "windows",
                "language": "english",
                "theme": "modern-blue",
                "databaseBackupCount": 1,
            })
            .to_string(),
        )
        .execute(&*pool)
        .await?;

        let first_backup = create_database_backup(&pool, "manual").await?;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let second_backup = create_database_backup(&pool, "manual").await?;

        assert!(!first_backup.exists());
        assert!(second_backup.exists());

        let backups_dir = get_backups_dir()?;
        let backup_files: Vec<_> = std::fs::read_dir(backups_dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("db"))
            .collect();

        assert_eq!(backup_files.len(), 1);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn database_crud_round_trip() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;

        let env_dir = temp.path().join("envs").join("env-2");
        let env = sample_environment(&env_dir);
        let serialized_env = serde_json::to_string(&env)?;
        let normalized_output_dir = normalize_path(&env.output_dir);

        sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?)",
        )
        .bind(&env.id)
        .bind(&env.output_dir)
        .bind(&normalized_output_dir)
        .bind(&serialized_env)
        .execute(&*pool)
        .await?;

        let stored_env: String = sqlx::query_scalar("SELECT data FROM environments WHERE id = ?")
            .bind(&env.id)
            .fetch_one(&*pool)
            .await?;
        let stored_value: serde_json::Value = serde_json::from_str(&stored_env)?;
        assert_eq!(stored_value, serde_json::to_value(&env)?);

        let updated_env = Environment {
            output_dir: temp
                .path()
                .join("envs")
                .join("env-2b")
                .to_string_lossy()
                .to_string(),
            ..env.clone()
        };
        let updated_serialized = serde_json::to_string(&updated_env)?;
        let updated_normalized_output_dir = normalize_path(&updated_env.output_dir);
        sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, normalized_output_dir = excluded.normalized_output_dir, data = excluded.data",
        )
        .bind(&updated_env.id)
        .bind(&updated_env.output_dir)
        .bind(&updated_normalized_output_dir)
        .bind(&updated_serialized)
        .execute(&*pool)
        .await?;

        let stored_output: String =
            sqlx::query_scalar("SELECT output_dir FROM environments WHERE id = ?")
                .bind(&updated_env.id)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(stored_output, updated_env.output_dir);

        let metadata = sample_metadata();
        let metadata_json = serde_json::to_string(&metadata)?;
        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, ?, ?, ?)",
        )
        .bind(&updated_env.id)
        .bind("mods")
        .bind("example.dll")
        .bind(&metadata_json)
        .execute(&*pool)
        .await?;

        let stored_metadata: String = sqlx::query_scalar(
            "SELECT data FROM mod_metadata WHERE environment_id = ? AND kind = ? AND file_name = ?",
        )
        .bind(&updated_env.id)
        .bind("mods")
        .bind("example.dll")
        .fetch_one(&*pool)
        .await?;
        let stored_metadata_value: serde_json::Value = serde_json::from_str(&stored_metadata)?;
        assert_eq!(stored_metadata_value, serde_json::to_value(&metadata)?);

        sqlx::query("INSERT INTO secrets (key, encrypted) VALUES (?, ?)")
            .bind("test-secret")
            .bind("secret-data")
            .execute(&*pool)
            .await?;

        let stored_secret: String =
            sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
                .bind("test-secret")
                .fetch_one(&*pool)
                .await?;
        assert_eq!(stored_secret, "secret-data");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn environments_enforce_normalized_output_dir_uniqueness() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;

        let first_dir = "C:/Games/Schedule I";
        let second_dir = "C:\\Games\\Schedule I\\";

        sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?)",
        )
        .bind("env-a")
        .bind(first_dir)
        .bind(normalize_path(first_dir))
        .bind("{}")
        .execute(&*pool)
        .await?;

        let duplicate_result = sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?)",
        )
        .bind("env-b")
        .bind(second_dir)
        .bind(normalize_path(second_dir))
        .bind("{}")
        .execute(&*pool)
        .await;

        assert!(duplicate_result.is_err());

        Ok(())
    }
}
