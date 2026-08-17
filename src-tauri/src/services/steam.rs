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
    pub steamapps_dir: Option<String>,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLaunchOptionsStatus {
    pub configured: bool,
    pub repairable: bool,
    pub required: String,
    pub current: Option<String>,
    pub config_path: Option<String>,
}

impl SteamService {
    pub fn new() -> Self {
        Self
    }

    /// Get Schedule I AppID
    pub fn get_steam_app_id() -> String {
        "3164500".to_string()
    }

    pub fn required_melonloader_launch_options() -> &'static str {
        crate::services::melon_loader::MelonLoaderService::linux_melonloader_launch_options()
    }

    fn required_winedlloverrides_assignment() -> &'static str {
        "WINEDLLOVERRIDES=\"version=n,b\""
    }

    fn required_winedlloverrides_entry() -> &'static str {
        "version=n,b"
    }

    fn launch_options_contain_command(options: &str) -> bool {
        options
            .split_whitespace()
            .any(|part| part.trim_matches(|ch| ch == '"' || ch == '\'') == "%command%")
    }

    fn launch_options_have_required_winedlloverride(options: &str) -> bool {
        let Some(value) = Self::extract_winedlloverrides_value(options) else {
            return false;
        };

        value.split(';').any(|entry| {
            entry
                .trim()
                .eq_ignore_ascii_case(Self::required_winedlloverrides_entry())
        })
    }

    fn schedule_i_launch_options_configured(options: &str) -> bool {
        Self::launch_options_have_required_winedlloverride(options)
            && Self::launch_options_contain_command(options)
    }

    fn merge_schedule_i_launch_options(current: Option<&str>) -> String {
        let Some(current) = current.map(str::trim).filter(|value| !value.is_empty()) else {
            return Self::required_melonloader_launch_options().to_string();
        };

        let mut merged = if Self::launch_options_have_required_winedlloverride(current) {
            current.to_string()
        } else if let Some(updated) = Self::add_required_winedlloverride_to_existing(current) {
            updated
        } else {
            format!(
                "{} {}",
                Self::required_winedlloverrides_assignment(),
                current
            )
        };

        if !Self::launch_options_contain_command(&merged) {
            merged.push_str(" %command%");
        }

        merged
    }

    fn extract_winedlloverrides_value(options: &str) -> Option<String> {
        let (_, value_start, value_end, _) = Self::find_winedlloverrides_assignment(options)?;
        Some(options[value_start..value_end].to_string())
    }

    fn add_required_winedlloverride_to_existing(options: &str) -> Option<String> {
        let (assignment_start, value_start, value_end, quote) =
            Self::find_winedlloverrides_assignment(options)?;
        let existing = &options[value_start..value_end];
        let mut new_value = existing.trim().to_string();
        if !new_value.is_empty() && !new_value.ends_with(';') {
            new_value.push(';');
        }
        new_value.push_str(Self::required_winedlloverrides_entry());

        let mut merged = String::with_capacity(options.len() + new_value.len());
        merged.push_str(&options[..value_start]);
        merged.push_str(&new_value);
        merged.push_str(&options[value_end..]);

        if quote.is_none() && new_value.contains(char::is_whitespace) {
            return Some(format!(
                "{}{}=\"{}\"{}",
                &options[..assignment_start],
                "WINEDLLOVERRIDES",
                new_value,
                &options[value_end..]
            ));
        }

        Some(merged)
    }

    fn find_winedlloverrides_assignment(
        options: &str,
    ) -> Option<(usize, usize, usize, Option<char>)> {
        let key = "WINEDLLOVERRIDES=";
        let start = options
            .to_ascii_lowercase()
            .find(&key.to_ascii_lowercase())?;
        let mut value_start = start + key.len();
        let first = options[value_start..].chars().next()?;

        if first == '"' || first == '\'' {
            let quote = first;
            value_start += first.len_utf8();
            let mut value_end = options.len();
            for (offset, ch) in options[value_start..].char_indices() {
                if ch == quote {
                    value_end = value_start + offset;
                    break;
                }
            }
            return Some((start, value_start, value_end, Some(quote)));
        }

        let mut value_end = options.len();
        for (offset, ch) in options[value_start..].char_indices() {
            if ch.is_whitespace() {
                value_end = value_start + offset;
                break;
            }
        }

        Some((start, value_start, value_end, None))
    }

    pub fn get_schedule_i_launch_options_status(&self) -> Result<SteamLaunchOptionsStatus> {
        let required = Self::required_melonloader_launch_options().to_string();
        let config_path = match Self::steam_local_config_path() {
            Ok(path) => path,
            Err(_) => {
                return Ok(SteamLaunchOptionsStatus {
                    configured: false,
                    repairable: false,
                    required,
                    current: None,
                    config_path: None,
                });
            }
        };

        let current = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .with_context(|| format!("Failed to read {}", config_path.display()))?;
            let entries = parse_text_vdf(&content)
                .with_context(|| format!("Failed to parse {}", config_path.display()))?;
            text_vdf_get_string(
                &entries,
                &[
                    "UserLocalConfigStore",
                    "Software",
                    "Valve",
                    "Steam",
                    "apps",
                    &Self::get_steam_app_id(),
                ],
                "LaunchOptions",
            )
            .map(ToOwned::to_owned)
        } else {
            None
        };

        Ok(SteamLaunchOptionsStatus {
            configured: current
                .as_deref()
                .is_some_and(Self::schedule_i_launch_options_configured),
            repairable: true,
            required,
            current,
            config_path: Some(config_path.to_string_lossy().to_string()),
        })
    }

    pub fn ensure_schedule_i_launch_options(&self) -> Result<SteamLaunchOptionsStatus> {
        let config_path = Self::steam_local_config_path()?;
        let mut entries = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .with_context(|| format!("Failed to read {}", config_path.display()))?;
            parse_text_vdf(&content)
                .with_context(|| format!("Failed to parse {}", config_path.display()))?
        } else {
            Vec::new()
        };
        let current = text_vdf_get_string(
            &entries,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "apps",
                &Self::get_steam_app_id(),
            ],
            "LaunchOptions",
        )
        .map(ToOwned::to_owned);
        let merged = Self::merge_schedule_i_launch_options(current.as_deref());

        text_vdf_set_string(
            &mut entries,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "apps",
                &Self::get_steam_app_id(),
            ],
            "LaunchOptions",
            &merged,
        );

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        std::fs::write(&config_path, write_text_vdf(&entries))
            .with_context(|| format!("Failed to write {}", config_path.display()))?;

        self.get_schedule_i_launch_options_status()
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
            for env_name in ["STEAM_DIR", "STEAM_PATH"] {
                if let Ok(steam_path) = std::env::var(env_name) {
                    if let Some(path) = Self::steam_root_from_candidate(&steam_path) {
                        return Some(path);
                    }
                }
            }

            let home = dirs::home_dir()?;
            let common_paths = [
                home.join(".steam").join("steam"),
                home.join(".local").join("share").join("Steam"),
                home.join(".var")
                    .join("app")
                    .join("com.valvesoftware.Steam")
                    .join(".local")
                    .join("share")
                    .join("Steam"),
            ];

            for steam_path in common_paths {
                if Self::is_valid_steam_root(&steam_path) {
                    return Some(steam_path);
                }
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

                if let Some(installation) = Self::build_steam_installation(
                    &game_path,
                    Some(&steamapps_dir),
                    Some(&manifest_path),
                ) {
                    return Ok(Some(installation));
                }
            }
        }

        let fallback_game_path = steamapps_dir.join("common").join("Schedule I");
        Ok(Self::build_steam_installation(
            &fallback_game_path,
            Some(&steamapps_dir),
            Some(&manifest_path),
        ))
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
    async fn detect_installed_branch_with_context(
        &self,
        game_path: &Path,
        steamapps_dir: Option<&Path>,
        manifest_path: Option<&Path>,
    ) -> Result<Option<String>> {
        let discovered_steamapps_dir = if manifest_path.is_none() && steamapps_dir.is_none() {
            Self::find_steamapps_dir(game_path)
        } else {
            None
        };
        let resolved_manifest_path = if let Some(manifest_path) = manifest_path {
            manifest_path.to_path_buf()
        } else {
            let Some(steamapps_dir) = steamapps_dir.or(discovered_steamapps_dir.as_deref()) else {
                return Ok(None);
            };
            steamapps_dir.join(format!("appmanifest_{}.acf", Self::get_steam_app_id()))
        };

        let manifest_path = resolved_manifest_path;
        if !manifest_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&manifest_path)
            .await
            .with_context(|| format!("Failed to read appmanifest: {}", manifest_path.display()))?;

        if let Some(key) = Self::find_vdf_key_value(&content, "betakey") {
            let key = key.trim().to_ascii_lowercase();
            return if key.is_empty() || key == "public" {
                Ok(Some("main".to_string()))
            } else {
                Ok(Some(key))
            };
        }

        Ok(Some("main".to_string()))
    }

    pub async fn detect_installed_branch(&self, game_path: &Path) -> Result<Option<String>> {
        self.detect_installed_branch_with_context(game_path, None, None)
            .await
    }

    pub async fn detect_installed_branch_for_installation(
        &self,
        installation: &SteamInstallation,
    ) -> Result<Option<String>> {
        let steamapps_dir = installation.steamapps_dir.as_deref().map(Path::new);
        let manifest_path = installation.manifest_path.as_deref().map(Path::new);
        self.detect_installed_branch_with_context(
            Path::new(&installation.path),
            steamapps_dir,
            manifest_path,
        )
        .await
    }

    pub async fn winetricks_log_paths_for_app(
        &self,
        app_id: &str,
        game_path: Option<&Path>,
    ) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();

        if let Some(game_path) = game_path {
            if let Some(steamapps_dir) = Self::find_steamapps_dir(game_path) {
                Self::push_unique_path(
                    &mut paths,
                    Self::winetricks_log_path_for_steamapps(&steamapps_dir, app_id),
                );
            }
        }

        if let Some(steam_path) = Self::get_steam_path() {
            for library_path in self.get_library_folders(&steam_path).await? {
                Self::push_unique_path(
                    &mut paths,
                    Self::winetricks_log_path_for_steamapps(
                        &library_path.join("steamapps"),
                        app_id,
                    ),
                );
            }
        }

        Ok(paths)
    }

    fn winetricks_log_path_for_steamapps(steamapps_dir: &Path, app_id: &str) -> PathBuf {
        steamapps_dir
            .join("compatdata")
            .join(app_id)
            .join("pfx")
            .join("winetricks.log")
    }

    fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
        if !paths
            .iter()
            .any(|existing| Self::path_key(existing) == Self::path_key(&path))
        {
            paths.push(path);
        }
    }

    fn build_steam_installation(
        game_path: &Path,
        steamapps_dir: Option<&Path>,
        manifest_path: Option<&Path>,
    ) -> Option<SteamInstallation> {
        let executable_path = game_path.join("Schedule I.exe");
        if !executable_path.exists() {
            return None;
        }

        Some(SteamInstallation {
            path: game_path.to_string_lossy().to_string(),
            executable_path: executable_path.to_string_lossy().to_string(),
            app_id: Self::get_steam_app_id(),
            steamapps_dir: steamapps_dir.map(|path| path.to_string_lossy().to_string()),
            manifest_path: manifest_path.map(|path| path.to_string_lossy().to_string()),
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

    fn steam_local_config_path() -> Result<PathBuf> {
        let steam_path = Self::get_steam_path().ok_or_else(|| {
            anyhow::anyhow!("Steam installation not found; cannot locate localconfig.vdf")
        })?;
        let userdata_dir = steam_path.join("userdata");
        let account_id = Self::most_recent_steam_account_id(&steam_path)
            .or_else(|| Self::first_steam_userdata_account_id(&userdata_dir))
            .ok_or_else(|| anyhow::anyhow!("No Steam userdata account found"))?;

        Ok(userdata_dir
            .join(account_id)
            .join("config")
            .join("localconfig.vdf"))
    }

    fn most_recent_steam_account_id(steam_path: &Path) -> Option<String> {
        let login_users =
            std::fs::read_to_string(steam_path.join("config").join("loginusers.vdf")).ok()?;
        let mut current_user: Option<String> = None;

        for line in login_users.lines() {
            let values = Self::extract_quoted_values(line);
            if values.len() == 1 && values[0].chars().all(|ch| ch.is_ascii_digit()) {
                current_user = steam_account_id_from_steam_id64(&values[0]);
            } else if values.len() >= 2
                && values[0].eq_ignore_ascii_case("MostRecent")
                && values[1] == "1"
            {
                return current_user;
            }
        }

        None
    }

    fn first_steam_userdata_account_id(userdata_dir: &Path) -> Option<String> {
        let mut candidates: Vec<PathBuf> = std::fs::read_dir(userdata_dir)
            .ok()?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.is_dir()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.chars().all(|ch| ch.is_ascii_digit()))
            })
            .collect();

        candidates.sort_by(|left, right| {
            let left_modified = left
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            let right_modified = right
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            right_modified.cmp(&left_modified)
        });

        candidates
            .first()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(ToOwned::to_owned)
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

        #[cfg(target_os = "windows")]
        let mut path = PathBuf::from(trimmed.replace('/', "\\"));
        #[cfg(not(target_os = "windows"))]
        let mut path = PathBuf::from(trimmed);

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

#[derive(Clone, Debug, PartialEq, Eq)]
enum TextVdfValue {
    Object(Vec<(String, TextVdfValue)>),
    String(String),
}

fn parse_text_vdf(content: &str) -> Result<Vec<(String, TextVdfValue)>> {
    TextVdfParser::new(content).parse_entries_until(None)
}

fn write_text_vdf(entries: &[(String, TextVdfValue)]) -> String {
    let mut output = String::new();
    write_text_vdf_entries(entries, 0, &mut output);
    output
}

fn text_vdf_get_string<'a>(
    entries: &'a [(String, TextVdfValue)],
    path: &[&str],
    key: &str,
) -> Option<&'a str> {
    let mut current = entries;
    for segment in path {
        let value = current.iter().find_map(|(entry_key, value)| {
            entry_key.eq_ignore_ascii_case(segment).then_some(value)
        })?;
        let TextVdfValue::Object(children) = value else {
            return None;
        };
        current = children;
    }

    current.iter().find_map(|(entry_key, value)| {
        if entry_key.eq_ignore_ascii_case(key) {
            if let TextVdfValue::String(value) = value {
                return Some(value.as_str());
            }
        }
        None
    })
}

fn text_vdf_set_string(
    entries: &mut Vec<(String, TextVdfValue)>,
    path: &[&str],
    key: &str,
    value: &str,
) {
    let parent = ensure_text_vdf_object_path(entries, path);
    if let Some((_, existing)) = parent
        .iter_mut()
        .find(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
    {
        *existing = TextVdfValue::String(value.to_string());
        return;
    }

    parent.push((key.to_string(), TextVdfValue::String(value.to_string())));
}

fn ensure_text_vdf_object_path<'a>(
    entries: &'a mut Vec<(String, TextVdfValue)>,
    path: &[&str],
) -> &'a mut Vec<(String, TextVdfValue)> {
    if path.is_empty() {
        return entries;
    }

    let key = path[0];
    let index = if let Some(index) = entries
        .iter()
        .position(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
    {
        if !matches!(entries[index].1, TextVdfValue::Object(_)) {
            entries[index].1 = TextVdfValue::Object(Vec::new());
        }
        index
    } else {
        entries.push((key.to_string(), TextVdfValue::Object(Vec::new())));
        entries.len() - 1
    };

    let TextVdfValue::Object(children) = &mut entries[index].1 else {
        unreachable!();
    };
    ensure_text_vdf_object_path(children, &path[1..])
}

fn write_text_vdf_entries(entries: &[(String, TextVdfValue)], indent: usize, output: &mut String) {
    let prefix = "\t".repeat(indent);
    for (key, value) in entries {
        output.push_str(&prefix);
        output.push('"');
        output.push_str(&escape_text_vdf_string(key));
        output.push('"');

        match value {
            TextVdfValue::String(value) => {
                output.push_str("\t\t\"");
                output.push_str(&escape_text_vdf_string(value));
                output.push_str("\"\n");
            }
            TextVdfValue::Object(children) => {
                output.push('\n');
                output.push_str(&prefix);
                output.push_str("{\n");
                write_text_vdf_entries(children, indent + 1, output);
                output.push_str(&prefix);
                output.push_str("}\n");
            }
        }
    }
}

fn escape_text_vdf_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn steam_account_id_from_steam_id64(steam_id64: &str) -> Option<String> {
    let id = steam_id64.parse::<u64>().ok()?;
    let account_id = id.checked_sub(76_561_197_960_265_728)?;
    Some(account_id.to_string())
}

struct TextVdfParser<'a> {
    chars: Vec<char>,
    cursor: usize,
    _source: std::marker::PhantomData<&'a str>,
}

impl<'a> TextVdfParser<'a> {
    fn new(content: &'a str) -> Self {
        Self {
            chars: content.chars().collect(),
            cursor: 0,
            _source: std::marker::PhantomData,
        }
    }

    fn parse_entries_until(
        &mut self,
        terminator: Option<char>,
    ) -> Result<Vec<(String, TextVdfValue)>> {
        let mut entries = Vec::new();

        loop {
            self.skip_whitespace();
            if self.is_eof() {
                if terminator.is_some() {
                    return Err(anyhow::anyhow!("Unexpected end of VDF object"));
                }
                return Ok(entries);
            }

            if let Some(terminator) = terminator {
                if self.peek() == Some(terminator) {
                    self.cursor += 1;
                    return Ok(entries);
                }
            }

            let key = self.parse_quoted_string()?;
            self.skip_whitespace();
            let value = if self.peek() == Some('{') {
                self.cursor += 1;
                TextVdfValue::Object(self.parse_entries_until(Some('}'))?)
            } else {
                TextVdfValue::String(self.parse_quoted_string()?)
            };
            entries.push((key, value));
        }
    }

    fn parse_quoted_string(&mut self) -> Result<String> {
        self.skip_whitespace();
        if self.peek() != Some('"') {
            return Err(anyhow::anyhow!("Expected quoted VDF string"));
        }
        self.cursor += 1;

        let mut value = String::new();
        while let Some(ch) = self.peek() {
            self.cursor += 1;
            match ch {
                '"' => return Ok(value),
                '\\' => {
                    if let Some(next) = self.peek() {
                        self.cursor += 1;
                        value.push(next);
                    } else {
                        value.push('\\');
                    }
                }
                _ => value.push(ch),
            }
        }

        Err(anyhow::anyhow!("Unterminated quoted VDF string"))
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.cursor += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.cursor).copied()
    }

    fn is_eof(&self) -> bool {
        self.cursor >= self.chars.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_text_vdf, text_vdf_get_string, text_vdf_set_string, write_text_vdf,
        SteamInstallation, SteamService,
    };
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
    async fn detect_installed_branch_canonicalizes_explicit_public_key_to_main() -> Result<()> {
        let temp = TempDir::new()?;
        let steamapps = temp.path().join("steamapps");
        let game_dir = steamapps.join("common").join("Schedule I");
        fs::create_dir_all(&game_dir).await?;
        let manifest_path = steamapps.join("appmanifest_3164500.acf");
        fs::write(
            &manifest_path,
            "\"AppState\"\n{\n  \"UserConfig\"\n  {\n    \"BetaKey\" \"public\"\n  }\n}\n",
        )
        .await?;
        let installation = SteamInstallation {
            path: game_dir.to_string_lossy().to_string(),
            executable_path: game_dir
                .join("Schedule I.exe")
                .to_string_lossy()
                .to_string(),
            app_id: SteamService::get_steam_app_id(),
            steamapps_dir: Some(steamapps.to_string_lossy().to_string()),
            manifest_path: Some(manifest_path.to_string_lossy().to_string()),
        };

        assert_eq!(
            SteamService::new()
                .detect_installed_branch_for_installation(&installation)
                .await?,
            Some("main".to_string())
        );
        Ok(())
    }

    #[test]
    fn text_vdf_set_string_inserts_schedule_launch_options_without_losing_other_apps() {
        let content = r#"
"UserLocalConfigStore"
{
    "Software"
    {
        "Valve"
        {
            "Steam"
            {
                "apps"
                {
                    "123"
                    {
                        "LaunchOptions" "OTHER=1 %command%"
                    }
                }
            }
        }
    }
}
"#;

        let mut entries = parse_text_vdf(content).expect("parse localconfig");
        text_vdf_set_string(
            &mut entries,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "apps",
                "3164500",
            ],
            "LaunchOptions",
            SteamService::required_melonloader_launch_options(),
        );
        let rendered = write_text_vdf(&entries);
        let reparsed = parse_text_vdf(&rendered).expect("parse rendered localconfig");

        assert_eq!(
            text_vdf_get_string(
                &reparsed,
                &[
                    "UserLocalConfigStore",
                    "Software",
                    "Valve",
                    "Steam",
                    "apps",
                    "123"
                ],
                "LaunchOptions"
            ),
            Some("OTHER=1 %command%")
        );
        assert_eq!(
            text_vdf_get_string(
                &reparsed,
                &[
                    "UserLocalConfigStore",
                    "Software",
                    "Valve",
                    "Steam",
                    "apps",
                    "3164500"
                ],
                "LaunchOptions"
            ),
            Some("WINEDLLOVERRIDES=\"version=n,b\" %command%")
        );
    }

    #[test]
    fn text_vdf_set_string_repairs_existing_schedule_launch_options() {
        let mut entries = parse_text_vdf(
            "\"UserLocalConfigStore\"{\"Software\"{\"Valve\"{\"Steam\"{\"apps\"{\"3164500\"{\"LaunchOptions\" \"old\"}}}}}}",
        )
        .expect("parse localconfig");

        text_vdf_set_string(
            &mut entries,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "apps",
                "3164500",
            ],
            "LaunchOptions",
            SteamService::required_melonloader_launch_options(),
        );

        assert_eq!(
            text_vdf_get_string(
                &entries,
                &[
                    "UserLocalConfigStore",
                    "Software",
                    "Valve",
                    "Steam",
                    "apps",
                    "3164500"
                ],
                "LaunchOptions"
            ),
            Some("WINEDLLOVERRIDES=\"version=n,b\" %command%")
        );
    }

    #[test]
    fn merge_schedule_launch_options_preserves_existing_arguments() {
        assert_eq!(
            SteamService::merge_schedule_i_launch_options(Some("PROTON_LOG=1 %command%")),
            "WINEDLLOVERRIDES=\"version=n,b\" PROTON_LOG=1 %command%"
        );
    }

    #[test]
    fn merge_schedule_launch_options_extends_existing_winedlloverrides() {
        assert_eq!(
            SteamService::merge_schedule_i_launch_options(Some(
                "WINEDLLOVERRIDES=\"winhttp=n,b\" PROTON_LOG=1 %command%"
            )),
            "WINEDLLOVERRIDES=\"winhttp=n,b;version=n,b\" PROTON_LOG=1 %command%"
        );
    }

    #[test]
    fn merge_schedule_launch_options_keeps_configured_options_unchanged() {
        let configured = "WINEDLLOVERRIDES=\"winhttp=n,b;version=n,b\" gamemoderun %command%";

        assert_eq!(
            SteamService::merge_schedule_i_launch_options(Some(configured)),
            configured
        );
        assert!(SteamService::schedule_i_launch_options_configured(
            configured
        ));
    }

    #[test]
    fn merge_schedule_launch_options_accepts_quoted_command_placeholder() {
        let configured = "WINEDLLOVERRIDES=\"version=n,b\" gamemoderun \"%command%\"";

        assert_eq!(
            SteamService::merge_schedule_i_launch_options(Some(configured)),
            configured
        );
        assert!(SteamService::schedule_i_launch_options_configured(
            configured
        ));
    }

    #[test]
    fn merge_schedule_launch_options_adds_missing_command_placeholder() {
        assert_eq!(
            SteamService::merge_schedule_i_launch_options(Some("PROTON_LOG=1")),
            "WINEDLLOVERRIDES=\"version=n,b\" PROTON_LOG=1 %command%"
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
        assert_eq!(
            installations[0].steamapps_dir.as_deref(),
            Some(
                secondary_library
                    .path()
                    .join("steamapps")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            installations[0].manifest_path.as_deref(),
            Some(
                secondary_library
                    .path()
                    .join("steamapps")
                    .join("appmanifest_3164500.acf")
                    .to_string_lossy()
                    .as_ref()
            )
        );

        Ok(())
    }

    #[tokio::test]
    async fn detect_installed_branch_uses_manifest_context_for_absolute_installdir() -> Result<()> {
        let steam_root = TempDir::new()?;
        let secondary_library = TempDir::new()?;
        let external_install = TempDir::new()?;

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

        let game_path = external_install.path().join("Custom Schedule I");
        fs::create_dir_all(&game_path).await?;
        fs::write(game_path.join("Schedule I.exe"), b"").await?;

        let encoded_game_path = game_path.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            secondary_library
                .path()
                .join("steamapps")
                .join("appmanifest_3164500.acf"),
            format!(
                "\"AppState\"\n{{\n    \"installdir\" \"{}\"\n    \"UserConfig\"\n    {{\n        \"betakey\" \"beta\"\n    }}\n}}\n",
                encoded_game_path
            ),
        )
        .await?;

        let service = SteamService::new();
        let installations = service
            .detect_steam_installations_from_root(steam_root.path())
            .await?;

        assert_eq!(installations.len(), 1);
        let branch = service
            .detect_installed_branch_for_installation(&installations[0])
            .await?;
        assert_eq!(branch.as_deref(), Some("beta"));

        Ok(())
    }

    #[tokio::test]
    #[ignore = "Requires a live Steam installation with Schedule I installed"]
    async fn live_detects_schedule_i_installation_branch_and_launch_options_status() -> Result<()> {
        let steam_path = SteamService::get_steam_path()
            .ok_or_else(|| anyhow::anyhow!("Steam installation not found"))?;
        assert!(
            steam_path.exists(),
            "Steam root should exist: {}",
            steam_path.display()
        );

        let service = SteamService::new();
        let installations = service.detect_steam_installations().await?;
        assert!(
            !installations.is_empty(),
            "Expected at least one live Schedule I Steam installation"
        );

        let installation = installations
            .iter()
            .find(|installation| installation.app_id == SteamService::get_steam_app_id())
            .ok_or_else(|| anyhow::anyhow!("Schedule I Steam installation was not detected"))?;

        assert!(std::path::Path::new(&installation.path).exists());
        assert!(std::path::Path::new(&installation.executable_path).exists());
        assert!(
            installation
                .manifest_path
                .as_deref()
                .is_some_and(|path| std::path::Path::new(path).exists()),
            "Detected installation should include an existing appmanifest path"
        );

        let branch = service
            .detect_installed_branch_for_installation(installation)
            .await?;
        assert!(
            branch.as_deref().is_some_and(|value| !value.is_empty()),
            "Expected branch detection to resolve main or a beta key"
        );

        let launch_options = service.get_schedule_i_launch_options_status()?;
        assert_eq!(
            launch_options.required,
            SteamService::required_melonloader_launch_options()
        );
        assert!(launch_options.repairable);
        assert!(
            launch_options
                .config_path
                .as_deref()
                .is_some_and(|path| path.ends_with("localconfig.vdf")),
            "Expected launch option status to identify Steam localconfig.vdf"
        );

        Ok(())
    }
}
