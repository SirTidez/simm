use std::path::Path;
use std::process::Command;
use anyhow::{Context, Result};
use crate::types::{DepotDownloaderInfo, DetectionMethod};

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

    let output = Command::new(which_command)
        .arg(executable_name)
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let path = path_str.lines().next()
                .and_then(|line| {
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
                cwd.join("DepotDownloader").join(executable_name).to_string_lossy().to_string(),
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

/// Verifies DepotDownloader is functional by running --help
pub async fn verify_depot_downloader(path: &str) -> Result<bool> {
    let output = Command::new(path)
        .arg("--help")
        .output()
        .context("Failed to execute DepotDownloader")?;

    Ok(output.status.success())
}

