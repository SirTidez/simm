use crate::services::depot_downloader::{
    acquire_process_permit, unique_login_id, DepotDownloaderService,
};
use crate::services::game_version::GameVersionService;
use crate::services::settings::SettingsService;
use crate::types::{Environment, Settings, UpdateCheckResult};
use crate::utils::depot_downloader_detector::detect_depot_downloader_with_override;
use anyhow::{Context, Result};
use chrono::Utc;
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir_in;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{watch, OwnedMutexGuard};
use tokio::task::JoinHandle;

const MANIFEST_PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const MANIFEST_PROBE_REAP_TIMEOUT: Duration = Duration::from_secs(3);
const MANIFEST_PROBE_READER_TIMEOUT: Duration = Duration::from_secs(3);
const MANIFEST_PROBE_OUTPUT_LIMIT: usize = 128 * 1024;
const ALL_ENVIRONMENT_CHECK_TIMEOUT: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, thiserror::Error)]
enum ManifestProbeError {
    #[error("Failed to start DepotDownloader manifest probe: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("DepotDownloader manifest probe I/O failed: {0}")]
    Io(String),
    #[error(
        "DepotDownloader manifest probe timed out after {timeout_ms}ms (child reaped: {reaped})"
    )]
    Timeout { timeout_ms: u128, reaped: bool },
    #[error("DepotDownloader manifest probe was cancelled (child reaped: {reaped})")]
    Cancelled { reaped: bool },
    #[error("DepotDownloader manifest provider exited with code {exit_code}: {stderr}")]
    Provider { exit_code: i32, stderr: String },
}

#[derive(Default)]
struct CappedProbeOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

impl CappedProbeOutput {
    fn into_text(self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            text.push_str("\n[manifest probe output truncated]");
        }
        text
    }
}

#[derive(Debug)]
struct ManifestProbeOutput {
    stdout: String,
    stderr: String,
}

struct ManifestProbeTask {
    cancel: watch::Sender<bool>,
    handle: JoinHandle<Result<ManifestProbeOutput, ManifestProbeError>>,
}

impl ManifestProbeTask {
    fn spawn(mut child: Child, process_permit: OwnedMutexGuard<()>) -> Self {
        let (cancel, cancellation) = watch::channel(false);
        let handle = tokio::spawn(async move {
            let _process_permit = process_permit;
            run_manifest_probe_child(&mut child, MANIFEST_PROBE_TIMEOUT, Some(cancellation)).await
        });
        Self { cancel, handle }
    }

    async fn finish(mut self) -> Result<ManifestProbeOutput, ManifestProbeError> {
        let joined = (&mut self.handle).await;
        joined.map_err(|error| {
            ManifestProbeError::Io(format!("manifest probe task failed: {error}"))
        })?
    }
}

impl Drop for ManifestProbeTask {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}

async fn read_capped_probe_output<R>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<CappedProbeOutput>
where
    R: AsyncRead + Unpin,
{
    let mut output = CappedProbeOutput::default();
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.bytes.len());
        let retained = remaining.min(read);
        output.bytes.extend_from_slice(&chunk[..retained]);
        output.truncated |= retained < read;
    }
    Ok(output)
}

async fn wait_for_manifest_probe_cancellation(mut cancellation: Option<watch::Receiver<bool>>) {
    let Some(receiver) = cancellation.as_mut() else {
        std::future::pending::<()>().await;
        return;
    };

    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn terminate_and_reap_manifest_probe(child: &mut Child) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    let _ = child.start_kill();
    matches!(
        tokio::time::timeout(MANIFEST_PROBE_REAP_TIMEOUT, child.wait()).await,
        Ok(Ok(_))
    )
}

async fn collect_probe_reader(
    task: Option<JoinHandle<std::io::Result<CappedProbeOutput>>>,
    stream_name: &str,
) -> Result<CappedProbeOutput, ManifestProbeError> {
    let Some(mut task) = task else {
        return Ok(CappedProbeOutput::default());
    };
    match tokio::time::timeout(MANIFEST_PROBE_READER_TIMEOUT, &mut task).await {
        Ok(Ok(Ok(output))) => Ok(output),
        Ok(Ok(Err(error))) => Err(ManifestProbeError::Io(format!(
            "failed reading {}: {}",
            stream_name, error
        ))),
        Ok(Err(error)) => Err(ManifestProbeError::Io(format!(
            "{} reader task failed: {}",
            stream_name, error
        ))),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(ManifestProbeError::Io(format!(
                "{} did not close after DepotDownloader exited",
                stream_name
            )))
        }
    }
}

async fn run_manifest_probe_child(
    child: &mut Child,
    timeout: Duration,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<ManifestProbeOutput, ManifestProbeError> {
    let stdout_task = child.stdout.take().map(|stdout| {
        tokio::spawn(read_capped_probe_output(
            stdout,
            MANIFEST_PROBE_OUTPUT_LIMIT,
        ))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tokio::spawn(read_capped_probe_output(
            stderr,
            MANIFEST_PROBE_OUTPUT_LIMIT,
        ))
    });

    enum ProbeWait {
        Exited(std::io::Result<ExitStatus>),
        TimedOut,
        Cancelled,
    }

    let wait = tokio::select! {
        status = child.wait() => ProbeWait::Exited(status),
        _ = tokio::time::sleep(timeout) => ProbeWait::TimedOut,
        _ = wait_for_manifest_probe_cancellation(cancellation) => ProbeWait::Cancelled,
    };

    let status = match wait {
        ProbeWait::Exited(Ok(status)) => status,
        ProbeWait::Exited(Err(error)) => {
            let _ = terminate_and_reap_manifest_probe(child).await;
            let _ = collect_probe_reader(stdout_task, "stdout").await;
            let _ = collect_probe_reader(stderr_task, "stderr").await;
            return Err(ManifestProbeError::Io(format!(
                "failed waiting for child: {}",
                error
            )));
        }
        ProbeWait::TimedOut => {
            let reaped = terminate_and_reap_manifest_probe(child).await;
            let _ = collect_probe_reader(stdout_task, "stdout").await;
            let _ = collect_probe_reader(stderr_task, "stderr").await;
            return Err(ManifestProbeError::Timeout {
                timeout_ms: timeout.as_millis(),
                reaped,
            });
        }
        ProbeWait::Cancelled => {
            let reaped = terminate_and_reap_manifest_probe(child).await;
            let _ = collect_probe_reader(stdout_task, "stdout").await;
            let _ = collect_probe_reader(stderr_task, "stderr").await;
            return Err(ManifestProbeError::Cancelled { reaped });
        }
    };

    let stdout = collect_probe_reader(stdout_task, "stdout")
        .await?
        .into_text();
    let stderr = collect_probe_reader(stderr_task, "stderr")
        .await?
        .into_text();
    if !status.success() {
        return Err(ManifestProbeError::Provider {
            exit_code: status.code().unwrap_or(-1),
            stderr: crate::services::logger::LoggerService::sanitize_log_text(&stderr),
        });
    }

    Ok(ManifestProbeOutput { stdout, stderr })
}

pub struct UpdateCheckService {
    game_version_service: GameVersionService,
    pool: Arc<SqlitePool>,
    runtime_settings: Option<Settings>,
}

impl UpdateCheckService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self {
            game_version_service: GameVersionService::new(),
            pool,
            runtime_settings: None,
        }
    }

    /// Supplies the already-loaded application settings for a background run.
    /// Secrets remain deliberately outside this snapshot and continue to be
    /// read through `SettingsService` from the separate encrypted table.
    pub fn with_runtime_settings(mut self, settings: Settings) -> Self {
        self.runtime_settings = Some(settings);
        self
    }

    pub async fn check_update_for_environment(
        &self,
        env: &Environment,
    ) -> Result<UpdateCheckResult> {
        let mut effective_env = env.clone();
        let env_service = crate::services::environment::EnvironmentService::new(self.pool.clone())?;
        let env_service = match &self.runtime_settings {
            Some(settings) => env_service.with_runtime_settings(settings.clone()),
            // Kept for direct unit construction; managed command and scheduler
            // paths always attach their RuntimeSettingsState snapshot.
            None => env_service,
        };
        if Self::restore_installed_manifest_baseline(&mut effective_env) {
            if let Some(installed_manifest_id) = effective_env.last_manifest_id.as_ref() {
                if let Err(err) = env_service
                    .update_environment(
                        &effective_env.id,
                        vec![(
                            "lastManifestId".to_string(),
                            serde_json::json!(installed_manifest_id),
                        )],
                    )
                    .await
                {
                    log::warn!(
                        "Failed to persist installed manifest baseline for {}: {}",
                        effective_env.id,
                        err
                    );
                }
            }
        }
        let runtime_switch = match env_service
            .reconcile_steam_env_branch_runtime_from_disk(&mut effective_env)
            .await
        {
            Ok(result) => result,
            Err(err) => {
                log::warn!(
                    "Failed to reconcile Steam env {} before update check: {}",
                    effective_env.id,
                    err
                );
                None
            }
        };

        log::info!(
            "Checking for updates: {} (branch: {})",
            effective_env.name,
            effective_env.branch
        );

        let mut result = UpdateCheckResult {
            update_available: false,
            current_manifest_id: effective_env
                .last_manifest_id
                .clone()
                .or_else(|| effective_env.remote_manifest_id.clone()),
            remote_manifest_id: None,
            remote_build_id: None,
            branch: effective_env.branch.clone(),
            runtime: effective_env.runtime.clone(),
            runtime_switch,
            app_id: effective_env.app_id.clone(),
            checked_at: Utc::now(),
            error: None,
            current_game_version: effective_env.current_game_version.clone(),
            update_game_version: None,
        };

        // Extract current game version if environment is completed (but don't fail if this doesn't work)
        if matches!(
            effective_env.status,
            crate::types::EnvironmentStatus::Completed
        ) {
            if let Ok(Some(version)) = self
                .game_version_service
                .extract_game_version(&effective_env.output_dir)
                .await
            {
                log::info!("Extracted current game version: {}", version);
                result.current_game_version = Some(version.clone());
            }
        }

        if effective_env.environment_type == Some(crate::types::EnvironmentType::Steam)
            && !Self::is_supported_schedule_i_managed_branch(&effective_env.branch)
        {
            result.error = Some(format!(
                "Steam installation is on closed or unsupported beta branch '{}'. SIMM recognizes the installation but does not use it for managed-environment update checks.",
                effective_env.branch
            ));
            log::info!(
                "Skipping managed update probe for Steam-only branch '{}' ({})",
                effective_env.branch,
                effective_env.name
            );
            return Ok(result);
        }

        // Steam installs use their on-disk appmanifest as the installed baseline.
        // DepotDownloader only resolves the remote target and never downloads here.
        if effective_env.environment_type == Some(crate::types::EnvironmentType::Steam) {
            log::info!("Steam environment detected, skipping DepotDownloader update check");

            // Still check for remote manifest ID to compare versions, but don't trigger downloads
            match self
                .get_manifest_id_from_depot_downloader(&effective_env.app_id, &effective_env.branch)
                .await
            {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    result.update_available = Self::compare_manifest_ids(
                        &effective_env,
                        &manifest_id,
                        "Steam environment",
                    );
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
                .get_manifest_id_from_depot_downloader(&effective_env.app_id, &effective_env.branch)
                .await
            {
                Ok(manifest_id) => {
                    result.remote_manifest_id = Some(manifest_id.clone());
                    log::info!("Remote manifest ID: {}", manifest_id);

                    result.update_available =
                        Self::compare_manifest_ids(&effective_env, &manifest_id, "Environment");
                }
                Err(e) => {
                    result.error = Some(e.to_string());
                    log::error!(
                        "Failed to get manifest ID for {} (branch: {}): {}",
                        effective_env.app_id,
                        effective_env.branch,
                        e
                    );
                }
            }
        }

        Ok(result)
    }

    fn restore_installed_manifest_baseline(env: &mut Environment) -> bool {
        let installed_manifest =
            if env.environment_type == Some(crate::types::EnvironmentType::Steam) {
                Self::read_steam_installed_manifest_id(env)
            } else {
                Self::read_depot_downloader_installed_manifest_id(env)
            };

        let Some(installed_manifest) = installed_manifest else {
            return false;
        };

        if env.last_manifest_id.as_deref() != Some(installed_manifest.as_str()) {
            log::info!(
                "Restoring installed manifest baseline for {} from {} to {}",
                env.name,
                env.last_manifest_id.as_deref().unwrap_or("none"),
                installed_manifest
            );
            env.last_manifest_id = Some(installed_manifest);
            return true;
        }

        false
    }

    fn read_depot_downloader_installed_manifest_id(env: &Environment) -> Option<String> {
        let manifest_dir = std::path::Path::new(&env.output_dir).join(".DepotDownloader");
        let manifest_name = Regex::new(r"^\d+_(\d+)\.manifest$")
            .expect("installed DepotDownloader manifest regex is valid");
        std::fs::read_dir(&manifest_dir)
            .ok()?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let file_name = entry.file_name().to_string_lossy().to_string();
                let manifest_id = manifest_name
                    .captures(&file_name)?
                    .get(1)?
                    .as_str()
                    .to_string();
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, manifest_id))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, manifest_id)| manifest_id)
    }

    fn read_steam_installed_manifest_id(env: &Environment) -> Option<String> {
        let manifest_path = Self::steam_appmanifest_path(env)?;
        let content = std::fs::read_to_string(manifest_path).ok()?;
        let mut depth = 0usize;
        let mut installed_depots_depth = None;
        let mut entering_installed_depots = false;
        let key_value =
            Regex::new(r#"^\s*\"([^\"]+)\"\s*\"([^\"]+)\""#).expect("VDF key-value regex is valid");

        for line in content.lines() {
            let key = line.split('"').nth(1).map(str::trim);
            let in_installed_depots =
                installed_depots_depth.is_some_and(|section_depth| depth >= section_depth);
            if in_installed_depots && key.is_some_and(|key| key.eq_ignore_ascii_case("manifest")) {
                if let Some(captures) = key_value.captures(line) {
                    return captures.get(2).map(|value| value.as_str().to_string());
                }
            }

            if key.is_some_and(|key| key.eq_ignore_ascii_case("InstalledDepots")) {
                entering_installed_depots = true;
            }

            let opening_braces = line.matches('{').count();
            if opening_braces > 0 {
                depth += opening_braces;
                if entering_installed_depots {
                    installed_depots_depth = Some(depth);
                    entering_installed_depots = false;
                }
            }

            let closing_braces = line.matches('}').count();
            if closing_braces > 0 {
                if installed_depots_depth.is_some_and(|section_depth| depth <= section_depth) {
                    installed_depots_depth = None;
                }
                depth = depth.saturating_sub(closing_braces);
            }
        }

        None
    }

    fn steam_appmanifest_path(env: &Environment) -> Option<std::path::PathBuf> {
        if let Some(path) = env.steam_manifest_path.as_deref() {
            return Some(std::path::PathBuf::from(path));
        }
        if let Some(steamapps_dir) = env.steamapps_dir.as_deref() {
            return Some(
                std::path::Path::new(steamapps_dir).join(format!("appmanifest_{}.acf", env.app_id)),
            );
        }

        std::path::Path::new(&env.output_dir)
            .ancestors()
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steamapps"))
            })
            .map(|steamapps_dir| steamapps_dir.join(format!("appmanifest_{}.acf", env.app_id)))
    }

    pub async fn check_all_environments(
        &self,
        envs: &[Environment],
    ) -> Result<HashMap<String, UpdateCheckResult>> {
        log::info!("Checking for updates on {} environment(s)", envs.len());
        let mut results = HashMap::new();
        let deadline = tokio::time::Instant::now() + ALL_ENVIRONMENT_CHECK_TIMEOUT;

        for env in envs {
            let check_result = if tokio::time::Instant::now() >= deadline {
                Err(anyhow::anyhow!(
                    "Update check batch exceeded its {} second deadline",
                    ALL_ENVIRONMENT_CHECK_TIMEOUT.as_secs()
                ))
            } else {
                match tokio::time::timeout_at(deadline, self.check_update_for_environment(env))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!(
                        "Update check batch exceeded its {} second deadline",
                        ALL_ENVIRONMENT_CHECK_TIMEOUT.as_secs()
                    )),
                }
            };

            match check_result {
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
                            runtime: env.runtime.clone(),
                            runtime_switch: None,
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
        Self::reconcile_peer_versions_for_shared_remote_manifest(envs, &mut results);
        Self::infer_updates_from_release_track_versions(envs, &mut results);

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

                    if candidate_id == &env.id
                        || candidate_env.app_id != env.app_id
                        || candidate_env.branch != env.branch
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

    fn reconcile_peer_versions_for_shared_remote_manifest(
        envs: &[Environment],
        results: &mut HashMap<String, UpdateCheckResult>,
    ) {
        let env_map: HashMap<&str, &Environment> =
            envs.iter().map(|env| (env.id.as_str(), env)).collect();

        for env in envs {
            let Some(current_result) = results.get(env.id.as_str()) else {
                continue;
            };
            let Some(remote_manifest_id) = current_result.remote_manifest_id.clone() else {
                continue;
            };
            let Some(current_version) = current_result.current_game_version.clone() else {
                continue;
            };

            let best_peer_version = results
                .iter()
                .filter_map(|(candidate_id, candidate_result)| {
                    let candidate_env = env_map.get(candidate_id.as_str())?;
                    let candidate_remote_manifest =
                        candidate_result.remote_manifest_id.as_deref()?;
                    let candidate_version = candidate_result.current_game_version.as_deref()?;

                    if candidate_env.app_id != env.app_id
                        || candidate_env.branch != env.branch
                        || candidate_remote_manifest != remote_manifest_id.as_str()
                    {
                        return None;
                    }

                    Some(candidate_version)
                })
                .max_by(|left, right| Self::compare_game_versions(left, right))
                .map(str::to_string);

            let Some(best_peer_version) = best_peer_version else {
                continue;
            };

            let ordering = Self::compare_game_versions(&current_version, &best_peer_version);
            let Some(result) = results.get_mut(env.id.as_str()) else {
                continue;
            };

            if ordering.is_lt() {
                if !result.update_available
                    || result.update_game_version.as_deref() != Some(best_peer_version.as_str())
                {
                    log::info!(
                        "Inferring update for {} from shared remote manifest {} and peer version {} -> {}",
                        env.name,
                        remote_manifest_id,
                        current_version,
                        best_peer_version
                    );
                    result.update_available = true;
                    result.update_game_version = Some(best_peer_version);
                }
            } else if !result.update_available {
                result.update_game_version = None;
            }
        }
    }

    fn infer_updates_from_release_track_versions(
        envs: &[Environment],
        results: &mut HashMap<String, UpdateCheckResult>,
    ) {
        let env_map: HashMap<&str, &Environment> =
            envs.iter().map(|env| (env.id.as_str(), env)).collect();

        for env in envs {
            let Some(current_result) = results.get(env.id.as_str()) else {
                continue;
            };
            let Some(current_version) = current_result.current_game_version.clone() else {
                continue;
            };

            let release_track = Self::release_track_for_branch(&env.branch);
            let best_track_version = results
                .iter()
                .filter_map(|(candidate_id, candidate_result)| {
                    let candidate_env = env_map.get(candidate_id.as_str())?;
                    let candidate_version = candidate_result.current_game_version.as_deref()?;

                    if candidate_env.app_id != env.app_id
                        || Self::release_track_for_branch(&candidate_env.branch) != release_track
                    {
                        return None;
                    }

                    Some(candidate_version)
                })
                .max_by(|left, right| Self::compare_game_versions(left, right))
                .map(str::to_string);

            let Some(best_track_version) = best_track_version else {
                continue;
            };

            let Some(result) = results.get_mut(env.id.as_str()) else {
                continue;
            };

            if Self::compare_game_versions(&current_version, &best_track_version).is_lt() {
                if !result.update_available
                    || result.update_game_version.as_deref() != Some(best_track_version.as_str())
                {
                    log::info!(
                        "Inferring update for {} from {} release-track version {} -> {}",
                        env.name,
                        release_track,
                        current_version,
                        best_track_version
                    );
                    result.update_available = true;
                    result.update_game_version = Some(best_track_version);
                }
            } else if !result.update_available {
                result.update_game_version = None;
            }
        }
    }

    fn release_track_for_branch(branch: &str) -> &str {
        match branch {
            "alternate" => "main",
            "alternate-beta" => "beta",
            other => other,
        }
    }

    fn is_supported_schedule_i_managed_branch(branch: &str) -> bool {
        matches!(
            branch.to_ascii_lowercase().as_str(),
            "main" | "beta" | "alternate" | "alternate-beta"
        )
    }

    fn compare_game_versions(left: &str, right: &str) -> std::cmp::Ordering {
        fn parse(version: &str) -> Option<(u32, u32, u32, String, u32)> {
            let pattern = Regex::new(r"^(\d+)\.(\d+)\.(\d+)([a-z]?)(\d*)$").ok()?;
            let captures = pattern.captures(version)?;
            Some((
                captures.get(1)?.as_str().parse().ok()?,
                captures.get(2)?.as_str().parse().ok()?,
                captures.get(3)?.as_str().parse().ok()?,
                captures
                    .get(4)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
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

    fn parse_manifest_id_from_probe_output(output: &str) -> Option<String> {
        // Accept only a manifest-labelled line or DepotDownloader's structured
        // manifestid field. Arbitrary build IDs, timestamps, and account IDs
        // must never become a remote manifest baseline.
        let labelled = Regex::new(r"(?im)^\s*manifest(?:\s*id)?\s*(?::|=|\s)\s*(\d+)\s*$")
            .expect("manifest label regex is valid");
        if let Some(manifest_id) = labelled
            .captures(output)
            .and_then(|captures| captures.get(1))
        {
            return Some(manifest_id.as_str().to_string());
        }

        let structured =
            Regex::new(r#"(?im)^\s*(?:\{\s*)?"manifestid"\s*:\s*"?(\d+)"?\s*,?\s*(?:\}\s*)?$"#)
                .expect("structured manifest regex is valid");
        structured
            .captures(output)
            .and_then(|captures| captures.get(1))
            .map(|manifest_id| manifest_id.as_str().to_string())
    }

    fn build_manifest_probe_command(
        executable: &std::path::Path,
        app_id: &str,
        branch: &str,
        username: &str,
        platform: &crate::types::Platform,
        depots_dir: &std::path::Path,
        probe_dir: &std::path::Path,
        remembered_session: bool,
    ) -> Command {
        let mut cmd = Command::new(executable);
        cmd.arg("-app")
            .arg(app_id)
            .arg("-branch")
            .arg(branch)
            .arg("-username")
            .arg(username)
            .arg("-loginid")
            .arg(unique_login_id())
            .arg("-os")
            .arg(DepotDownloaderService::platform_arg(platform))
            .arg("-manifest-only")
            .arg("-dir")
            .arg(probe_dir)
            .current_dir(depots_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if remembered_session {
            cmd.arg("-remember-password");
        }
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        cmd
    }

    async fn get_manifest_id_from_depot_downloader(
        &self,
        app_id: &str,
        branch: &str,
    ) -> Result<String> {
        // Get credentials from settings for authentication
        let mut settings_service =
            SettingsService::new(self.pool.clone()).context("Failed to create settings service")?;
        let settings = match self.runtime_settings.as_ref() {
            Some(settings) => settings.clone(),
            None => settings_service
                .load_settings()
                .await
                .context("Failed to load settings")?,
        };

        let detector_info =
            detect_depot_downloader_with_override(settings.depot_downloader_path.as_deref())
                .await
                .context("Failed to detect DepotDownloader")?;
        if !detector_info.installed {
            return Err(anyhow::anyhow!("DepotDownloader is not installed"));
        }
        let depot_downloader_path = detector_info
            .path
            .ok_or_else(|| anyhow::anyhow!("DepotDownloader path not found"))?;

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
        let depot_platform =
            DepotDownloaderService::resolve_depot_platform(app_id, settings.platform.clone());

        log::info!(
            "Fetching manifest ID from Steam: app_id={}, branch={}",
            app_id,
            branch
        );

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        // Keep the shared account store as the process CWD so remembered
        // sessions remain usable, but direct depot/cache output into an empty
        // probe directory so an old local manifest cannot satisfy this query.
        let manifest_probe_dir = tempdir_in(&depots_dir)
            .context("Failed to create temporary manifest probe directory")?;

        // Build command with authentication
        let mut cmd = Self::build_manifest_probe_command(
            std::path::Path::new(&depot_downloader_path),
            app_id,
            branch,
            &username,
            &depot_platform,
            &depots_dir,
            manifest_probe_dir.path(),
            settings
                .depot_downloader_remembered_session
                .unwrap_or(false),
        );

        let process_permit = acquire_process_permit().await;
        let child = cmd.spawn().map_err(ManifestProbeError::Spawn)?;
        let output = ManifestProbeTask::spawn(child, process_permit)
            .finish()
            .await?;

        let output_str = output.stdout;
        let error_str = output.stderr;
        let all_output = format!("{}{}", output_str, error_str);
        let sanitized_stdout =
            crate::services::logger::LoggerService::sanitize_log_text(&output_str);
        let sanitized_stderr =
            crate::services::logger::LoggerService::sanitize_log_text(&error_str);
        let sanitized_output =
            crate::services::logger::LoggerService::sanitize_log_text(&all_output);

        log::info!("DepotDownloader stdout: {}", sanitized_stdout);
        if !error_str.is_empty() {
            log::info!("DepotDownloader stderr: {}", sanitized_stderr);
        }

        if let Some(manifest_id) = Self::parse_manifest_id_from_probe_output(&all_output) {
            log::info!("Found manifest ID: {}", manifest_id);
            return Ok(manifest_id);
        }

        log::error!("Could not parse manifest ID from DepotDownloader output");

        Err(anyhow::anyhow!(
            "Could not parse manifest ID from DepotDownloader output. Output: {}",
            sanitized_output
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

    #[test]
    fn manifest_probe_parser_requires_anchored_manifest_context() {
        assert_eq!(
            UpdateCheckService::parse_manifest_id_from_probe_output(
                "Manifest: 5738443694136269112\n"
            )
            .as_deref(),
            Some("5738443694136269112")
        );
        assert_eq!(
            UpdateCheckService::parse_manifest_id_from_probe_output(
                "{\n  \"manifestid\": 3260909537147661748\n}\n"
            )
            .as_deref(),
            Some("3260909537147661748")
        );
        assert!(UpdateCheckService::parse_manifest_id_from_probe_output(
            "Account 123456789012345 authenticated\nBuild 987654321098765 ready\n"
        )
        .is_none());
    }

    #[test]
    fn remembered_manifest_probe_uses_shared_account_cwd_and_isolated_output() {
        let temp = tempdir().expect("temporary root");
        let depots = temp.path().join("depots");
        let probe = depots.join("probe");
        let executable = temp.path().join("DepotDownloader.exe");
        let command = UpdateCheckService::build_manifest_probe_command(
            &executable,
            "3164500",
            "alternate-beta",
            "fixture-user",
            &crate::types::Platform::Windows,
            &depots,
            &probe,
            true,
        );
        let std_command = command.as_std();
        assert_eq!(std_command.get_current_dir(), Some(depots.as_path()));
        let args = std_command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|window| { window[0] == "-dir" && window[1] == probe.to_string_lossy() }));
        assert!(args.iter().any(|arg| arg == "-remember-password"));
        assert!(args
            .windows(2)
            .any(|window| { window[0] == "-loginid" && window[1].parse::<u32>().is_ok() }));
    }

    #[tokio::test]
    async fn manifest_probe_timeout_kills_and_reaps_child_fixture() -> Result<()> {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args([
                "/D",
                "/Q",
                "/C",
                "echo Manifest: 5738443694136269112 & for /L %i in (1,1,2147483647) do @rem fixture",
            ]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "printf 'Manifest: 5738443694136269112\\n'; while :; do :; done",
            ]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;

        let error = run_manifest_probe_child(&mut child, Duration::from_millis(50), None)
            .await
            .expect_err("fixture must exceed the short manifest-probe deadline");

        assert!(matches!(
            error,
            ManifestProbeError::Timeout { reaped: true, .. }
        ));
        assert!(
            child.try_wait()?.is_some(),
            "timed-out fixture must already be reaped"
        );
        Ok(())
    }

    #[tokio::test]
    async fn manifest_probe_output_reader_caps_retained_bytes_while_draining() -> Result<()> {
        let input = vec![b'x'; 64];
        let output = read_capped_probe_output(input.as_slice(), 16).await?;
        assert_eq!(output.bytes.len(), 16);
        assert!(output.truncated);
        Ok(())
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
            steamapps_dir: None,
            steam_manifest_path: None,
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
            steamapps_dir: None,
            steam_manifest_path: None,
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
            steamapps_dir: None,
            steam_manifest_path: None,
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
    fn supported_schedule_i_managed_branches_exclude_closed_beta_keys() {
        assert!(UpdateCheckService::is_supported_schedule_i_managed_branch(
            "beta"
        ));
        assert!(UpdateCheckService::is_supported_schedule_i_managed_branch(
            "ALTERNATE-BETA"
        ));
        assert!(!UpdateCheckService::is_supported_schedule_i_managed_branch(
            "closed-beta"
        ));
        assert!(!UpdateCheckService::is_supported_schedule_i_managed_branch(
            "qa_preview"
        ));
    }

    #[test]
    fn restore_installed_manifest_baseline_reads_the_environment_manifest_file() -> Result<()> {
        let temp = tempdir()?;
        let manifest_dir = temp.path().join(".DepotDownloader");
        std::fs::create_dir_all(&manifest_dir)?;
        std::fs::write(
            manifest_dir.join("3164501_2624148878279466820.manifest"),
            b"manifest contents",
        )?;

        let mut env = Environment {
            id: "beta".to_string(),
            name: "Beta".to_string(),
            description: None,
            app_id: schedule_i_config().app_id.clone(),
            branch: "beta".to_string(),
            output_dir: temp.path().to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: Some("incorrect-remote-manifest".to_string()),
            last_update_check: None,
            update_available: Some(false),
            remote_manifest_id: Some("incorrect-remote-manifest".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.5f2".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        assert!(UpdateCheckService::restore_installed_manifest_baseline(
            &mut env
        ));

        assert_eq!(env.last_manifest_id.as_deref(), Some("2624148878279466820"));
        Ok(())
    }

    #[test]
    fn restore_installed_manifest_baseline_reads_the_steam_appmanifest() -> Result<()> {
        let temp = tempdir()?;
        let manifest_path = temp.path().join("appmanifest_3164500.acf");
        std::fs::write(
            &manifest_path,
            r#""AppState"
{
    "InstalledDepots"
    {
        "3164501"
        {
            "manifest" "3260909537147661748"
        }
    }
    "PrivateDepots"
    {
        "3164501"
        {
            "manifests"
            {
                "closed-beta"
                {
                    "gid" "5738443694136269112"
                }
            }
        }
    }
}
"#,
        )?;

        let mut env = Environment {
            id: "steam-installation".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "beta".to_string(),
            output_dir: temp.path().join("Schedule I").to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: Some("5738443694136269112".to_string()),
            last_update_check: None,
            update_available: Some(true),
            remote_manifest_id: Some("3260909537147661748".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.6f11".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: Some(manifest_path.to_string_lossy().to_string()),
            environment_type: Some(EnvironmentType::Steam),
        };

        assert!(UpdateCheckService::restore_installed_manifest_baseline(
            &mut env
        ));
        assert_eq!(env.last_manifest_id.as_deref(), Some("3260909537147661748"));
        assert!(!UpdateCheckService::compare_manifest_ids(
            &env,
            "3260909537147661748",
            "Steam environment"
        ));
        Ok(())
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
            steamapps_dir: None,
            steam_manifest_path: None,
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
                    current_manifest_id: Some("317".to_string()),
                    remote_manifest_id: Some("317".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    runtime: beta_env.runtime.clone(),
                    runtime_switch: None,
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
                    runtime: steam_beta_env.runtime.clone(),
                    runtime_switch: None,
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
    fn infer_updates_for_missing_manifest_baseline_ignores_other_app_ids() {
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
            remote_manifest_id: Some("317".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.3f3".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let other_app_peer = Environment {
            id: "other-beta".to_string(),
            name: "Other App Beta".to_string(),
            app_id: "9999999".to_string(),
            current_game_version: Some("0.4.4f6".to_string()),
            environment_type: Some(EnvironmentType::Steam),
            ..beta_env.clone()
        };

        let mut results = HashMap::from([
            (
                beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("317".to_string()),
                    remote_manifest_id: Some("317".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    runtime: beta_env.runtime.clone(),
                    runtime_switch: None,
                    app_id: beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.3f3".to_string()),
                    update_game_version: None,
                },
            ),
            (
                other_app_peer.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("802".to_string()),
                    remote_manifest_id: Some("802".to_string()),
                    remote_build_id: None,
                    branch: other_app_peer.branch.clone(),
                    runtime: other_app_peer.runtime.clone(),
                    runtime_switch: None,
                    app_id: other_app_peer.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.4f6".to_string()),
                    update_game_version: None,
                },
            ),
        ]);

        UpdateCheckService::infer_updates_for_missing_manifest_baselines(
            &[beta_env.clone(), other_app_peer.clone()],
            &mut results,
        );

        let beta_result = results.get("beta").expect("beta result");
        assert!(!beta_result.update_available);
        assert!(beta_result.update_game_version.is_none());
    }

    #[test]
    fn reconcile_peer_versions_flags_older_branch_peer_across_schedule_i_releases() {
        let steam_env = Environment {
            id: "steam-beta".to_string(),
            name: "Steam Installation".to_string(),
            description: None,
            app_id: schedule_i_config().app_id.clone(),
            branch: "beta".to_string(),
            output_dir: "C:\\steam-beta".to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: Some("3347041993176785453".to_string()),
            last_update_check: None,
            update_available: Some(true),
            remote_manifest_id: Some("3828069228120160165".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.6f5".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::Steam),
        };

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
            last_manifest_id: Some("3828069228120160165".to_string()),
            last_update_check: None,
            update_available: Some(false),
            remote_manifest_id: Some("3828069228120160165".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.5f2".to_string()),
            update_game_version: Some("0.4.5f2".to_string()),
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let mut results = HashMap::from([
            (
                steam_env.id.clone(),
                UpdateCheckResult {
                    update_available: true,
                    current_manifest_id: Some("3347041993176785453".to_string()),
                    remote_manifest_id: Some("3828069228120160165".to_string()),
                    remote_build_id: None,
                    branch: steam_env.branch.clone(),
                    runtime: steam_env.runtime.clone(),
                    runtime_switch: None,
                    app_id: steam_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.6f5".to_string()),
                    update_game_version: None,
                },
            ),
            (
                beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("3828069228120160165".to_string()),
                    remote_manifest_id: Some("3828069228120160165".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    runtime: beta_env.runtime.clone(),
                    runtime_switch: None,
                    app_id: beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.5f2".to_string()),
                    update_game_version: Some("0.4.5f2".to_string()),
                },
            ),
        ]);

        UpdateCheckService::reconcile_peer_versions_for_shared_remote_manifest(
            &[steam_env, beta_env],
            &mut results,
        );

        let steam_update = results.get("steam-beta").expect("steam result");
        assert!(steam_update.update_available);
        assert_eq!(
            steam_update.current_manifest_id.as_deref(),
            Some("3347041993176785453")
        );
        assert_eq!(
            steam_update.remote_manifest_id.as_deref(),
            Some("3828069228120160165")
        );

        let updated_beta = results.get("beta").expect("beta result");
        assert!(updated_beta.update_available);
        assert_eq!(updated_beta.update_game_version.as_deref(), Some("0.4.6f5"));
    }

    #[test]
    fn infer_updates_from_release_track_versions_pairs_beta_and_alternate_beta() {
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
            last_manifest_id: Some("3828069228120160165".to_string()),
            last_update_check: None,
            update_available: Some(false),
            remote_manifest_id: Some("3828069228120160165".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.5f1".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

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
            last_manifest_id: Some("6863174197092412323".to_string()),
            last_update_check: None,
            update_available: Some(false),
            remote_manifest_id: Some("6863174197092412323".to_string()),
            remote_build_id: None,
            current_game_version: Some("0.4.4f10".to_string()),
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let mut results = HashMap::from([
            (
                beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("3828069228120160165".to_string()),
                    remote_manifest_id: Some("3828069228120160165".to_string()),
                    remote_build_id: None,
                    branch: beta_env.branch.clone(),
                    runtime: beta_env.runtime.clone(),
                    runtime_switch: None,
                    app_id: beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.5f1".to_string()),
                    update_game_version: None,
                },
            ),
            (
                alternate_beta_env.id.clone(),
                UpdateCheckResult {
                    update_available: false,
                    current_manifest_id: Some("6863174197092412323".to_string()),
                    remote_manifest_id: Some("6863174197092412323".to_string()),
                    remote_build_id: None,
                    branch: alternate_beta_env.branch.clone(),
                    runtime: alternate_beta_env.runtime.clone(),
                    runtime_switch: None,
                    app_id: alternate_beta_env.app_id.clone(),
                    checked_at: Utc::now(),
                    error: None,
                    current_game_version: Some("0.4.4f10".to_string()),
                    update_game_version: None,
                },
            ),
        ]);

        UpdateCheckService::infer_updates_from_release_track_versions(
            &[beta_env, alternate_beta_env],
            &mut results,
        );

        let alternate_beta = results
            .get("alternate-beta")
            .expect("alternate-beta result");
        assert!(alternate_beta.update_available);
        assert_eq!(
            alternate_beta.update_game_version.as_deref(),
            Some("0.4.5f1")
        );
    }
}
