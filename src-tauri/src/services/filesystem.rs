use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

const STEAM_SHORTCUT_TAG: &str = "SIMM";
const STEAM_SHORTCUT_MANAGED_KEYS: &[&str] = &[
    "appid",
    "appname",
    "exe",
    "StartDir",
    "icon",
    "ShortcutPath",
    "LaunchOptions",
    "IsHidden",
    "AllowDesktopConfig",
    "AllowOverlay",
    "OpenVR",
    "Devkit",
    "DevkitGameID",
    "FlatpakAppID",
    "tags",
];

#[derive(Clone, Debug, PartialEq)]
enum BinaryVdfValue {
    Object(Vec<(String, BinaryVdfValue)>),
    String(String),
    Int32(i32),
    UInt64(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SteamShortcutRegistration {
    shortcut_url: String,
    shortcut_app_id: u32,
    shortcuts_file: PathBuf,
    status: SteamShortcutStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SteamShortcutStatus {
    Inserted,
    Updated,
    Unchanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SteamLaunchCommand {
    program: PathBuf,
    prefix_args: Vec<String>,
}

impl SteamLaunchCommand {
    fn new(program: impl Into<PathBuf>, prefix_args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            prefix_args,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.prefix_args);
        command
    }

    fn display(&self) -> String {
        let mut parts = vec![self.program.to_string_lossy().to_string()];
        parts.extend(self.prefix_args.iter().cloned());
        parts.join(" ")
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamShortcutSetup {
    pub shortcut_url: String,
    pub shortcut_app_id: u32,
    pub shortcuts_file: String,
    pub status: String,
    pub requires_client_reload: bool,
}

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
            "steam_restart" => {
                let dir = game_dir.ok_or_else(|| {
                    let message = "Game directory is required for Steam restart launch";
                    warn_with_location(message);
                    anyhow::anyhow!(message)
                })?;
                self.launch_custom_install_via_steam_shortcut_after_restart(dir)
                    .await
            }
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

        if let Some(dir) = game_dir {
            return self
                .launch_custom_install_via_steam_shortcut(&app_id, dir)
                .await;
        }

        // Try Steam protocol first
        if let Err(error) = self.launch_via_steam_protocol(&app_id).await {
            warn_with_location(format!(
                "Steam protocol launch failed for app {}. Falling back to Steam executable: {}",
                app_id, error
            ));
            // Fallback to Steam executable method
            self.launch_via_steam_executable(&app_id, None).await?;
        }

        Ok(format!("steam://run/{}", app_id))
    }

    async fn launch_custom_install_via_steam_shortcut(
        &self,
        app_id: &str,
        game_dir: &str,
    ) -> Result<String> {
        let registration = self
            .prepare_steam_shortcut_registration(app_id, game_dir)
            .await?;

        if registration.status != SteamShortcutStatus::Unchanged {
            warn_with_location(format!(
                "Registered Steam shortcut for {} at {}",
                crate::services::logger::LoggerService::sanitize_log_text(game_dir),
                crate::services::logger::LoggerService::sanitize_log_text(
                    &registration.shortcuts_file.to_string_lossy()
                )
            ));
        }

        if Self::steam_shortcut_requires_client_reload(registration.shortcut_app_id)? {
            let message = Self::steam_shortcut_reload_message(game_dir);
            warn_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        if let Err(error) = self.launch_via_steam_url(&registration.shortcut_url).await {
            warn_with_location(format!(
                "Steam shortcut protocol launch failed for {}. Falling back to Steam executable URL launch: {}",
                crate::services::logger::LoggerService::sanitize_log_text(game_dir),
                error
            ));
            self.launch_via_steam_executable_url(&registration.shortcut_url)
                .await?;
        }

        Ok(format!(
            "{} ({})",
            registration.shortcut_url,
            crate::services::logger::LoggerService::sanitize_log_text(
                &registration.shortcuts_file.to_string_lossy()
            )
        ))
    }

    async fn launch_custom_install_via_steam_shortcut_after_restart(
        &self,
        game_dir: &str,
    ) -> Result<String> {
        let app_id = crate::services::steam::SteamService::get_steam_app_id();
        let registration = self
            .prepare_steam_shortcut_registration(&app_id, game_dir)
            .await?;

        warn_with_location(format!(
            "Restarting Steam before launching custom install {} through shortcut",
            crate::services::logger::LoggerService::sanitize_log_text(game_dir)
        ));
        self.restart_steam_client().await?;
        Self::clear_steam_shortcut_reload_marker(registration.shortcut_app_id)?;

        if let Err(error) = self.launch_via_steam_url(&registration.shortcut_url).await {
            warn_with_location(format!(
                "Steam shortcut protocol launch failed after Steam restart for {}. Falling back to Steam executable URL launch: {}",
                crate::services::logger::LoggerService::sanitize_log_text(game_dir),
                error
            ));
            self.launch_via_steam_executable_url(&registration.shortcut_url)
                .await?;
        }

        Ok(format!(
            "{} ({})",
            registration.shortcut_url,
            crate::services::logger::LoggerService::sanitize_log_text(
                &registration.shortcuts_file.to_string_lossy()
            )
        ))
    }

    async fn prepare_steam_shortcut_registration(
        &self,
        app_id: &str,
        game_dir: &str,
    ) -> Result<SteamShortcutRegistration> {
        let executable_path = self.resolve_game_executable(game_dir)?;
        self.ensure_steam_appid_file(game_dir, app_id).await?;

        let shortcut_name = Self::steam_shortcut_name_for_dir(game_dir);
        let shortcut = SteamShortcut::new(
            shortcut_name,
            executable_path,
            PathBuf::from(game_dir),
            Self::steam_shortcut_launch_options(),
        );
        let shortcut_app_id = shortcut.app_id();
        let shortcut_url = format!(
            "steam://rungameid/{}",
            Self::steam_shortcut_long_id(shortcut_app_id)
        );

        let (shortcuts_file, status) = self.upsert_steam_shortcut(&shortcut)?;
        Self::sync_steam_shortcut_reload_marker(shortcut_app_id, status)?;

        Ok(SteamShortcutRegistration {
            shortcut_url,
            shortcut_app_id,
            shortcuts_file,
            status,
        })
    }

    pub async fn ensure_schedule_i_steam_shortcut(
        &self,
        game_dir: &str,
    ) -> Result<SteamShortcutSetup> {
        let app_id = crate::services::steam::SteamService::get_steam_app_id();
        let registration = self
            .prepare_steam_shortcut_registration(&app_id, game_dir)
            .await?;

        Ok(SteamShortcutSetup {
            shortcut_url: registration.shortcut_url,
            shortcut_app_id: registration.shortcut_app_id,
            shortcuts_file: registration.shortcuts_file.to_string_lossy().to_string(),
            status: match registration.status {
                SteamShortcutStatus::Inserted => "inserted",
                SteamShortcutStatus::Updated => "updated",
                SteamShortcutStatus::Unchanged => "unchanged",
            }
            .to_string(),
            requires_client_reload: Self::steam_shortcut_requires_client_reload(
                registration.shortcut_app_id,
            )?,
        })
    }

    pub(crate) fn schedule_i_shortcut_app_id_for_dir(&self, game_dir: &str) -> Result<u32> {
        let executable_path = self.resolve_game_executable(game_dir)?;
        let shortcut = SteamShortcut::new(
            Self::steam_shortcut_name_for_dir(game_dir),
            executable_path,
            PathBuf::from(game_dir),
            Self::steam_shortcut_launch_options(),
        );
        Ok(shortcut.app_id())
    }

    async fn launch_via_steam_protocol(&self, app_id: &str) -> Result<()> {
        let url = format!("steam://run/{}", app_id);
        self.launch_via_steam_url(&url).await
    }

    async fn launch_via_steam_url(&self, url: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use winapi::um::shellapi::ShellExecuteW;
            use winapi::um::winuser::SW_SHOW;

            let url_wide: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
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
                .arg(url)
                .spawn()
                .context("Failed to launch Steam protocol")?;
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(url)
                .spawn()
                .context("Failed to launch Steam protocol")?;
        }

        Ok(())
    }

    async fn launch_via_steam_executable_url(&self, url: &str) -> Result<()> {
        let steam_command = Self::steam_launch_command()?;

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut command = steam_command.command();
            command.arg(url).creation_flags(0x08000000);
            command
                .spawn()
                .context("Failed to launch Steam shortcut URL")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam command {} for shortcut URL: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
                        ),
                        error
                    ));
                    error
                })?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut command = steam_command.command();
            command
                .arg(url)
                .spawn()
                .context("Failed to launch Steam shortcut URL")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam command {} for shortcut URL: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
                        ),
                        error
                    ));
                    error
                })?;
        }

        Ok(())
    }

    fn resolve_game_executable(&self, game_dir: &str) -> Result<PathBuf> {
        let executable_path = Path::new(game_dir).join(Self::schedule_i_executable_name());
        if executable_path.exists() {
            return Ok(executable_path);
        }

        let message = format!(
            "Game executable not found at {}",
            crate::services::logger::LoggerService::sanitize_log_text(
                &executable_path.to_string_lossy()
            )
        );
        error_with_location(&message);
        Err(anyhow::anyhow!(message))
    }

    async fn ensure_steam_appid_file(&self, game_dir: &str, app_id: &str) -> Result<()> {
        let appid_path = Path::new(game_dir).join("steam_appid.txt");
        match tokio::fs::read_to_string(&appid_path).await {
            Ok(existing) if existing.trim() == app_id => Ok(()),
            Ok(existing) if !existing.trim().is_empty() && existing.trim() != app_id => {
                warn_with_location(format!(
                    "Leaving existing steam_appid.txt in {} unchanged because it contains {} instead of {}",
                    crate::services::logger::LoggerService::sanitize_log_text(game_dir),
                    existing.trim(),
                    app_id
                ));
                Ok(())
            }
            _ => tokio::fs::write(&appid_path, app_id)
                .await
                .with_context(|| format!("Failed to write {}", appid_path.display())),
        }
    }

    fn steam_shortcut_name_for_dir(game_dir: &str) -> String {
        let folder_name = Path::new(game_dir)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Schedule I");
        format!("SIMM - {}", folder_name)
    }

    fn steam_shortcut_reload_message(game_dir: &str) -> String {
        format!(
            "Steam needs to reload SIMM's shortcut for {} before it can launch through Steam. Fully exit Steam and start it again once, then click Launch. SIMM will not fall back to a local launch for this action.",
            game_dir
        )
    }

    fn schedule_i_executable_name() -> &'static str {
        if cfg!(target_os = "macos") {
            "Schedule I.app"
        } else {
            "Schedule I.exe"
        }
    }

    fn steam_shortcut_launch_options() -> String {
        if cfg!(target_os = "linux") {
            crate::services::melon_loader::MelonLoaderService::linux_melonloader_launch_options()
                .to_string()
        } else {
            String::new()
        }
    }

    fn steam_shortcut_long_id(app_id: u32) -> u64 {
        ((app_id as u64) << 32) | 0x0200_0000
    }

    fn steam_launch_command() -> Result<SteamLaunchCommand> {
        let steam_path =
            crate::services::steam::SteamService::get_steam_path().ok_or_else(|| {
                let message = "Steam installation not found";
                error_with_location(message);
                anyhow::anyhow!(message)
            })?;

        Self::steam_launch_command_from_root(&steam_path).ok_or_else(|| {
            let message = format!(
                "Steam launch command not found for Steam root {}",
                crate::services::logger::LoggerService::sanitize_log_text(
                    &steam_path.to_string_lossy()
                )
            );
            error_with_location(&message);
            anyhow::anyhow!(message)
        })
    }

    fn steam_launch_command_from_root(steam_path: &Path) -> Option<SteamLaunchCommand> {
        #[cfg(target_os = "windows")]
        {
            let steam_exe = steam_path.join("steam.exe");
            return Self::launchable_file_command(&steam_exe);
        }

        #[cfg(target_os = "macos")]
        {
            let steam_sh = steam_path
                .join("Steam.app")
                .join("Contents")
                .join("MacOS")
                .join("steam.sh");
            return Self::launchable_file_command(&steam_sh);
        }

        #[cfg(target_os = "linux")]
        {
            if Self::is_flatpak_steam_root(steam_path) {
                if let Some(command) = Self::flatpak_steam_command() {
                    return Some(command);
                }
            }

            for candidate in [steam_path.join("steam"), steam_path.join("steam.sh")] {
                if let Some(command) = Self::launchable_file_command(&candidate) {
                    return Some(command);
                }
            }

            if let Some(command) = Self::path_command_candidate("steam") {
                return Some(SteamLaunchCommand::new(command, Vec::new()));
            }

            Self::flatpak_steam_command()
        }
    }

    fn launchable_file_command(path: &Path) -> Option<SteamLaunchCommand> {
        if path.is_file() {
            Some(SteamLaunchCommand::new(path.to_path_buf(), Vec::new()))
        } else {
            None
        }
    }

    #[cfg(target_os = "linux")]
    fn is_flatpak_steam_root(path: &Path) -> bool {
        let normalized = path.to_string_lossy().replace('\\', "/");
        normalized.contains("/.var/app/com.valvesoftware.Steam/.local/share/Steam")
    }

    #[cfg(target_os = "linux")]
    fn flatpak_steam_command() -> Option<SteamLaunchCommand> {
        let flatpak = Self::path_command_candidate("flatpak")?;
        let status = Command::new(&flatpak)
            .args(["info", "com.valvesoftware.Steam"])
            .status()
            .ok()?;
        if status.success() {
            Some(SteamLaunchCommand::new(
                flatpak,
                vec!["run".to_string(), "com.valvesoftware.Steam".to_string()],
            ))
        } else {
            None
        }
    }

    #[cfg(target_os = "linux")]
    fn path_command_candidate(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    }

    fn upsert_steam_shortcut(
        &self,
        shortcut: &SteamShortcut,
    ) -> Result<(PathBuf, SteamShortcutStatus)> {
        let shortcuts_file = Self::steam_shortcuts_file_path()?;
        if let Some(parent) = shortcuts_file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }

        let mut root = if shortcuts_file.exists() {
            let data = std::fs::read(&shortcuts_file)
                .with_context(|| format!("Failed to read {}", shortcuts_file.display()))?;
            parse_binary_vdf(&data)
                .with_context(|| format!("Failed to parse {}", shortcuts_file.display()))?
        } else {
            vec![("shortcuts".to_string(), BinaryVdfValue::Object(Vec::new()))]
        };

        let shortcuts = ensure_object(&mut root, "shortcuts");
        let status = upsert_shortcut_entry(shortcuts, shortcut);
        if status != SteamShortcutStatus::Unchanged {
            let bytes = write_binary_vdf(&root);
            std::fs::write(&shortcuts_file, bytes)
                .with_context(|| format!("Failed to write {}", shortcuts_file.display()))?;
        }

        Ok((shortcuts_file, status))
    }

    fn steam_shortcuts_file_path() -> Result<PathBuf> {
        let steam_path = crate::services::steam::SteamService::get_steam_path()
            .ok_or_else(|| anyhow::anyhow!("Steam installation not found"))?;
        let userdata_dir = steam_path.join("userdata");
        let account_id = Self::most_recent_steam_account_id(&steam_path)
            .or_else(|| Self::first_steam_userdata_account_id(&userdata_dir))
            .ok_or_else(|| anyhow::anyhow!("No Steam userdata account found"))?;

        Ok(userdata_dir
            .join(account_id)
            .join("config")
            .join("shortcuts.vdf"))
    }

    fn most_recent_steam_account_id(steam_path: &Path) -> Option<String> {
        let login_users =
            std::fs::read_to_string(steam_path.join("config").join("loginusers.vdf")).ok()?;
        let mut current_user: Option<String> = None;

        for line in login_users.lines() {
            let values = quoted_values(line);
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

    fn sync_steam_shortcut_reload_marker(
        shortcut_app_id: u32,
        status: SteamShortcutStatus,
    ) -> Result<()> {
        if status == SteamShortcutStatus::Unchanged {
            return Ok(());
        }

        if Self::steam_process_started_at().is_some() {
            Self::mark_steam_shortcut_reload_pending(shortcut_app_id)
        } else {
            Self::clear_steam_shortcut_reload_marker(shortcut_app_id)
        }
    }

    fn steam_shortcut_requires_client_reload(shortcut_app_id: u32) -> Result<bool> {
        let marker_path = Self::steam_shortcut_reload_marker_path(shortcut_app_id)?;
        let marker_modified_at = match marker_path.metadata() {
            Ok(metadata) => metadata
                .modified()
                .with_context(|| format!("Failed to read {}", marker_path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Failed to inspect {}", marker_path.display()));
            }
        };

        if Self::steam_shortcut_marker_requires_client_reload_for_times(
            marker_modified_at,
            Self::steam_process_started_at(),
        ) {
            return Ok(true);
        }

        Self::clear_steam_shortcut_reload_marker(shortcut_app_id)?;
        Ok(false)
    }

    fn mark_steam_shortcut_reload_pending(shortcut_app_id: u32) -> Result<()> {
        let marker_path = Self::steam_shortcut_reload_marker_path(shortcut_app_id)?;
        if let Some(parent) = marker_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        std::fs::write(&marker_path, b"pending")
            .with_context(|| format!("Failed to write {}", marker_path.display()))
    }

    fn clear_steam_shortcut_reload_marker(shortcut_app_id: u32) -> Result<()> {
        let marker_path = Self::steam_shortcut_reload_marker_path(shortcut_app_id)?;
        match std::fs::remove_file(&marker_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("Failed to remove {}", marker_path.display()))
            }
        }
    }

    fn steam_shortcut_reload_marker_path(shortcut_app_id: u32) -> Result<PathBuf> {
        Ok(crate::db::get_data_dir()?
            .join("steam-shortcuts")
            .join(format!("{shortcut_app_id}.reload-pending")))
    }

    fn steam_shortcut_marker_requires_client_reload_for_times(
        marker_modified_at: SystemTime,
        steam_started_at: Option<SystemTime>,
    ) -> bool {
        match steam_started_at {
            Some(started_at) => started_at <= marker_modified_at,
            None => false,
        }
    }

    #[cfg(target_os = "windows")]
    fn steam_process_started_at() -> Option<SystemTime> {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "$proc = Get-CimInstance Win32_Process -Filter \"Name = 'steam.exe'\" | Sort-Object CreationDate | Select-Object -First 1; if ($proc) { $proc.CreationDate.ToUniversalTime().ToString('o') }",
            ])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8(output.stdout).ok()?;
        let timestamp = stdout.trim();
        if timestamp.is_empty() {
            return None;
        }

        let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
        let millis = parsed.timestamp_millis();
        if millis < 0 {
            return None;
        }

        Some(SystemTime::UNIX_EPOCH + Duration::from_millis(millis as u64))
    }

    #[cfg(target_os = "linux")]
    fn steam_process_started_at() -> Option<SystemTime> {
        let pid = Self::linux_steam_process_id()?;
        let output = std::process::Command::new("ps")
            .args(["-o", "etimes=", "-p", &pid])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8(output.stdout).ok()?;
        Self::linux_process_started_at_from_etimes(&stdout, SystemTime::now())
    }

    #[cfg(target_os = "linux")]
    fn linux_steam_process_id() -> Option<String> {
        let candidates: &[&[&str]] = &[
            &["-xo", "steam"],
            &["-fo", r"(^|/)steam( |$)"],
            &["-fo", "steam"],
        ];

        candidates.iter().find_map(|args| {
            let output = std::process::Command::new("pgrep")
                .args(*args)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }

            String::from_utf8(output.stdout)
                .ok()?
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && line.chars().all(|ch| ch.is_ascii_digit()))
                .map(ToOwned::to_owned)
        })
    }

    #[cfg(target_os = "linux")]
    fn linux_process_started_at_from_etimes(output: &str, now: SystemTime) -> Option<SystemTime> {
        let elapsed_seconds = output
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?
            .parse::<u64>()
            .ok()?;

        now.checked_sub(Duration::from_secs(elapsed_seconds))
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    fn steam_process_started_at() -> Option<SystemTime> {
        None
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
            let executable_path = Path::new(dir).join(Self::schedule_i_executable_name());
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
        let steam_command = Self::steam_launch_command()?;

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut command = steam_command.command();
            command
                .arg("-applaunch")
                .arg(app_id)
                .creation_flags(0x08000000);
            command
                .spawn()
                .context("Failed to launch game via Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam command {} for app {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
                        ),
                        app_id,
                        error
                    ));
                    error
                })?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut command = steam_command.command();
            command
                .arg("-applaunch")
                .arg(app_id)
                .spawn()
                .context("Failed to launch game via Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to spawn Steam command {} for app {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
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
        let steam_command = Self::steam_launch_command()?;

        if Self::is_steam_running(&steam_command.program) {
            return Ok(());
        }

        // Steam is not running, start it
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut command = steam_command.command();
            command.creation_flags(0x08000000);
            command
                .spawn()
                .context("Failed to start Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to start Steam command {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
                        ),
                        error
                    ));
                    error
                })?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            steam_command
                .command()
                .spawn()
                .context("Failed to start Steam")
                .map_err(|error| {
                    error_with_location(format!(
                        "Failed to start Steam command {}: {}",
                        crate::services::logger::LoggerService::sanitize_log_text(
                            &steam_command.display()
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

    pub(crate) async fn restart_steam_client(&self) -> Result<()> {
        let steam_command = Self::steam_launch_command()?;

        if Self::is_steam_running(&steam_command.program) {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let mut command = steam_command.command();
                command.arg("-shutdown").creation_flags(0x08000000);
                command
                    .spawn()
                    .context("Failed to request Steam shutdown")?;
            }

            #[cfg(not(target_os = "windows"))]
            {
                let mut command = steam_command.command();
                command
                    .arg("-shutdown")
                    .spawn()
                    .context("Failed to request Steam shutdown")?;
            }

            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while Self::is_steam_running(&steam_command.program) {
                if std::time::Instant::now() >= deadline {
                    return Err(anyhow::anyhow!(
                        "Steam did not exit after SIMM requested shutdown. Close Steam manually, then click Launch again."
                    ));
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut command = steam_command.command();
            command.creation_flags(0x08000000);
            command.spawn().context("Failed to restart Steam")?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            steam_command
                .command()
                .spawn()
                .context("Failed to restart Steam")?;
        }

        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        while !Self::is_steam_running(&steam_command.program) {
            if std::time::Instant::now() >= deadline {
                return Err(anyhow::anyhow!(
                    "Steam did not start after SIMM requested restart. Start Steam manually, then click Launch again."
                ));
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        Ok(())
    }

    fn is_steam_running(_steam_exe: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let steam_exe_name = _steam_exe
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "steam.exe".to_string());

            let output = std::process::Command::new("tasklist")
                .arg("/FI")
                .arg(format!("IMAGENAME eq {}", steam_exe_name))
                .creation_flags(0x08000000)
                .output()
                .ok();

            output.is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&steam_exe_name)
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new("pgrep")
                .arg("-f")
                .arg("steam")
                .output()
                .is_ok_and(|output| output.status.success())
        }
    }

    async fn launch_directly(&self, game_dir: &str) -> Result<String> {
        if cfg!(target_os = "linux") {
            let message = "Direct local launch is not supported on Linux because Schedule I runs through Steam Proton. Use Steam launch instead.";
            warn_with_location(message);
            return Err(anyhow::anyhow!(message));
        }

        // Find the game executable
        let executable_path = Path::new(game_dir).join(Self::schedule_i_executable_name());

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

#[derive(Clone, Debug)]
struct SteamShortcut {
    app_name: String,
    exe: String,
    start_dir: String,
    icon: String,
    launch_options: String,
}

impl SteamShortcut {
    fn new(
        app_name: String,
        executable_path: PathBuf,
        start_dir: PathBuf,
        launch_options: String,
    ) -> Self {
        let exe = quote_steam_shortcut_path(&executable_path);
        let start_dir = quote_steam_shortcut_path(&start_dir);

        Self {
            app_name,
            icon: executable_path.to_string_lossy().to_string(),
            exe,
            start_dir,
            launch_options,
        }
    }

    fn app_id(&self) -> u32 {
        crc32_ieee(format!("{}{}", self.exe, self.app_name).as_bytes()) | 0x8000_0000
    }

    fn to_vdf_entry(&self) -> Vec<(String, BinaryVdfValue)> {
        vec![
            (
                "appid".to_string(),
                BinaryVdfValue::Int32(self.app_id() as i32),
            ),
            (
                "appname".to_string(),
                BinaryVdfValue::String(self.app_name.clone()),
            ),
            ("exe".to_string(), BinaryVdfValue::String(self.exe.clone())),
            (
                "StartDir".to_string(),
                BinaryVdfValue::String(self.start_dir.clone()),
            ),
            (
                "icon".to_string(),
                BinaryVdfValue::String(self.icon.clone()),
            ),
            (
                "ShortcutPath".to_string(),
                BinaryVdfValue::String(String::new()),
            ),
            (
                "LaunchOptions".to_string(),
                BinaryVdfValue::String(self.launch_options.clone()),
            ),
            ("IsHidden".to_string(), BinaryVdfValue::Int32(0)),
            ("AllowDesktopConfig".to_string(), BinaryVdfValue::Int32(1)),
            ("AllowOverlay".to_string(), BinaryVdfValue::Int32(1)),
            ("OpenVR".to_string(), BinaryVdfValue::Int32(0)),
            ("Devkit".to_string(), BinaryVdfValue::Int32(0)),
            (
                "DevkitGameID".to_string(),
                BinaryVdfValue::String(String::new()),
            ),
            ("LastPlayTime".to_string(), BinaryVdfValue::Int32(0)),
            (
                "FlatpakAppID".to_string(),
                BinaryVdfValue::String(String::new()),
            ),
            (
                "tags".to_string(),
                BinaryVdfValue::Object(vec![(
                    "0".to_string(),
                    BinaryVdfValue::String(STEAM_SHORTCUT_TAG.to_string()),
                )]),
            ),
        ]
    }
}

fn upsert_shortcut_entry(
    shortcuts: &mut Vec<(String, BinaryVdfValue)>,
    shortcut: &SteamShortcut,
) -> SteamShortcutStatus {
    for (_, value) in shortcuts.iter_mut() {
        let BinaryVdfValue::Object(entry) = value else {
            continue;
        };

        let app_name =
            get_vdf_string(entry, "appname").or_else(|| get_vdf_string(entry, "AppName"));
        let exe = get_vdf_string(entry, "exe");
        if app_name == Some(shortcut.app_name.as_str()) || exe == Some(shortcut.exe.as_str()) {
            if steam_shortcut_entry_matches(entry, shortcut) {
                return SteamShortcutStatus::Unchanged;
            }

            update_managed_steam_shortcut_fields(entry, shortcut);
            return SteamShortcutStatus::Updated;
        }
    }

    let next_index = shortcuts
        .iter()
        .filter_map(|(key, _)| key.parse::<usize>().ok())
        .max()
        .map_or(0, |index| index + 1);
    shortcuts.push((
        next_index.to_string(),
        BinaryVdfValue::Object(shortcut.to_vdf_entry()),
    ));
    SteamShortcutStatus::Inserted
}

fn steam_shortcut_entry_matches(
    entry: &[(String, BinaryVdfValue)],
    shortcut: &SteamShortcut,
) -> bool {
    let expected = shortcut.to_vdf_entry();
    STEAM_SHORTCUT_MANAGED_KEYS.iter().all(|key| {
        let actual_value = get_vdf_value(entry, key);
        let expected_value = get_vdf_value(&expected, key);
        actual_value == expected_value
    })
}

fn update_managed_steam_shortcut_fields(
    entry: &mut Vec<(String, BinaryVdfValue)>,
    shortcut: &SteamShortcut,
) {
    for (key, value) in shortcut
        .to_vdf_entry()
        .into_iter()
        .filter(|(key, _)| is_managed_steam_shortcut_key(key))
    {
        if let Some((_, existing_value)) = entry
            .iter_mut()
            .find(|(existing_key, _)| existing_key.eq_ignore_ascii_case(&key))
        {
            *existing_value = value;
        } else {
            entry.push((key, value));
        }
    }
}

fn is_managed_steam_shortcut_key(key: &str) -> bool {
    STEAM_SHORTCUT_MANAGED_KEYS
        .iter()
        .any(|managed_key| key.eq_ignore_ascii_case(managed_key))
}

fn get_vdf_value<'a>(
    entries: &'a [(String, BinaryVdfValue)],
    wanted_key: &str,
) -> Option<&'a BinaryVdfValue> {
    entries
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(wanted_key))
        .map(|(_, value)| value)
}

fn get_vdf_string<'a>(
    entries: &'a [(String, BinaryVdfValue)],
    wanted_key: &str,
) -> Option<&'a str> {
    entries.iter().find_map(|(key, value)| {
        if key.eq_ignore_ascii_case(wanted_key) {
            if let BinaryVdfValue::String(value) = value {
                return Some(value.as_str());
            }
        }
        None
    })
}

fn ensure_object<'a>(
    entries: &'a mut Vec<(String, BinaryVdfValue)>,
    key: &str,
) -> &'a mut Vec<(String, BinaryVdfValue)> {
    if let Some(index) = entries
        .iter()
        .position(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
    {
        if !matches!(entries[index].1, BinaryVdfValue::Object(_)) {
            entries[index].1 = BinaryVdfValue::Object(Vec::new());
        }
        let BinaryVdfValue::Object(object) = &mut entries[index].1 else {
            unreachable!();
        };
        return object;
    }

    entries.push((key.to_string(), BinaryVdfValue::Object(Vec::new())));
    let BinaryVdfValue::Object(object) = &mut entries.last_mut().expect("inserted object").1 else {
        unreachable!();
    };
    object
}

fn parse_binary_vdf(data: &[u8]) -> Result<Vec<(String, BinaryVdfValue)>> {
    let mut cursor = 0;
    parse_binary_vdf_object(data, &mut cursor)
}

fn parse_binary_vdf_object(
    data: &[u8],
    cursor: &mut usize,
) -> Result<Vec<(String, BinaryVdfValue)>> {
    let mut entries = Vec::new();

    loop {
        let value_type = *data
            .get(*cursor)
            .ok_or_else(|| anyhow::anyhow!("Unexpected end of VDF data"))?;
        *cursor += 1;

        if value_type == 0x08 {
            break;
        }

        let key = read_vdf_c_string(data, cursor)?;
        let value = match value_type {
            0x00 => BinaryVdfValue::Object(parse_binary_vdf_object(data, cursor)?),
            0x01 => BinaryVdfValue::String(read_vdf_c_string(data, cursor)?),
            0x02 => {
                let bytes = read_vdf_bytes::<4>(data, cursor)?;
                BinaryVdfValue::Int32(i32::from_le_bytes(bytes))
            }
            0x07 => {
                let bytes = read_vdf_bytes::<8>(data, cursor)?;
                BinaryVdfValue::UInt64(u64::from_le_bytes(bytes))
            }
            unsupported => {
                return Err(anyhow::anyhow!(
                    "Unsupported binary VDF value type {} for key {}",
                    unsupported,
                    key
                ));
            }
        };
        entries.push((key, value));
    }

    Ok(entries)
}

fn write_binary_vdf(entries: &[(String, BinaryVdfValue)]) -> Vec<u8> {
    let mut output = Vec::new();
    write_binary_vdf_object(entries, &mut output);
    output
}

fn write_binary_vdf_object(entries: &[(String, BinaryVdfValue)], output: &mut Vec<u8>) {
    for (key, value) in entries {
        match value {
            BinaryVdfValue::Object(entries) => {
                output.push(0x00);
                write_vdf_c_string(key, output);
                write_binary_vdf_object(entries, output);
            }
            BinaryVdfValue::String(value) => {
                output.push(0x01);
                write_vdf_c_string(key, output);
                write_vdf_c_string(value, output);
            }
            BinaryVdfValue::Int32(value) => {
                output.push(0x02);
                write_vdf_c_string(key, output);
                output.extend(value.to_le_bytes());
            }
            BinaryVdfValue::UInt64(value) => {
                output.push(0x07);
                write_vdf_c_string(key, output);
                output.extend(value.to_le_bytes());
            }
        }
    }

    output.push(0x08);
}

fn read_vdf_c_string(data: &[u8], cursor: &mut usize) -> Result<String> {
    let start = *cursor;
    while let Some(byte) = data.get(*cursor) {
        *cursor += 1;
        if *byte == 0 {
            return String::from_utf8(data[start..(*cursor - 1)].to_vec())
                .context("Invalid UTF-8 in binary VDF string");
        }
    }

    Err(anyhow::anyhow!("Unterminated binary VDF string"))
}

fn read_vdf_bytes<const N: usize>(data: &[u8], cursor: &mut usize) -> Result<[u8; N]> {
    let end = (*cursor).saturating_add(N);
    let bytes = data
        .get(*cursor..end)
        .ok_or_else(|| anyhow::anyhow!("Unexpected end of binary VDF numeric value"))?;
    *cursor = end;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Unexpected binary VDF numeric length"))
}

fn write_vdf_c_string(value: &str, output: &mut Vec<u8>) {
    output.extend(value.as_bytes().iter().copied().filter(|byte| *byte != 0));
    output.push(0);
}

fn quote_steam_shortcut_path(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

fn quoted_values(line: &str) -> Vec<String> {
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

fn steam_account_id_from_steam_id64(steam_id64: &str) -> Option<String> {
    let id = steam_id64.parse::<u64>().ok()?;
    let account_id = id.checked_sub(76_561_197_960_265_728)?;
    Some(account_id.to_string())
}

fn crc32_ieee(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
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
        #[cfg(target_os = "linux")]
        assert!(err
            .to_string()
            .contains("Direct local launch is not supported on Linux"));
        #[cfg(not(target_os = "linux"))]
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

    #[tokio::test]
    async fn launch_game_steam_restart_requires_directory() {
        let service = FileSystemService::new();
        let err = service
            .launch_game(None, Some("steam_restart"))
            .await
            .expect_err("expected missing directory error");
        assert!(err
            .to_string()
            .contains("Game directory is required for Steam restart launch"));
    }

    #[test]
    fn steam_shortcut_app_id_uses_expected_crc_shape() {
        let shortcut = SteamShortcut {
            app_name: "SIMM - Schedule I Custom".to_string(),
            exe: "\"C:\\Games\\Schedule I Custom\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I Custom\"".to_string(),
            icon: "C:\\Games\\Schedule I Custom\\Schedule I.exe".to_string(),
            launch_options: String::new(),
        };

        let app_id = shortcut.app_id();
        assert_ne!(app_id, 0);
        assert_eq!(app_id & 0x8000_0000, 0x8000_0000);
        assert_eq!(
            FileSystemService::steam_shortcut_long_id(app_id),
            ((app_id as u64) << 32) | 0x0200_0000
        );
    }

    #[test]
    fn steam_shortcut_reload_message_keeps_user_visible_path() {
        let message =
            FileSystemService::steam_shortcut_reload_message(r"C:\Games\Schedule I Custom");

        assert!(message.contains(r"C:\Games\Schedule I Custom"));
        assert!(!message.contains("<path:"));
    }

    #[test]
    fn steam_shortcut_reload_check_waits_for_steam_reinitialization() {
        let marker_modified_at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let steam_started_before = SystemTime::UNIX_EPOCH + Duration::from_secs(99);
        let steam_started_same_tick = marker_modified_at;
        let steam_started_after = SystemTime::UNIX_EPOCH + Duration::from_secs(101);

        assert!(
            FileSystemService::steam_shortcut_marker_requires_client_reload_for_times(
                marker_modified_at,
                Some(steam_started_before)
            )
        );
        assert!(
            FileSystemService::steam_shortcut_marker_requires_client_reload_for_times(
                marker_modified_at,
                Some(steam_started_same_tick)
            )
        );
        assert!(
            !FileSystemService::steam_shortcut_marker_requires_client_reload_for_times(
                marker_modified_at,
                Some(steam_started_after)
            )
        );
        assert!(
            !FileSystemService::steam_shortcut_marker_requires_client_reload_for_times(
                marker_modified_at,
                None
            )
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_started_at_from_etimes_uses_elapsed_seconds() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let started_at = FileSystemService::linux_process_started_at_from_etimes("  42\n", now)
            .expect("started time");

        assert_eq!(
            started_at,
            SystemTime::UNIX_EPOCH + Duration::from_secs(958)
        );
        assert!(
            FileSystemService::linux_process_started_at_from_etimes("not-a-number\n", now)
                .is_none()
        );
        assert!(FileSystemService::linux_process_started_at_from_etimes("", now).is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn schedule_i_executable_name_uses_windows_binary_for_proton_builds() {
        assert_eq!(
            FileSystemService::schedule_i_executable_name(),
            "Schedule I.exe"
        );
    }

    #[test]
    fn steam_shortcut_launch_options_are_platform_specific() {
        if cfg!(target_os = "linux") {
            assert_eq!(
                FileSystemService::steam_shortcut_launch_options(),
                "WINEDLLOVERRIDES=\"version=n,b\" %command%"
            );
        } else {
            assert!(FileSystemService::steam_shortcut_launch_options().is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn steam_launch_command_detects_flatpak_steam_root_shape() {
        let root = Path::new("/home/example/.var/app/com.valvesoftware.Steam/.local/share/Steam");

        assert!(FileSystemService::is_flatpak_steam_root(root));
        assert!(!FileSystemService::is_flatpak_steam_root(Path::new(
            "/home/example/.local/share/Steam"
        )));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn steam_launch_command_from_root_uses_root_steam_sh_candidate() {
        let temp = tempdir().expect("temp dir");
        let steam_sh = temp.path().join("steam.sh");
        std::fs::write(&steam_sh, "#!/bin/sh\n").expect("create steam.sh");

        let command = FileSystemService::steam_launch_command_from_root(temp.path())
            .expect("steam launch command");

        assert_eq!(command.program, steam_sh);
        assert!(command.prefix_args.is_empty());
    }

    #[test]
    fn binary_vdf_round_trips_shortcuts() {
        let shortcut = SteamShortcut {
            app_name: "SIMM - Schedule I Custom".to_string(),
            exe: "\"C:\\Games\\Schedule I Custom\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I Custom\"".to_string(),
            icon: "C:\\Games\\Schedule I Custom\\Schedule I.exe".to_string(),
            launch_options: String::new(),
        };
        let root = vec![(
            "shortcuts".to_string(),
            BinaryVdfValue::Object(vec![(
                "0".to_string(),
                BinaryVdfValue::Object(shortcut.to_vdf_entry()),
            )]),
        )];

        let bytes = write_binary_vdf(&root);
        let parsed = parse_binary_vdf(&bytes).expect("parse generated vdf");
        assert_eq!(parsed, root);
    }

    #[test]
    fn upsert_shortcut_entry_updates_existing_exe() {
        let original = SteamShortcut {
            app_name: "SIMM - Old Name".to_string(),
            exe: "\"C:\\Games\\Schedule I\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I\"".to_string(),
            icon: "C:\\Games\\Schedule I\\Schedule I.exe".to_string(),
            launch_options: String::new(),
        };
        let updated = SteamShortcut {
            app_name: "SIMM - Schedule I".to_string(),
            exe: original.exe.clone(),
            start_dir: original.start_dir.clone(),
            icon: original.icon.clone(),
            launch_options: String::new(),
        };
        let mut shortcuts = vec![(
            "0".to_string(),
            BinaryVdfValue::Object(original.to_vdf_entry()),
        )];
        let BinaryVdfValue::Object(existing_entry) = &mut shortcuts[0].1 else {
            panic!("expected object");
        };
        let (_, last_play_time) = existing_entry
            .iter_mut()
            .find(|(key, _)| key == "LastPlayTime")
            .expect("LastPlayTime field");
        *last_play_time = BinaryVdfValue::Int32(123);

        let status = upsert_shortcut_entry(&mut shortcuts, &updated);

        assert_eq!(status, SteamShortcutStatus::Updated);
        assert_eq!(shortcuts.len(), 1);
        let BinaryVdfValue::Object(entry) = &shortcuts[0].1 else {
            panic!("expected object");
        };
        assert_eq!(get_vdf_string(entry, "appname"), Some("SIMM - Schedule I"));
        assert_eq!(
            get_vdf_value(entry, "LastPlayTime"),
            Some(&BinaryVdfValue::Int32(123))
        );
    }

    #[test]
    fn upsert_shortcut_entry_reports_unchanged_existing_entry() {
        let shortcut = SteamShortcut {
            app_name: "SIMM - Schedule I".to_string(),
            exe: "\"C:\\Games\\Schedule I\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I\"".to_string(),
            icon: "C:\\Games\\Schedule I\\Schedule I.exe".to_string(),
            launch_options: String::new(),
        };
        let mut shortcuts = vec![(
            "0".to_string(),
            BinaryVdfValue::Object(shortcut.to_vdf_entry()),
        )];

        let status = upsert_shortcut_entry(&mut shortcuts, &shortcut);

        assert_eq!(status, SteamShortcutStatus::Unchanged);
        assert_eq!(shortcuts.len(), 1);
    }

    #[test]
    fn upsert_shortcut_entry_ignores_steam_last_play_time_changes() {
        let shortcut = SteamShortcut {
            app_name: "SIMM - Schedule I".to_string(),
            exe: "\"C:\\Games\\Schedule I\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I\"".to_string(),
            icon: "C:\\Games\\Schedule I\\Schedule I.exe".to_string(),
            launch_options: String::new(),
        };
        let mut shortcuts = vec![(
            "0".to_string(),
            BinaryVdfValue::Object(shortcut.to_vdf_entry()),
        )];
        let BinaryVdfValue::Object(entry) = &mut shortcuts[0].1 else {
            panic!("expected object");
        };
        let (_, last_play_time) = entry
            .iter_mut()
            .find(|(key, _)| key == "LastPlayTime")
            .expect("LastPlayTime field");
        *last_play_time = BinaryVdfValue::Int32(456);

        let status = upsert_shortcut_entry(&mut shortcuts, &shortcut);

        assert_eq!(status, SteamShortcutStatus::Unchanged);
        let BinaryVdfValue::Object(entry) = &shortcuts[0].1 else {
            panic!("expected object");
        };
        assert_eq!(
            get_vdf_value(entry, "LastPlayTime"),
            Some(&BinaryVdfValue::Int32(456))
        );
    }

    #[test]
    fn upsert_shortcut_entry_reports_inserted_new_entry() {
        let shortcut = SteamShortcut {
            app_name: "SIMM - Schedule I".to_string(),
            exe: "\"C:\\Games\\Schedule I\\Schedule I.exe\"".to_string(),
            start_dir: "\"C:\\Games\\Schedule I\"".to_string(),
            icon: "C:\\Games\\Schedule I\\Schedule I.exe".to_string(),
            launch_options: "WINEDLLOVERRIDES=\"version=n,b\" %command%".to_string(),
        };
        let mut shortcuts = Vec::new();

        let status = upsert_shortcut_entry(&mut shortcuts, &shortcut);

        assert_eq!(status, SteamShortcutStatus::Inserted);
        assert_eq!(shortcuts.len(), 1);
        let BinaryVdfValue::Object(entry) = &shortcuts[0].1 else {
            panic!("expected object");
        };
        assert_eq!(
            get_vdf_string(entry, "LaunchOptions"),
            Some("WINEDLLOVERRIDES=\"version=n,b\" %command%")
        );
    }

    #[test]
    fn steam_account_id_uses_steam_id64_offset() {
        assert_eq!(
            steam_account_id_from_steam_id64("76561198000000000"),
            Some("39734272".to_string())
        );
    }
}
