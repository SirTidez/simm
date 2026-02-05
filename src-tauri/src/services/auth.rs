use std::process::Stdio;
use tokio::process::Command;
use anyhow::{Context, Result};
use crate::utils::depot_downloader_detector::detect_depot_downloader;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthResult {
    pub success: bool,
    pub error: Option<String>,
    pub requires_steam_guard: Option<bool>,
}

#[derive(Clone)]
pub struct AuthService;

impl AuthService {
    pub fn new() -> Self {
        Self
    }

    pub async fn authenticate(
        &self,
        username: String,
        password: Option<String>,
        steam_guard: Option<String>,
    ) -> Result<AuthResult> {
        let detector_info = detect_depot_downloader().await?;
        if !detector_info.installed || detector_info.path.is_none() {
            return Ok(AuthResult {
                success: false,
                error: Some("DepotDownloader is not installed. Please install it first.".to_string()),
                requires_steam_guard: None,
            });
        }

        let executable_path = detector_info.path.unwrap();
        let mut args = vec![
            "-app".to_string(),
            "3164500".to_string(), // Schedule I AppID
            "-username".to_string(),
            username,
            "-manifest-only".to_string(),
            "-branch".to_string(),
            "public".to_string(),
        ];

        if cfg!(target_os = "windows") {
            args.push("-remember-password".to_string());
        }

        if let Some(ref sg) = steam_guard {
            args.push("-steamguard".to_string());
            args.push(sg.clone());
        }

        // Get depots directory from SIMM folder
        let depots_dir = crate::utils::directory_init::get_depots_dir()
            .context("Failed to get depots directory")?;

        #[cfg(target_os = "windows")]
        let mut child = {
            use std::os::windows::process::CommandExt;
            Command::new(&executable_path)
                .args(&args)
                .current_dir(&depots_dir) // Set working directory to SIMM/depots
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to spawn DepotDownloader process")?
        };

        #[cfg(not(target_os = "windows"))]
        let mut child = Command::new(&executable_path)
            .args(&args)
            .current_dir(&depots_dir) // Set working directory to SIMM/depots
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn DepotDownloader process")?;

        // Handle password if provided
        if let Some(pwd) = password {
            if let Some(mut stdin) = child.stdin.take() {
                tokio::spawn(async move {
                    // Wait a bit for password prompt
                    tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(format!("{}\n", pwd).as_bytes()).await;
                });
            }
        }

        let output = child.wait_with_output().await?;
        let all_output = String::from_utf8_lossy(&output.stdout)
            .to_string()
            + &String::from_utf8_lossy(&output.stderr).to_string();
        let lower_output = all_output.to_lowercase();

        if output.status.success()
            || lower_output.contains("logged in")
            || lower_output.contains("authentication successful")
        {
            Ok(AuthResult {
                success: true,
                error: None,
                requires_steam_guard: None,
            })
        } else if lower_output.contains("steam guard")
            || lower_output.contains("two-factor")
        {
            Ok(AuthResult {
                success: false,
                error: Some("Steam Guard approval required".to_string()),
                requires_steam_guard: Some(true),
            })
        } else if lower_output.contains("password")
            && (lower_output.contains("incorrect") || lower_output.contains("invalid"))
        {
            Ok(AuthResult {
                success: false,
                error: Some("Invalid password".to_string()),
                requires_steam_guard: None,
            })
        } else {
            Ok(AuthResult {
                success: false,
                error: Some(format!("Authentication failed: {}", all_output)),
                requires_steam_guard: None,
            })
        }
    }

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
    #[cfg(target_os = "windows")]
    async fn authenticate_returns_error_when_depotdownloader_missing() -> Result<()> {
        let temp = tempdir()?;
        let _cwd_guard = CurrentDirGuard::new(temp.path())?;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = format!("{}\\System32", system_root);
        let _path_guard = EnvVarGuard::set("PATH", &system32);
        let _local_guard = EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let _program_guard = EnvVarGuard::set("PROGRAMFILES", temp.path().to_string_lossy().as_ref());

        let service = AuthService::new();
        let result = service
            .authenticate("user".to_string(), None, None)
            .await?;

        assert!(!result.success);
        assert!(result.error.as_deref().unwrap_or("").contains("DepotDownloader"));
        assert_eq!(result.requires_steam_guard, None);

        Ok(())
    }
}
