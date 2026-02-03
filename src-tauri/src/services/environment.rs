use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::types::{Environment, schedule_i_config};

pub struct EnvironmentService {
    pool: Arc<SqlitePool>,
}

impl EnvironmentService {
    pub fn new(pool: Arc<SqlitePool>) -> Result<Self> {
        Ok(Self { pool })
    }

    async fn fetch_environments(&self) -> Result<Vec<Environment>> {
        let rows = sqlx::query_scalar::<_, String>("SELECT data FROM environments")
            .fetch_all(&*self.pool)
            .await
            .context("Failed to query environments")?;

        let mut envs = Vec::new();
        for row in rows {
            match serde_json::from_str::<Environment>(&row) {
                Ok(env) => envs.push(env),
                Err(err) => {
                    log::warn!("Skipping invalid environment record: {}", err);
                }
            }
        }

        Ok(envs)
    }

    async fn save_environment(&self, env: &Environment) -> Result<()> {
        let serialized = serde_json::to_string(env).context("Failed to serialize environment")?;
        sqlx::query(
            "INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, data = excluded.data",
        )
        .bind(&env.id)
        .bind(&env.output_dir)
        .bind(serialized)
        .execute(&*self.pool)
        .await
        .context("Failed to save environment")?;

        Ok(())
    }

    pub async fn get_environments(&self) -> Result<Vec<Environment>> {
        self.fetch_environments().await
    }

    pub async fn get_environment(&self, id: &str) -> Result<Option<Environment>> {
        let row = sqlx::query_scalar::<_, String>("SELECT data FROM environments WHERE id = ?")
            .bind(id)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to query environment")?;

        match row {
            Some(data) => Ok(serde_json::from_str::<Environment>(&data).ok()),
            None => Ok(None),
        }
    }

    pub async fn create_environment(
        &self,
        app_id: String,
        branch: String,
        output_dir: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let app_config = if app_id == schedule_i_config().app_id {
            schedule_i_config()
        } else {
            return Err(anyhow::anyhow!("Unknown app ID: {}", app_id));
        };

        let branch_config = app_config
            .branches
            .iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| anyhow::anyhow!("Unknown branch: {} for app {}", branch, app_id))?;

        let id = format!("{}-{}-{}", app_id, branch, chrono::Utc::now().timestamp_millis());

        let branch_name = branch_config
            .display_name
            .replace(" (IL2CPP)", "")
            .replace(" (Mono)", "")
            .trim()
            .to_string();

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or(branch_name),
            description,
            app_id,
            branch,
            output_dir,
            runtime: branch_config.runtime.clone(),
            status: crate::types::EnvironmentStatus::NotDownloaded,
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
            environment_type: Some(crate::types::EnvironmentType::DepotDownloader),
        };

        self.save_environment(&env).await?;
        Ok(env)
    }

    pub async fn create_steam_environment(
        &self,
        steam_path: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let existing_envs = self.fetch_environments().await?;
        if existing_envs.iter().any(|env| {
            env.environment_type == Some(crate::types::EnvironmentType::Steam)
                || env.id.starts_with("steam-")
        }) {
            return Err(anyhow::anyhow!(
                "Steam installation already exists and is managed by Steam"
            ));
        }

        let path = Path::new(&steam_path);
        if !crate::services::steam::SteamService::validate_steam_installation(path)? {
            return Err(anyhow::anyhow!("Invalid Steam installation path: {}", steam_path));
        }

        let game_version_service = crate::services::game_version::GameVersionService::new();
        let current_game_version = game_version_service.extract_game_version(&steam_path).await?;

        let runtime = if steam_path.to_lowercase().contains("mono") {
            crate::types::Runtime::Mono
        } else {
            crate::types::Runtime::Il2cpp
        };

        let id = format!("steam-{}", chrono::Utc::now().timestamp_millis());

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or_else(|| "Steam Installation".to_string()),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch: "main".to_string(),
            output_dir: steam_path,
            runtime,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: Some(chrono::Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version,
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(crate::types::EnvironmentType::Steam),
        };

        self.save_environment(&env).await?;
        Ok(env)
    }

    pub async fn update_environment(
        &self,
        id: &str,
        updates: impl IntoIterator<Item = (String, serde_json::Value)>,
    ) -> Result<Environment> {
        let mut env = self
            .get_environment(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment {} not found", id))?;

        for (key, value) in updates {
            match key.as_str() {
                "name" => {
                    if let Some(v) = value.as_str() {
                        env.name = v.to_string();
                    }
                }
                "description" => {
                    env.description = value.as_str().map(|s| s.to_string());
                }
                "status" => {
                    if let Some(v) = value.as_str() {
                        env.status = match v {
                            "not_downloaded" => crate::types::EnvironmentStatus::NotDownloaded,
                            "downloading" => crate::types::EnvironmentStatus::Downloading,
                            "completed" => crate::types::EnvironmentStatus::Completed,
                            "error" => crate::types::EnvironmentStatus::Error,
                            _ => return Err(anyhow::anyhow!("Invalid status: {}", v)),
                        };
                    }
                }
                "lastUpdated" => {}
                "size" => {
                    if let Some(v) = value.as_u64() {
                        env.size = Some(v);
                    }
                }
                "lastManifestId" => {
                    if let Some(v) = value.as_str() {
                        env.last_manifest_id = Some(v.to_string());
                    }
                }
                "lastUpdateCheck" => {
                    if let Some(timestamp) = value.as_i64() {
                        if let Some(dt) = DateTime::from_timestamp(timestamp, 0) {
                            env.last_update_check = Some(dt.with_timezone(&Utc));
                        } else {
                            log::warn!("Invalid timestamp for lastUpdateCheck: {}", timestamp);
                        }
                    } else if value.is_null() {
                        env.last_update_check = None;
                    } else {
                        log::warn!("Unexpected type for lastUpdateCheck: {:?}", value);
                    }
                }
                "updateAvailable" => {
                    if let Some(v) = value.as_bool() {
                        env.update_available = Some(v);
                    }
                }
                "remoteManifestId" => {
                    if let Some(v) = value.as_str() {
                        env.remote_manifest_id = Some(v.to_string());
                    }
                }
                "remoteBuildId" => {
                    if let Some(v) = value.as_str() {
                        env.remote_build_id = Some(v.to_string());
                    }
                }
                "currentGameVersion" => {
                    if let Some(v) = value.as_str() {
                        env.current_game_version = Some(v.to_string());
                    }
                }
                "updateGameVersion" => {
                    if let Some(v) = value.as_str() {
                        env.update_game_version = Some(v.to_string());
                    }
                }
                "melonLoaderVersion" => {
                    if let Some(v) = value.as_str() {
                        env.melon_loader_version = Some(v.to_string());
                    }
                }
                _ => {}
            }
        }

        self.save_environment(&env).await?;
        Ok(env)
    }

    pub async fn delete_environment(&self, id: &str) -> Result<bool> {
        let env = self.get_environment(id).await?;
        if let Some(env) = env {
            if env.environment_type == Some(crate::types::EnvironmentType::Steam)
                || env.id.starts_with("steam-")
            {
                return Err(anyhow::anyhow!(
                    "Steam installations are managed by Steam and cannot be deleted"
                ));
            }

            if Path::new(&env.output_dir).exists() {
                if let Err(e) = tokio::fs::remove_dir_all(&env.output_dir).await {
                    log::warn!("Failed to delete directory {}: {}", env.output_dir, e);
                }
            }

            sqlx::query("DELETE FROM environments WHERE id = ?")
                .bind(id)
                .execute(&*self.pool)
                .await
                .context("Failed to delete environment")?;

            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn get_environment_size(&self, output_dir: &str) -> Result<u64> {
        if !Path::new(output_dir).exists() {
            return Ok(0);
        }

        Self::calculate_size(Path::new(output_dir)).await
    }

    async fn calculate_size(path: &Path) -> Result<u64> {
        Self::calculate_size_impl(path.to_path_buf()).await
    }

    fn calculate_size_impl(
        path: PathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send>> {
        Box::pin(async move {
            let mut size = 0u64;

            let mut entries = tokio::fs::read_dir(&path).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = entry.metadata().await?;

                if metadata.is_dir() {
                    size += Self::calculate_size_impl(entry_path).await?;
                } else {
                    size += metadata.len();
                }
            }

            Ok(size)
        })
    }
}

impl Clone for EnvironmentService {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
        }
    }
}
