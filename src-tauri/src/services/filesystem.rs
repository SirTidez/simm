use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::{Context, Result};
use std::path::Path;

#[derive(Clone)]
pub struct FileSystemService;

impl FileSystemService {
    pub fn new() -> Self {
        Self
    }

    pub async fn open_path(&self, path: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", path])
                .creation_flags(0x08000000)
                .spawn()
                .context("Failed to open path")?;
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(path)
                .spawn()
                .context("Failed to open path")?;
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(path)
                .spawn()
                .context("Failed to open path")?;
        }

        Ok(())
    }

    pub async fn open_folder(&self, path: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer")
                .arg(path)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to open folder")?;
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(path)
                .spawn()
                .context("Failed to open folder")?;
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(path)
                .spawn()
                .context("Failed to open folder")?;
        }

        Ok(())
    }

    pub async fn reveal_path(&self, path: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer")
                .arg(format!("/select,\"{}\"", path))
                .creation_flags(0x08000000)
                .spawn()
                .context("Failed to reveal path")?;
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(path)
                .spawn()
                .context("Failed to reveal path")?;
        }

        #[cfg(target_os = "linux")]
        {
            let parent = Path::new(path)
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Path has no parent folder"))?;
            self.open_folder(parent.to_string_lossy().as_ref()).await?;
        }

        Ok(())
    }

    pub async fn launch_game(
        &self,
        game_dir: Option<&str>,
        launch_method: Option<&str>,
    ) -> Result<String> {
        let method = launch_method.unwrap_or("steam");

        match method {
            "steam" => self.launch_via_steam(game_dir).await,
            "direct" => {
                let dir = game_dir.ok_or_else(|| {
                    let message = "Game directory is required for direct launch";
                    warn_with_location(message);
                    anyhow::anyhow!(message)
                })?;
                self.launch_directly(dir).await
            }
            _ => {
                let message = format!("Unknown launch method: {}", method);
                warn_with_location(&message);
                Err(anyhow::anyhow!(message))
            }
        }
    }

    async fn launch_via_steam(&self, game_dir: Option<&str>) -> Result<String> {
        let app_id = crate::services::steam::SteamService::get_steam_app_id();

        // If we have a custom game directory, use executable method to pass the path
        // Otherwise, try protocol first for simplicity
        if let Some(dir) = game_dir {
            self.launch_via_steam_executable(&app_id, Some(dir)).await?;
        } else {
            // Try Steam protocol first
            if let Err(error) = self.launch_via_steam_protocol(&app_id).await {
                warn_with_location(format!(
                    "Steam protocol launch failed for app {}. Falling back to Steam executable: {}",
                    app_id, error
                ));
                // Fallback to Steam executable method
                self.launch_via_steam_executable(&app_id, None).await?;
            }
        }

        Ok(format!("steam://run/{}", app_id))
    }

    async fn launch_via_steam_protocol(&self, app_id: &str) -> Result<()> {
        let url = format!("steam://run/{}", app_id);

        #[cfg(target_os = "windows")]
        {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use winapi::um::shellapi::ShellExecuteW;
            use winapi::um::winuser::SW_SHOW;

            let url_wide: Vec<u16> = OsStr::new(&url).encode_wide().chain(Some(0)).collect();
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    OsStr::new("open")
                        .encode_wide()
                        .chain(Some(0))
                        .collect::<Vec<_>>()
                        .as_ptr(),
                    url_wide.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOW,
                )
            };

            if result as usize <= 32 {
                return Err(anyhow::anyhow!("Failed to launch Steam protocol"));
            }
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&url)
                .spawn()
                .context("Failed to launch Steam protocol")?;
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(&url)
                .spawn()
                .context("Failed to launch Steam protocol")?;
        }

        Ok(())
    }

    async fn launch_via_steam_executable(
        &self,
        app_id: &str,
        game_dir: Option<&str>,
    ) -> Result<()> {
        // If we have a custom game directory, we need to launch the executable directly
        // but ensure Steam is running so it can inject its API for authentication
        if let Some(dir) = game_dir {
            // Ensure Steam is running first
            self.ensure_steam_running().await?;

            // Launch the game executable directly - Steam will inject its API if running
            let executable_name = if cfg!(target_os = "windows") {
                "Schedule I.exe"
            } else if cfg!(target_os = "macos") {
                "Schedule I.app"
            } else {
                "Schedule I"
            };

            let executable_path = Path::new(dir).join(executable_name);
            if !executable_path.exists() {
                let message = format!(
                    "Game executable not found at {}",
                    crate::services::logger::LoggerService::sanitize_log_text(
                        &executable_path.to_string_lossy()
                    )
                );
                error_with_location(&message);
                return Err(anyhow::anyhow!(message));
            }

            // Launch with Steam environment variables to ensure proper authentication
            let mut cmd = std::process::Command::new(&executable_path);
            cmd.current_dir(dir);

            // Set Steam App ID environment variable so Steam knows which game this is
            cmd.env("SteamAppId", app_id);
            cmd.env("SteamGameId", app_id);

            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW flag
            }

            cmd.spawn()
                .context("Failed to launch game executable")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn game executable for {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(dir),
                        error
                    ));
                    error
                })?;

            return Ok(());
        }

        // For Steam's own installations, use standard Steam launch
        let steam_path =
            crate::services::steam::SteamService::get_steam_path().ok_or_else(|| {
                let message = "Steam installation not found";
                error_with_location(message);
                anyhow::anyhow!(message)
            })?;

        let steam_exe = if cfg!(target_os = "windows") {
            steam_path.join("steam.exe")
        } else if cfg!(target_os = "macos") {
            steam_path
                .join("Steam.app")
                .join("Contents")
                .join("MacOS")
                .join("steam.sh")
        } else {
            steam_path.join("steam")
        };

        if !steam_exe.exists() {
            let message = format!(
                "Steam executable not found at {}",
                crate::services::logger::LoggerService::sanitize_log_text(
                    &steam_exe.to_string_lossy()
                )
            );
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(&steam_exe)
                .arg("-applaunch")
                .arg(app_id)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to launch game via Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam executable {} for app {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_exe.to_string_lossy()
                        ),
                        app_id,
                        error
                    ));
                    error
                })?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new(&steam_exe)
                .arg("-applaunch")
                .arg(app_id)
                .spawn()
                .context("Failed to launch game via Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam executable {} for app {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_exe.to_string_lossy()
                        ),
                        app_id,
                        error
                    ));
                    error
                })?;
        }

        Ok(())
    }

    async fn ensure_steam_running(&self) -> Result<()> {
        let steam_path = crate::services::steam::SteamService::get_steam_path()
            .ok_or_else(|| anyhow::anyhow!("Steam installation not found"))?;

        let steam_exe = if cfg!(target_os = "windows") {
            steam_path.join("steam.exe")
        } else if cfg!(target_os = "macos") {
            steam_path
                .join("Steam.app")
                .join("Contents")
                .join("MacOS")
                .join("steam.sh")
        } else {
            steam_path.join("steam")
        };

        if !steam_exe.exists() {
            let message = format!(
                "Steam executable not found at {}",
                crate::services::logger::LoggerService::sanitize_log_text(
                    &steam_exe.to_string_lossy()
                )
            );
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        // Check if Steam is already running
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            let steam_exe_name = steam_exe.file_name().unwrap().to_string_lossy().to_string();

            let output = Command::new("tasklist")
                .arg("/FI")
                .arg(format!("IMAGENAME eq {}", steam_exe_name))
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .output()
                .ok();

            if let Some(output) = output {
                let output_str = String::from_utf8_lossy(&output.stdout);
                if output_str.contains(&steam_exe_name) {
                    // Steam is already running
                    return Ok(());
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            // On Unix systems, check if Steam process is running
            let output = std::process::Command::new("pgrep")
                .arg("-f")
                .arg("steam")
                .output()
                .ok();

            if let Some(output) = output {
                if output.status.success() {
                    // Steam is already running
                    return Ok(());
                }
            }
        }

        // Steam is not running, start it
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(&steam_exe)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to start Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to start Steam executable {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_exe.to_string_lossy()
                        ),
                        error
                    ));
                    error
                })?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new(&steam_exe)
                .spawn()
                .context("Failed to start Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to start Steam executable {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_exe.to_string_lossy()
                        ),
                        error
                    ));
                    error
                })?;
        }

        // Give Steam a moment to start
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        Ok(())
    }

    async fn launch_directly(&self, game_dir: &str) -> Result<String> {
        // Find the game executable
        let executable_name = if cfg!(target_os = "windows") {
            "Schedule I.exe"
        } else if cfg!(target_os = "macos") {
            "Schedule I.app"
        } else {
            "Schedule I"
        };

        let executable_path = Path::new(game_dir).join(executable_name);

        if !executable_path.exists() {
            let message = format!(
                "Game executable not found at {}",
                crate::services::logger::LoggerService::sanitize_log_text(
                    &executable_path.to_string_lossy()
                )
            );
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(&executable_path)
                .current_dir(game_dir)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
                .spawn()
                .context("Failed to launch game")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn game executable {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &executable_path.to_string_lossy()
                        ),
                        error
                    ));
                    error
                })?;
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&executable_path)
                .spawn()
                .context("Failed to launch game")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn game executable {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &executable_path.to_string_lossy()
                        ),
                        error
                    ));
                    error
                })?;
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new(&executable_path)
                .current_dir(game_dir)
                .spawn()
                .context("Failed to launch game")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn game executable {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &executable_path.to_string_lossy()
                        ),
                        error
                    ));
                    error
                })?;
        }

        Ok(executable_path.to_string_lossy().to_string())
    }
}

impl Default for FileSystemService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn launch_game_rejects_unknown_method() {
        let service = FileSystemService::new();
        let err = service
            .launch_game(Some("C:\\fake"), Some("mystery"))
            .await
            .expect_err("expected unknown launch method error");
        assert!(err.to_string().contains("Unknown launch method"));
    }

    #[tokio::test]
    async fn launch_game_direct_missing_executable_errors() {
        let temp = tempdir().expect("temp dir");
        let service = FileSystemService::new();
        let err = service
            .launch_game(Some(temp.path().to_string_lossy().as_ref()), Some("direct"))
            .await
            .expect_err("expected missing executable error");
        assert!(err.to_string().contains("Game executable not found"));
    }

    #[tokio::test]
    async fn launch_game_direct_requires_directory() {
        let service = FileSystemService::new();
        let err = service
            .launch_game(None, Some("direct"))
            .await
            .expect_err("expected missing directory error");
        assert!(err
            .to_string()
            .contains("Game directory is required for direct launch"));
    }
}
