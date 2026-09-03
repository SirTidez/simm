use crate::types::{DepotDownloadOptions, DownloadProgress, DownloadStatus};
use crate::utils::depot_downloader_detector::detect_depot_downloader_with_override;
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
#[cfg(target_os = "windows")]
#[allow(unused_imports)] // Required for CommandExt trait methods
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
use tokio::task::JoinHandle;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

pub struct DepotDownloaderService {
    active_downloads: Arc<RwLock<HashMap<String, ActiveDownload>>>,
    download_progress: Arc<RwLock<HashMap<String, DownloadProgress>>>,
    auth_prompted_downloads: Arc<RwLock<HashSet<String>>>,
    credential_handoffs: Arc<RwLock<HashMap<String, CredentialHandoffPhase>>>,
    shutting_down: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialHandoffPhase {
    Supplied,
    PromptObserved,
    Authenticated,
}

struct ActiveDownload {
    child: Child,
    stdout_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
    output_dir: String,
    operation_id: String,
    _process_permit: Option<OwnedMutexGuard<()>>,
}

impl ActiveDownload {
    async fn join_reader_before(
        task: Option<JoinHandle<()>>,
        deadline: tokio::time::Instant,
    ) -> bool {
        let Some(mut task) = task else {
            return true;
        };

        if tokio::time::timeout_at(deadline, &mut task).await.is_ok() {
            return true;
        }

        // Never detach a reader task after the shutdown deadline. These tasks
        // only await pipe input, so aborting and joining is safe once the
        // child-reap deadline has elapsed.
        task.abort();
        let _ = task.await;
        false
    }

    async fn join_readers_before(&mut self, deadline: tokio::time::Instant) -> bool {
        let stdout_task = self.stdout_task.take();
        let stderr_task = self.stderr_task.take();
        let stdout_joined = Self::join_reader_before(stdout_task, deadline).await;
        let stderr_joined = Self::join_reader_before(stderr_task, deadline).await;
        stdout_joined && stderr_joined
    }

    async fn kill_reap_and_join_before(&mut self, deadline: tokio::time::Instant) -> bool {
        let child_reaped = match self.child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => {
                // `shutdown` requests termination before doing its bounded
                // persistence work. A repeated start_kill can report an error
                // even though termination is already in flight, so always
                // proceed to the bounded reap.
                let _ = self.child.start_kill();
                tokio::time::timeout_at(deadline, self.child.wait())
                    .await
                    .is_ok()
            }
            Err(_) => {
                let _ = self.child.start_kill();
                tokio::time::timeout_at(deadline, self.child.wait())
                    .await
                    .is_ok()
            }
        };
        let readers_joined = self.join_readers_before(deadline).await;
        child_reaped && readers_joined
    }

    #[cfg(test)]
    fn child_fixture(child: Child) -> Self {
        Self {
            child,
            stdout_task: None,
            stderr_task: None,
            output_dir: String::new(),
            operation_id: unique_login_id(),
            _process_permit: None,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DepotShutdownReport {
    pub interrupted_download_ids: Vec<String>,
    pub timed_out_download_ids: Vec<String>,
}

// DepotDownloader normally completes far sooner; this is a fail-safe so a
// stalled child cannot keep the global download gate forever.
const DEPOT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
pub const DEPOT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

static DEPOT_PROCESS_GATE: Lazy<Arc<Mutex<()>>> = Lazy::new(|| Arc::new(Mutex::new(())));
static DEPOT_LOGIN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) async fn acquire_process_permit() -> OwnedMutexGuard<()> {
    DEPOT_PROCESS_GATE.clone().lock_owned().await
}

/// Owns a newly spawned child until it has been published in active_downloads.
/// If start_download is cancelled at one of the intervening async lock points,
/// cleanup keeps the global process permit until the child has been killed and
/// reaped.
struct PendingDepotChild {
    child: Option<Child>,
    process_permit: Option<OwnedMutexGuard<()>>,
}

impl PendingDepotChild {
    fn new(child: Child, process_permit: OwnedMutexGuard<()>) -> Self {
        Self {
            child: Some(child),
            process_permit: Some(process_permit),
        }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("pending child remains owned")
    }

    fn into_parts(mut self) -> (Child, OwnedMutexGuard<()>) {
        (
            self.child.take().expect("pending child remains owned"),
            self.process_permit
                .take()
                .expect("pending process permit remains owned"),
        )
    }
}

impl Drop for PendingDepotChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let process_permit = self.process_permit.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = child.kill().await;
                drop(process_permit);
            });
        } else {
            let _ = child.start_kill();
            drop(process_permit);
        }
    }
}

pub(crate) fn unique_login_id() -> String {
    let sequence = DEPOT_LOGIN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    (sequence % u64::from(u32::MAX)).max(1).to_string()
}

fn ensure_no_active_game_download(
    active_download_id: Option<&str>,
    requested_download_id: &str,
) -> Result<()> {
    if let Some(active_download_id) = active_download_id {
        return Err(anyhow::anyhow!(
            "Another game download or update is already running for {}. Wait for it to finish before starting {}.",
            active_download_id,
            requested_download_id
        ));
    }
    Ok(())
}

impl DepotDownloaderService {
    pub fn new() -> Self {
        Self {
            active_downloads: Arc::new(RwLock::new(HashMap::new())),
            download_progress: Arc::new(RwLock::new(HashMap::new())),
            auth_prompted_downloads: Arc::new(RwLock::new(HashSet::new())),
            credential_handoffs: Arc::new(RwLock::new(HashMap::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn resolve_depot_platform(
        app_id: &str,
        configured_platform: crate::types::Platform,
    ) -> crate::types::Platform {
        if cfg!(not(target_os = "windows"))
            && app_id == crate::services::steam::SteamService::get_steam_app_id()
        {
            crate::types::Platform::Windows
        } else {
            configured_platform
        }
    }

    pub(crate) fn platform_arg(platform: &crate::types::Platform) -> &'static str {
        match platform {
            crate::types::Platform::Windows => "windows",
            crate::types::Platform::Macos => "macos",
            crate::types::Platform::Linux => "linux",
        }
    }

    fn build_command_args(&self, options: &DepotDownloadOptions) -> Vec<String> {
        let mut args = Vec::new();

        args.push("-app".to_string());
        args.push(options.app_id.clone());
        args.push("-branch".to_string());
        args.push(options.branch.clone());
        args.push("-dir".to_string());
        args.push(options.output_dir.clone());

        if let Some(ref username) = options.username {
            args.push("-username".to_string());
            args.push(username.clone());
        }

        args.push("-loginid".to_string());
        args.push(unique_login_id());

        if options.remember_credentials {
            args.push("-remember-password".to_string());
        }

        if options.validate.unwrap_or(false) {
            args.push("-validate".to_string());
        }

        if let Some(ref os) = options.os {
            args.push("-os".to_string());
            args.push(Self::platform_arg(os).to_string());
        }

        if let Some(ref language) = options.language {
            args.push("-language".to_string());
            args.push(language.clone());
        }

        if let Some(max_downloads) = options.max_downloads {
            args.push("-max-downloads".to_string());
            args.push(max_downloads.to_string());
        }

        args
    }

    fn credential_stdin_payload(options: &DepotDownloadOptions) -> Option<Vec<u8>> {
        let mut values = Vec::new();
        if let Some(password) = options
            .password
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            values.push(password);
        }
        if let Some(steam_guard) = options
            .steam_guard
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            values.push(steam_guard);
        }

        (!values.is_empty()).then(|| format!("{}\n", values.join("\n")).into_bytes())
    }

    async fn write_credential_input(mut stdin: ChildStdin, payload: &[u8]) -> Result<()> {
        stdin
            .write_all(payload)
            .await
            .context("Failed to send one-time Steam credentials to DepotDownloader")?;
        stdin
            .shutdown()
            .await
            .context("Failed to close DepotDownloader credential stdin")?;
        Ok(())
    }

    async fn observe_supplied_credential_prompt(&self, download_id: &str) -> bool {
        let mut handoffs = self.credential_handoffs.write().await;
        let Some(phase) = handoffs.get_mut(download_id) else {
            return false;
        };
        match phase {
            CredentialHandoffPhase::Supplied | CredentialHandoffPhase::PromptObserved => {
                *phase = CredentialHandoffPhase::PromptObserved;
                true
            }
            CredentialHandoffPhase::Authenticated => false,
        }
    }

    async fn mark_credentials_authenticated(&self, download_id: &str) {
        if let Some(phase) = self.credential_handoffs.write().await.get_mut(download_id) {
            *phase = CredentialHandoffPhase::Authenticated;
        }
    }

    async fn clear_auth_state(&self, download_id: &str) {
        self.auth_prompted_downloads
            .write()
            .await
            .remove(download_id);
        self.credential_handoffs.write().await.remove(download_id);
    }

    async fn take_auth_retry_requested(&self, download_id: &str) -> bool {
        let requested = self
            .auth_prompted_downloads
            .write()
            .await
            .remove(download_id);
        self.credential_handoffs.write().await.remove(download_id);
        requested
    }

    async fn request_auth_retry(&self, download_id: &str) -> bool {
        self.credential_handoffs.write().await.remove(download_id);
        self.auth_prompted_downloads
            .write()
            .await
            .insert(download_id.to_string());
        let mut active_downloads = self.active_downloads.write().await;
        if let Some(download) = active_downloads.get_mut(download_id) {
            if let Err(error) = download.child.start_kill() {
                log::warn!(
                    "[DepotDownloader] Failed to stop password-prompt process {}: {}",
                    download_id,
                    error
                );
                drop(active_downloads);
                self.auth_prompted_downloads
                    .write()
                    .await
                    .remove(download_id);
                return false;
            }
            true
        } else {
            drop(active_downloads);
            self.clear_auth_state(download_id).await;
            false
        }
    }

    #[cfg(test)]
    async fn take_finished_download(&self, download_id: &str) -> bool {
        let mut active_downloads = self.active_downloads.write().await;
        let is_finished = active_downloads
            .get_mut(download_id)
            .and_then(|download| download.child.try_wait().ok().flatten())
            .is_some();
        let mut finished_download = is_finished
            .then(|| active_downloads.remove(download_id))
            .flatten();
        drop(active_downloads);
        if let Some(download) = finished_download.as_mut() {
            let _ = download
                .join_readers_before(tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT)
                .await;
        }
        if is_finished {
            self.clear_auth_state(download_id).await;
        }
        is_finished
    }

    fn read_installed_manifest_id(output_dir: &str) -> Option<String> {
        let manifest_dir = std::path::Path::new(output_dir).join(".DepotDownloader");
        let manifest_name = Regex::new(r"^\d+_(\d+)\.manifest$")
            .expect("installed DepotDownloader manifest regex is valid");

        std::fs::read_dir(manifest_dir)
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

    async fn persist_completed_download<R: Runtime>(
        app: &AppHandle<R>,
        download_id: &str,
        manifest_id: Option<&str>,
    ) {
        let Some(pool) = app.try_state::<Arc<SqlitePool>>() else {
            log::error!(
                "[DepotDownloader] Cannot persist completed download {} because SIMM database state is unavailable",
                download_id
            );
            return;
        };
        let pool = pool.inner().clone();
        if let Err(error) =
            Self::persist_completed_download_to_pool(pool, download_id, manifest_id).await
        {
            log::error!(
                "[DepotDownloader] Failed to persist completed download {}: {:#}",
                download_id,
                error
            );
        }
    }

    async fn persist_completed_download_to_pool(
        pool: Arc<SqlitePool>,
        download_id: &str,
        manifest_id: Option<&str>,
    ) -> Result<()> {
        let environment_service = crate::services::environment::EnvironmentService::new(pool)?;
        let mut updates = vec![
            ("status".to_string(), serde_json::json!("completed")),
            ("updateAvailable".to_string(), serde_json::json!(false)),
            ("updateGameVersion".to_string(), serde_json::Value::Null),
        ];
        if let Some(manifest_id) = manifest_id {
            updates.push(("lastManifestId".to_string(), serde_json::json!(manifest_id)));
            updates.push((
                "remoteManifestId".to_string(),
                serde_json::json!(manifest_id),
            ));
        }

        environment_service
            .update_environment(download_id, updates)
            .await?;
        Ok(())
    }

    async fn persist_interrupted_download_to_pool(
        pool: Arc<SqlitePool>,
        download_id: &str,
    ) -> Result<()> {
        crate::services::environment::EnvironmentService::new(pool)?
            .update_environment(
                download_id,
                vec![("status".to_string(), serde_json::json!("error"))],
            )
            .await?;
        Ok(())
    }

    async fn persist_interrupted_download_before<R: Runtime>(
        app: &AppHandle<R>,
        download_id: &str,
        deadline: tokio::time::Instant,
    ) {
        let Some(pool) = app.try_state::<Arc<SqlitePool>>() else {
            log::warn!(
                "[DepotDownloader] Cannot persist interrupted download {} because database state is unavailable",
                download_id
            );
            return;
        };
        match tokio::time::timeout_at(
            deadline,
            Self::persist_interrupted_download_to_pool(pool.inner().clone(), download_id),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!(
                "[DepotDownloader] Failed to persist interrupted download {}: {:#}",
                download_id,
                error
            ),
            Err(_) => log::warn!(
                "[DepotDownloader] Timed out persisting interrupted download {} during shutdown",
                download_id
            ),
        }
    }

    pub async fn reconcile_interrupted_downloads(pool: Arc<SqlitePool>) -> Result<Vec<String>> {
        let environment_service =
            crate::services::environment::EnvironmentService::new(pool.clone())?;
        let mut interrupted_ids = environment_service
            .get_environments()
            .await?
            .into_iter()
            .filter(|environment| {
                matches!(
                    environment.status,
                    crate::types::EnvironmentStatus::Downloading
                )
            })
            .map(|environment| environment.id)
            .collect::<Vec<_>>();
        interrupted_ids.sort();

        for download_id in &interrupted_ids {
            Self::persist_interrupted_download_to_pool(pool.clone(), download_id).await?;
        }

        Ok(interrupted_ids)
    }

    async fn parse_progress<R: Runtime>(
        &self,
        line: &str,
        download_id: &str,
        app: &AppHandle<R>,
    ) -> Result<()> {
        if self
            .download_progress
            .read()
            .await
            .get(download_id)
            .is_some_and(|progress| {
                matches!(
                    progress.status,
                    DownloadStatus::Cancelled | DownloadStatus::Completed | DownloadStatus::Error
                )
            })
        {
            return Ok(());
        }

        let mut progress = {
            let map = self.download_progress.write().await;
            map.get(download_id)
                .cloned()
                .unwrap_or_else(|| DownloadProgress {
                    download_id: download_id.to_string(),
                    operation_id: unique_login_id(),
                    status: DownloadStatus::Downloading,
                    progress: 0.0,
                    downloaded_files: None,
                    total_files: None,
                    speed: None,
                    eta: None,
                    message: None,
                    error: None,
                    manifest_id: None,
                })
        };

        let lower_line = line.to_lowercase();
        let invalid_password = lower_line.contains("password")
            && (lower_line.contains("incorrect")
                || lower_line.contains("invalid")
                || lower_line.contains("wrong"));

        // Check for password prompts
        if !invalid_password
            && (lower_line.contains("enter account password")
                || lower_line.contains("password for")
                || (lower_line.contains("password")
                    && (lower_line.contains(':') || lower_line.contains('>'))))
        {
            if self.observe_supplied_credential_prompt(download_id).await {
                // This operation already has a one-time payload buffered on
                // stdin. Let DepotDownloader consume it; killing here would
                // turn a valid handoff into a false retry loop.
                progress.message = Some("Submitting one-time Steam credentials...".to_string());
                self.download_progress
                    .write()
                    .await
                    .insert(download_id.to_string(), progress.clone());
                crate::events::emit_progress(app, progress)?;
                return Ok(());
            }

            // DepotDownloader waits on stdin after this prompt. SIMM does not
            // forward a password through process arguments, so terminate the
            // attempt and let the auth flow retry. Keep the killed child in
            // the map until the completion task reaps it and joins both output
            // readers, rather than orphaning those tasks or the progress row.
            let retry_requested = self.request_auth_retry(download_id).await;
            progress.message = Some(line.trim().to_string());
            progress.status = DownloadStatus::Error;
            progress.error = Some(if retry_requested {
                "Steam authentication required before retrying this download".to_string()
            } else {
                "Steam authentication required; the download process already ended".to_string()
            });
            self.download_progress
                .write()
                .await
                .insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Password prompt detected. Please provide credentials in the authentication modal."
                    .to_string(),
            )?;
            return Ok(());
        }

        // Steam Guard / 2FA waiting
        if lower_line.contains("steam guard")
            || lower_line.contains("two-factor")
            || lower_line.contains("2fa")
            || lower_line.contains("mobile authenticator")
            || lower_line.contains("approve")
        {
            progress.message = Some("Waiting for Steam Guard approval...".to_string());
            self.download_progress
                .write()
                .await
                .insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_waiting(
                app,
                download_id.to_string(),
                "Please approve the login request on your Steam Mobile App".to_string(),
            )?;
            return Ok(());
        }

        // Authentication errors
        if invalid_password {
            // An invalid buffered password can leave some DepotDownloader
            // versions waiting for another stdin line. Terminate that child
            // so the global download gate is always released for retry.
            let _ = self.request_auth_retry(download_id).await;
            progress.status = DownloadStatus::Error;
            progress.error = Some("Invalid password".to_string());
            self.download_progress
                .write()
                .await
                .insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Invalid password. Please check your credentials.".to_string(),
            )?;
            return Ok(());
        }

        // Rate limiting / suspicious activity
        if lower_line.contains("rate limit")
            || lower_line.contains("too many")
            || lower_line.contains("suspicious")
            || lower_line.contains("blocked")
            || lower_line.contains("temporarily")
        {
            progress.status = DownloadStatus::Error;
            progress.error = Some("Steam rate limit or suspicious activity detected".to_string());
            self.download_progress
                .write()
                .await
                .insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_error(
                app,
                download_id.to_string(),
                "Steam has temporarily blocked this login attempt. Please wait a few minutes and try again, or use DepotDownloader directly to authenticate first.".to_string(),
            )?;
            return Ok(());
        }

        // Authentication success
        if lower_line.contains("logged in")
            || lower_line.contains("authentication successful")
            || lower_line.contains("login successful")
            || lower_line.contains("authenticated")
        {
            self.mark_credentials_authenticated(download_id).await;
            progress.message = Some("Authentication successful, starting download...".to_string());
            self.download_progress
                .write()
                .await
                .insert(download_id.to_string(), progress.clone());
            crate::events::emit_progress(app, progress.clone())?;
            crate::events::emit_auth_success(app, download_id.to_string())?;
        }

        // Parse percentage: "Downloading depot 3164501 (45%)" or "05.30% filepath"
        // Try format with parentheses first: (45%)
        let percent_re_paren = Regex::new(r"\((\d+)%\)").unwrap();
        let mut found_percent = false;
        if let Some(caps) = percent_re_paren.captures(line) {
            if let Ok(percent) = caps[1].parse::<f64>() {
                progress.progress = percent.min(100.0).max(0.0);
                found_percent = true;
            }
        }

        // If not found in parentheses format, try plain format: 05.30% (match anywhere in line)
        // This will match percentages like "05.30%", "5.30%", "45%", etc.
        if !found_percent {
            let percent_re_plain = Regex::new(r"(\d+\.?\d*)%").unwrap();
            if let Some(caps) = percent_re_plain.captures(line) {
                if let Ok(percent) = caps[1].parse::<f64>() {
                    // Only update if we found a valid percentage (0-100)
                    if percent >= 0.0 && percent <= 100.0 {
                        progress.progress = percent;
                    }
                }
            }
        }

        if let Some((downloaded, total)) = Self::extract_file_counts(line) {
            progress.downloaded_files = Some(downloaded);
            progress.total_files = Some(total);

            // Calculate progress from file counts if percentage wasn't found
            // This ensures we always have a progress value
            if progress.progress == 0.0 && total > 0 {
                progress.progress = ((downloaded as f64 / total as f64) * 100.0)
                    .min(100.0)
                    .max(0.0);
            }
        }

        // Parse speed: "Speed: 5.2 MB/s"
        let speed_re = Regex::new(r"(?i)Speed:\s+([\d.]+)\s*(MB/s|KB/s)").unwrap();
        if let Some(caps) = speed_re.captures(line) {
            progress.speed = Some(format!("{} {}", &caps[1], &caps[2]));
        }

        // Parse manifest ID from output. Keep the most recent match because an
        // update run can mention the currently installed manifest before the
        // newly resolved target manifest later in the output.
        let manifest_pattern = Regex::new(r"(?i)(?:manifest|manifestid)[:\s]+(\d{10,})").unwrap();
        if let Some(caps) = manifest_pattern.captures(line) {
            if let Some(manifest_id) = caps.get(1) {
                let manifest_id = manifest_id.as_str().to_string();
                if progress.manifest_id.as_ref() != Some(&manifest_id) {
                    progress.manifest_id = Some(manifest_id.clone());
                    eprintln!("[DepotDownloader] Captured manifest ID: {}", manifest_id);
                }
            }
        }

        // Check for completion
        if line.contains("Download complete") || line.contains("All files downloaded") {
            progress.status = DownloadStatus::Completed;
            progress.progress = 100.0;
        }

        // Check for validation
        if line.contains("Validating") {
            progress.status = DownloadStatus::Validating;
        }

        // Update message - strip percentage patterns to avoid duplication
        if progress.message.is_none() || !progress.message.as_ref().unwrap().contains("Waiting") {
            let mut clean_message = line.trim().to_string();

            // Remove percentage patterns from message to avoid duplication
            // Remove format: (45%)
            clean_message = Regex::new(r"\s*\(\d+%\)\s*")
                .unwrap()
                .replace_all(&clean_message, " ")
                .to_string();
            // Remove format: 05.30% or 45% at start of line
            clean_message = Regex::new(r"^\d+\.?\d*%\s*")
                .unwrap()
                .replace_all(&clean_message, "")
                .to_string();
            // Remove any remaining standalone percentages
            clean_message = Regex::new(r"\s+\d+\.?\d*%\s+")
                .unwrap()
                .replace_all(&clean_message, " ")
                .to_string();

            clean_message = clean_message.trim().to_string();
            if !clean_message.is_empty() {
                progress.message = Some(clean_message);
            }
        }

        self.download_progress
            .write()
            .await
            .insert(download_id.to_string(), progress.clone());
        crate::events::emit_progress(app, progress)?;

        Ok(())
    }

    fn extract_file_counts(line: &str) -> Option<(u64, u64)> {
        let patterns = [
            r"(?i)Downloaded\s+(\d+)\s+of\s+(\d+)\s+files?",
            r"(?i)(\d+)\s*/\s*(\d+)\s+files?",
            r"(?i)files?\s*:\s*(\d+)\s*/\s*(\d+)",
            r"(?i)file\s+(\d+)\s+of\s+(\d+)",
            r"(?i)(\d+)\s+of\s+(\d+)\s+files?",
        ];

        for pattern in patterns {
            let regex = Regex::new(pattern).unwrap();
            if let Some(caps) = regex.captures(line) {
                if let (Ok(downloaded), Ok(total)) =
                    (caps[1].parse::<u64>(), caps[2].parse::<u64>())
                {
                    if total > 0 && downloaded <= total {
                        return Some((downloaded, total));
                    }
                }
            }
        }

        None
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn start_download<R: Runtime>(
        &self,
        download_id: String,
        options: DepotDownloadOptions,
        app: AppHandle<R>,
    ) -> Result<()> {
        self.start_download_with_executable(download_id, options, app, None)
            .await
    }

    pub async fn start_download_with_executable<R: Runtime>(
        &self,
        download_id: String,
        options: DepotDownloadOptions,
        app: AppHandle<R>,
        configured_executable: Option<&str>,
    ) -> Result<()> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(anyhow::anyhow!(
                "SIMM is shutting down; no new game download can be started"
            ));
        }

        // Detect DepotDownloader
        let detector_info = detect_depot_downloader_with_override(configured_executable).await?;
        if !detector_info.installed || detector_info.path.is_none() {
            return Err(anyhow::anyhow!(
                "DepotDownloader is not installed. Please install it first."
            ));
        }

        let executable_path = detector_info.path.unwrap();

        let output_dir = options.output_dir.clone();

        // Build command
        let args = self.build_command_args(&options);

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        let process_permit = acquire_process_permit().await;

        // DepotDownloader maintains shared on-disk state, so only one game
        // install or update process may run at a time. Keep the check and
        // process insertion in one write-locked critical section to avoid a
        // second environment racing past this guard.
        let mut active_downloads = self.active_downloads.write().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(anyhow::anyhow!(
                "SIMM is shutting down; no new game download can be started"
            ));
        }
        ensure_no_active_game_download(
            active_downloads.keys().next().map(String::as_str),
            &download_id,
        )?;
        self.clear_auth_state(&download_id).await;

        // Spawn process with working directory set to depots folder.
        #[cfg(target_os = "windows")]
        let child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag to prevent console window from appearing
            .spawn()
            .context("Failed to spawn DepotDownloader process")?;

        #[cfg(not(target_os = "windows"))]
        let child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn DepotDownloader process")?;

        let mut pending_child = PendingDepotChild::new(child, process_permit);
        let credential_input = if let Some(payload) = Self::credential_stdin_payload(&options) {
            Some((pending_child.child_mut().stdin.take(), payload))
        } else {
            None
        };
        if credential_input.is_some() {
            self.credential_handoffs
                .write()
                .await
                .insert(download_id.clone(), CredentialHandoffPhase::Supplied);
        } else {
            self.credential_handoffs.write().await.remove(&download_id);
        }

        let operation_id = unique_login_id();

        // The process is now reserved by the global gate. Only publish the
        // active progress entry after it has spawned successfully.
        {
            let mut progress = self.download_progress.write().await;
            progress.insert(
                download_id.clone(),
                DownloadProgress {
                    download_id: download_id.clone(),
                    operation_id: operation_id.clone(),
                    status: DownloadStatus::Downloading,
                    progress: 0.0,
                    downloaded_files: None,
                    total_files: None,
                    speed: None,
                    eta: None,
                    message: None,
                    error: None,
                    manifest_id: None,
                },
            );
        }

        let _app_clone = app.clone();
        let _download_id_clone = download_id.clone();
        let operation_id_complete = operation_id.clone();
        let service_clone = Arc::new(self.clone());

        // Handle stdout
        let mut stdout_task = None;
        if let Some(stdout) = pending_child.child_mut().stdout.take() {
            let app_stdout = app.clone();
            let download_id_stdout = download_id.clone();
            let service_stdout = service_clone.clone();
            stdout_task = Some(tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        if let Err(e) = service_stdout
                            .parse_progress(&line, &download_id_stdout, &app_stdout)
                            .await
                        {
                            eprintln!("Error parsing progress: {}", e);
                        }
                    }
                }
            }));
        }

        // Handle stderr
        let mut stderr_task = None;
        if let Some(stderr) = pending_child.child_mut().stderr.take() {
            let app_stderr = app.clone();
            let download_id_stderr = download_id.clone();
            let service_stderr = service_clone.clone();
            stderr_task = Some(tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        if let Err(e) = service_stderr
                            .parse_progress(&line, &download_id_stderr, &app_stderr)
                            .await
                        {
                            eprintln!("Error parsing progress: {}", e);
                        }
                    }
                }
            }));
        }

        let (child, process_permit) = pending_child.into_parts();

        // Store child process
        active_downloads.insert(
            download_id.clone(),
            ActiveDownload {
                child,
                stdout_task,
                stderr_task,
                output_dir: output_dir.clone(),
                operation_id,
                _process_permit: Some(process_permit),
            },
        );
        drop(active_downloads);

        // Publish the child before awaiting pipe I/O so app shutdown can
        // always find, terminate, and reap it. The credential payload is tiny,
        // but an external process may still close or stop reading stdin.
        if let Some((stdin, payload)) = credential_input {
            let credential_result = match stdin {
                Some(stdin) => Self::write_credential_input(stdin, &payload).await,
                None => Err(anyhow::anyhow!(
                    "DepotDownloader did not provide a stdin pipe for one-time credentials"
                )),
            };

            if let Err(error) = credential_result {
                let mut active_downloads = self.active_downloads.write().await;
                let mut failed_download = active_downloads.remove(&download_id);
                drop(active_downloads);
                if let Some(download) = failed_download.as_mut() {
                    let _ = download
                        .kill_reap_and_join_before(
                            tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT,
                        )
                        .await;
                }
                if !self.shutting_down.load(Ordering::Acquire) {
                    let mut progress_map = self.download_progress.write().await;
                    if let Some(progress) = progress_map.get_mut(&download_id) {
                        progress.status = DownloadStatus::Error;
                        progress.error = Some(error.to_string());
                        let progress = progress.clone();
                        drop(progress_map);
                        let _ = crate::events::emit_progress(&app, progress);
                    }
                }
                self.clear_auth_state(&download_id).await;
                return Err(error);
            }
        }

        // Handle process completion
        let app_complete = app.clone();
        let download_id_complete = download_id.clone();
        let service_complete = service_clone.clone();
        tokio::spawn(async move {
            let started_at = Instant::now();
            // Poll for process completion
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                let mut map = service_complete.active_downloads.write().await;
                if map
                    .get(&download_id_complete)
                    .is_some_and(|download| download.operation_id != operation_id_complete)
                {
                    break;
                }
                if started_at.elapsed() >= DEPOT_DOWNLOAD_TIMEOUT {
                    if let Some(mut download) = map.remove(&download_id_complete) {
                        drop(map);
                        let _ = download
                            .kill_reap_and_join_before(
                                tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT,
                            )
                            .await;
                        service_complete
                            .clear_auth_state(&download_id_complete)
                            .await;
                        let mut progress_map = service_complete.download_progress.write().await;
                        if let Some(progress) = progress_map.get_mut(&download_id_complete) {
                            if !matches!(
                                progress.status,
                                DownloadStatus::Cancelled
                                    | DownloadStatus::Completed
                                    | DownloadStatus::Error
                            ) {
                                progress.status = DownloadStatus::Error;
                                progress.error =
                                    Some("DepotDownloader timed out before completion".to_string());
                                let progress_clone = progress.clone();
                                drop(progress_map);
                                let _ = crate::events::emit_progress(&app_complete, progress_clone);
                            }
                        }
                        let _ = crate::events::emit_error(
                            &app_complete,
                            download_id_complete.clone(),
                            operation_id_complete.clone(),
                            "DepotDownloader timed out before completion".to_string(),
                        );
                        break;
                    }
                    drop(map);
                    service_complete
                        .clear_auth_state(&download_id_complete)
                        .await;
                    break;
                }
                if let Some(download) = map.get_mut(&download_id_complete) {
                    match download.child.try_wait() {
                        Ok(Some(status)) => {
                            let mut download = map
                                .remove(&download_id_complete)
                                .expect("polled DepotDownloader child remains registered");
                            drop(map);

                            // Wait for stdout/stderr readers to flush the final
                            // manifest/progress lines before we emit completion.
                            let _ = download
                                .join_readers_before(
                                    tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT,
                                )
                                .await;

                            let auth_retry_requested = service_complete
                                .take_auth_retry_requested(&download_id_complete)
                                .await;
                            if auth_retry_requested {
                                // The prompt handler already emitted the
                                // specific authentication event. Do not turn
                                // this expected kill into a generic process
                                // failure after it has been reaped.
                                break;
                            }

                            if status.success() {
                                let manifest_id = service_complete
                                    .download_progress
                                    .read()
                                    .await
                                    .get(&download_id_complete)
                                    .and_then(|progress| progress.manifest_id.clone());

                                let manifest_id = manifest_id.or_else(|| {
                                    DepotDownloaderService::read_installed_manifest_id(
                                        &download.output_dir,
                                    )
                                });

                                DepotDownloaderService::persist_completed_download(
                                    &app_complete,
                                    &download_id_complete,
                                    manifest_id.as_deref(),
                                )
                                .await;

                                let mut progress_map =
                                    service_complete.download_progress.write().await;
                                if let Some(progress) = progress_map.get_mut(&download_id_complete)
                                {
                                    progress.status = DownloadStatus::Completed;
                                    progress.progress = 100.0;
                                    let progress_clone = progress.clone();
                                    drop(progress_map);
                                    let _ =
                                        crate::events::emit_progress(&app_complete, progress_clone);
                                } else {
                                    drop(progress_map);
                                }

                                // Emit complete event with manifest ID
                                let _ = crate::events::emit_complete(
                                    &app_complete,
                                    download_id_complete.clone(),
                                    operation_id_complete.clone(),
                                    manifest_id,
                                );
                            } else {
                                let mut progress_map =
                                    service_complete.download_progress.write().await;
                                if let Some(progress) = progress_map.get_mut(&download_id_complete)
                                {
                                    progress.status = DownloadStatus::Error;
                                    progress.error = Some(format!(
                                        "Process exited with code {:?}",
                                        status.code()
                                    ));
                                    let progress_clone = progress.clone();
                                    drop(progress_map);
                                    let _ =
                                        crate::events::emit_progress(&app_complete, progress_clone);
                                }
                                let _ = crate::events::emit_error(
                                    &app_complete,
                                    download_id_complete.clone(),
                                    operation_id_complete.clone(),
                                    format!("DepotDownloader exited with code {:?}", status.code()),
                                );
                            }
                            break;
                        }
                        Ok(None) => {
                            // Process still running
                            drop(map);
                            continue;
                        }
                        Err(e) => {
                            // Error checking status
                            let mut download = map.remove(&download_id_complete);
                            drop(map);
                            if let Some(download) = download.as_mut() {
                                let _ = download
                                    .kill_reap_and_join_before(
                                        tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT,
                                    )
                                    .await;
                            }
                            service_complete
                                .clear_auth_state(&download_id_complete)
                                .await;
                            let mut progress_map = service_complete.download_progress.write().await;
                            if let Some(progress) = progress_map.get_mut(&download_id_complete) {
                                progress.status = DownloadStatus::Error;
                                progress.error =
                                    Some(format!("Error checking process status: {}", e));
                                let progress_clone = progress.clone();
                                drop(progress_map);
                                let _ = crate::events::emit_progress(&app_complete, progress_clone);
                            }
                            let _ = crate::events::emit_error(
                                &app_complete,
                                download_id_complete.clone(),
                                operation_id_complete.clone(),
                                format!("Error checking process status: {}", e),
                            );
                            break;
                        }
                    }
                } else {
                    // A cancellation or failed start may have removed the child.
                    // Clear a stale expected-auth marker so a later operation
                    // using this ID cannot be misclassified.
                    drop(map);
                    service_complete
                        .clear_auth_state(&download_id_complete)
                        .await;
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn cancel_download<R: Runtime>(
        &self,
        download_id: &str,
        app: &AppHandle<R>,
    ) -> Result<bool> {
        let mut map = self.active_downloads.write().await;
        if let Some(mut download) = map.remove(download_id) {
            drop(map);
            let terminated = download
                .kill_reap_and_join_before(tokio::time::Instant::now() + DEPOT_SHUTDOWN_TIMEOUT)
                .await;
            if !terminated {
                log::warn!(
                    "[DepotDownloader] Timed out fully reaping cancelled download {}",
                    download_id
                );
            }
            self.auth_prompted_downloads
                .write()
                .await
                .remove(download_id);

            let mut progress_map = self.download_progress.write().await;
            if let Some(progress) = progress_map.get_mut(download_id) {
                progress.status = DownloadStatus::Cancelled;
                progress.message = Some("Download cancelled".to_string());
                let _ = crate::events::emit_progress(app, progress.clone());
            }

            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn shutdown<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        timeout: Duration,
    ) -> DepotShutdownReport {
        self.shutting_down.store(true, Ordering::Release);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut downloads = {
            let mut active_downloads = self.active_downloads.write().await;
            active_downloads.drain().collect::<Vec<_>>()
        };
        downloads.sort_by(|left, right| left.0.cmp(&right.0));

        let mut report = DepotShutdownReport::default();
        for (download_id, mut download) in downloads {
            self.clear_auth_state(&download_id).await;

            if let Ok(Some(status)) = download.child.try_wait() {
                let readers_joined = download.join_readers_before(deadline).await;
                if !readers_joined {
                    report.timed_out_download_ids.push(download_id.clone());
                }
                if status.success() {
                    let manifest_id = self
                        .download_progress
                        .read()
                        .await
                        .get(&download_id)
                        .and_then(|progress| progress.manifest_id.clone())
                        .or_else(|| Self::read_installed_manifest_id(&download.output_dir));
                    if tokio::time::timeout_at(
                        deadline,
                        Self::persist_completed_download(app, &download_id, manifest_id.as_deref()),
                    )
                    .await
                    .is_err()
                    {
                        log::warn!(
                            "[DepotDownloader] Timed out persisting completed download {} during shutdown",
                            download_id
                        );
                        report.timed_out_download_ids.push(download_id.clone());
                    }
                    let mut progress_map = self.download_progress.write().await;
                    if let Some(progress) = progress_map.get_mut(&download_id) {
                        progress.status = DownloadStatus::Completed;
                        progress.progress = 100.0;
                        let progress = progress.clone();
                        drop(progress_map);
                        let _ = crate::events::emit_progress(app, progress);
                    }
                    let _ = crate::events::emit_complete(
                        app,
                        download_id,
                        download.operation_id.clone(),
                        manifest_id,
                    );
                    continue;
                }
            }

            report.interrupted_download_ids.push(download_id.clone());
            let interruption_message =
                "Download interrupted while SIMM was closing. Retry the download to continue."
                    .to_string();
            {
                let mut progress_map = self.download_progress.write().await;
                let progress =
                    progress_map
                        .entry(download_id.clone())
                        .or_insert_with(|| DownloadProgress {
                            download_id: download_id.clone(),
                            operation_id: download.operation_id.clone(),
                            status: DownloadStatus::Error,
                            progress: 0.0,
                            downloaded_files: None,
                            total_files: None,
                            speed: None,
                            eta: None,
                            message: None,
                            error: None,
                            manifest_id: None,
                        });
                progress.status = DownloadStatus::Error;
                progress.message = Some("Download interrupted by app shutdown".to_string());
                progress.error = Some(interruption_message.clone());
                let progress = progress.clone();
                drop(progress_map);
                let _ = crate::events::emit_progress(app, progress);
            }
            let _ = crate::events::emit_error(
                app,
                download_id.clone(),
                download.operation_id.clone(),
                interruption_message,
            );

            // Request termination before database I/O so the external process
            // begins stopping immediately even if persistence is slow.
            let _ = download.child.start_kill();
            Self::persist_interrupted_download_before(app, &download_id, deadline).await;
            if !download.kill_reap_and_join_before(deadline).await {
                report.timed_out_download_ids.push(download_id);
            }
        }

        report.timed_out_download_ids.sort();
        report.timed_out_download_ids.dedup();
        report
    }

    pub async fn get_progress(&self, download_id: &str) -> Option<DownloadProgress> {
        let map = self.download_progress.read().await;
        map.get(download_id).cloned()
    }

    #[allow(dead_code)]
    pub async fn get_active_downloads(&self) -> Vec<String> {
        let map = self.active_downloads.read().await;
        map.keys().cloned().collect()
    }
}

impl Clone for DepotDownloaderService {
    fn clone(&self) -> Self {
        Self {
            active_downloads: Arc::clone(&self.active_downloads),
            download_progress: Arc::clone(&self.download_progress),
            auth_prompted_downloads: Arc::clone(&self.auth_prompted_downloads),
            credential_handoffs: Arc::clone(&self.credential_handoffs),
            shutting_down: Arc::clone(&self.shutting_down),
        }
    }
}

impl Default for DepotDownloaderService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::test_helpers::EnvVarGuard;
    use crate::types::schedule_i_config;
    use serial_test::serial;
    use tauri::test::mock_app;
    use tempfile::tempdir;
    use tokio::io::AsyncReadExt;

    #[test]
    fn active_game_download_blocks_every_other_depot_operation() {
        assert!(ensure_no_active_game_download(None, "second-environment").is_ok());

        let error = ensure_no_active_game_download(Some("first-environment"), "second-environment")
            .expect_err("an active game operation must block the next one");

        assert!(error.to_string().contains("first-environment"));
        assert!(error.to_string().contains("second-environment"));
    }

    #[tokio::test]
    async fn auth_prompted_child_is_reaped_and_does_not_leave_an_active_download() -> Result<()> {
        let service = DepotDownloaderService::new();
        let download_id = "auth-prompt-download";

        #[cfg(target_os = "windows")]
        let child = Command::new("cmd")
            .args(["/C", "ping 127.0.0.1 -n 30 > NUL"])
            .spawn()?;
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("sh").args(["-c", "sleep 30"]).spawn()?;

        service.active_downloads.write().await.insert(
            download_id.to_string(),
            ActiveDownload::child_fixture(child),
        );

        assert!(service.request_auth_retry(download_id).await);

        let mut reaped = false;
        for _ in 0..40 {
            if service.take_finished_download(download_id).await {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        assert!(reaped, "the password-prompt child should have exited");
        assert!(service.active_downloads.read().await.is_empty());
        assert!(!service
            .auth_prompted_downloads
            .read()
            .await
            .contains(download_id));
        assert!(ensure_no_active_game_download(None, "retry-after-auth").is_ok());
        Ok(())
    }

    #[tokio::test]
    async fn supplied_password_prompt_consumes_stdin_and_child_completes_without_retry(
    ) -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle().clone();
        let download_id = "credential-prompt-fixture";
        let secret = "fixture-password-never-in-argv";

        #[cfg(target_os = "windows")]
        let fixture_args = vec![
            "/V:ON",
            "/C",
            "echo Enter account password: & set /p supplied= & if \"!supplied!\"==\"%EXPECTED_PASSWORD%\" (echo Authentication successful & echo Download complete) else (exit /b 17)",
        ];
        #[cfg(not(target_os = "windows"))]
        let fixture_args = vec![
            "-c",
            "printf 'Enter account password:\\n'; IFS= read -r supplied; [ \"$supplied\" = \"$EXPECTED_PASSWORD\" ] || exit 17; printf 'Authentication successful\\nDownload complete\\n'",
        ];
        assert!(fixture_args
            .iter()
            .all(|argument| !argument.contains(secret)));

        #[cfg(target_os = "windows")]
        let mut child = Command::new("cmd")
            .args(&fixture_args)
            .env("EXPECTED_PASSWORD", secret)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        #[cfg(not(target_os = "windows"))]
        let mut child = Command::new("sh")
            .args(&fixture_args)
            .env("EXPECTED_PASSWORD", secret)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().expect("fixture stdin is piped");
        let stdout = child.stdout.take().expect("fixture stdout is piped");
        service
            .credential_handoffs
            .write()
            .await
            .insert(download_id.to_string(), CredentialHandoffPhase::Supplied);
        service.download_progress.write().await.insert(
            download_id.to_string(),
            DownloadProgress {
                download_id: download_id.to_string(),
                operation_id: unique_login_id(),
                status: DownloadStatus::Downloading,
                progress: 0.0,
                downloaded_files: None,
                total_files: None,
                speed: None,
                eta: None,
                message: None,
                error: None,
                manifest_id: None,
            },
        );

        let reader_service = service.clone();
        let reader_handle = handle.clone();
        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    let _ = reader_service
                        .parse_progress(&line, download_id, &reader_handle)
                        .await;
                }
            }
        });
        service.active_downloads.write().await.insert(
            download_id.to_string(),
            ActiveDownload {
                child,
                stdout_task: Some(reader_task),
                stderr_task: None,
                output_dir: String::new(),
                operation_id: unique_login_id(),
                _process_permit: None,
            },
        );

        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "fixture-output".to_string(),
            username: Some("fixture-user".to_string()),
            password: Some(secret.to_string()),
            remember_credentials: false,
            steam_guard: None,
            validate: None,
            os: None,
            language: None,
            max_downloads: None,
        };
        let command_args = service.build_command_args(&options);
        assert!(command_args
            .iter()
            .all(|argument| !argument.contains(secret)));
        let payload = DepotDownloaderService::credential_stdin_payload(&options)
            .expect("fixture password produces stdin payload");
        DepotDownloaderService::write_credential_input(stdin, &payload).await?;

        let mut reaped = false;
        for _ in 0..80 {
            if service.take_finished_download(download_id).await {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        assert!(
            reaped,
            "credential fixture child must complete and be reaped"
        );
        assert!(matches!(
            service
                .get_progress(download_id)
                .await
                .expect("fixture progress remains available")
                .status,
            DownloadStatus::Completed
        ));
        assert!(!service
            .auth_prompted_downloads
            .read()
            .await
            .contains(download_id));
        assert!(!service
            .credential_handoffs
            .read()
            .await
            .contains_key(download_id));
        assert!(service.active_downloads.read().await.is_empty());
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn shutdown_reaps_owned_child_joins_reader_and_persists_recoverable_error() -> Result<()>
    {
        let temp = tempdir()?;
        let _data_guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let environment_service = EnvironmentService::new(pool.clone())?;
        let environment = environment_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                temp.path().join("game").to_string_lossy().to_string(),
                Some("Shutdown fixture".to_string()),
                None,
            )
            .await?;
        environment_service
            .update_environment(
                &environment.id,
                vec![("status".to_string(), serde_json::json!("downloading"))],
            )
            .await?;

        #[cfg(target_os = "windows")]
        let mut child = Command::new("cmd")
            .args(["/C", "echo fixture-ready & ping 127.0.0.1 -n 30 > NUL"])
            .stdout(Stdio::piped())
            .spawn()?;
        #[cfg(not(target_os = "windows"))]
        let mut child = Command::new("sh")
            .args(["-c", "echo fixture-ready; sleep 30"])
            .stdout(Stdio::piped())
            .spawn()?;
        let mut stdout = child.stdout.take().expect("fixture stdout is piped");
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes).await;
        });

        let service = DepotDownloaderService::new();
        service.download_progress.write().await.insert(
            environment.id.clone(),
            DownloadProgress {
                download_id: environment.id.clone(),
                operation_id: unique_login_id(),
                status: DownloadStatus::Downloading,
                progress: 25.0,
                downloaded_files: None,
                total_files: None,
                speed: None,
                eta: None,
                message: Some("Downloading fixture".to_string()),
                error: None,
                manifest_id: None,
            },
        );
        service.active_downloads.write().await.insert(
            environment.id.clone(),
            ActiveDownload {
                child,
                stdout_task: Some(stdout_task),
                stderr_task: None,
                output_dir: environment.output_dir.clone(),
                operation_id: unique_login_id(),
                _process_permit: None,
            },
        );

        let app = mock_app();
        app.manage(pool.clone());
        let report = service
            .shutdown(&app.handle(), Duration::from_secs(2))
            .await;

        assert_eq!(
            report.interrupted_download_ids,
            vec![environment.id.clone()]
        );
        assert!(report.timed_out_download_ids.is_empty());
        assert!(service.active_downloads.read().await.is_empty());
        assert!(service.shutting_down.load(Ordering::Acquire));
        assert!(matches!(
            service
                .get_progress(&environment.id)
                .await
                .expect("shutdown progress remains visible")
                .status,
            DownloadStatus::Error
        ));
        assert!(matches!(
            environment_service
                .get_environment(&environment.id)
                .await?
                .expect("environment remains available")
                .status,
            crate::types::EnvironmentStatus::Error
        ));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn startup_reconciles_only_stale_downloading_environments() -> Result<()> {
        let temp = tempdir()?;
        let _data_guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let environment_service = EnvironmentService::new(pool.clone())?;
        let interrupted = environment_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                temp.path()
                    .join("interrupted")
                    .to_string_lossy()
                    .to_string(),
                Some("Interrupted".to_string()),
                None,
            )
            .await?;
        let completed = environment_service
            .create_environment(
                schedule_i_config().app_id,
                "beta".to_string(),
                temp.path().join("completed").to_string_lossy().to_string(),
                Some("Completed".to_string()),
                None,
            )
            .await?;
        environment_service
            .update_environment(
                &interrupted.id,
                vec![("status".to_string(), serde_json::json!("downloading"))],
            )
            .await?;
        environment_service
            .update_environment(
                &completed.id,
                vec![("status".to_string(), serde_json::json!("completed"))],
            )
            .await?;

        let reconciled = DepotDownloaderService::reconcile_interrupted_downloads(pool).await?;

        assert_eq!(reconciled, vec![interrupted.id.clone()]);
        assert!(matches!(
            environment_service
                .get_environment(&interrupted.id)
                .await?
                .expect("interrupted environment remains available")
                .status,
            crate::types::EnvironmentStatus::Error
        ));
        assert!(matches!(
            environment_service
                .get_environment(&completed.id)
                .await?
                .expect("completed environment remains available")
                .status,
            crate::types::EnvironmentStatus::Completed
        ));
        Ok(())
    }

    #[cfg(target_os = "windows")]
    struct CurrentDirGuard {
        original: std::path::PathBuf,
    }

    #[cfg(target_os = "windows")]
    impl CurrentDirGuard {
        fn new(path: &std::path::Path) -> Result<Self> {
            let original = std::env::current_dir().context("Failed to read current dir")?;
            std::env::set_current_dir(path).context("Failed to set current dir")?;
            Ok(Self { original })
        }
    }

    #[cfg(target_os = "windows")]
    impl Drop for CurrentDirGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.original);
        }
    }

    #[test]
    fn build_command_args_includes_optional_flags() {
        let service = DepotDownloaderService::new();
        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "C:\\Games\\Schedule I".to_string(),
            username: Some("user".to_string()),
            password: None,
            remember_credentials: true,
            steam_guard: Some("code".to_string()),
            validate: Some(true),
            os: Some(crate::types::Platform::Windows),
            language: Some("english".to_string()),
            max_downloads: Some(3),
        };

        let args = service.build_command_args(&options);
        assert!(args.contains(&"-app".to_string()));
        assert!(args.contains(&"3164500".to_string()));
        assert!(args.contains(&"-branch".to_string()));
        assert!(args.contains(&"main".to_string()));
        assert!(args.contains(&"-dir".to_string()));
        assert!(args.contains(&"C:\\Games\\Schedule I".to_string()));
        assert!(args.contains(&"-username".to_string()));
        assert!(args.contains(&"user".to_string()));
        assert!(args.contains(&"-validate".to_string()));
        assert!(args.contains(&"-os".to_string()));
        assert!(args.contains(&"windows".to_string()));
        assert!(args.contains(&"-language".to_string()));
        assert!(args.contains(&"english".to_string()));
        assert!(args.contains(&"-max-downloads".to_string()));
        assert!(args.contains(&"3".to_string()));

        assert!(args.contains(&"-remember-password".to_string()));
        assert!(!args.contains(&"code".to_string()));
        let login_id = args
            .windows(2)
            .find(|window| window[0] == "-loginid")
            .map(|window| window[1].as_str())
            .expect("download args should include -loginid");
        assert!(login_id.parse::<u32>().is_ok());
    }

    #[tokio::test]
    async fn process_gate_serializes_depot_children() {
        let first = acquire_process_permit().await;
        let blocked = tokio::spawn(acquire_process_permit());
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!blocked.is_finished());
        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(1), blocked)
            .await
            .expect("second process acquires permit after first exits")
            .expect("permit task joins");
        drop(second);
    }

    #[tokio::test]
    async fn cancelled_start_reaps_pending_child_before_releasing_process_gate() -> Result<()> {
        let permit = acquire_process_permit().await;
        #[cfg(target_os = "windows")]
        let child = Command::new("cmd")
            .args(["/D", "/Q", "/C", "ping -n 30 127.0.0.1 >nul"])
            .spawn()?;
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("sh").args(["-c", "sleep 30"]).spawn()?;

        let pending = PendingDepotChild::new(child, permit);
        drop(pending);
        let replacement = tokio::time::timeout(Duration::from_secs(2), acquire_process_permit())
            .await
            .expect("pending child cleanup should release the permit after reap");
        drop(replacement);
        Ok(())
    }

    #[test]
    fn operation_identifiers_are_unique_for_immediate_retries() {
        assert_ne!(unique_login_id(), unique_login_id());
    }

    #[test]
    fn build_command_args_uses_remembered_session_only_with_durable_opt_in() {
        let service = DepotDownloaderService::new();
        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "alternate-beta".to_string(),
            output_dir: "/home/user/SIMM/alternate-beta".to_string(),
            username: Some("ditidez".to_string()),
            password: None,
            remember_credentials: true,
            steam_guard: None,
            validate: None,
            os: Some(crate::types::Platform::Windows),
            language: Some("english".to_string()),
            max_downloads: None,
        };

        let args = service.build_command_args(&options);

        assert!(args
            .windows(2)
            .any(|window| { window[0] == "-username" && window[1] == "ditidez" }));
        assert!(args.contains(&"-remember-password".to_string()));
    }

    #[test]
    fn build_command_args_does_not_remember_session_from_username_alone() {
        let service = DepotDownloaderService::new();
        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "/tmp/simm".to_string(),
            username: Some("ditidez".to_string()),
            password: None,
            remember_credentials: false,
            steam_guard: None,
            validate: None,
            os: None,
            language: None,
            max_downloads: None,
        };

        let args = service.build_command_args(&options);

        assert!(args.contains(&"-username".to_string()));
        assert!(!args.contains(&"-remember-password".to_string()));
    }

    #[test]
    fn credentials_are_written_to_stdin_not_command_arguments() {
        let service = DepotDownloaderService::new();
        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "/tmp/simm".to_string(),
            username: Some("demo-user".to_string()),
            password: Some("dummy-password".to_string()),
            remember_credentials: false,
            steam_guard: Some("dummy-guard".to_string()),
            validate: None,
            os: None,
            language: None,
            max_downloads: None,
        };

        let args = service.build_command_args(&options);
        let stdin = DepotDownloaderService::credential_stdin_payload(&options)
            .expect("one-time credentials should produce stdin input");

        assert!(!args.contains(&"dummy-password".to_string()));
        assert!(!args.contains(&"dummy-guard".to_string()));
        assert_eq!(stdin, b"dummy-password\ndummy-guard\n");
    }

    #[test]
    fn resolve_depot_platform_uses_windows_depots_for_schedule_i_on_proton_hosts() {
        let platform = DepotDownloaderService::resolve_depot_platform(
            "3164500",
            crate::types::Platform::Linux,
        );

        if cfg!(target_os = "windows") {
            assert_eq!(platform, crate::types::Platform::Linux);
        } else {
            assert_eq!(platform, crate::types::Platform::Windows);
        }
    }

    #[test]
    fn resolve_depot_platform_keeps_non_schedule_i_platform() {
        let platform =
            DepotDownloaderService::resolve_depot_platform("123", crate::types::Platform::Linux);

        assert_eq!(platform, crate::types::Platform::Linux);
    }

    #[tokio::test]
    async fn cancel_download_returns_false_when_missing() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let cancelled = service.cancel_download("missing", &app.handle()).await?;
        assert!(!cancelled);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    #[cfg(target_os = "windows")]
    async fn start_download_returns_error_when_depotdownloader_missing() -> Result<()> {
        let temp = tempdir()?;
        let _cwd_guard = CurrentDirGuard::new(temp.path())?;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = format!("{}\\System32", system_root);
        let _path_guard = EnvVarGuard::set("PATH", &system32);
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard =
            EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());

        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle().clone();

        let options = DepotDownloadOptions {
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: temp.path().to_string_lossy().to_string(),
            username: None,
            password: None,
            remember_credentials: false,
            steam_guard: None,
            validate: None,
            os: None,
            language: None,
            max_downloads: None,
        };

        let err = service
            .start_download("download-1".to_string(), options, handle)
            .await
            .expect_err("expected DepotDownloader missing error");
        assert!(err.to_string().contains("DepotDownloader"));

        Ok(())
    }

    #[test]
    fn read_installed_manifest_id_reads_the_downloaded_manifest() -> Result<()> {
        let temp = tempdir()?;
        let manifest_dir = temp.path().join(".DepotDownloader");
        std::fs::create_dir_all(&manifest_dir)?;
        std::fs::write(
            manifest_dir.join("3164501_5738443694136269112.manifest"),
            b"manifest contents",
        )?;

        assert_eq!(
            DepotDownloaderService::read_installed_manifest_id(
                temp.path().to_string_lossy().as_ref()
            ),
            Some("5738443694136269112".to_string())
        );
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn completed_download_persistence_clears_update_state_before_event_delivery() -> Result<()>
    {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let environment_service = EnvironmentService::new(pool.clone())?;
        let environment = environment_service
            .create_environment(
                schedule_i_config().app_id,
                "beta".to_string(),
                temp.path().join("beta").to_string_lossy().to_string(),
                Some("Beta".to_string()),
                None,
            )
            .await?;

        environment_service
            .update_environment(
                &environment.id,
                vec![
                    ("status".to_string(), serde_json::json!("downloading")),
                    ("updateAvailable".to_string(), serde_json::json!(true)),
                    (
                        "updateGameVersion".to_string(),
                        serde_json::json!("0.4.6f5"),
                    ),
                    (
                        "lastManifestId".to_string(),
                        serde_json::json!("old-manifest"),
                    ),
                    (
                        "remoteManifestId".to_string(),
                        serde_json::json!("new-manifest"),
                    ),
                ],
            )
            .await?;

        DepotDownloaderService::persist_completed_download_to_pool(
            pool,
            &environment.id,
            Some("new-manifest"),
        )
        .await?;

        let persisted = environment_service
            .get_environment(&environment.id)
            .await?
            .expect("environment remains available");
        assert!(matches!(
            persisted.status,
            crate::types::EnvironmentStatus::Completed
        ));
        assert_eq!(persisted.last_manifest_id.as_deref(), Some("new-manifest"));
        assert_eq!(
            persisted.remote_manifest_id.as_deref(),
            Some("new-manifest")
        );
        assert_eq!(persisted.update_available, Some(false));
        assert_eq!(persisted.update_game_version, None);
        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_updates_percentage() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("Downloading depot 123 (45%)", "download-2", &handle)
            .await?;

        let progress = service
            .get_progress("download-2")
            .await
            .expect("progress set");
        assert_eq!(progress.progress, 45.0);

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_sets_auth_waiting_message() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("Steam Guard required", "download-3", &handle)
            .await?;

        let progress = service
            .get_progress("download-3")
            .await
            .expect("progress set");
        assert_eq!(
            progress.message.as_deref(),
            Some("Waiting for Steam Guard approval...")
        );

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_sets_invalid_password_error() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();
        service.credential_handoffs.write().await.insert(
            "download-4".to_string(),
            CredentialHandoffPhase::PromptObserved,
        );

        service
            .parse_progress("Password: incorrect", "download-4", &handle)
            .await?;

        let progress = service
            .get_progress("download-4")
            .await
            .expect("progress set");
        assert!(matches!(progress.status, DownloadStatus::Error));
        assert_eq!(progress.error.as_deref(), Some("Invalid password"));
        assert!(!service
            .credential_handoffs
            .read()
            .await
            .contains_key("download-4"));

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_sets_rate_limit_error() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("Too many requests", "download-5", &handle)
            .await?;

        let progress = service
            .get_progress("download-5")
            .await
            .expect("progress set");
        assert!(matches!(progress.status, DownloadStatus::Error));
        assert_eq!(
            progress.error.as_deref(),
            Some("Steam rate limit or suspicious activity detected")
        );

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_captures_counts_speed_manifest_and_completion() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("Downloaded 5 of 10 files", "download-6", &handle)
            .await?;
        service
            .parse_progress("Speed: 1.2 MB/s", "download-6", &handle)
            .await?;
        service
            .parse_progress("Manifest: 1234567890", "download-6", &handle)
            .await?;
        service
            .parse_progress("Download complete", "download-6", &handle)
            .await?;

        let progress = service
            .get_progress("download-6")
            .await
            .expect("progress set");
        assert_eq!(progress.downloaded_files, Some(5));
        assert_eq!(progress.total_files, Some(10));
        assert_eq!(progress.speed.as_deref(), Some("1.2 MB/s"));
        assert_eq!(progress.manifest_id.as_deref(), Some("1234567890"));
        assert!(matches!(progress.status, DownloadStatus::Completed));
        assert_eq!(progress.progress, 100.0);

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_captures_alternate_file_count_formats() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("3/27 files", "download-9", &handle)
            .await?;
        let progress = service
            .get_progress("download-9")
            .await
            .expect("progress set");
        assert_eq!(progress.downloaded_files, Some(3));
        assert_eq!(progress.total_files, Some(27));

        service
            .parse_progress("file 4 of 27", "download-10", &handle)
            .await?;
        let progress = service
            .get_progress("download-10")
            .await
            .expect("progress set");
        assert_eq!(progress.downloaded_files, Some(4));
        assert_eq!(progress.total_files, Some(27));

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_sets_validating_status() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress("Validating files", "download-7", &handle)
            .await?;

        let progress = service
            .get_progress("download-7")
            .await
            .expect("progress set");
        assert!(matches!(progress.status, DownloadStatus::Validating));

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_keeps_latest_manifest_id() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service
            .parse_progress(
                "Got manifest request code for depot 3164501 from app 3164500, manifest 5603394666660587467, result: 123",
                "download-8",
                &handle,
            )
            .await?;
        service
            .parse_progress(
                "Manifest 3177164058227208309 (03/14/2026 02:10:46)",
                "download-8",
                &handle,
            )
            .await?;

        let progress = service
            .get_progress("download-8")
            .await
            .expect("progress set");
        assert_eq!(progress.manifest_id.as_deref(), Some("3177164058227208309"));

        Ok(())
    }

    #[tokio::test]
    async fn parse_progress_ignores_lines_after_cancellation() -> Result<()> {
        let service = DepotDownloaderService::new();
        let app = mock_app();
        let handle = app.handle();

        service.download_progress.write().await.insert(
            "download-cancelled".to_string(),
            DownloadProgress {
                download_id: "download-cancelled".to_string(),
                operation_id: unique_login_id(),
                status: DownloadStatus::Cancelled,
                progress: 12.0,
                downloaded_files: Some(1),
                total_files: Some(10),
                speed: None,
                eta: None,
                message: Some("Download cancelled".to_string()),
                error: None,
                manifest_id: None,
            },
        );

        service
            .parse_progress("Downloading depot 123 (45%)", "download-cancelled", &handle)
            .await?;

        let progress = service
            .get_progress("download-cancelled")
            .await
            .expect("progress retained");
        assert!(matches!(progress.status, DownloadStatus::Cancelled));
        assert_eq!(progress.progress, 12.0);
        assert_eq!(progress.downloaded_files, Some(1));

        Ok(())
    }
}
