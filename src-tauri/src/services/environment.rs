use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::time::{sleep, Duration};

use crate::types::{Environment, Runtime, schedule_i_config};

pub struct EnvironmentService {
    pool: Arc<SqlitePool>,
}

impl EnvironmentService {
    pub fn new(pool: Arc<SqlitePool>) -> Result<Self> {
        Ok(Self { pool })
    }

    pub fn infer_runtime_from_installation_path(path: &Path) -> Runtime {
        if path.join("GameAssembly.dll").exists() {
            Runtime::Il2cpp
        } else if path
            .join("Schedule I_Data")
            .join("Managed")
            .join("Assembly-CSharp.dll")
            .exists()
        {
            Runtime::Mono
        } else {
            Runtime::Il2cpp
        }
    }

    pub fn branch_for_runtime(runtime: &Runtime) -> String {
        match runtime {
            Runtime::Il2cpp => "main".to_string(),
            Runtime::Mono => "alternate".to_string(),
        }
    }

    pub fn runtime_for_branch(branch: &str) -> Option<Runtime> {
        schedule_i_config()
            .branches
            .into_iter()
            .find(|b| b.name.eq_ignore_ascii_case(branch))
            .map(|b| b.runtime)
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

    fn is_retryable_write_error(err: &sqlx::Error) -> bool {
        let msg = err.to_string().to_lowercase();
        msg.contains("database is locked") || msg.contains("database is busy")
    }

    async fn save_environment(&self, env: &Environment) -> Result<()> {
        let normalized_output_dir = Self::normalize_path(&env.output_dir);
        let serialized = serde_json::to_string(env).context("Failed to serialize environment")?;
        let upsert_with_normalized = {
            let mut last_error: Option<sqlx::Error> = None;
            let mut success = None;

            for attempt in 0..3 {
                let result = sqlx::query(
                    "INSERT INTO environments (id, output_dir, normalized_output_dir, data) VALUES (?, ?, ?, ?) \
                     ON CONFLICT(id) DO UPDATE SET output_dir = excluded.output_dir, normalized_output_dir = excluded.normalized_output_dir, data = excluded.data",
                )
                .bind(&env.id)
                .bind(&env.output_dir)
                .bind(&normalized_output_dir)
                .bind(&serialized)
                .execute(&*self.pool)
                .await;

                match result {
                    Ok(done) => {
                        success = Some(done);
                        break;
                    }
                    Err(err) if Self::is_retryable_write_error(&err) && attempt < 2 => {
                        let backoff_ms = 25 * (attempt + 1);
                        sleep(Duration::from_millis(backoff_ms)).await;
                    }
                    Err(err) => {
                        last_error = Some(err);
                        break;
                    }
                }
            }

            if success.is_some() {
                Ok(())
            } else {
                Err(last_error.unwrap_or_else(|| sqlx::Error::Protocol("unknown sqlite write failure".to_string())))
            }
        };

        match upsert_with_normalized {
            Ok(_) => Ok(()),
            Err(err) if err
                .to_string()
                .to_lowercase()
                .contains("no such column: normalized_output_dir") => {
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
            Err(err) if err
                .to_string()
                .to_lowercase()
                .contains("unique constraint failed") => {
                let update_by_normalized = sqlx::query(
                    "UPDATE environments SET output_dir = ?, data = ? WHERE normalized_output_dir = ?",
                )
                .bind(&env.output_dir)
                .bind(&serialized)
                .bind(&normalized_output_dir)
                .execute(&*self.pool)
                .await;

                if let Ok(updated) = update_by_normalized {
                    if updated.rows_affected() > 0 {
                        return Ok(());
                    }
                }

                let update_by_output_dir = sqlx::query(
                    "UPDATE environments SET data = ? WHERE output_dir = ?",
                )
                .bind(&serialized)
                .bind(&env.output_dir)
                .execute(&*self.pool)
                .await
                .context("Failed to resolve environment save conflict by output_dir")?;

                if update_by_output_dir.rows_affected() > 0 {
                    return Ok(());
                }

                Err(err).context("Failed to save environment")
            }
            Err(err) => Err(err).context("Failed to save environment"),
        }
    }

    pub async fn hard_delete_environment_record(&self, id: &str) -> Result<()> {
        self.clear_environment_metadata(id).await?;

        sqlx::query("DELETE FROM environments WHERE id = ?")
            .bind(id)
            .execute(&*self.pool)
            .await
            .context("Failed to hard delete environment")?;

        Ok(())
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\")
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    }

    async fn clear_environment_metadata(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM mod_metadata WHERE environment_id = ?")
            .bind(id)
            .execute(&*self.pool)
            .await
            .context("Failed to clear environment metadata")?;

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

    pub async fn upsert_environment(&self, env: &Environment) -> Result<()> {
        self.save_environment(env).await
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

        let steam_service = crate::services::steam::SteamService::new();
        let runtime_from_files = Self::infer_runtime_from_installation_path(path);
        let detected_branch = steam_service
            .detect_installed_branch(path)
            .await
            .ok()
            .flatten();
        let branch = detected_branch.unwrap_or_else(|| Self::branch_for_runtime(&runtime_from_files));
        let runtime = Self::runtime_for_branch(&branch).unwrap_or(runtime_from_files);

        let id = format!("steam-{}", chrono::Utc::now().timestamp_millis());

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or_else(|| "Steam Installation".to_string()),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch,
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

    pub async fn create_local_environment(
        &self,
        local_path: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        let normalized_local_path = Self::normalize_path(&local_path);
        let existing_envs = self.fetch_environments().await?;
        if existing_envs
            .iter()
            .any(|env| Self::normalize_path(&env.output_dir) == normalized_local_path)
        {
            return Err(anyhow::anyhow!(
                "An environment already exists for this installation path"
            ));
        }

        let path = Path::new(&local_path);

        // Validate installation - check for game executable
        let executable = path.join("Schedule I.exe");
        if !executable.exists() {
            return Err(anyhow::anyhow!("Invalid installation path: Schedule I.exe not found in {}", local_path));
        }

        let runtime = Self::infer_runtime_from_installation_path(path);
        let branch = Self::branch_for_runtime(&runtime);

        // Extract game version
        let game_version_service = crate::services::game_version::GameVersionService::new();
        let current_game_version = game_version_service.extract_game_version(&local_path).await.ok().flatten();

        // Check MelonLoader status
        let melon_loader_version = self.detect_melon_loader_version(path).await;

        let id = format!("local-{}", chrono::Utc::now().timestamp_millis());

        // Generate default name from folder name
        let default_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Local Installation".to_string());

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or(default_name),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch,
            output_dir: local_path,
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
            melon_loader_version,
            environment_type: Some(crate::types::EnvironmentType::Local),
        };

        self.save_environment(&env).await?;

        Ok(env)
    }

    async fn detect_melon_loader_version(&self, game_path: &Path) -> Option<String> {
        // Check for MelonLoader by looking for version.dll or MelonLoader folder
        let melon_loader_dir = game_path.join("MelonLoader");
        if !melon_loader_dir.exists() {
            return None;
        }

        // Try to read version from MelonLoader.dll or net6/MelonLoader.dll
        let possible_paths = [
            melon_loader_dir.join("MelonLoader.dll"),
            melon_loader_dir.join("net6").join("MelonLoader.dll"),
            melon_loader_dir.join("net35").join("MelonLoader.dll"),
        ];

        for dll_path in &possible_paths {
            if dll_path.exists() {
                // MelonLoader is installed, but we can't easily read version from DLL
                // Return a placeholder indicating it's installed
                return Some("installed".to_string());
            }
        }

        // Check for version.dll as another indicator
        if game_path.join("version.dll").exists() {
            return Some("installed".to_string());
        }

        None
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
                            "unavailable" => crate::types::EnvironmentStatus::Unavailable,
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

    pub async fn delete_environment(&self, id: &str, delete_files: bool) -> Result<bool> {
        let env = self.get_environment(id).await?;

        if let Some(env) = env {
            if env.environment_type == Some(crate::types::EnvironmentType::Steam)
                || env.id.starts_with("steam-")
            {
                self.clear_environment_metadata(id).await?;

                let mut updated_env = env.clone();
                let current_path_valid =
                    crate::services::steam::SteamService::validate_steam_installation(Path::new(&updated_env.output_dir))
                        .unwrap_or(false);

                if current_path_valid {
                    updated_env.status = crate::types::EnvironmentStatus::Completed;
                } else {
                    let steam_service = crate::services::steam::SteamService::new();
                    if let Ok(installations) = steam_service.detect_steam_installations().await {
                        if let Some(installation) = installations.first() {
                            updated_env.output_dir = installation.path.clone();
                            updated_env.status = crate::types::EnvironmentStatus::Completed;
                        } else {
                            updated_env.status = crate::types::EnvironmentStatus::Unavailable;
                        }
                    } else {
                        updated_env.status = crate::types::EnvironmentStatus::Unavailable;
                    }
                }

                updated_env.last_updated = Some(chrono::Utc::now());
                self.save_environment(&updated_env).await?;
                return Ok(true);
            }

            // Only delete files if explicitly requested AND not a Steam environment
            // Steam environments are managed by Steam, so we never delete their files
            let should_delete_files = delete_files
                && env.environment_type != Some(crate::types::EnvironmentType::Steam)
                && Path::new(&env.output_dir).exists();

            if should_delete_files {
                tokio::fs::remove_dir_all(&env.output_dir)
                    .await
                    .with_context(|| format!("Failed to delete output directory: {}", env.output_dir))?;
            }

            sqlx::query("DELETE FROM environments WHERE id = ?")
                .bind(id)
                .execute(&*self.pool)
                .await
                .context("Failed to delete environment")?;

            self.clear_environment_metadata(id).await?;
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

        let unavailable = service
            .update_environment(
                &env.id,
                vec![("status".to_string(), serde_json::json!("unavailable"))],
            )
            .await?;
        assert!(matches!(unavailable.status, EnvironmentStatus::Unavailable));

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
        let service = EnvironmentService::new(pool.clone())?;

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

        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&env.id)
        .bind("example.dll")
        .bind("{}")
        .execute(&*pool)
        .await?;

        let deleted = service.delete_environment(&env.id, true).await?;
        assert!(deleted);
        assert!(!output_dir.exists());
        assert!(service.get_environment(&env.id).await?.is_none());

        let metadata_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?",
        )
        .bind(&env.id)
        .fetch_one(&*pool)
        .await?;
        assert_eq!(metadata_count, 0);

        let deleted_missing = service.delete_environment("missing", true).await?;
        assert!(!deleted_missing);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_environment_for_steam_clears_mod_metadata_but_keeps_record() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;

        let steam_path = temp.path().join("steam");
        fs::create_dir_all(&steam_path).await?;
        fs::write(steam_path.join("Schedule I.exe"), b"").await?;

        let steam_env = Environment {
            id: "steam-1".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: steam_path.to_string_lossy().to_string(),
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

        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&steam_env.id)
        .bind("steammod.dll")
        .bind("{}")
        .execute(&*pool)
        .await?;

        let service = EnvironmentService::new(pool.clone())?;
        let deleted = service
            .delete_environment(&steam_env.id, true)
            .await?;
        assert!(deleted);
        let after = service.get_environment(&steam_env.id).await?;
        assert!(after.is_some());

        let metadata_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?",
        )
        .bind(&steam_env.id)
        .fetch_one(&*service.pool)
        .await?;
        assert_eq!(metadata_count, 0);

        assert!(matches!(
            after.expect("steam env should remain").status,
            EnvironmentStatus::Completed
        ));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn create_local_environment_rejects_duplicate_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = EnvironmentService::new(pool.clone())?;

        let local_dir = temp.path().join("local");
        fs::create_dir_all(&local_dir).await?;
        fs::write(local_dir.join("Schedule I.exe"), b"").await?;
        fs::write(local_dir.join("GameAssembly.dll"), b"").await?;

        let created = service
            .create_local_environment(local_dir.to_string_lossy().to_string(), None, None)
            .await?;
        assert!(created.id.starts_with("local-"));

        let err = service
            .create_local_environment(local_dir.to_string_lossy().to_string(), None, None)
            .await
            .expect_err("expected duplicate path error");
        assert!(err
            .to_string()
            .contains("already exists for this installation path"));

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
