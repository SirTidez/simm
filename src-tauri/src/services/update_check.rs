use anyhow::{Context, Result};
use crate::types::{Environment, UpdateCheckResult};
use crate::utils::depot_downloader_detector::detect_depot_downloader;
use crate::services::game_version::GameVersionService;
use crate::services::settings::SettingsService;
use chrono::Utc;
use std::process::Command;
use regex::Regex;
use std::collections::HashMap;
use sqlx::SqlitePool;
use std::sync::Arc;

pub struct UpdateCheckService {
    game_version_service: GameVersionService,
    pool: Arc<SqlitePool>,
}

impl UpdateCheckService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self {
            game_version_service: GameVersionService::new(),
            pool,
        }
    }

    pub async fn check_update_for_environment(&self, env: &Environment) -> Result<UpdateCheckResult> {
        log::info!("Checking for updates: {} (branch: {})", env.name, env.branch);

        let mut result = UpdateCheckResult {
            update_available: false,
            current_manifest_id: env.last_manifest_id.clone(),
            remote_manifest_id: None,
            remote_build_id: None,
            branch: env.branch.clone(),
            app_id: env.app_id.clone(),
            checked_at: Utc::now(),
            error: None,
            current_game_version: env.current_game_version.clone(),
            update_game_version: None,
        };

        // Extract current game version if environment is completed (but don't fail if this doesn't work)
        if matches!(env.status, crate::types::EnvironmentStatus::Completed) {
            if let Ok(Some(version)) = self.game_version_service.extract_game_version(&env.output_dir).await {
                log::info!("Extracted current game version: {}", version);
                result.current_game_version = Some(version.clone());
            }
        }

        // For Steam environments, skip DepotDownloader and only check version
        if env.environment_type == Some(crate::types::EnvironmentType::Steam) {
            log::info!("Steam environment detected, skipping DepotDownloader update check");

            // Still check for remote manifest ID to compare versions, but don't trigger downloads
            match self.get_manifest_id_from_depot_downloader(&env.app_id, &env.branch).await {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    // Compare manifest IDs - only show update if we have a stored manifest ID to compare against
                    if let Some(ref current_manifest) = env.last_manifest_id {
                        // Only show update if manifest IDs are different
                        result.update_available = current_manifest != &manifest_id;
                        if result.update_available {
                            log::info!("Update available for Steam environment (manifest changed: {} -> {})", current_manifest, manifest_id);
                        } else {
                            log::info!("No update available (manifest ID unchanged: {})", manifest_id);
                        }
                    } else {
                        // For Steam environments without stored manifest ID, don't assume update
                        result.update_available = false;
                        log::warn!("Steam environment has no stored manifest ID, cannot determine if update is available");
                    }
                }
                Err(e) => {
                    // For Steam environments, errors in manifest check are not critical
                    log::warn!("Could not check remote manifest for Steam environment: {}", e);
                    result.error = Some(format!("Could not check for updates (Steam will handle updates): {}", e));
                }
            }
        } else {
            // For DepotDownloader environments, use existing logic
            match self.get_manifest_id_from_depot_downloader(&env.app_id, &env.branch).await {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    // Compare manifest IDs - only show update if we have a stored manifest ID to compare against
                    if let Some(ref current_manifest) = env.last_manifest_id {
                        // Only show update if manifest IDs are different
                        result.update_available = current_manifest != &manifest_id;
                        if result.update_available {
                            log::info!("Update available (manifest changed: {} -> {})", current_manifest, manifest_id);
                        } else {
                            log::info!("No update available (manifest ID unchanged: {})", manifest_id);
                        }
                    } else {
                        // If no previous manifest ID stored, don't assume an update is available
                        // The manifest ID will be stored after the first successful download
                        // This prevents false positives for newly created environments
                        result.update_available = false;
                        log::warn!("No stored manifest ID for {} (branch: {}), cannot determine if update is available", env.app_id, env.branch);
                    }
                }
                Err(e) => {
                    result.error = Some(e.to_string());
                    log::error!("Failed to get manifest ID for {} (branch: {}): {}", env.app_id, env.branch, e);
                }
            }
        }

        Ok(result)
    }

    pub async fn check_all_environments(&self, envs: &[Environment]) -> Result<HashMap<String, UpdateCheckResult>> {
        log::info!("Checking for updates on {} environment(s)", envs.len());
        let mut results = HashMap::new();

        for env in envs {
            match self.check_update_for_environment(env).await {
                Ok(result) => {
                    results.insert(env.id.clone(), result);
                }
                Err(e) => {
                    log::error!("Error checking updates for {}: {}", env.name, e);
                    // Create error result
                    results.insert(env.id.clone(), UpdateCheckResult {
                        update_available: false,
                        current_manifest_id: env.last_manifest_id.clone(),
                        remote_manifest_id: None,
                        remote_build_id: None,
                        branch: env.branch.clone(),
                        app_id: env.app_id.clone(),
                        checked_at: Utc::now(),
                        error: Some(e.to_string()),
                        current_game_version: env.current_game_version.clone(),
                        update_game_version: None,
                    });
                }
            }
        }

        Ok(results)
    }

    async fn get_manifest_id_from_depot_downloader(&self, app_id: &str, branch: &str) -> Result<String> {
        let detector_info = detect_depot_downloader().await
            .context("Failed to detect DepotDownloader")?;

        if !detector_info.installed {
            return Err(anyhow::anyhow!("DepotDownloader is not installed"));
        }

        let depot_downloader_path = detector_info.path
            .ok_or_else(|| anyhow::anyhow!("DepotDownloader path not found"))?;

        // Get credentials from settings for authentication
        let mut settings_service = SettingsService::new(self.pool.clone())
            .context("Failed to create settings service")?;
        let settings = settings_service.load_settings().await
            .context("Failed to load settings")?;

        let credentials = settings_service.get_credentials().await
            .context("Failed to get credentials")?;

        // Get username from credentials or settings
        let username = credentials
            .as_ref()
            .map(|(u, _)| u.clone())
            .or_else(|| settings.steam_username.clone())
            .ok_or_else(|| anyhow::anyhow!("Steam authentication required. Please authenticate first."))?;

        log::info!("Fetching manifest ID from Steam: app_id={}, branch={}, username={}", app_id, branch, username);

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        // Build command with authentication
        let mut cmd = Command::new(&depot_downloader_path);
        cmd.arg("-app")
            .arg(app_id)
            .arg("-branch")
            .arg(branch)
            .arg("-username")
            .arg(&username)
            .arg("-manifest-only")
            .current_dir(&depots_dir); // Set working directory to SIMM/depots

        // Use -remember-password on Windows if credentials are saved
        if cfg!(target_os = "windows") && credentials.is_some() {
            cmd.arg("-remember-password");
        }

        // Hide console window on Windows
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW flag
        }

        let output = cmd.output()
            .context("Failed to execute DepotDownloader")?;

        let output_str = String::from_utf8_lossy(&output.stdout);
        let error_str = String::from_utf8_lossy(&output.stderr);
        let all_output = format!("{}{}", output_str, error_str);

        log::info!("DepotDownloader stdout: {}", output_str);
        if !error_str.is_empty() {
            log::info!("DepotDownloader stderr: {}", error_str);
        }

        // Check if command failed
        if !output.status.success() {
            return Err(anyhow::anyhow!("DepotDownloader exited with code {}: {}",
                output.status.code().unwrap_or(-1), error_str));
        }

        // Parse manifest ID from output
        let manifest_id_pattern = Regex::new(r"(?i)manifest[:\s]+(\d+)")
            .context("Failed to compile regex")?;

        if let Some(caps) = manifest_id_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID: {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        // Try alternative patterns
        let alt_pattern = Regex::new(r#""manifestid"\s*:\s*(\d+)"#)
            .context("Failed to compile regex")?;

        if let Some(caps) = alt_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID (alt pattern): {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        // Try to find any large number that might be a manifest ID
        let number_pattern = Regex::new(r"\b(\d{10,})\b")
            .context("Failed to compile regex")?;

        if let Some(caps) = number_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID (number pattern): {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        log::error!("Could not parse manifest ID from DepotDownloader output");

        Err(anyhow::anyhow!("Could not parse manifest ID from DepotDownloader output. Output: {}", all_output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::types::{EnvironmentStatus, EnvironmentType, Runtime, schedule_i_config};
    use serial_test::serial;
    use tempfile::tempdir;

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

    struct CurrentDirGuard {
        original: std::path::PathBuf,
    }

    impl CurrentDirGuard {
        fn new(path: &std::path::Path) -> Result<Self> {
            let original = std::env::current_dir().context("Failed to read current dir")?;
            std::env::set_current_dir(path).context("Failed to set current dir")?;
            Ok(Self { original })
        }
    }

    impl Drop for CurrentDirGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.original);
        }
    }

    #[tokio::test]
    #[serial]
    async fn check_update_for_steam_env_records_error_when_depotdownloader_missing() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let _path_guard = EnvVarGuard::set(
            "PATH",
            &format!("{}\\System32", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())),
        );
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard = EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());
        let _cwd_guard = CurrentDirGuard::new(temp.path())?;

        let pool = initialize_pool().await?;
        let service = UpdateCheckService::new(pool);

        let env = Environment {
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

        let result = service.check_update_for_environment(&env).await?;
        assert!(!result.update_available);
        assert!(result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Steam will handle updates"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn check_update_for_depot_env_sets_error_when_depotdownloader_missing() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let _path_guard = EnvVarGuard::set(
            "PATH",
            &format!("{}\\System32", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())),
        );
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard = EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());
        let _cwd_guard = CurrentDirGuard::new(temp.path())?;

        let pool = initialize_pool().await?;
        let service = UpdateCheckService::new(pool);

        let env = Environment {
            id: "env-1".to_string(),
            name: "Env".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "main".to_string(),
            output_dir: temp.path().join("env").to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::NotDownloaded,
            last_updated: None,
            size: None,
            last_manifest_id: Some("123".to_string()),
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let result = service.check_update_for_environment(&env).await?;
        assert!(!result.update_available);
        assert!(result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("DepotDownloader"));

        Ok(())
    }
}
