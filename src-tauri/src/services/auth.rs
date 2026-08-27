use crate::utils::depot_downloader_detector::detect_depot_downloader;
use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::{Context, Result};
use regex::Regex;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const PASSWORD_AUTH_TIMEOUT: Duration = Duration::from_secs(120);
const QR_AUTH_TIMEOUT: Duration = Duration::from_secs(300);
const AUTH_OUTPUT_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_AUTH_OUTPUT_BYTES: usize = 128 * 1024;
const PASSWORD_AUTH_TIMEOUT_ERROR: &str =
    "Steam authentication timed out. Please check Steam Guard and try again.";
const QR_AUTH_TIMEOUT_ERROR: &str =
    "Steam QR authentication timed out. Start a new QR login and scan the new code.";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthResult {
    pub success: bool,
    pub error: Option<String>,
    pub requires_steam_guard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthProcessCompletion {
    Exited,
    TimedOut,
    Cancelled,
}

#[derive(Debug)]
struct AuthProcessOutput {
    completion: AuthProcessCompletion,
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Keeps cancellation connected to the task that owns the child process. If
/// the command future is dropped, the task still receives the cancellation
/// signal and performs kill, reap, and pipe-reader cleanup.
struct AuthProcessTask {
    cancel: Option<oneshot::Sender<()>>,
    handle: JoinHandle<Result<AuthProcessOutput>>,
}

impl AuthProcessTask {
    async fn finish(mut self) -> Result<AuthProcessOutput> {
        let joined = (&mut self.handle).await;
        self.cancel.take();
        joined.context("Steam authentication process task failed")?
    }
}

impl Drop for AuthProcessTask {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
    }
}

#[derive(Clone)]
pub struct AuthService;

impl AuthService {
    pub fn new() -> Self {
        Self
    }

    fn auth_branch() -> String {
        let config = crate::types::schedule_i_config();
        config
            .branches
            .iter()
            .find(|branch| branch.requires_auth)
            .map(|branch| branch.name.clone())
            .unwrap_or_else(|| "main".to_string())
    }

    fn trimmed_optional(value: Option<String>) -> Option<String> {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn login_id() -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| {
                let bounded = (duration.as_millis() % u128::from(u32::MAX)) as u32;
                bounded.max(1).to_string()
            })
            .unwrap_or_else(|_| "1".to_string())
    }

    fn build_auth_args(
        username: String,
        remember_credentials: bool,
        steam_guard: Option<String>,
    ) -> Vec<String> {
        let config = crate::types::schedule_i_config();
        let auth_branch = Self::auth_branch();
        let steam_guard = Self::trimmed_optional(steam_guard);

        let mut args = vec![
            "-app".to_string(),
            config.app_id,
            "-username".to_string(),
            username,
        ];

        if remember_credentials {
            args.push("-remember-password".to_string());
        }

        args.extend([
            "-loginid".to_string(),
            Self::login_id(),
            "-manifest-only".to_string(),
            "-branch".to_string(),
            auth_branch,
        ]);

        if steam_guard.is_some() {
            args.push("-no-mobile".to_string());
        }

        args
    }

    fn build_qr_auth_args(remember_credentials: bool) -> Vec<String> {
        let config = crate::types::schedule_i_config();
        let mut args = vec![
            "-app".to_string(),
            config.app_id,
            "-qr".to_string(),
            "-loginid".to_string(),
            Self::login_id(),
            "-manifest-only".to_string(),
            "-branch".to_string(),
            Self::auth_branch(),
        ];
        if remember_credentials {
            args.push("-remember-password".to_string());
        }
        args
    }

    fn success(username: Option<String>) -> AuthResult {
        AuthResult {
            success: true,
            error: None,
            requires_steam_guard: None,
            username,
        }
    }

    fn failure(error: String, requires_steam_guard: Option<bool>) -> AuthResult {
        AuthResult {
            success: false,
            error: Some(error),
            requires_steam_guard,
            username: None,
        }
    }

    fn parse_qr_account_name(output: &str) -> Option<String> {
        let account_pattern = Regex::new(r"-username\s+([^\s]+)\s+-remember-password").ok()?;
        account_pattern
            .captures(output)
            .and_then(|caps| caps.get(1))
            .map(|account| account.as_str().to_string())
    }

    fn decode_depotdownloader_output(bytes: &[u8]) -> String {
        if let Ok(output) = std::str::from_utf8(bytes) {
            return output.to_string();
        }

        bytes
            .iter()
            .map(|byte| match byte {
                0x00..=0x7f => char::from(*byte),
                0xdb => '\u{2588}',
                0xdc => '\u{2584}',
                0xdf => '\u{2580}',
                _ => '\u{fffd}',
            })
            .collect()
    }

    fn append_capped_output(output: &mut String, value: &str) {
        let remaining = MAX_AUTH_OUTPUT_BYTES.saturating_sub(output.len());
        if remaining == 0 {
            return;
        }

        let mut end = remaining.min(value.len());
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        output.push_str(&value[..end]);
    }

    fn emit_qr_output_line<R: Runtime>(app: &AppHandle<R>, output: &mut String, line: String) {
        Self::append_capped_output(output, &line);
        Self::append_capped_output(output, "\n");
        let _ = crate::events::emit_steam_auth_qr_line(app, line);
    }

    async fn pump_qr_output<R, S>(app: AppHandle<R>, mut stream: S) -> String
    where
        R: Runtime,
        S: AsyncRead + Unpin + Send + 'static,
    {
        let mut buffer = [0_u8; 4096];
        let mut pending = String::new();
        let mut output = String::new();

        loop {
            let read = match stream.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    warn_with_location(format!(
                        "Steam QR auth output stream read failed: {}",
                        error
                    ));
                    break;
                }
            };

            let decoded = Self::decode_depotdownloader_output(&buffer[..read])
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            pending.push_str(&decoded);

            while let Some(newline_index) = pending.find('\n') {
                let mut line = pending.drain(..=newline_index).collect::<String>();
                if line.ends_with('\n') {
                    line.pop();
                }
                Self::emit_qr_output_line(&app, &mut output, line);
            }

            // A process can write indefinitely without a newline. Emit a
            // bounded partial line so the framing buffer cannot grow without
            // limit while the pipe continues to be drained.
            if pending.len() >= MAX_AUTH_OUTPUT_BYTES {
                let line = std::mem::take(&mut pending);
                Self::emit_qr_output_line(&app, &mut output, line);
            }
        }

        if !pending.is_empty() {
            Self::emit_qr_output_line(&app, &mut output, pending);
        }

        output
    }

    async fn read_capped_output<S>(mut stream: S) -> Vec<u8>
    where
        S: AsyncRead + Unpin,
    {
        let mut buffer = [0_u8; 4096];
        let mut output = Vec::new();

        loop {
            match stream.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = MAX_AUTH_OUTPUT_BYTES.saturating_sub(output.len());
                    output.extend_from_slice(&buffer[..read.min(remaining)]);
                }
                Err(error) => {
                    warn_with_location(format!("Steam auth output stream read failed: {}", error));
                    break;
                }
            }
        }

        output
    }

    async fn join_output_reader<T: Default>(label: &str, mut handle: Option<JoinHandle<T>>) -> T {
        let Some(mut handle) = handle.take() else {
            return T::default();
        };

        match tokio::time::timeout(AUTH_OUTPUT_JOIN_TIMEOUT, &mut handle).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                warn_with_location(format!(
                    "Steam auth {} output reader failed: {}",
                    label, error
                ));
                T::default()
            }
            Err(_) => {
                warn_with_location(format!(
                    "Steam auth {} output reader did not close after process exit",
                    label
                ));
                handle.abort();
                let _ = handle.await;
                T::default()
            }
        }
    }

    async fn kill_and_reap(child: &mut Child) -> Result<ExitStatus> {
        if let Err(kill_error) = child.start_kill() {
            if child
                .try_wait()
                .context("Failed to inspect Steam authentication process")?
                .is_none()
            {
                return Err(kill_error).context("Failed to terminate Steam authentication process");
            }
        }

        child
            .wait()
            .await
            .context("Failed to reap Steam authentication process")
    }

    async fn wait_for_child(
        child: &mut Child,
        deadline: Duration,
        mut cancel: oneshot::Receiver<()>,
    ) -> Result<(AuthProcessCompletion, ExitStatus)> {
        tokio::select! {
            status = child.wait() => {
                Ok((
                    AuthProcessCompletion::Exited,
                    status.context("Failed while waiting for Steam authentication process")?,
                ))
            }
            _ = tokio::time::sleep(deadline) => {
                let status = Self::kill_and_reap(child).await?;
                Ok((AuthProcessCompletion::TimedOut, status))
            }
            _ = &mut cancel => {
                let status = Self::kill_and_reap(child).await?;
                Ok((AuthProcessCompletion::Cancelled, status))
            }
        }
    }

    async fn run_password_process(
        mut child: Child,
        stdin_lines: Vec<String>,
        deadline: Duration,
    ) -> Result<AuthProcessOutput> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let stdout_task = child
                .stdout
                .take()
                .map(|stdout| tokio::spawn(Self::read_capped_output(stdout)));
            let stderr_task = child
                .stderr
                .take()
                .map(|stderr| tokio::spawn(Self::read_capped_output(stderr)));
            let stdin_task = if stdin_lines.is_empty() {
                None
            } else {
                child.stdin.take().map(|mut stdin| {
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        use tokio::io::AsyncWriteExt;
                        let _ = stdin
                            .write_all(format!("{}\n", stdin_lines.join("\n")).as_bytes())
                            .await;
                    })
                })
            };

            let (completion, status) =
                Self::wait_for_child(&mut child, deadline, cancel_rx).await?;

            if let Some(stdin_task) = stdin_task {
                stdin_task.abort();
                let _ = stdin_task.await;
            }
            let stdout = Self::join_output_reader("stdout", stdout_task).await;
            let stderr = Self::join_output_reader("stderr", stderr_task).await;

            Ok(AuthProcessOutput {
                completion,
                status,
                stdout: Self::decode_depotdownloader_output(&stdout),
                stderr: Self::decode_depotdownloader_output(&stderr),
            })
        });

        AuthProcessTask {
            cancel: Some(cancel_tx),
            handle,
        }
        .finish()
        .await
    }

    async fn run_qr_process<R: Runtime>(
        app: AppHandle<R>,
        mut child: Child,
        deadline: Duration,
    ) -> Result<AuthProcessOutput> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let stdout_task = child.stdout.take().map(|stdout| {
                let app = app.clone();
                tokio::spawn(Self::pump_qr_output(app, stdout))
            });
            let stderr_task = child.stderr.take().map(|stderr| {
                let app = app.clone();
                tokio::spawn(Self::pump_qr_output(app, stderr))
            });

            let (completion, status) =
                Self::wait_for_child(&mut child, deadline, cancel_rx).await?;
            let stdout = Self::join_output_reader("QR stdout", stdout_task).await;
            let stderr = Self::join_output_reader("QR stderr", stderr_task).await;

            Ok(AuthProcessOutput {
                completion,
                status,
                stdout,
                stderr,
            })
        });

        AuthProcessTask {
            cancel: Some(cancel_tx),
            handle,
        }
        .finish()
        .await
    }

    pub async fn authenticate(
        &self,
        username: String,
        password: Option<String>,
        steam_guard: Option<String>,
        remember_credentials: bool,
    ) -> Result<AuthResult> {
        let detector_info = detect_depot_downloader().await?;
        if !detector_info.installed || detector_info.path.is_none() {
            warn_with_location("Steam auth rejected because DepotDownloader is not installed");
            return Ok(Self::failure(
                "DepotDownloader is not installed. Please install it first.".to_string(),
                None,
            ));
        }

        let executable_path = detector_info.path.unwrap();
        let password = Self::trimmed_optional(password);
        let steam_guard = Self::trimmed_optional(steam_guard);
        // DepotDownloader accepts interactive password input on stdin. Keep it
        // out of the OS command line, which can otherwise be inspected by
        // other local processes while authentication is running.
        let args = Self::build_auth_args(username, remember_credentials, steam_guard.clone());

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam auth failed to resolve DepotDownloader working directory: {}",
                    error
                ));
                error
            })?;

        #[cfg(target_os = "windows")]
        let child = ({
            #[allow(unused_imports)] // Required for CommandExt trait methods
            use std::os::windows::process::CommandExt;
            Command::new(&executable_path)
                .args(&args)
                .current_dir(&depots_dir) // Set working directory to SIMM/depots
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to spawn DepotDownloader process")
        })
        .map_err(|error| {
            error_with_location(format!(
                "Steam auth failed to spawn DepotDownloader: {}",
                error
            ));
            error
        })?;

        #[cfg(not(target_os = "windows"))]
        let child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Failed to spawn DepotDownloader process")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam auth failed to spawn DepotDownloader: {}",
                    error
                ));
                error
            })?;

        let stdin_lines = [password, steam_guard]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let output = Self::run_password_process(child, stdin_lines, PASSWORD_AUTH_TIMEOUT)
            .await
            .map_err(|error| {
                error_with_location(format!("Steam auth process management failed: {}", error));
                error
            })?;
        let all_output = output.stdout + &output.stderr;
        let sanitized_output =
            crate::services::logger::LoggerService::sanitize_log_text(&all_output);
        let lower_output = all_output.to_lowercase();

        if output.completion == AuthProcessCompletion::TimedOut {
            warn_with_location(format!(
                "Steam authentication timed out after {} seconds: {}",
                PASSWORD_AUTH_TIMEOUT.as_secs(),
                sanitized_output
            ));
            return Ok(Self::failure(PASSWORD_AUTH_TIMEOUT_ERROR.to_string(), None));
        }

        if output.status.success()
            || lower_output.contains("logged in")
            || lower_output.contains("authentication successful")
            || lower_output.contains("login successful")
            || lower_output.contains("authenticated")
        {
            Ok(Self::success(None))
        } else if lower_output.contains("steam guard") || lower_output.contains("two-factor") {
            warn_with_location(format!(
                "Steam auth requires Steam Guard approval: {}",
                sanitized_output
            ));
            Ok(Self::failure(
                "Steam Guard approval required".to_string(),
                Some(true),
            ))
        } else if lower_output.contains("password")
            && (lower_output.contains("incorrect") || lower_output.contains("invalid"))
        {
            warn_with_location(format!(
                "Steam auth rejected invalid credentials: {}",
                sanitized_output
            ));
            Ok(Self::failure("Invalid password".to_string(), None))
        } else {
            error_with_location(format!(
                "Steam auth failed with DepotDownloader output: {}",
                sanitized_output
            ));
            Ok(Self::failure(
                format!("Authentication failed: {}", sanitized_output),
                None,
            ))
        }
    }

    pub async fn authenticate_qr<R: Runtime>(
        &self,
        app: AppHandle<R>,
        remember_credentials: bool,
    ) -> Result<AuthResult> {
        let detector_info = detect_depot_downloader().await?;
        if !detector_info.installed || detector_info.path.is_none() {
            warn_with_location("Steam QR auth rejected because DepotDownloader is not installed");
            return Ok(Self::failure(
                "DepotDownloader is not installed. Please install it first.".to_string(),
                None,
            ));
        }

        let executable_path = detector_info.path.unwrap();
        let args = Self::build_qr_auth_args(remember_credentials);

        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam QR auth failed to resolve DepotDownloader working directory: {}",
                    error
                ));
                error
            })?;

        #[cfg(target_os = "windows")]
        let child = ({
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            Command::new(&executable_path)
                .args(&args)
                .current_dir(&depots_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .creation_flags(0x08000000)
                .spawn()
                .context("Failed to spawn DepotDownloader QR auth process")
        })
        .map_err(|error| {
            error_with_location(format!(
                "Steam QR auth failed to spawn DepotDownloader: {}",
                error
            ));
            error
        })?;

        #[cfg(not(target_os = "windows"))]
        let child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Failed to spawn DepotDownloader QR auth process")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam QR auth failed to spawn DepotDownloader: {}",
                    error
                ));
                error
            })?;

        let output = Self::run_qr_process(app, child, QR_AUTH_TIMEOUT)
            .await
            .map_err(|error| {
                error_with_location(format!(
                    "Steam QR auth process management failed: {}",
                    error
                ));
                error
            })?;
        let all_output = output.stdout + &output.stderr;
        let lower_output = all_output.to_lowercase();

        if output.completion == AuthProcessCompletion::TimedOut {
            let sanitized_output =
                crate::services::logger::LoggerService::sanitize_log_text(&all_output);
            warn_with_location(format!(
                "Steam QR authentication timed out after {} seconds: {}",
                QR_AUTH_TIMEOUT.as_secs(),
                sanitized_output
            ));
            return Ok(Self::failure(QR_AUTH_TIMEOUT_ERROR.to_string(), None));
        }

        if output.status.success()
            || lower_output.contains("logged in")
            || lower_output.contains("authentication successful")
            || lower_output.contains("login successful")
            || lower_output.contains("authenticated")
        {
            if let Some(username) = Self::parse_qr_account_name(&all_output) {
                Ok(Self::success(Some(username)))
            } else {
                error_with_location("Steam QR auth succeeded but account name was not detected");
                Ok(Self::failure(
                    "QR login succeeded, but SIMM could not detect the Steam account name needed for future DepotDownloader sessions.".to_string(),
                    None,
                ))
            }
        } else {
            let sanitized_output =
                crate::services::logger::LoggerService::sanitize_log_text(&all_output);
            error_with_location(format!(
                "Steam QR auth failed with DepotDownloader output: {}",
                sanitized_output
            ));
            if lower_output.contains("asyncjobfailed") || lower_output.contains("async job failed")
            {
                return Ok(Self::failure(
                    "Steam rejected the QR login session before it completed. Start a new QR login and scan the fresh code in the Steam Mobile App.".to_string(),
                    None,
                ));
            }
            Ok(Self::failure(
                format!("QR authentication failed: {}", sanitized_output),
                None,
            ))
        }
    }

    #[allow(dead_code)]
    pub async fn check_authentication_status(&self, username: String) -> Result<bool> {
        let result = self.authenticate(username, None, None, false).await?;
        Ok(result.success)
    }
}

impl Default for AuthService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    use serial_test::serial;
    use std::io::Write;
    use tauri::test::mock_app;
    #[cfg(target_os = "windows")]
    use tempfile::tempdir;

    #[cfg(target_os = "windows")]
    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    #[cfg(target_os = "windows")]
    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    #[cfg(target_os = "windows")]
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
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

    fn login_id_arg(args: &[String]) -> Option<&str> {
        args.windows(2)
            .find(|window| window[0] == "-loginid")
            .map(|window| window[1].as_str())
    }

    fn spawn_timeout_fixture() -> Result<Child> {
        let executable = std::env::current_exe().context("Failed to locate auth test binary")?;
        let mut command = Command::new(executable);
        command
            .args([
                "--exact",
                "services::auth::tests::auth_timeout_child_fixture",
                "--nocapture",
            ])
            .env("SIMM_AUTH_TIMEOUT_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
            .spawn()
            .context("Failed to spawn auth timeout fixture")
    }

    #[test]
    fn auth_timeout_child_fixture() {
        if std::env::var_os("SIMM_AUTH_TIMEOUT_FIXTURE").is_none() {
            return;
        }

        println!("auth timeout fixture stdout");
        eprintln!("auth timeout fixture stderr");
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
        std::thread::sleep(Duration::from_secs(30));
    }

    #[tokio::test]
    async fn password_auth_timeout_kills_and_reaps_child() -> Result<()> {
        let child = spawn_timeout_fixture()?;
        let started = tokio::time::Instant::now();

        let output = AuthService::run_password_process(
            child,
            vec!["fixture-password-not-an-argument".to_string()],
            Duration::from_millis(750),
        )
        .await?;

        assert_eq!(output.completion, AuthProcessCompletion::TimedOut);
        assert!(!output.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(output.stdout.contains("auth timeout fixture stdout"));
        assert!(output.stderr.contains("auth timeout fixture stderr"));
        Ok(())
    }

    #[tokio::test]
    async fn qr_auth_timeout_kills_and_reaps_child_after_streaming_output() -> Result<()> {
        let child = spawn_timeout_fixture()?;
        let app = mock_app();
        let handle = app.handle().clone();
        let started = tokio::time::Instant::now();

        let output = AuthService::run_qr_process(handle, child, Duration::from_millis(750)).await?;

        assert_eq!(output.completion, AuthProcessCompletion::TimedOut);
        assert!(!output.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(output.stdout.contains("auth timeout fixture stdout"));
        assert!(output.stderr.contains("auth timeout fixture stderr"));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    #[cfg(target_os = "windows")]
    async fn authenticate_returns_error_when_depotdownloader_missing() -> Result<()> {
        let temp = tempdir()?;
        let _cwd_guard = CurrentDirGuard::new(temp.path())?;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = format!("{}\\System32", system_root);
        let _path_guard = EnvVarGuard::set("PATH", &system32);
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard =
            EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());

        let service = AuthService::new();
        let result = service
            .authenticate("user".to_string(), None, None, false)
            .await?;

        assert!(!result.success);
        assert!(result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("DepotDownloader"));
        assert_eq!(result.requires_steam_guard, None);

        Ok(())
    }

    #[test]
    fn build_auth_args_uses_a_configured_schedule_i_branch() {
        let args =
            AuthService::build_auth_args("steam-user".to_string(), true, Some("guard".to_string()));

        assert!(args.windows(2).any(|window| {
            window[0] == "-branch"
                && window[1] == crate::types::schedule_i_config().branches[0].name
        }));
        assert!(!args.iter().any(|arg| arg == "-password"));
        assert!(!args.iter().any(|arg| arg == "secret-pass"));
        let login_id = login_id_arg(&args).expect("auth args should include -loginid");
        assert!(login_id.parse::<u32>().is_ok());
        assert!(args.iter().any(|arg| arg == "-remember-password"));
        assert!(args.iter().any(|arg| arg == "-no-mobile"));
        assert!(!args.iter().any(|arg| arg == "-steamguard"));
        assert!(!args.iter().any(|arg| arg == "public"));
    }

    #[test]
    fn build_auth_args_omits_blank_steam_guard() {
        let args =
            AuthService::build_auth_args("steam-user".to_string(), false, Some("   ".to_string()));

        assert!(!args.iter().any(|arg| arg == "-no-mobile"));
        assert!(!args.iter().any(|arg| arg == "-steamguard"));
        assert!(!args.iter().any(|arg| arg == "-remember-password"));
    }

    #[test]
    fn build_qr_auth_args_omits_username_uses_qr_and_unique_login_id() {
        let args = AuthService::build_qr_auth_args(true);

        assert!(args.iter().any(|arg| arg == "-qr"));
        assert!(args.iter().any(|arg| arg == "-remember-password"));
        let login_id = login_id_arg(&args).expect("QR auth args should include -loginid");
        assert!(login_id.parse::<u32>().is_ok());
        assert!(args.iter().any(|arg| arg == "-manifest-only"));
        assert!(!args.iter().any(|arg| arg == "-username"));
        assert!(!args.iter().any(|arg| arg == "-password"));
    }

    #[test]
    fn qr_auth_args_honor_one_time_credentials_setting() {
        let args = AuthService::build_qr_auth_args(false);
        assert!(!args.iter().any(|arg| arg == "-remember-password"));
    }

    #[test]
    fn parse_qr_account_name_reads_depotdownloader_success_line() {
        let output =
            "Success! Next time you can login with -username schedule_user -remember-password instead of -qr.";

        assert_eq!(
            AuthService::parse_qr_account_name(output).as_deref(),
            Some("schedule_user")
        );
    }

    #[test]
    fn decode_depotdownloader_output_preserves_utf8_and_oem_qr_blocks() {
        assert_eq!(
            AuthService::decode_depotdownloader_output("Use the Steam Mobile App\n".as_bytes()),
            "Use the Steam Mobile App\n"
        );
        assert_eq!(
            AuthService::decode_depotdownloader_output(&[0xdb, 0xdb, b' ', 0xdb, b'\r', b'\n']),
            "\u{2588}\u{2588} \u{2588}\r\n"
        );
    }
}
