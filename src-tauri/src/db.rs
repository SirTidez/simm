use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::fs;

use crate::types::{Environment, EnvironmentType, ModMetadata, Settings};

const MIGRATION_FLAG_KEY: &str = "storage.migrated";

pub async fn initialize_pool() -> Result<Arc<SqlitePool>> {
    let db_path = get_database_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).context("Failed to create database directory")?;
    }

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

    sqlx::migrate!()
        .run(&pool)
        .await
        .context("Failed to run database migrations")?;

    migrate_from_files(&pool).await?;

    Ok(Arc::new(pool))
}

pub fn get_database_path() -> Result<PathBuf> {
    let data_dir = get_data_dir()?;
    Ok(data_dir.join("data.db"))
}

pub fn get_data_dir() -> Result<PathBuf> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?
        .join("simmrust");

    Ok(data_dir)
}

fn legacy_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
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
        let serialized = serde_json::to_string(env)?;
        sqlx::query(
            "INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, data = excluded.data",
        )
        .bind(&env.id)
        .bind(&env.output_dir)
        .bind(serialized)
        .execute(pool)
        .await
        .context("Failed to migrate environments")?;
    }

    let mut secrets_written = false;
    for dir in &legacy_dirs {
        secrets_written |= migrate_secret_file(pool, dir, "credentials.enc", "steam_credentials").await?;
        secrets_written |= migrate_secret_file(pool, dir, "github_token.enc", "github_token").await?;
        secrets_written |= migrate_secret_file(pool, dir, "nexus_mods_api_key.enc", "nexus_mods_api_key").await?;
    }

    for env in &environments {
        migrate_mod_metadata_for_env(pool, env, "mods").await?;
        migrate_mod_metadata_for_env(pool, env, "plugins").await?;
    }

    if settings_migrated || !environments.is_empty() || secrets_written {
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

    let content = fs::read_to_string(&path).await.unwrap_or_default();
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

async fn migrate_mod_metadata_for_env(pool: &SqlitePool, env: &Environment, kind: &str) -> Result<()> {
    let metadata_path = if kind == "mods" {
        Path::new(&env.output_dir).join("Mods").join(".mods-metadata.json")
    } else {
        Path::new(&env.output_dir).join("Plugins").join(".plugins-metadata.json")
    };

    if !metadata_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&metadata_path).await.unwrap_or_default();
    if content.trim().is_empty() {
        return Ok(());
    }

    let metadata: std::collections::HashMap<String, ModMetadata> = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            log::warn!("Failed to parse {} metadata for {}: {}", kind, env.id, err);
            return Ok(());
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

    Ok(())
}
