use crate::types::{DepotDownloaderInfo, DetectionMethod};
#[cfg(all(test, target_os = "windows"))]
use anyhow::Context;
use anyhow::Result;
use std::path::Path;
use std::process::Command;

/// Detects if DepotDownloader is installed and returns its path
pub async fn detect_depot_downloader() -> Result<DepotDownloaderInfo> {
    detect_depot_downloader_with_override(None).await
}

/// Resolves a user-configured DepotDownloader executable before consulting
/// PATH and the platform defaults. Invalid configured paths fail closed so a
/// typo cannot silently launch a different installation than the one selected
/// in Settings.
pub async fn detect_depot_downloader_with_override(
    configured_path: Option<&str>,
) -> Result<DepotDownloaderInfo> {
    if let Some(configured_path) = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = Path::new(configured_path);
        if !path.is_file() {
            anyhow::bail!(
                "Configured DepotDownloader executable does not exist or is not a file: {}",
                path.display()
            );
        }
        return Ok(depot_downloader_info(
            true,
            Some(path.to_string_lossy().into_owned()),
            Some(DetectionMethod::Manual),
        ));
    }

    let executable_names = if cfg!(target_os = "windows") {
        vec!["DepotDownloader.exe"]
    } else {
        vec!["DepotDownloader", "depotdownloader"]
    };

    for executable_name in &executable_names {
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
                    return Ok(depot_downloader_info(
                        true,
                        Some(path),
                        Some(DetectionMethod::Path),
                    ));
                }
            }
        }
    }

    // Check common installation locations
    let common_paths = get_common_paths(&executable_names);

    for (path, method) in common_paths {
        if Path::new(&path).exists() {
            return Ok(depot_downloader_info(true, Some(path), Some(method)));
        }
    }

    Ok(depot_downloader_info(false, None, None))
}

fn depot_downloader_info(
    installed: bool,
    path: Option<String>,
    method: Option<DetectionMethod>,
) -> DepotDownloaderInfo {
    DepotDownloaderInfo {
        installed,
        path,
        method,
        version: None,
        can_auto_install: cfg!(any(target_os = "windows", target_os = "linux")),
        install_help_url: "https://github.com/SteamRE/DepotDownloader#installation".to_string(),
        install_hint: depot_downloader_install_hint(),
    }
}

fn depot_downloader_install_hint() -> String {
    if cfg!(target_os = "windows") {
        "SIMM can install DepotDownloader with winget.".to_string()
    } else if cfg!(target_os = "macos") {
        "Install DepotDownloader with Homebrew (`brew tap steamre/tools && brew install depotdownloader`) or download a release from GitHub.".to_string()
    } else {
        "SIMM can install the latest Linux DepotDownloader release into ~/.local/bin, or you can install it manually from GitHub.".to_string()
    }
}

fn get_common_paths(executable_names: &[&str]) -> Vec<(String, DetectionMethod)> {
    let mut paths = Vec::new();

    if cfg!(target_os = "windows") {
        let executable_name = executable_names
            .first()
            .copied()
            .unwrap_or("DepotDownloader.exe");
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
        for executable_name in executable_names {
            paths.push((
                format!("/opt/homebrew/bin/{}", executable_name),
                DetectionMethod::Homebrew,
            ));
            paths.push((
                format!("/usr/local/bin/{}", executable_name),
                DetectionMethod::Homebrew,
            ));
            if let Ok(home) = std::env::var("HOME") {
                paths.push((
                    format!("{}/.homebrew/bin/{}", home, executable_name),
                    DetectionMethod::Homebrew,
                ));
            }
        }
    } else {
        // Linux
        for executable_name in executable_names {
            paths.push((
                format!("/usr/local/bin/{}", executable_name),
                DetectionMethod::Manual,
            ));
            paths.push((
                format!("/usr/bin/{}", executable_name),
                DetectionMethod::Manual,
            ));
            if let Ok(home) = std::env::var("HOME") {
                paths.push((
                    format!("{}/.local/bin/{}", home, executable_name),
                    DetectionMethod::Manual,
                ));
                paths.push((
                    format!("{}/.dotnet/tools/{}", home, executable_name),
                    DetectionMethod::Manual,
                ));
            }
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
        let detected_path =
            Path::new(result.path.as_deref().context("missing detected path")?).canonicalize()?;
        assert_eq!(detected_path, exe_path.canonicalize()?);
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

    #[tokio::test]
    async fn configured_executable_takes_precedence() -> Result<()> {
        let temp = tempdir()?;
        let executable = temp.path().join("custom-depot.exe");
        fs::write(&executable, b"fixture").await?;

        let result = detect_depot_downloader_with_override(executable.to_str()).await?;
        assert!(result.installed);
        assert_eq!(result.path.as_deref(), executable.to_str());
        assert!(matches!(result.method, Some(DetectionMethod::Manual)));
        Ok(())
    }

    #[tokio::test]
    async fn invalid_configured_executable_fails_closed() -> Result<()> {
        let temp = tempdir()?;
        let missing = temp.path().join("missing-depot.exe");
        let error = detect_depot_downloader_with_override(missing.to_str())
            .await
            .expect_err("invalid explicit path must not fall back to another executable");
        assert!(error.to_string().contains("does not exist"));
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn common_paths_include_linux_binary_name_variants() {
        let paths = get_common_paths(&["DepotDownloader", "depotdownloader"]);
        let path_strings: Vec<&str> = paths.iter().map(|(path, _)| path.as_str()).collect();

        assert!(path_strings.contains(&"/usr/local/bin/DepotDownloader"));
        assert!(path_strings.contains(&"/usr/local/bin/depotdownloader"));
        assert!(path_strings.contains(&"/usr/bin/DepotDownloader"));
        assert!(path_strings.contains(&"/usr/bin/depotdownloader"));
        assert!(
            path_strings
                .iter()
                .any(|path| path.ends_with("/.dotnet/tools/DepotDownloader")),
            "expected dotnet global tool path in {:?}",
            path_strings
        );
    }

    #[test]
    fn linux_info_reports_user_local_auto_install_flow() {
        let info = depot_downloader_info(false, None, None);

        assert!(!info.installed);
        assert!(info.can_auto_install);
        assert!(info.install_hint.contains("~/.local/bin"));
        assert!(info.install_help_url.contains("SteamRE/DepotDownloader"));
    }
}
