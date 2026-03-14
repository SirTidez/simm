use crate::services::game_version::GameVersionService;
use crate::services::settings::SettingsService;
use crate::types::{Environment, UpdateCheckResult};
use crate::utils::depot_downloader_detector::detect_depot_downloader;
use anyhow::{Context, Result};
use chrono::Utc;
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use tempfile::tempdir_in;

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

    pub async fn check_update_for_environment(
        &self,
        env: &Environment,
    ) -> Result<UpdateCheckResult> {
        log::info!(
            "Checking for updates: {} (branch: {})",
            env.name,
            env.branch
        );

        let mut result = UpdateCheckResult {
            update_available: false,
            current_manifest_id: env
                .last_manifest_id
                .clone()
                .or_else(|| env.remote_manifest_id.clone()),
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
            if let Ok(Some(version)) = self
                .game_version_service
                .extract_game_version(&env.output_dir)
                .await
            {
                log::info!("Extracted current game version: {}", version);
                result.current_game_version = Some(version.clone());
            }
        }

        // For Steam environments, skip DepotDownloader and only check version
        if env.environment_type == Some(crate::types::EnvironmentType::Steam) {
            log::info!("Steam environment detected, skipping DepotDownloader update check");

            // Still check for remote manifest ID to compare versions, but don't trigger downloads
            match self
                .get_manifest_id_from_depot_downloader(&env.app_id, &env.branch)
                .await
            {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    result.update_available =
                        Self::compare_manifest_ids(env, &manifest_id, "Steam environment");
                }
                Err(e) => {
                    // For Steam environments, errors in manifest check are not critical
                    log::warn!(
                        "Could not check remote manifest for Steam environment: {}",
                        e
                    );
                    result.error = Some(format!(
                        "Could not check for updates (Steam will handle updates): {}",
                        e
                    ));
                }
            }
        } else {
            // For DepotDownloader environments, use existing logic
            match self
                .get_manifest_id_from_depot_downloader(&env.app_id, &env.branch)
                .await
            {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    result.update_available =
                        Self::compare_manifest_ids(env, &manifest_id, "Environment");
                }
                Err(e) => {
                    result.error = Some(e.to_string());
                    log::error!(
                        "Failed to get manifest ID for {} (branch: {}): {}",
                        env.app_id,
                        env.branch,
                        e
                    );
                }
            }
        }

        Ok(result)
    }

    pub async fn check_all_environments(
        &self,
        envs: &[Environment],
    ) -> Result<HashMap<String, UpdateCheckResult>> {
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
                    results.insert(
                        env.id.clone(),
                        UpdateCheckResult {
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
                        },
                    );
                }
            }
        }

        Self::infer_updates_for_missing_manifest_baselines(envs, &mut results);
        Self::heal_stale_manifest_baselines(envs, &mut results);

        Ok(results)
    }

    fn infer_updates_for_missing_manifest_baselines(
        envs: &[Environment],
        results: &mut HashMap<String, UpdateCheckResult>,
    ) {
        let env_map: HashMap<&str, &Environment> =
            envs.iter().map(|env| (env.id.as_str(), env)).collect();

        for env in envs {
            let Some(current_result) = results.get(env.id.as_str()) else {
                continue;
            };

            let is_depot_env = env.environment_type != Some(crate::types::EnvironmentType::Steam);
            if !is_depot_env || env.last_manifest_id.is_some() || current_result.update_available {
                continue;
            }

            let Some(remote_manifest_id) = current_result.remote_manifest_id.clone() else {
                continue;
            };
            let Some(current_version) = current_result.current_game_version.clone() else {
                continue;
            };

            let inferred_latest_version = results
                .iter()
                .filter_map(|(candidate_id, candidate_result)| {
                    let candidate_env = env_map.get(candidate_id.as_str())?;
                    let candidate_version = candidate_result.current_game_version.as_deref()?;
                    let candidate_remote_manifest =
                        candidate_result.remote_manifest_id.as_deref()?;

                    if candidate_id == &env.id
                        || candidate_env.branch != env.branch
                        || candidate_remote_manifest != remote_manifest_id.as_str()
                    {
                        return None;
                    }

                    Some(candidate_version)
                })
                .max_by(|left, right| Self::compare_game_versions(left, right));

            if let Some(latest_version) = inferred_latest_version.map(str::to_string) {
                if Self::compare_game_versions(&current_version, &latest_version).is_lt() {
                    let Some(result) = results.get_mut(env.id.as_str()) else {
                        continue;
                    };
                    log::info!(
                        "Inferring update for {} from branch peer version {} -> {} (remote manifest {})",
                        env.name,
                        current_version,
                        latest_version,
                        remote_manifest_id
                    );
                    result.update_available = true;
                    result.update_game_version = Some(latest_version);
                }
            }
        }
    }

    fn heal_stale_manifest_baselines(
        envs: &[Environment],
        results: &mut HashMap<String, UpdateCheckResult>,
    ) {
        let env_map: HashMap<&str, &Environment> =
            envs.iter().map(|env| (env.id.as_str(), env)).collect();

        for env in envs {
            let Some(current_result) = results.get(env.id.as_str()) else {
                continue;
            };

            if !current_result.update_available {
                continue;
            }

            let Some(remote_manifest_id) = current_result.remote_manifest_id.clone() else {
                continue;
            };
            let Some(current_version) = current_result.current_game_version.clone() else {
                continue;
            };

            let has_current_peer = results.iter().any(|(candidate_id, candidate_result)| {
                let Some(candidate_env) = env_map.get(candidate_id.as_str()) else {
                    return false;
                };
                if candidate_id == &env.id
                    || candidate_env.app_id != env.app_id
                    || candidate_result.update_available
                {
                    return false;
                }

                candidate_result.current_game_version.as_deref() == Some(current_version.as_str())
            });

            if has_current_peer {
                if let Some(result) = results.get_mut(env.id.as_str()) {
                    log::info!(
                        "Healing stale manifest baseline for {} by accepting remote manifest {} for current version {}",
                        env.name,
                        remote_manifest_id,
                        current_version
                    );
                    result.update_available = false;
                    result.current_manifest_id = Some(remote_manifest_id);
                    result.update_game_version = None;
                }
            }
        }
    }

    fn compare_manifest_ids(
        env: &Environment,
        remote_manifest_id: &str,
        log_context: &str,
    ) -> bool {
        let baseline_manifest = env
            .last_manifest_id
            .as_ref()
            .or(env.remote_manifest_id.as_ref());

        match baseline_manifest {
            Some(current_manifest) => {
                let update_available = current_manifest != remote_manifest_id;
                if update_available {
                    log::info!(
                        "{} update available (manifest changed: {} -> {})",
                        log_context,
                        current_manifest,
                        remote_manifest_id
                    );
                } else {
                    log::info!(
                        "{} has no update available (manifest ID unchanged: {})",
                        log_context,
                        remote_manifest_id
                    );
                }
                update_available
            }
            None => {
                log::info!(
                    "{} has no manifest baseline for {} (branch: {}); storing remote manifest {} for future comparisons",
                    log_context,
                    env.app_id,
                    env.branch,
                    remote_manifest_id
                );
                false
            }
        }
    }

    fn compare_game_versions(left: &str, right: &str) -> std::cmp::Ordering {
        fn parse(version: &str) -> Option<(u32, u32, u32, String, u32)> {
            let pattern = Regex::new(r"^(\d+)\.(\d+)\.(\d+)([a-z]?)(\d*)$").ok()?;
            let captures = pattern.captures(version)?;
            Some((
                captures.get(1)?.as_str().parse().ok()?,
                captures.get(2)?.as_str().parse().ok()?,
                captures.get(3)?.as_str().parse().ok()?,
                captures.get(4).map(|m| m.as_str()).unwrap_or("").to_string(),
                captures
                    .get(5)
                    .map(|m| m.as_str())
                    .filter(|value| !value.is_empty())
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            ))
        }

        match (parse(left), parse(right)) {
            (Some(left_parts), Some(right_parts)) => left_parts.cmp(&right_parts),
            _ => left.cmp(right),
        }
    }

    async fn get_manifest_id_from_depot_downloader(
        &self,
        app_id: &str,
        branch: &str,
    ) -> Result<String> {
        let detector_info = detect_depot_downloader()
            .await
            .context("Failed to detect DepotDownloader")?;

        if !detector_info.installed {
            return Err(anyhow::anyhow!("DepotDownloader is not installed"));
        }

        let depot_downloader_path = detector_info
            .path
            .ok_or_else(|| anyhow::anyhow!("DepotDownloader path not found"))?;

        // Get credentials from settings for authentication
        let mut settings_service =
            SettingsService::new(self.pool.clone()).context("Failed to create settings service")?;
        let settings = settings_service
            .load_settings()
            .await
            .context("Failed to load settings")?;

        let credentials = settings_service
            .get_credentials()
            .await
            .context("Failed to get credentials")?;

        // Get username from credentials or settings
        let username = credentials
            .as_ref()
            .map(|(u, _)| u.clone())
            .or_else(|| settings.steam_username.clone())
            .ok_or_else(|| {
                anyhow::anyhow!("Steam authentication required. Please authenticate first.")
            })?;

        log::info!(
            "Fetching manifest ID from Steam: app_id={}, branch={}, username={}",
            app_id,
            branch,
            username
        );

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        // Use a fresh working directory so DepotDownloader cannot satisfy the
        // manifest probe from a previously cached depot manifest.
        let manifest_probe_dir = tempdir_in(&depots_dir)
            .context("Failed to create temporary manifest probe directory")?;

        // Build command with authentication
        let mut cmd = Command::new(&depot_downloader_path);
        cmd.arg("-app")
            .arg(app_id)
            .arg("-branch")
            .arg(branch)
            .arg("-username")
            .arg(&username)
            .arg("-manifest-only")
            .current_dir(manifest_probe_dir.path());

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

        let output = cmd.output().context("Failed to execute DepotDownloader")?;

        let output_str = String::from_utf8_lossy(&output.stdout);
        let error_str = String::from_utf8_lossy(&output.stderr);
        let all_output = format!("{}{}", output_str, error_str);

        log::info!("DepotDownloader stdout: {}", output_str);
        if !error_str.is_empty() {
            log::info!("DepotDownloader stderr: {}", error_str);
        }

        // Check if command failed
        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "DepotDownloader exited with code {}: {}",
                output.status.code().unwrap_or(-1),
                error_str
            ));
        }

        // Parse manifest ID from output
        let manifest_id_pattern =
            Regex::new(r"(?i)manifest[:\s]+(\d+)").context("Failed to compile regex")?;

        if let Some(caps) = manifest_id_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID: {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        // Try alternative patterns
        let alt_pattern =
            Regex::new(r#""manifestid"\s*:\s*(\d+)"#).context("Failed to compile regex")?;

        if let Some(caps) = alt_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID (alt pattern): {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        // Try to find any large number that might be a manifest ID
        let number_pattern = Regex::new(r"\b(\d{10,})\b").context("Failed to compile regex")?;

        if let Some(caps) = number_pattern.captures(&all_output) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id_str = manifest_id.as_str().to_string();
                log::info!("Found manifest ID (number pattern): {}", manifest_id_str);
                return Ok(manifest_id_str);
            }
        }

        log::error!("Could not parse manifest ID from DepotDownloader output");

        Err(anyhow::anyhow!(
            "Could not parse manifest ID from DepotDownloader output. Output: {}",
            all_output
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::types::{schedule_i_config, EnvironmentStatus, EnvironmentType, Runtime};
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
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let _path_guard = EnvVarGuard::set(
            "PATH",
            &format!(
                "{}\\System32",
                std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())
            ),
        );
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard =
            EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());
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
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let _path_guard = EnvVarGuard::set(
            "PATH",
            &format!(
                "{}\\System32",
                std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())
            ),
        );
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard =
            EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());
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

    #[test]
    fn compare_manifest_ids_uses_remote_manifest_as_fallback_baseline() {
        let env = Environment {
            id: "env-1".to_string(),
            name: "Env".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "beta".to_string(),
            output_dir: "C:\\env".to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: Some("100".to_string()),
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(EnvironmentType::Steam),
        };

        assert!(!UpdateCheckService::compare_manifest_ids(
            &env,
            "100",
            "Environment"
        ));
        assert!(UpdateCheckService::compare_manifest_ids(
            &env,
            "101",
            "Environment"
        ));
    }

    #[test]
    fn infer_updates_for_missing_manifest_baseline_uses_branch_peer_version() {
        let beta_env = Environment {
            id: "beta".to_string(),
            name: "Beta".to_string(),
            description: None,
            app_id: schedule_i_config().app_id.clone(),
            branch: "beta".to_string(),
            output_dir: "C:\\beta".to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: Some("802".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.3f3".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let steam_beta_env = Environment {
            id: "steam-beta".to_string(),
            name: "Steam Beta".to_string(),
            current_game_version: Some("0.4.4f6".to_string()),
            environment_type: Some(EnvironmentType::Steam),
            ..beta_env.clone()
        };

        let mut results = HashMap::from([
            (
                beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("802".to_string()),
                    remote_manifest_id: Some("802".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    app_id: beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.3f3".to_string()),
                    update_game_version: None,
                },
            ),
            (
                steam_beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("802".to_string()),
                    remote_manifest_id: Some("802".to_string()),
                    remote_build_id: None,
                    branch: steam_beta_env.branch.clone(),
                    app_id: steam_beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.4f6".to_string()),
                    update_game_version: None,
                },
            ),
        ]);

        UpdateCheckService::infer_updates_for_missing_manifest_baselines(
            &[beta_env.clone(), steam_beta_env.clone()],
            &mut results,
        );

        let beta_result = results.get("beta").expect("beta result");
        assert!(beta_result.update_available);
        assert_eq!(beta_result.update_game_version.as_deref(), Some("0.4.4f6"));
    }

    #[test]
    fn heal_stale_manifest_baseline_accepts_peer_matched_current_version() {
        let alternate_beta_env = Environment {
            id: "alternate-beta".to_string(),
            name: "Alternate Beta".to_string(),
            description: None,
            app_id: schedule_i_config().app_id.clone(),
            branch: "alternate-beta".to_string(),
            output_dir: "C:\\alternate-beta".to_string(),
            runtime: Runtime::Mono,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: Some("560".to_string()),
            last_update_check: None,
            update_available: Some(true),
            remote_manifest_id: Some("317".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.4f6".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let beta_env = Environment {
            id: "beta".to_string(),
            name: "Beta".to_string(),
            branch: "beta".to_string(),
            runtime: Runtime::Il2cpp,
            environment_type: Some(EnvironmentType::DepotDownloader),
            ..alternate_beta_env.clone()
        };

        let mut results = HashMap::from([
            (
                alternate_beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: true,
                    current_manifest_id: Some("560".to_string()),
                    remote_manifest_id: Some("317".to_string()),
                    remote_build_id: None,
                    branch: alternate_beta_env.branch.clone(),
                    app_id: alternate_beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.4f6".to_string()),
                    update_game_version: None,
                },
            ),
            (
                beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("802".to_string()),
                    remote_manifest_id: Some("802".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    app_id: beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.4f6".to_string()),
                    update_game_version: None,
                },
            ),
        ]);

        UpdateCheckService::heal_stale_manifest_baselines(
            &[alternate_beta_env.clone(), beta_env.clone()],
            &mut results,
        );

        let healed = results.get("alternate-beta").expect("alternate-beta result");
        assert!(!healed.update_available);
        assert_eq!(healed.current_manifest_id.as_deref(), Some("317"));
    }
}
