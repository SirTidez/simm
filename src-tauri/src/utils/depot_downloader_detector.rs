use crate::types::{DepotDownloaderInfo, DetectionMethod};
#[cfg(all(test, target_os = "windows"))]
use anyhow::Context;
use anyhow::Result;
use std::path::Path;
use std::process::Command;

/// Detects if DepotDownloader is installed and returns its path
pub async fn detect_depot_downloader() -> Result<DepotDownloaderInfo> {
    let executable_name = if cfg!(target_os = "windows") {
        "DepotDownloader.exe"
    } else {
        "DepotDownloader"
    };

    // First, try to find it in PATH
    let which_command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        Command::new(which_command)
            .arg(executable_name)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
            .output()
    };

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(which_command).arg(executable_name).output();

    if let Ok(output) = output {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let path = path_str.lines().next().and_then(|line| {
                let trimmed = line.trim();
                if !trimmed.is_empty() && Path::new(trimmed).exists() {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            });

            if let Some(path) = path {
                return Ok(DepotDownloaderInfo {
                    installed: true,
                    path: Some(path),
                    method: Some(DetectionMethod::Path),
                    version: None,
                });
            }
        }
    }

    // Check common installation locations
    let common_paths = get_common_paths(executable_name);

    for (path, method) in common_paths {
        if Path::new(&path).exists() {
            return Ok(DepotDownloaderInfo {
                installed: true,
                path: Some(path),
                method: Some(method),
                version: None,
            });
        }
    }

    Ok(DepotDownloaderInfo {
        installed: false,
        path: None,
        method: None,
        version: None,
    })
}

fn get_common_paths(executable_name: &str) -> Vec<(String, DetectionMethod)> {
    let mut paths = Vec::new();

    if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            paths.push((
                format!("{}\\Microsoft\\WinGet\\Packages\\SteamRE.DepotDownloader_Microsoft.Winget.Source_8wekyb3d8bbwe\\{}",
                    local_app_data, executable_name),
                DetectionMethod::Winget,
            ));
        }
        if let Ok(program_files) = std::env::var("PROGRAMFILES") {
            paths.push((
                format!("{}\\DepotDownloader\\{}", program_files, executable_name),
                DetectionMethod::Manual,
            ));
        }
        if let Ok(cwd) = std::env::current_dir() {
            paths.push((
                cwd.join("DepotDownloader")
                    .join(executable_name)
                    .to_string_lossy()
                    .to_string(),
                DetectionMethod::Manual,
            ));
        }
    } else if cfg!(target_os = "macos") {
        paths.push((
            "/opt/homebrew/bin/DepotDownloader".to_string(),
            DetectionMethod::Homebrew,
        ));
        paths.push((
            "/usr/local/bin/DepotDownloader".to_string(),
            DetectionMethod::Homebrew,
        ));
        if let Ok(home) = std::env::var("HOME") {
            paths.push((
                format!("{}/.homebrew/bin/DepotDownloader", home),
                DetectionMethod::Homebrew,
            ));
        }
    } else {
        // Linux
        paths.push((
            "/usr/local/bin/DepotDownloader".to_string(),
            DetectionMethod::Manual,
        ));
        paths.push((
            "/usr/bin/DepotDownloader".to_string(),
            DetectionMethod::Manual,
        ));
        if let Ok(home) = std::env::var("HOME") {
            paths.push((
                format!("{}/.local/bin/DepotDownloader", home),
                DetectionMethod::Manual,
            ));
        }
    }

    paths
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
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
    async fn detect_depot_downloader_finds_in_path() -> Result<()> {
        let temp = tempdir()?;
        let exe_name = "DepotDownloader.exe";
        let exe_path = temp.path().join(exe_name);
        fs::write(&exe_path, b"").await?;

        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = format!("{}\\System32", system_root);
        let new_path = format!("{};{}", temp.path().to_string_lossy(), system32);
        let _path_guard = EnvVarGuard::set("PATH", &new_path);

        let result = detect_depot_downloader().await?;
        assert!(result.installed);
        assert_eq!(
            result.path.as_deref(),
            Some(exe_path.to_string_lossy().as_ref())
        );
        assert!(matches!(result.method, Some(DetectionMethod::Path)));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn detect_depot_downloader_finds_in_current_dir() -> Result<()> {
        let temp = tempdir()?;
        let exe_name = "DepotDownloader.exe";
        let dir = temp.path().join("DepotDownloader");
        fs::create_dir_all(&dir).await?;
        let exe_path = dir.join(exe_name);
        fs::write(&exe_path, b"").await?;

        let _dir_guard = CurrentDirGuard::new(temp.path())?;
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = format!("{}\\System32", system_root);
        let _path_guard = EnvVarGuard::set("PATH", &system32);
        let _local_app_data_guard =
            EnvVarGuard::set("LOCALAPPDATA", temp.path().to_string_lossy().as_ref());
        let program_files_nonexistent = temp.path().join("does_not_exist");
        let _program_files_guard = EnvVarGuard::set(
            "PROGRAMFILES",
            program_files_nonexistent.to_string_lossy().as_ref(),
        );

        let result = detect_depot_downloader().await?;
        assert!(result.installed);
        assert_eq!(
            result.path.as_deref(),
            Some(exe_path.to_string_lossy().as_ref())
        );
        assert!(matches!(result.method, Some(DetectionMethod::Manual)));

        Ok(())
    }
}
