use std::path::Path;
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
                tokio::fs::remove_dir_all(&env.output_dir)
                    .await
                    .with_context(|| format!("Failed to delete output directory: {}", env.output_dir))?;
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
}

impl Clone for EnvironmentService {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::types::{EnvironmentStatus, EnvironmentType, Runtime};
    use serial_test::serial;
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

    #[tokio::test]
    #[serial]
    async fn create_and_fetch_environment() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-1");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                Some("Test env".to_string()),
            )
            .await?;

        assert!(env.id.starts_with("3164500-main-"));
        assert_eq!(env.name, "Main");
        assert_eq!(env.description.as_deref(), Some("Test env"));
        assert_eq!(env.branch, "main");
        assert!(matches!(env.runtime, Runtime::Il2cpp));
        assert!(matches!(env.status, EnvironmentStatus::NotDownloaded));
        assert!(matches!(env.environment_type, Some(EnvironmentType::DepotDownloader)));

        let stored = service.get_environment(&env.id).await?;
        assert!(stored.is_some());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn update_environment_updates_fields() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-2");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let timestamp = 1_700_000_000i64;
        let updates = vec![
            ("name".to_string(), serde_json::json!("Updated")),
            ("description".to_string(), serde_json::json!("New desc")),
            ("status".to_string(), serde_json::json!("completed")),
            ("size".to_string(), serde_json::json!(1234)),
            ("lastManifestId".to_string(), serde_json::json!("manifest")),
            ("lastUpdateCheck".to_string(), serde_json::json!(timestamp)),
            ("updateAvailable".to_string(), serde_json::json!(true)),
            ("remoteManifestId".to_string(), serde_json::json!("remote")),
            ("remoteBuildId".to_string(), serde_json::json!("build")),
            ("currentGameVersion".to_string(), serde_json::json!("1.0.0")),
            ("updateGameVersion".to_string(), serde_json::json!("1.0.1")),
            ("melonLoaderVersion".to_string(), serde_json::json!("0.6.0")),
        ];

        let updated = service.update_environment(&env.id, updates).await?;
        assert_eq!(updated.name, "Updated");
        assert_eq!(updated.description.as_deref(), Some("New desc"));
        assert!(matches!(updated.status, EnvironmentStatus::Completed));
        assert_eq!(updated.size, Some(1234));
        assert_eq!(updated.last_manifest_id.as_deref(), Some("manifest"));
        assert_eq!(updated.last_update_check.map(|dt| dt.timestamp()), Some(timestamp));
        assert_eq!(updated.update_available, Some(true));
        assert_eq!(updated.remote_manifest_id.as_deref(), Some("remote"));
        assert_eq!(updated.remote_build_id.as_deref(), Some("build"));
        assert_eq!(updated.current_game_version.as_deref(), Some("1.0.0"));
        assert_eq!(updated.update_game_version.as_deref(), Some("1.0.1"));
        assert_eq!(updated.melon_loader_version.as_deref(), Some("0.6.0"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn update_environment_rejects_invalid_status() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-3");
        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let updates = vec![("status".to_string(), serde_json::json!("bad"))];
        let err = service
            .update_environment(&env.id, updates)
            .await
            .expect_err("expected invalid status error");
        assert!(err.to_string().contains("Invalid status"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_removes_dir_and_row() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let output_dir = temp.path().join("envs").join("env-4");
        fs::create_dir_all(&output_dir).await?;
        fs::write(output_dir.join("file.txt"), b"test").await?;

        let env = service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                Some("Delete".to_string()),
                None,
            )
            .await?;

        let deleted = service.delete_environment(&env.id).await?;
        assert!(deleted);
        assert!(!output_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_none());

        let deleted_missing = service.delete_environment("missing").await?;
        assert!(!deleted_missing);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_rejects_steam_install() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;

        let steam_env = Environment {
            id: "steam-1".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: temp.path().join("steam").to_string_lossy().to_string(),
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
            environment_type: Some(EnvironmentType::Steam),
        };

        let serialized = serde_json::to_string(&steam_env)?;
        sqlx::query(
            "INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)",
        )
        .bind(&steam_env.id)
        .bind(&steam_env.output_dir)
        .bind(serialized)
        .execute(&*pool)
        .await?;

        let service = EnvironmentService::new(pool)?;
        let err = service
            .delete_environment(&steam_env.id)
            .await
            .expect_err("expected steam delete error");
        assert!(err.to_string().contains("Steam installations"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_steam_environment_rejects_invalid_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool)?;

        let err = service
            .create_steam_environment(
                temp.path().to_string_lossy().to_string(),
                None,
                None,
            )
            .await
            .expect_err("expected invalid steam path error");
        assert!(err.to_string().contains("Invalid Steam installation path"));

        Ok(())
    }
}
