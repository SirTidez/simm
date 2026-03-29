use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
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
            if let Some(path) = Self::get_steam_path_from_windows_registry() {
                return Some(path);
            }

            if let Ok(steam_path) = std::env::var("STEAM_PATH") {
                if let Some(path) = Self::steam_root_from_candidate(&steam_path) {
                    return Some(path);
                }
            }

            // Common Steam installation paths on Windows
            let common_paths = [
                PathBuf::from("C:\\Program Files (x86)\\Steam"),
                PathBuf::from("C:\\Program Files\\Steam"),
                PathBuf::from("D:\\Steam"),
                PathBuf::from("E:\\Steam"),
            ];

            for path in common_paths {
                if Self::is_valid_steam_root(&path) {
                    return Some(path);
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            let steam_path = PathBuf::from(format!(
                "{}/Library/Application Support/Steam",
                dirs::home_dir()?.to_string_lossy()
            ));
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
        let steam_path = Self::get_steam_path()
            .ok_or_else(|| anyhow::anyhow!("Steam installation not found"))?;

        self.detect_steam_installations_from_root(&steam_path).await
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

        let content = fs::read_to_string(&vdf_path)
            .await
            .context("Failed to read libraryfolders.vdf")?;

        for path in Self::parse_library_folder_paths(&content) {
            if path.exists()
                && !folders
                    .iter()
                    .any(|existing| Self::path_key(existing) == Self::path_key(&path))
            {
                folders.push(path);
            }
        }

        Ok(folders)
    }

    /// Validate Steam installation path
    pub fn validate_steam_installation(path: &Path) -> Result<bool> {
        let executable = path.join("Schedule I.exe");
        Ok(executable.exists())
    }

    async fn detect_steam_installations_from_root(
        &self,
        steam_path: &Path,
    ) -> Result<Vec<SteamInstallation>> {
        let mut installations: Vec<SteamInstallation> = Vec::new();

        for library_path in self.get_library_folders(steam_path).await? {
            if let Some(installation) = self
                .resolve_schedule_installation_from_library(&library_path)
                .await?
            {
                if !installations
                    .iter()
                    .any(|existing| existing.path.eq_ignore_ascii_case(&installation.path))
                {
                    installations.push(installation);
                }
            }
        }

        Ok(installations)
    }

    async fn resolve_schedule_installation_from_library(
        &self,
        library_path: &Path,
    ) -> Result<Option<SteamInstallation>> {
        let steamapps_dir = library_path.join("steamapps");
        let manifest_path =
            steamapps_dir.join(format!("appmanifest_{}.acf", Self::get_steam_app_id()));

        if manifest_path.exists() {
            let content = fs::read_to_string(&manifest_path).await.with_context(|| {
                format!("Failed to read appmanifest: {}", manifest_path.display())
            })?;

            if let Some(install_dir) = Self::find_vdf_key_value(&content, "installdir") {
                let game_path = if Path::new(&install_dir).is_absolute() {
                    PathBuf::from(&install_dir)
                } else {
                    steamapps_dir.join("common").join(install_dir)
                };

                if let Some(installation) = Self::build_steam_installation(&game_path) {
                    return Ok(Some(installation));
                }
            }
        }

        let fallback_game_path = steamapps_dir.join("common").join("Schedule I");
        Ok(Self::build_steam_installation(&fallback_game_path))
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

        let manifest_path =
            steamapps_dir.join(format!("appmanifest_{}.acf", Self::get_steam_app_id()));
        if !manifest_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&manifest_path)
            .await
            .with_context(|| format!("Failed to read appmanifest: {}", manifest_path.display()))?;

        if let Some(key) = Self::find_vdf_key_value(&content, "betakey") {
            let key = key.trim().to_ascii_lowercase();
            return if key.is_empty() {
                Ok(Some("main".to_string()))
            } else {
                Ok(Some(key))
            };
        }

        Ok(Some("main".to_string()))
    }

    fn build_steam_installation(game_path: &Path) -> Option<SteamInstallation> {
        let executable_path = game_path.join("Schedule I.exe");
        if !executable_path.exists() {
            return None;
        }

        Some(SteamInstallation {
            path: game_path.to_string_lossy().to_string(),
            executable_path: executable_path.to_string_lossy().to_string(),
            app_id: Self::get_steam_app_id(),
        })
    }

    fn parse_library_folder_paths(content: &str) -> Vec<PathBuf> {
        let mut folders: Vec<PathBuf> = Vec::new();

        for line in content.lines() {
            let values = Self::extract_quoted_values(line);
            if values.len() < 2 {
                continue;
            }

            let key = values[0].trim();
            let value = Self::decode_vdf_value(&values[1]);
            let is_legacy_library_entry =
                key.parse::<u32>().is_ok() && Self::looks_like_path(&value);
            let is_modern_library_path =
                key.eq_ignore_ascii_case("path") && Self::looks_like_path(&value);

            if (is_legacy_library_entry || is_modern_library_path) && !value.is_empty() {
                let path = PathBuf::from(value);
                if !folders
                    .iter()
                    .any(|existing| Self::path_key(existing) == Self::path_key(&path))
                {
                    folders.push(path);
                }
            }
        }

        folders
    }

    fn find_vdf_key_value(content: &str, wanted_key: &str) -> Option<String> {
        for line in content.lines() {
            let values = Self::extract_quoted_values(line);
            if values.len() < 2 {
                continue;
            }

            if values[0].trim().eq_ignore_ascii_case(wanted_key) {
                return Some(Self::decode_vdf_value(&values[1]));
            }
        }

        None
    }

    fn extract_quoted_values(line: &str) -> Vec<String> {
        let mut values = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;

        for ch in line.chars() {
            match (ch, in_quotes) {
                ('"', false) => {
                    current.clear();
                    in_quotes = true;
                }
                ('"', true) => {
                    values.push(current.clone());
                    in_quotes = false;
                }
                (_, true) => current.push(ch),
                _ => {}
            }
        }

        values
    }

    fn decode_vdf_value(value: &str) -> String {
        value.replace("\\\\", "\\")
    }

    fn looks_like_path(value: &str) -> bool {
        value.contains('\\') || value.contains('/')
    }

    fn path_key(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    fn is_valid_steam_root(path: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            return path.join("steam.exe").exists();
        }

        #[cfg(target_os = "macos")]
        {
            return path.join("Steam.app").exists();
        }

        #[cfg(target_os = "linux")]
        {
            return path.exists();
        }
    }

    #[cfg(target_os = "windows")]
    fn get_steam_path_from_windows_registry() -> Option<PathBuf> {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;

        let registry_candidates = [
            (
                HKEY_CURRENT_USER,
                "Software\\Valve\\Steam",
                ["SteamPath", "InstallPath", "SteamExe"],
            ),
            (
                HKEY_LOCAL_MACHINE,
                "SOFTWARE\\Valve\\Steam",
                ["InstallPath", "SteamPath", "SteamExe"],
            ),
            (
                HKEY_LOCAL_MACHINE,
                "SOFTWARE\\WOW6432Node\\Valve\\Steam",
                ["InstallPath", "SteamPath", "SteamExe"],
            ),
        ];

        for (hive, subkey_path, value_names) in registry_candidates {
            let root = RegKey::predef(hive);
            let Ok(key) = root.open_subkey(subkey_path) else {
                continue;
            };

            for value_name in value_names {
                let Ok(value) = key.get_value::<String, _>(value_name) else {
                    continue;
                };

                if let Some(path) = Self::steam_root_from_candidate(&value) {
                    return Some(path);
                }
            }
        }

        None
    }

    fn steam_root_from_candidate(candidate: &str) -> Option<PathBuf> {
        let trimmed = candidate.trim().trim_matches('"');
        if trimmed.is_empty() {
            return None;
        }

        let mut path = PathBuf::from(trimmed.replace('/', "\\"));
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steam.exe"))
        {
            path.pop();
        }

        if Self::is_valid_steam_root(&path) {
            Some(path)
        } else {
            None
        }
    }
}

impl Default for SteamService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::SteamService;
    use anyhow::Result;
    use tempfile::TempDir;
    use tokio::fs;

    #[test]
    fn parse_library_folder_paths_supports_legacy_and_modern_formats() {
        let content = r#"
"libraryfolders"
{
    "0"    "C:\\Program Files (x86)\\Steam"
    "1"
    {
        "path"    "D:\\SteamLibrary"
        "label"   ""
        "apps"
        {
            "3164500"    "1234567890"
        }
    }
}
"#;

        let folders = SteamService::parse_library_folder_paths(content);
        let folder_strings: Vec<String> = folders
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();

        assert_eq!(
            folder_strings,
            vec![
                "C:\\Program Files (x86)\\Steam".to_string(),
                "D:\\SteamLibrary".to_string()
            ]
        );
    }

    #[test]
    fn find_vdf_key_value_reads_manifest_fields() {
        let manifest = r#"
"AppState"
{
    "appid"        "3164500"
    "Universe"     "1"
    "installdir"   "Schedule I"
    "UserConfig"
    {
        "betakey"  "beta"
    }
}
"#;

        assert_eq!(
            SteamService::find_vdf_key_value(manifest, "installdir"),
            Some("Schedule I".to_string())
        );
        assert_eq!(
            SteamService::find_vdf_key_value(manifest, "betakey"),
            Some("beta".to_string())
        );
    }

    #[tokio::test]
    async fn detect_steam_installations_uses_manifest_installdir_in_secondary_library() -> Result<()>
    {
        let steam_root = TempDir::new()?;
        let secondary_library = TempDir::new()?;

        fs::create_dir_all(steam_root.path().join("steamapps")).await?;
        fs::create_dir_all(secondary_library.path().join("steamapps")).await?;

        let encoded_secondary_path = secondary_library
            .path()
            .to_string_lossy()
            .replace('\\', "\\\\");
        let library_folders = format!(
            "\"libraryfolders\"\n{{\n    \"1\"\n    {{\n        \"path\"    \"{}\"\n    }}\n}}\n",
            encoded_secondary_path
        );
        fs::write(
            steam_root
                .path()
                .join("steamapps")
                .join("libraryfolders.vdf"),
            library_folders,
        )
        .await?;

        fs::write(
            secondary_library
                .path()
                .join("steamapps")
                .join("appmanifest_3164500.acf"),
            "\"AppState\"\n{\n    \"installdir\" \"Custom Schedule I\"\n}\n",
        )
        .await?;

        let game_path = secondary_library
            .path()
            .join("steamapps")
            .join("common")
            .join("Custom Schedule I");
        fs::create_dir_all(&game_path).await?;
        fs::write(game_path.join("Schedule I.exe"), b"").await?;

        let service = SteamService::new();
        let installations = service
            .detect_steam_installations_from_root(steam_root.path())
            .await?;

        assert_eq!(installations.len(), 1);
        assert_eq!(
            installations[0].path,
            game_path.to_string_lossy().to_string()
        );
        assert_eq!(
            installations[0].executable_path,
            game_path
                .join("Schedule I.exe")
                .to_string_lossy()
                .to_string()
        );

        Ok(())
    }
}
