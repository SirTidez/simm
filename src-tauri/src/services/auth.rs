use crate::utils::depot_downloader_detector::detect_depot_downloader;
use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::{Context, Result};
use regex::Regex;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthResult {
    pub success: bool,
    pub error: Option<String>,
    pub requires_steam_guard: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
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
        password: Option<String>,
        steam_guard: Option<String>,
    ) -> Vec<String> {
        let config = crate::types::schedule_i_config();
        let auth_branch = Self::auth_branch();
        let password = Self::trimmed_optional(password);
        let steam_guard = Self::trimmed_optional(steam_guard);

        let mut args = vec![
            "-app".to_string(),
            config.app_id,
            "-username".to_string(),
            username,
        ];

        if let Some(password) = password {
            args.push("-password".to_string());
            args.push(password);
        }

        args.extend([
            "-remember-password".to_string(),
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

    fn build_qr_auth_args() -> Vec<String> {
        let config = crate::types::schedule_i_config();
        vec![
            "-app".to_string(),
            config.app_id,
            "-qr".to_string(),
            "-remember-password".to_string(),
            "-loginid".to_string(),
            Self::login_id(),
            "-manifest-only".to_string(),
            "-branch".to_string(),
            Self::auth_branch(),
        ]
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

    async fn emit_qr_output_line<R: Runtime>(
        app: &AppHandle<R>,
        output: &Arc<Mutex<String>>,
        line: String,
    ) {
        output.lock().await.push_str(&format!("{}\n", line));
        let _ = crate::events::emit_steam_auth_qr_line(app, line);
    }

    async fn pump_qr_output<R, S>(app: AppHandle<R>, mut stream: S, output: Arc<Mutex<String>>)
    where
        R: Runtime,
        S: AsyncRead + Unpin,
    {
        let mut buffer = [0_u8; 4096];
        let mut pending = String::new();

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
                Self::emit_qr_output_line(&app, &output, line).await;
            }
        }

        if !pending.is_empty() {
            Self::emit_qr_output_line(&app, &output, pending).await;
        }
    }

    pub async fn authenticate(
        &self,
        username: String,
        password: Option<String>,
        steam_guard: Option<String>,
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
        let steam_guard = Self::trimmed_optional(steam_guard);
        let args = Self::build_auth_args(username, password, steam_guard.clone());

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
        let mut child = ({
            #[allow(unused_imports)] // Required for CommandExt trait methods
            use std::os::windows::process::CommandExt;
            Command::new(&executable_path)
                .args(&args)
                .current_dir(&depots_dir) // Set working directory to SIMM/depots
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
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
        let mut child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn DepotDownloader process")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam auth failed to spawn DepotDownloader: {}",
                    error
                ));
                error
            })?;

        if let Some(steam_guard) = steam_guard {
            if let Some(mut stdin) = child.stdin.take() {
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin
                        .write_all(format!("{}\n", steam_guard).as_bytes())
                        .await;
                });
            }
        }

        let output = child.wait_with_output().await.map_err(|error| {
            error_with_location(format!(
                "Steam auth failed while waiting for DepotDownloader output: {}",
                error
            ));
            error
        })?;
        let all_output = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr).to_string();
        let sanitized_output =
            crate::services::logger::LoggerService::sanitize_log_text(&all_output);
        let lower_output = all_output.to_lowercase();

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

    pub async fn authenticate_qr<R: Runtime>(&self, app: AppHandle<R>) -> Result<AuthResult> {
        let detector_info = detect_depot_downloader().await?;
        if !detector_info.installed || detector_info.path.is_none() {
            warn_with_location("Steam QR auth rejected because DepotDownloader is not installed");
            return Ok(Self::failure(
                "DepotDownloader is not installed. Please install it first.".to_string(),
                None,
            ));
        }

        let executable_path = detector_info.path.unwrap();
        let args = Self::build_qr_auth_args();

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
        let mut child = ({
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            Command::new(&executable_path)
                .args(&args)
                .current_dir(&depots_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
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
        let mut child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn DepotDownloader QR auth process")
            .map_err(|error| {
                error_with_location(format!(
                    "Steam QR auth failed to spawn DepotDownloader: {}",
                    error
                ));
                error
            })?;

        let output = Arc::new(Mutex::new(String::new()));
        let mut stdout_task = None;
        if let Some(stdout) = child.stdout.take() {
            let app = app.clone();
            let output = output.clone();
            stdout_task = Some(tokio::spawn(async move {
                Self::pump_qr_output(app, stdout, output).await;
            }));
        }

        let mut stderr_task = None;
        if let Some(stderr) = child.stderr.take() {
            let app = app.clone();
            let output = output.clone();
            stderr_task = Some(tokio::spawn(async move {
                Self::pump_qr_output(app, stderr, output).await;
            }));
        }

        let status = child.wait().await.map_err(|error| {
            error_with_location(format!(
                "Steam QR auth failed while waiting for DepotDownloader: {}",
                error
            ));
            error
        })?;

        if let Some(handle) = stdout_task {
            let _ = handle.await;
        }
        if let Some(handle) = stderr_task {
            let _ = handle.await;
        }

        let all_output = output.lock().await.clone();
        let lower_output = all_output.to_lowercase();

        if status.success()
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
        let result = self.authenticate(username, None, None).await?;
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
        let result = service.authenticate("user".to_string(), None, None).await?;

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
        let args = AuthService::build_auth_args(
            "steam-user".to_string(),
            Some("secret-pass".to_string()),
            Some("guard".to_string()),
        );

        assert!(args.windows(2).any(|window| {
            window[0] == "-branch"
                && window[1] == crate::types::schedule_i_config().branches[0].name
        }));
        assert!(args
            .windows(2)
            .any(|window| window[0] == "-password" && window[1] == "secret-pass"));
        let login_id = login_id_arg(&args).expect("auth args should include -loginid");
        assert!(login_id.parse::<u32>().is_ok());
        assert!(args.iter().any(|arg| arg == "-remember-password"));
        assert!(args.iter().any(|arg| arg == "-no-mobile"));
        assert!(!args.iter().any(|arg| arg == "-steamguard"));
        assert!(!args.iter().any(|arg| arg == "public"));
    }

    #[test]
    fn build_auth_args_omits_blank_steam_guard() {
        let args = AuthService::build_auth_args(
            "steam-user".to_string(),
            Some("secret-pass".to_string()),
            Some("   ".to_string()),
        );

        assert!(!args.iter().any(|arg| arg == "-no-mobile"));
        assert!(!args.iter().any(|arg| arg == "-steamguard"));
    }

    #[test]
    fn build_qr_auth_args_omits_username_uses_qr_and_unique_login_id() {
        let args = AuthService::build_qr_auth_args();

        assert!(args.iter().any(|arg| arg == "-qr"));
        assert!(args.iter().any(|arg| arg == "-remember-password"));
        let login_id = login_id_arg(&args).expect("QR auth args should include -loginid");
        assert!(login_id.parse::<u32>().is_ok());
        assert!(args.iter().any(|arg| arg == "-manifest-only"));
        assert!(!args.iter().any(|arg| arg == "-username"));
        assert!(!args.iter().any(|arg| arg == "-password"));
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
