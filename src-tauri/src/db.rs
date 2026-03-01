use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use sqlx::migrate::MigrateError;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::fs;

use crate::types::{Environment, EnvironmentType, ModMetadata, Settings};

const MIGRATION_FLAG_KEY: &str = "storage.migrated";
const SQLITE_SIDE_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

pub async fn initialize_pool() -> Result<Arc<SqlitePool>> {
    let db_path = get_database_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).context("Failed to create database directory")?;
    }

    migrate_legacy_database_if_needed(&db_path)?;

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
    if let Err(err) = migrator.run(&pool).await {
        match err {
            MigrateError::VersionMismatch(version) => {
                if has_expected_schema(&pool).await? {
                    log::warn!(
                        "Database migration version mismatch detected for version {}; proceeding with existing schema",
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

    migrate_from_files(&pool).await?;

    Ok(Arc::new(pool))
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

fn migrate_legacy_database_if_needed(target_db_path: &Path) -> Result<()> {
    if target_db_path.exists() {
        return Ok(());
    }

    let target_normalized = normalize_path(&target_db_path.to_string_lossy());
    let source = legacy_database_paths()
        .into_iter()
        .find(|candidate| {
            let candidate_normalized = normalize_path(&candidate.to_string_lossy());
            candidate_normalized != target_normalized && candidate.exists()
        });

    let Some(source_db_path) = source else {
        return Ok(());
    };

    if let Some(parent) = target_db_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create target directory {}", parent.display()))?;
    }

    log::info!(
        "Migrating SQLite database from {} to {}",
        source_db_path.display(),
        target_db_path.display()
    );

    let mut migrated_any = false;

    for suffix in std::iter::once("").chain(SQLITE_SIDE_SUFFIXES.iter().copied()) {
        let src = sqlite_bundle_path(&source_db_path, suffix);
        if !src.exists() {
            continue;
        }

        let dst = sqlite_bundle_path(target_db_path, suffix);
        if dst.exists() {
            std::fs::remove_file(&dst)
                .with_context(|| format!("Failed to clear existing file {}", dst.display()))?;
        }

        std::fs::copy(&src, &dst).with_context(|| {
            format!(
                "Failed to copy database file from {} to {}",
                src.display(),
                dst.display()
            )
        })?;

        std::fs::remove_file(&src)
            .with_context(|| format!("Failed to remove legacy file {}", src.display()))?;

        migrated_any = true;
    }

    if !migrated_any {
        return Err(anyhow::anyhow!(
            "Legacy database migration candidate found but no files were copied"
        ));
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

    for env in &environments {
        let normalized_output_dir = normalize_path(&env.output_dir);
        let serialized = serde_json::to_string(env)?;
        sqlx::query(
            "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, normalized_output_dir = excluded.normalized_output_dir, data = excluded.data",
        )
        .bind(&env.id)
        .bind(&env.output_dir)
        .bind(normalized_output_dir)
        .bind(serialized)
        .execute(pool)
        .await
        .context("Failed to migrate environments")?;
    }

    let mut secrets_written = false;
    for dir in &legacy_dirs {
        secrets_written |= migrate_secret_file(pool, dir, "credentials.enc", "steam_credentials").await?;
        secrets_written |= migrate_secret_file(pool, dir, "nexus_mods_api_key.enc", "nexus_mods_api_key").await?;
    }

    let mut mod_metadata_migrated = false;
    for env in &environments {
        mod_metadata_migrated |= migrate_mod_metadata_for_env(pool, env, "mods").await?;
        mod_metadata_migrated |= migrate_mod_metadata_for_env(pool, env, "plugins").await?;
    }

    if settings_migrated || !environments.is_empty() || secrets_written || mod_metadata_migrated {
        sqlx::query("INSERT INTO app_meta (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(MIGRATION_FLAG_KEY)
            .bind("true")
            .execute(pool)
            .await
            .context("Failed to set migration flag")?;
    }

    Ok(())
}

async fn has_expected_schema(pool: &SqlitePool) -> Result<bool> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
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

    Ok(required.iter().all(|table| tables.contains(&table.to_string())))
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

async fn migrate_mod_metadata_for_env(pool: &SqlitePool, env: &Environment, kind: &str) -> Result<bool> {
    let metadata_path = if kind == "mods" {
        Path::new(&env.output_dir).join("Mods").join(".mods-metadata.json")
    } else {
        Path::new(&env.output_dir).join("Plugins").join(".plugins-metadata.json")
    };

    if !metadata_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&metadata_path)
        .await
        .with_context(|| format!("Failed to read {} metadata file {}", kind, metadata_path.display()))?;
    if content.trim().is_empty() {
        return Ok(false);
    }

    let metadata: std::collections::HashMap<String, ModMetadata> = match serde_json::from_str(&content) {
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
    use crate::types::{
        EnvironmentStatus, LogLevel, ModSource, Platform, Runtime, Theme,
    };
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
            max_concurrent_downloads: 3,
            platform: Platform::Windows,
            language: "en".to_string(),
            theme: Theme::Light,
            melon_loader_version: Some("0.6.0".to_string()),
            auto_install_melon_loader: Some(true),
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
            custom_theme: None,
            log_retention_days: Some(7),
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
            installed_version: Some("1.0.0".to_string()),
            installed_at: None,
            last_update_check: None,
            update_available: Some(false),
            remote_version: None,
            detected_runtime: Some(Runtime::Il2cpp),
            runtime_match: Some(true),
            mod_storage_id: Some("storage-1".to_string()),
            symlink_paths: Some(vec!["C:\\mods\\sample".to_string()]),
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
    async fn get_data_dir_defaults_to_simm_home_directory() -> Result<()> {
        let temp = tempdir()?;
        let _data_guard = EnvVarGuard::unset("SIMMRUST_DATA_DIR");
        let _home_guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());

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

        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", target_dir.to_string_lossy().as_ref());

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

    #[tokio::test]
    #[serial]
    async fn initialize_pool_creates_tables() -> Result<()> {
        let temp = tempdir()?;
        let override_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", override_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .fetch_all(&*pool)
        .await?;

        for table in ["app_meta", "settings", "environments", "secrets", "mod_metadata"] {
            assert!(tables.contains(&table.to_string()));
        }

        Ok(())
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

        let stored_settings: Option<String> = sqlx::query_scalar(
            "SELECT data FROM settings WHERE id = 1",
        )
        .fetch_optional(&*pool)
        .await?;
        let stored_settings = stored_settings.expect("expected settings row");
        let stored_value: serde_json::Value = serde_json::from_str(&stored_settings)?;
        let expected_value = serde_json::to_value(&settings)?;
        assert_eq!(stored_value, expected_value);

        let stored_env: Option<String> = sqlx::query_scalar(
            "SELECT data FROM environments WHERE id = ?",
        )
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

        let stored_secret: Option<String> = sqlx::query_scalar(
            "SELECT encrypted FROM secrets WHERE key = ?",
        )
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

        let migration_flag: Option<String> = sqlx::query_scalar(
            "SELECT value FROM app_meta WHERE key = ?",
        )
        .bind(MIGRATION_FLAG_KEY)
        .fetch_optional(&*pool)
        .await?;
        assert_eq!(migration_flag.as_deref(), Some("true"));

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

        let stored_env: String = sqlx::query_scalar(
            "SELECT data FROM environments WHERE id = ?",
        )
        .bind(&env.id)
        .fetch_one(&*pool)
        .await?;
        let stored_value: serde_json::Value = serde_json::from_str(&stored_env)?;
        assert_eq!(stored_value, serde_json::to_value(&env)?);

        let updated_env = Environment {
            output_dir: temp.path().join("envs").join("env-2b").to_string_lossy().to_string(),
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

        let stored_output: String = sqlx::query_scalar(
            "SELECT output_dir FROM environments WHERE id = ?",
        )
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

        sqlx::query(
            "INSERT INTO secrets (key, encrypted) VALUES (?, ?)",
        )
        .bind("test-secret")
        .bind("secret-data")
        .execute(&*pool)
        .await?;

        let stored_secret: String = sqlx::query_scalar(
            "SELECT encrypted FROM secrets WHERE key = ?",
        )
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
