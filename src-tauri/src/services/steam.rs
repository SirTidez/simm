use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use regex::Regex;
use tokio::fs;

/// Steam detection and management service
#[derive(Clone)]
pub struct SteamService;

/// Steam installation detection result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamInstallation {
    pub path: String,
    pub executable_path: String,
    pub app_id: String,
}

impl SteamService {
    pub fn new() -> Self {
        Self
    }

    /// Get Schedule I AppID
    pub fn get_steam_app_id() -> String {
        "3164500".to_string()
    }

    /// Find Steam installation directory
    pub fn get_steam_path() -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            // Common Steam installation paths on Windows
            let common_paths = vec![
                PathBuf::from("C:\\Program Files (x86)\\Steam"),
                PathBuf::from("C:\\Program Files\\Steam"),
                PathBuf::from("D:\\Steam"),
                PathBuf::from("E:\\Steam"),
            ];

            for path in common_paths {
                if path.join("steam.exe").exists() {
                    return Some(path);
                }
            }

            // Check registry or environment variables
            if let Ok(steam_path) = std::env::var("STEAM_PATH") {
                let path = PathBuf::from(steam_path);
                if path.join("steam.exe").exists() {
                    return Some(path);
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            let steam_path = PathBuf::from(format!("{}/Library/Application Support/Steam", 
                dirs::home_dir()?.to_string_lossy()));
            if steam_path.join("Steam.app").exists() {
                return Some(steam_path);
            }
        }

        #[cfg(target_os = "linux")]
        {
            let steam_path = dirs::home_dir()?.join(".steam").join("steam");
            if steam_path.exists() {
                return Some(steam_path);
            }
        }

        None
    }

    /// Detect Steam installations of Schedule I
    pub async fn detect_steam_installations(&self) -> Result<Vec<SteamInstallation>> {
        let mut installations = Vec::new();

        let steam_path = Self::get_steam_path()
            .ok_or_else(|| anyhow::anyhow!("Steam installation not found"))?;

        // Get library folders from libraryfolders.vdf
        let library_folders = self.get_library_folders(&steam_path).await?;

        // Check each library folder for Schedule I
        for library_path in library_folders {
            let game_path = library_path.join("steamapps").join("common").join("Schedule I");
            let executable_path = game_path.join("Schedule I.exe");

            if executable_path.exists() {
                installations.push(SteamInstallation {
                    path: game_path.to_string_lossy().to_string(),
                    executable_path: executable_path.to_string_lossy().to_string(),
                    app_id: Self::get_steam_app_id(),
                });
            }
        }

        Ok(installations)
    }

    /// Get all Steam library folders from libraryfolders.vdf
    async fn get_library_folders(&self, steam_path: &Path) -> Result<Vec<PathBuf>> {
        let mut folders = Vec::new();

        // Add default Steam library
        folders.push(steam_path.to_path_buf());

        // Parse libraryfolders.vdf
        let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
        
        if !vdf_path.exists() {
            // If libraryfolders.vdf doesn't exist, just return default
            return Ok(folders);
        }

        let content = fs::read_to_string(&vdf_path).await
            .context("Failed to read libraryfolders.vdf")?;

        // Parse VDF file manually (simple parsing for libraryfolders)
        // Format is typically:
        // "LibraryFolders"
        // {
        //     "1" "C:\\Program Files (x86)\\Steam"
        //     "2" "D:\\SteamLibrary"
        // }
        let lines: Vec<&str> = content.lines().collect();
        for line in lines {
            let line = line.trim();
            // Look for lines with quoted paths
            if line.starts_with('"') && line.contains("\\\\") {
                // Extract path between quotes
                if let Some(start) = line.find('"') {
                    let rest = &line[start + 1..];
                    if let Some(end) = rest.find('"') {
                        let path_str = &rest[..end];
                        // Unescape backslashes
                        let path_str = path_str.replace("\\\\", "\\");
                        let path = PathBuf::from(path_str);
                        if path.exists() && !folders.contains(&path) {
                            folders.push(path);
                        }
                    }
                }
            }
        }

        Ok(folders)
    }

    /// Validate Steam installation path
    pub fn validate_steam_installation(path: &Path) -> Result<bool> {
        let executable = path.join("Schedule I.exe");
        Ok(executable.exists())
    }

    fn find_steamapps_dir(game_path: &Path) -> Option<PathBuf> {
        let mut current = Some(game_path);
        while let Some(path) = current {
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steamapps"))
            {
                return Some(path.to_path_buf());
            }
            current = path.parent();
        }
        None
    }

    /// Detect currently selected Steam branch from appmanifest (betakey).
    /// Returns "main" when no betakey is set.
    pub async fn detect_installed_branch(&self, game_path: &Path) -> Result<Option<String>> {
        let Some(steamapps_dir) = Self::find_steamapps_dir(game_path) else {
            return Ok(None);
        };

        let manifest_path = steamapps_dir.join(format!("appmanifest_{}.acf", Self::get_steam_app_id()));
        if !manifest_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&manifest_path)
            .await
            .with_context(|| format!("Failed to read appmanifest: {}", manifest_path.display()))?;

        let betakey_re = Regex::new(r#"(?i)"betakey"\s+"([^"]*)""#)
            .context("Failed to compile betakey regex")?;

        if let Some(caps) = betakey_re.captures(&content) {
            let key = caps
                .get(1)
                .map(|m| m.as_str().trim().to_ascii_lowercase())
                .unwrap_or_default();

            if key.is_empty() {
                return Ok(Some("main".to_string()));
            }

            return Ok(Some(key));
        }

        Ok(Some("main".to_string()))
    }
}

impl Default for SteamService {
    fn default() -> Self {
        Self::new()
    }
}

