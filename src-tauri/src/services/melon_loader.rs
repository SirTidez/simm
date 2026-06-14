use crate::types::Environment;
use anyhow::{Context, Result};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::time::Instant;
use zip::ZipArchive;

#[derive(Clone)]
pub struct MelonLoaderService;

const LINUX_MELONLOADER_LAUNCH_OPTIONS: &str = "WINEDLLOVERRIDES=\"version=n,b\" %command%";
const SCHEDULE_I_STEAM_APP_ID: &str = "3164500";
const LINUX_REQUIRED_WINETRICKS_VERBS: &[&str] = &["dotnet6", "vcrun2015"];
const DEFAULT_LAUNCH_VERIFY_TIMEOUT_MS: u64 = 20_000;
const MAX_LAUNCH_VERIFY_TIMEOUT_MS: u64 = 60_000;
const LAUNCH_LOG_TIMESTAMP_TOLERANCE_MS: u64 = 1_500;

#[derive(Debug, Clone)]
struct LinuxPrerequisiteInspection {
    installed: Option<bool>,
    installed_verbs: Vec<String>,
    missing_verbs: Vec<String>,
    status_path: Option<String>,
    error: Option<String>,
}

impl LinuxPrerequisiteInspection {
    fn unknown(error: impl Into<String>) -> Self {
        Self {
            installed: None,
            installed_verbs: Vec::new(),
            missing_verbs: LINUX_REQUIRED_WINETRICKS_VERBS
                .iter()
                .map(|verb| (*verb).to_string())
                .collect(),
            status_path: None,
            error: Some(error.into()),
        }
    }

    fn status_label(&self) -> &'static str {
        match self.installed {
            Some(true) => "installed",
            Some(false) => "missing",
            None => "unknown",
        }
    }
}

impl MelonLoaderService {
    pub fn new() -> Self {
        Self
    }

    pub fn linux_melonloader_launch_options() -> &'static str {
        LINUX_MELONLOADER_LAUNCH_OPTIONS
    }

    pub async fn verify_launch_after(
        &self,
        game_dir: &str,
        launch_started_at_ms: u64,
        timeout_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        let latest_log = Path::new(game_dir).join("MelonLoader").join("Latest.log");
        if !self.is_melon_loader_installed(game_dir) {
            return Ok(Self::launch_verification_response(
                "notInstalled",
                false,
                latest_log,
                None,
                "MelonLoader is not installed for this environment.",
            ));
        }

        let timeout = Duration::from_millis(
            timeout_ms
                .unwrap_or(DEFAULT_LAUNCH_VERIFY_TIMEOUT_MS)
                .clamp(1_000, MAX_LAUNCH_VERIFY_TIMEOUT_MS),
        );
        let deadline = Instant::now() + timeout;
        let fresh_after = launch_started_at_ms.saturating_sub(LAUNCH_LOG_TIMESTAMP_TOLERANCE_MS);

        loop {
            let current_status = match Self::inspect_launch_log(&latest_log, fresh_after).await? {
                LaunchLogInspection::Confirmed { modified_at } => {
                    return Ok(Self::launch_verification_response(
                        "confirmed",
                        true,
                        latest_log,
                        Some(modified_at),
                        "MelonLoader wrote a fresh launch log.",
                    ));
                }
                LaunchLogInspection::Stale { modified_at } => Self::launch_verification_response(
                    "staleLog",
                    false,
                    latest_log.clone(),
                    Some(modified_at),
                    "MelonLoader log exists, but it has not been refreshed since this launch request.",
                ),
                LaunchLogInspection::Missing => Self::launch_verification_response(
                    "noLog",
                    false,
                    latest_log.clone(),
                    None,
                    "MelonLoader has not written Latest.log for this launch yet.",
                ),
                LaunchLogInspection::NoMarker { modified_at } => Self::launch_verification_response(
                    "noConfirmation",
                    false,
                    latest_log.clone(),
                    Some(modified_at),
                    "Latest.log refreshed, but SIMM could not find a MelonLoader initialization marker.",
                ),
            };

            if Instant::now() >= deadline {
                return Ok(current_status);
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn get_linux_requirements_status(
        &self,
        env: &Environment,
    ) -> Result<Option<serde_json::Value>> {
        if !cfg!(target_os = "linux") {
            return Ok(None);
        }

        let protontricks = Self::detect_protontricks().await;
        let is_steam_env = env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-");
        let mut warnings = Vec::new();

        if !protontricks.available {
            warnings.push("Protontricks was not found. Install Protontricks before using MelonLoader with Schedule I on Linux.".to_string());
        }

        let prerequisite_app_id = if is_steam_env {
            Some(SCHEDULE_I_STEAM_APP_ID.to_string())
        } else {
            match crate::services::filesystem::FileSystemService::new()
                .schedule_i_shortcut_app_id_for_dir(&env.output_dir)
            {
                Ok(app_id) => Some(app_id.to_string()),
                Err(error) => {
                    warnings.push(format!(
                        "Could not inspect the SIMM Steam shortcut Proton prefix for MelonLoader prerequisites: {}",
                        error
                    ));
                    None
                }
            }
        };

        let prerequisite_status = match prerequisite_app_id.as_deref() {
            Some(app_id) => {
                Self::inspect_linux_prerequisites(app_id, Path::new(&env.output_dir)).await
            }
            None => LinuxPrerequisiteInspection::unknown(
                "Steam app id for the Proton prefix could not be determined",
            ),
        };

        match prerequisite_status.installed {
            Some(true) => {}
            Some(false) => {
                warnings.push(format!(
                    "Schedule I Proton prefix is missing required MelonLoader prerequisites: {}.",
                    prerequisite_status.missing_verbs.join(", ")
                ));
            }
            None => {
                if let Some(error) = &prerequisite_status.error {
                    warnings.push(format!(
                        "Could not verify Schedule I Proton prerequisites: {}",
                        error
                    ));
                }
            }
        }

        let mut steam_launch_options = None;
        let mut steam_launch_options_configured = None;
        let mut steam_launch_options_repairable = None;
        let mut needs_steam_launch_options_repair = None;
        let mut steam_launch_options_path = None;

        if is_steam_env {
            match crate::services::steam::SteamService::new().get_schedule_i_launch_options_status()
            {
                Ok(status) => {
                    steam_launch_options_configured = Some(status.configured);
                    steam_launch_options_repairable = Some(status.repairable);
                    needs_steam_launch_options_repair =
                        Some(!status.configured && status.repairable);
                    steam_launch_options_path = status.config_path;
                    steam_launch_options = status.current;

                    if !status.configured {
                        warnings.push(format!(
                            "Schedule I Steam launch options must include {} so Proton loads MelonLoader's version.dll.",
                            Self::linux_melonloader_launch_options()
                        ));
                    }
                }
                Err(error) => {
                    warnings.push(format!(
                        "Could not inspect Schedule I Steam launch options: {}",
                        error
                    ));
                    steam_launch_options_configured = Some(false);
                    steam_launch_options_repairable = Some(false);
                    needs_steam_launch_options_repair = Some(false);
                }
            }
        } else {
            warnings.push("SIMM will manage a Steam shortcut for this environment. Steam may need one full restart before Protontricks and launch actions can use the shortcut prefix.".to_string());
        }

        let prerequisite_command_app_id = prerequisite_app_id
            .as_deref()
            .unwrap_or(SCHEDULE_I_STEAM_APP_ID);
        let prerequisite_status_label = prerequisite_status.status_label();
        Ok(Some(serde_json::json!({
            "appId": SCHEDULE_I_STEAM_APP_ID,
            "protontricksInstalled": protontricks.available,
            "protontricksCommand": protontricks.command_label,
            "canInstallPrerequisites": protontricks.available,
            "prerequisiteCommands": [
                format!("{} {} dotnet6", protontricks.command_label, prerequisite_command_app_id),
                format!("{} {} vcrun2015", protontricks.command_label, prerequisite_command_app_id),
            ],
            "prerequisiteAppId": prerequisite_app_id,
            "requiredPrerequisites": LINUX_REQUIRED_WINETRICKS_VERBS,
            "installedPrerequisites": prerequisite_status.installed_verbs,
            "missingPrerequisites": prerequisite_status.missing_verbs,
            "prerequisitesInstalled": prerequisite_status.installed,
            "prerequisiteStatus": prerequisite_status_label,
            "prerequisiteStatusPath": prerequisite_status.status_path,
            "prerequisiteStatusError": prerequisite_status.error,
            "launchOptions": Self::linux_melonloader_launch_options(),
            "steamLaunchOptions": steam_launch_options,
            "steamLaunchOptionsConfigured": steam_launch_options_configured,
            "steamLaunchOptionsRepairable": steam_launch_options_repairable,
            "needsSteamLaunchOptionsRepair": needs_steam_launch_options_repair,
            "steamLaunchOptionsPath": steam_launch_options_path,
            "warnings": warnings,
        })))
    }

    pub async fn ensure_linux_prerequisites(&self, env: &Environment) -> Result<Option<String>> {
        if !cfg!(target_os = "linux") {
            return Ok(None);
        }

        let is_steam_env = env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-");
        let protontricks = Self::detect_protontricks().await;
        if !protontricks.available {
            return Err(anyhow::anyhow!(
                "Protontricks is required to install Schedule I MelonLoader prerequisites on Linux. Install Protontricks, then retry. Required commands: protontricks {} dotnet6; protontricks {} vcrun2015",
                SCHEDULE_I_STEAM_APP_ID,
                SCHEDULE_I_STEAM_APP_ID
            ));
        }

        let (target_app_id, target_label, shortcut_reload_note) = if is_steam_env {
            let status =
                crate::services::steam::SteamService::new().ensure_schedule_i_launch_options()?;
            if !status.configured {
                return Err(anyhow::anyhow!(
                    "Failed to configure Schedule I Steam launch options"
                ));
            }
            (
                SCHEDULE_I_STEAM_APP_ID.to_string(),
                format!("Steam app {}", SCHEDULE_I_STEAM_APP_ID),
                None,
            )
        } else {
            let filesystem = crate::services::filesystem::FileSystemService::new();
            let shortcut = filesystem
                .ensure_schedule_i_steam_shortcut(&env.output_dir)
                .await?;
            let reload_note = if shortcut.requires_client_reload {
                filesystem.restart_steam_client().await?;
                Some(
                    "SIMM restarted Steam so the managed shortcut prefix is available.".to_string(),
                )
            } else {
                None
            };
            if shortcut.requires_client_reload {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            (
                shortcut.shortcut_app_id.to_string(),
                format!("SIMM Steam shortcut {}", shortcut.shortcut_app_id),
                reload_note,
            )
        };

        let prerequisite_status =
            Self::inspect_linux_prerequisites(&target_app_id, Path::new(&env.output_dir)).await;
        let missing_verbs = Self::missing_linux_prerequisite_verbs(&prerequisite_status);

        let mut message = if missing_verbs.is_empty() {
            format!("Linux prerequisites already installed for {}", target_label)
        } else {
            Self::run_protontricks(&protontricks, &target_app_id, &missing_verbs).await?;

            let updated_status =
                Self::inspect_linux_prerequisites(&target_app_id, Path::new(&env.output_dir)).await;
            if updated_status.installed == Some(false) {
                return Err(anyhow::anyhow!(
                    "Protontricks completed, but SIMM still detects missing Schedule I MelonLoader prerequisites: {}",
                    updated_status.missing_verbs.join(", ")
                ));
            }

            format!(
                "Installed missing Linux prerequisites ({}) with {} for {}",
                missing_verbs.join(", "),
                protontricks.command_label,
                target_label
            )
        };
        if let Some(note) = shortcut_reload_note {
            message.push_str(". ");
            message.push_str(&note);
        }
        Ok(Some(message))
    }

    fn missing_linux_prerequisite_verbs(status: &LinuxPrerequisiteInspection) -> Vec<&'static str> {
        match status.installed {
            Some(true) => Vec::new(),
            Some(false) => LINUX_REQUIRED_WINETRICKS_VERBS
                .iter()
                .copied()
                .filter(|required| {
                    status
                        .missing_verbs
                        .iter()
                        .any(|missing| missing.eq_ignore_ascii_case(required))
                })
                .collect(),
            None => LINUX_REQUIRED_WINETRICKS_VERBS.to_vec(),
        }
    }

    async fn inspect_linux_prerequisites(
        app_id: &str,
        game_path: &Path,
    ) -> LinuxPrerequisiteInspection {
        match crate::services::steam::SteamService::new()
            .winetricks_log_paths_for_app(app_id, Some(game_path))
            .await
        {
            Ok(paths) => Self::inspect_winetricks_log_paths(&paths).await,
            Err(error) => LinuxPrerequisiteInspection::unknown(format!(
                "Failed to locate Steam Proton prefix metadata: {}",
                error
            )),
        }
    }

    async fn inspect_winetricks_log_paths(paths: &[PathBuf]) -> LinuxPrerequisiteInspection {
        if paths.is_empty() {
            return LinuxPrerequisiteInspection::unknown(
                "Steam compatdata path could not be located",
            );
        }

        for path in paths {
            match fs::read_to_string(path).await {
                Ok(content) => {
                    return Self::inspect_winetricks_log_content(
                        &content,
                        Some(path.to_string_lossy().to_string()),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return LinuxPrerequisiteInspection {
                        installed: None,
                        installed_verbs: Vec::new(),
                        missing_verbs: LINUX_REQUIRED_WINETRICKS_VERBS
                            .iter()
                            .map(|verb| (*verb).to_string())
                            .collect(),
                        status_path: Some(path.to_string_lossy().to_string()),
                        error: Some(format!("Failed to read {}: {}", path.display(), error)),
                    };
                }
            }
        }

        LinuxPrerequisiteInspection {
            installed: Some(false),
            installed_verbs: Vec::new(),
            missing_verbs: LINUX_REQUIRED_WINETRICKS_VERBS
                .iter()
                .map(|verb| (*verb).to_string())
                .collect(),
            status_path: paths.first().map(|path| path.to_string_lossy().to_string()),
            error: Some("winetricks.log was not found for the Proton prefix".to_string()),
        }
    }

    fn inspect_winetricks_log_content(
        content: &str,
        status_path: Option<String>,
    ) -> LinuxPrerequisiteInspection {
        let installed_verbs = Self::parse_winetricks_log_verbs(content);
        let missing_verbs = LINUX_REQUIRED_WINETRICKS_VERBS
            .iter()
            .filter(|required| {
                !installed_verbs
                    .iter()
                    .any(|installed| installed.eq_ignore_ascii_case(required))
            })
            .map(|verb| (*verb).to_string())
            .collect::<Vec<_>>();

        LinuxPrerequisiteInspection {
            installed: Some(missing_verbs.is_empty()),
            installed_verbs,
            missing_verbs,
            status_path,
            error: None,
        }
    }

    fn parse_winetricks_log_verbs(content: &str) -> Vec<String> {
        let mut verbs = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let verb = trimmed
                .split_whitespace()
                .next()
                .unwrap_or(trimmed)
                .trim()
                .to_ascii_lowercase();
            if !verb.is_empty() && !verbs.iter().any(|existing| existing == &verb) {
                verbs.push(verb);
            }
        }
        verbs
    }

    async fn inspect_launch_log(path: &Path, fresh_after_ms: u64) -> Result<LaunchLogInspection> {
        let metadata = match fs::metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LaunchLogInspection::Missing);
            }
            Err(error) => return Err(error.into()),
        };

        let modified_at = Self::system_time_to_millis(metadata.modified().unwrap_or(UNIX_EPOCH));
        if modified_at < fresh_after_ms {
            return Ok(LaunchLogInspection::Stale { modified_at });
        }

        let bytes = fs::read(path).await.context("Failed to read Latest.log")?;
        let content = String::from_utf8_lossy(&bytes);
        if Self::content_confirms_melonloader_launch(&content) {
            Ok(LaunchLogInspection::Confirmed { modified_at })
        } else {
            Ok(LaunchLogInspection::NoMarker { modified_at })
        }
    }

    fn content_confirms_melonloader_launch(content: &str) -> bool {
        let lower = content.to_ascii_lowercase();
        lower.contains("melonloader")
            && (lower.contains("game name:")
                || lower.contains("loading mods")
                || lower.contains("loading plugins")
                || lower.contains("melon assembly loaded")
                || lower.contains("support module loaded")
                || lower.contains("scene loaded"))
    }

    fn system_time_to_millis(time: SystemTime) -> u64 {
        time.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn launch_verification_response(
        status: &str,
        confirmed: bool,
        log_path: PathBuf,
        modified_at: Option<u64>,
        message: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "status": status,
            "confirmed": confirmed,
            "logPath": log_path.to_string_lossy().to_string(),
            "modifiedAt": modified_at,
            "message": message,
        })
    }

    async fn run_protontricks(
        protontricks: &ProtontricksCommand,
        app_id: &str,
        verbs: &[&str],
    ) -> Result<()> {
        let mut command = tokio::process::Command::new(&protontricks.program);
        command
            .args(&protontricks.prefix_args)
            .arg(app_id)
            .args(verbs)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = command
            .output()
            .await
            .with_context(|| format!("Failed to run {}", protontricks.command_label))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no output".to_string()
        };

        Err(anyhow::anyhow!(
            "{} {} {} failed: {}",
            protontricks.command_label,
            app_id,
            verbs.join(" "),
            detail
        ))
    }

    async fn detect_protontricks() -> ProtontricksCommand {
        if tokio::process::Command::new("protontricks")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
        {
            return ProtontricksCommand {
                available: true,
                program: "protontricks".to_string(),
                prefix_args: Vec::new(),
                command_label: "protontricks".to_string(),
            };
        }

        if tokio::process::Command::new("flatpak")
            .args(["info", "com.github.Matoking.protontricks"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
        {
            return ProtontricksCommand {
                available: true,
                program: "flatpak".to_string(),
                prefix_args: vec![
                    "run".to_string(),
                    "com.github.Matoking.protontricks".to_string(),
                ],
                command_label: "flatpak run com.github.Matoking.protontricks".to_string(),
            };
        }

        ProtontricksCommand {
            available: false,
            program: "protontricks".to_string(),
            prefix_args: Vec::new(),
            command_label: "protontricks".to_string(),
        }
    }

    fn normalize_version(version: &str) -> String {
        let trimmed = version.trim();

        if let Some(stripped) = trimmed.strip_prefix("v0.7.") {
            if let Some(core) = stripped.strip_suffix(".0") {
                return format!("v0.7.{}", core);
            }
        }

        if let Some(stripped) = trimmed.strip_prefix("0.7.") {
            if let Some(core) = stripped.strip_suffix(".0") {
                return format!("0.7.{}", core);
            }
        }

        trimmed.to_string()
    }

    pub fn is_melon_loader_installed(&self, game_dir: &str) -> bool {
        let game_path = Path::new(game_dir);

        // Check for version.dll in root (case-insensitive check)
        let version_dll_lower = game_path.join("version.dll");
        let version_dll_upper = game_path.join("Version.dll");

        // Check for MelonLoader folder
        let melon_loader_folder = game_path.join("MelonLoader");

        let has_version_dll = version_dll_lower.exists() || version_dll_upper.exists();
        let has_melon_loader_folder = melon_loader_folder.exists() && melon_loader_folder.is_dir();

        // MelonLoader is installed if both version.dll and MelonLoader folder exist
        has_version_dll && has_melon_loader_folder
    }

    pub async fn get_installed_version(&self, game_dir: &str) -> Result<Option<String>> {
        if !self.is_melon_loader_installed(game_dir) {
            return Ok(None);
        }

        let melon_loader_folder = Path::new(game_dir).join("MelonLoader");

        // Try to read version from version.txt file
        let version_file = melon_loader_folder.join("version.txt");
        if version_file.exists() {
            match fs::read_to_string(&version_file).await {
                Ok(content) => {
                    let version = Self::normalize_version(content.trim());
                    if !version.is_empty() {
                        return Ok(Some(version));
                    }
                }
                Err(_) => {}
            }
        }

        // Try to extract from version.dll using PowerShell (Windows)
        #[cfg(target_os = "windows")]
        {
            let version_dll = Path::new(game_dir).join("version.dll");
            if version_dll.exists() {
                if let Ok(version) = self.extract_version_from_dll(&version_dll).await {
                    return Ok(Some(version));
                }
            }
        }

        Ok(None)
    }

    pub async fn write_installed_version(&self, game_dir: &str, version: &str) -> Result<String> {
        if !self.is_melon_loader_installed(game_dir) {
            return Err(anyhow::anyhow!(
                "Cannot record MelonLoader version because MelonLoader is not installed in {}",
                game_dir
            ));
        }

        let version = Self::normalize_version(version);
        if version.is_empty() {
            return Err(anyhow::anyhow!("MelonLoader version cannot be empty"));
        }

        let version_file = Path::new(game_dir).join("MelonLoader").join("version.txt");
        fs::write(&version_file, version.as_bytes())
            .await
            .with_context(|| format!("Failed to write {}", version_file.display()))?;

        Ok(version)
    }

    #[cfg(target_os = "windows")]
    async fn extract_version_from_dll(&self, dll_path: &Path) -> Result<String> {
        #[allow(unused_imports)] // Required for CommandExt trait methods
        use std::os::windows::process::CommandExt;
        use tokio::process::Command;

        let path_str = dll_path.to_string_lossy().replace('\'', "''");
        let output = Command::new("powershell")
            .arg("-Command")
            .arg(&format!(
                "(Get-Item '{}').VersionInfo.FileVersion",
                path_str
            ))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
            .output()
            .await
            .context("Failed to execute PowerShell command")?;

        if output.status.success() {
            let version = Self::normalize_version(String::from_utf8_lossy(&output.stdout).trim());
            if !version.is_empty() && version != "null" {
                return Ok(version);
            }
        }

        Err(anyhow::anyhow!("Failed to extract version from DLL"))
    }

    pub async fn install_melon_loader(
        &self,
        game_dir: &str,
        zip_path: &str,
    ) -> Result<serde_json::Value> {
        let game_path = Path::new(game_dir);
        let zip_file_path = Path::new(zip_path);

        if !zip_file_path.exists() {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("MelonLoader zip file not found: {}", zip_path)
            }));
        }

        if !game_path.exists() {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("Game directory does not exist: {}", game_dir)
            }));
        }

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir().join(format!("melonloader-{}", uuid::Uuid::new_v4()));

        fs::create_dir_all(&temp_dir)
            .await
            .context("Failed to create temp directory")?;

        let installed_files = match self
            .extract_and_install(&zip_file_path, game_path, &temp_dir)
            .await
        {
            Ok(files) => files,
            Err(e) => {
                let _ = fs::remove_dir_all(&temp_dir).await;
                return Ok(serde_json::json!({
                    "success": false,
                    "error": e.to_string()
                }));
            }
        };

        // Clean up temp directory
        let _ = fs::remove_dir_all(&temp_dir).await;

        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files
        }))
    }

    async fn extract_and_install(
        &self,
        zip_path: &Path,
        game_dir: &Path,
        temp_dir: &Path,
    ) -> Result<Vec<String>> {
        let file = std::fs::File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        // Extract all files to temp directory
        // First, collect all file data synchronously (before any await)
        let mut file_data = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;

            let file_name = file.name().to_string();
            let safe_path = Self::safe_archive_relative_path(&file_name)?;
            let is_dir = file_name.ends_with('/');

            let mut buffer = Vec::new();
            if !is_dir {
                file.read_to_end(&mut buffer)
                    .context("Failed to read file data from archive")?;
            }

            if let Some(safe_path) = safe_path {
                file_data.push((safe_path, is_dir, buffer));
            }
        }

        // Now do async operations with the collected data
        for (relative_path, is_dir, buffer) in file_data {
            let outpath = temp_dir.join(&relative_path);

            if is_dir {
                fs::create_dir_all(&outpath).await?;
            } else {
                if let Some(p) = outpath.parent() {
                    fs::create_dir_all(p).await?;
                }
                let mut outfile = fs::File::create(&outpath).await?;
                tokio::io::AsyncWriteExt::write_all(&mut outfile, &buffer).await?;
            }
        }

        let install_root = Self::find_melonloader_install_root(temp_dir)
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "MelonLoader archive did not contain version.dll and a MelonLoader folder"
                )
            })?;

        // Copy all items from the detected MelonLoader payload root to game_dir root.
        let mut installed_files = Vec::new();
        let mut entries = fs::read_dir(&install_root).await?;

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = game_dir.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_recursive(&entry_path, &dest_path)).await?;
                installed_files.push(format!("{}/", file_name));
            } else {
                fs::copy(&entry_path, &dest_path).await?;
                installed_files.push(file_name.to_string());
            }
        }

        if !self.is_melon_loader_installed(&game_dir.to_string_lossy()) {
            return Err(anyhow::anyhow!(
                "MelonLoader files were copied, but installation verification failed. Expected version.dll and MelonLoader/ under {}.",
                game_dir.display()
            ));
        }

        Ok(installed_files)
    }

    fn safe_archive_relative_path(name: &str) -> Result<Option<PathBuf>> {
        let mut relative = PathBuf::new();
        for component in Path::new(name).components() {
            match component {
                Component::Normal(part) => relative.push(part),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(anyhow::anyhow!(
                        "MelonLoader archive contains unsafe path: {}",
                        name
                    ));
                }
            }
        }

        if relative.as_os_str().is_empty() {
            Ok(None)
        } else {
            Ok(Some(relative))
        }
    }

    async fn find_melonloader_install_root(root: &Path) -> Result<Option<PathBuf>> {
        if Self::path_contains_melonloader_install(root).await {
            return Ok(Some(root.to_path_buf()));
        }

        let mut entries = fs::read_dir(root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !entry.file_type().await?.is_dir() {
                continue;
            }

            if let Some(found) = Box::pin(Self::find_melonloader_install_root(&path)).await? {
                return Ok(Some(found));
            }
        }

        Ok(None)
    }

    async fn path_contains_melonloader_install(path: &Path) -> bool {
        let melon_loader_folder = path.join("MelonLoader");
        let version_dll_lower = path.join("version.dll");
        let version_dll_upper = path.join("Version.dll");

        fs::metadata(&melon_loader_folder)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
            && (fs::metadata(&version_dll_lower).await.is_ok()
                || fs::metadata(&version_dll_upper).await.is_ok())
    }

    async fn copy_directory_recursive(&self, source: &Path, dest: &Path) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = dest.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_recursive(&entry_path, &dest_path)).await?;
            } else {
                fs::copy(&entry_path, &dest_path).await?;
            }
        }

        Ok(())
    }

    pub async fn uninstall_melon_loader(&self, game_dir: &str) -> Result<serde_json::Value> {
        let game_path = Path::new(game_dir);

        // Remove version.dll (check both cases)
        let version_dll_lower = game_path.join("version.dll");
        let version_dll_upper = game_path.join("Version.dll");

        if version_dll_lower.exists() {
            fs::remove_file(&version_dll_lower).await?;
        }
        if version_dll_upper.exists() {
            fs::remove_file(&version_dll_upper).await?;
        }

        // Remove MelonLoader folder
        let melon_loader_folder = game_path.join("MelonLoader");
        if melon_loader_folder.exists() {
            fs::remove_dir_all(&melon_loader_folder).await?;
        }

        Ok(serde_json::json!({
            "success": true,
            "message": "MelonLoader uninstalled successfully"
        }))
    }
}

struct ProtontricksCommand {
    available: bool,
    program: String,
    prefix_args: Vec<String>,
    command_label: String,
}

enum LaunchLogInspection {
    Confirmed { modified_at: u64 },
    Stale { modified_at: u64 },
    Missing,
    NoMarker { modified_at: u64 },
}

impl Default for MelonLoaderService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::MelonLoaderService;
    #[cfg(target_os = "linux")]
    use crate::services::filesystem::FileSystemService;
    #[cfg(target_os = "linux")]
    use crate::services::steam::SteamService;
    #[cfg(target_os = "linux")]
    use crate::types::{Environment, EnvironmentStatus, EnvironmentType, Runtime};
    use anyhow::Result;
    #[cfg(target_os = "linux")]
    use chrono::Utc;
    use std::io::Write;
    use std::path::Path;
    use tempfile::tempdir;
    use zip::write::FileOptions;

    #[test]
    fn linux_launch_options_apply_version_dll_override() {
        assert_eq!(
            MelonLoaderService::linux_melonloader_launch_options(),
            "WINEDLLOVERRIDES=\"version=n,b\" %command%"
        );
    }

    #[test]
    fn normalizes_four_part_07_versions() {
        assert_eq!(MelonLoaderService::normalize_version("0.7.2.0"), "0.7.2");
        assert_eq!(MelonLoaderService::normalize_version("v0.7.2.0"), "v0.7.2");
    }

    #[test]
    fn leaves_other_versions_unchanged() {
        assert_eq!(MelonLoaderService::normalize_version("0.8.0.0"), "0.8.0.0");
        assert_eq!(MelonLoaderService::normalize_version("1.0.0.0"), "1.0.0.0");
        assert_eq!(MelonLoaderService::normalize_version("0.7.2"), "0.7.2");
    }

    #[test]
    fn parses_winetricks_log_verbs_as_case_insensitive_tokens() {
        let verbs = MelonLoaderService::parse_winetricks_log_verbs(
            "\n# comment\nDOTNET6\nvcrun2015 installed\nvcrun2015\n",
        );

        assert_eq!(verbs, vec!["dotnet6", "vcrun2015"]);
    }

    #[test]
    fn winetricks_log_content_reports_required_linux_prerequisites() {
        let status = MelonLoaderService::inspect_winetricks_log_content(
            "dotnet6\nvcrun2015\n",
            Some("/tmp/winetricks.log".to_string()),
        );

        assert_eq!(status.installed, Some(true));
        assert!(status.missing_verbs.is_empty());
        assert_eq!(status.status_label(), "installed");
        assert_eq!(status.status_path.as_deref(), Some("/tmp/winetricks.log"));
    }

    #[test]
    fn winetricks_log_content_reports_missing_linux_prerequisites() {
        let status = MelonLoaderService::inspect_winetricks_log_content("dotnet6\n", None);

        assert_eq!(status.installed, Some(false));
        assert_eq!(status.missing_verbs, vec!["vcrun2015"]);
        assert_eq!(status.status_label(), "missing");
    }

    #[test]
    fn linux_prerequisite_selection_runs_only_missing_verbs() {
        let status = MelonLoaderService::inspect_winetricks_log_content("dotnet6\n", None);

        assert_eq!(
            MelonLoaderService::missing_linux_prerequisite_verbs(&status),
            vec!["vcrun2015"]
        );
    }

    #[test]
    fn linux_prerequisite_selection_skips_when_all_verbs_are_installed() {
        let status =
            MelonLoaderService::inspect_winetricks_log_content("dotnet6\nvcrun2015\n", None);

        assert!(MelonLoaderService::missing_linux_prerequisite_verbs(&status).is_empty());
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) -> Result<()> {
        let file = std::fs::File::create(path)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = FileOptions::default();

        for (name, contents) in entries {
            zip.start_file(*name, options)?;
            zip.write_all(contents)?;
        }

        zip.finish()?;
        Ok(())
    }

    #[tokio::test]
    async fn install_melon_loader_accepts_nested_archive_payload() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path().join("Schedule I");
        tokio::fs::create_dir_all(&game_dir).await?;
        let archive = temp.path().join("melonloader.zip");
        write_zip(
            &archive,
            &[
                ("MelonLoader.x64/version.dll", b"dll"),
                ("MelonLoader.x64/MelonLoader/MelonLoader.dll", b"loader"),
            ],
        )?;

        let result = MelonLoaderService::new()
            .install_melon_loader(
                game_dir.to_string_lossy().as_ref(),
                archive.to_string_lossy().as_ref(),
            )
            .await?;

        assert_eq!(result["success"], true);
        assert!(game_dir.join("version.dll").exists());
        assert!(game_dir
            .join("MelonLoader")
            .join("MelonLoader.dll")
            .exists());
        Ok(())
    }

    #[tokio::test]
    async fn write_installed_version_persists_status_version() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path().join("Schedule I");
        let melonloader_dir = game_dir.join("MelonLoader");
        tokio::fs::create_dir_all(&melonloader_dir).await?;
        tokio::fs::write(game_dir.join("version.dll"), b"dll").await?;
        tokio::fs::write(melonloader_dir.join("MelonLoader.dll"), b"loader").await?;

        let service = MelonLoaderService::new();
        let recorded = service
            .write_installed_version(game_dir.to_string_lossy().as_ref(), "v0.7.2.0")
            .await?;
        let detected = service
            .get_installed_version(game_dir.to_string_lossy().as_ref())
            .await?;

        assert_eq!(recorded, "v0.7.2");
        assert_eq!(detected.as_deref(), Some("v0.7.2"));
        Ok(())
    }

    #[tokio::test]
    async fn install_melon_loader_rejects_archives_without_payload_root() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path().join("Schedule I");
        tokio::fs::create_dir_all(&game_dir).await?;
        let archive = temp.path().join("melonloader.zip");
        write_zip(&archive, &[("readme.txt", b"not melonloader")])?;

        let result = MelonLoaderService::new()
            .install_melon_loader(
                game_dir.to_string_lossy().as_ref(),
                archive.to_string_lossy().as_ref(),
            )
            .await?;

        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .is_some_and(|message| message.contains("version.dll")));
        assert!(!game_dir.join("readme.txt").exists());
        Ok(())
    }

    #[tokio::test]
    async fn install_melon_loader_rejects_traversal_entries() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path().join("Schedule I");
        tokio::fs::create_dir_all(&game_dir).await?;
        let archive = temp.path().join("melonloader.zip");
        write_zip(
            &archive,
            &[
                ("../version.dll", b"dll"),
                ("MelonLoader/MelonLoader.dll", b"loader"),
            ],
        )?;

        let result = MelonLoaderService::new()
            .install_melon_loader(
                game_dir.to_string_lossy().as_ref(),
                archive.to_string_lossy().as_ref(),
            )
            .await?;

        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .is_some_and(|message| message.contains("unsafe path")));
        assert!(!temp.path().join("version.dll").exists());
        Ok(())
    }

    #[tokio::test]
    async fn verify_launch_after_confirms_fresh_melonloader_log() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path();
        let melonloader_dir = game_dir.join("MelonLoader");
        tokio::fs::create_dir_all(&melonloader_dir).await?;
        tokio::fs::write(game_dir.join("version.dll"), b"version").await?;
        tokio::fs::write(
            melonloader_dir.join("Latest.log"),
            "[00:00:01.000] MelonLoader\n[00:00:02.000] Game Name: Schedule I\n",
        )
        .await?;

        let launch_started_at =
            MelonLoaderService::system_time_to_millis(std::time::SystemTime::now())
                .saturating_sub(5_000);
        let status = MelonLoaderService::new()
            .verify_launch_after(
                game_dir.to_string_lossy().as_ref(),
                launch_started_at,
                Some(1_000),
            )
            .await?;

        assert_eq!(status["status"], "confirmed");
        assert_eq!(status["confirmed"], true);
        Ok(())
    }

    #[tokio::test]
    async fn verify_launch_after_skips_when_melonloader_is_not_installed() -> Result<()> {
        let temp = tempdir()?;
        let status = MelonLoaderService::new()
            .verify_launch_after(temp.path().to_string_lossy().as_ref(), 0, Some(1_000))
            .await?;

        assert_eq!(status["status"], "notInstalled");
        assert_eq!(status["confirmed"], false);
        Ok(())
    }

    #[tokio::test]
    async fn verify_launch_after_reports_stale_log_when_not_refreshed() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path();
        let melonloader_dir = game_dir.join("MelonLoader");
        tokio::fs::create_dir_all(&melonloader_dir).await?;
        tokio::fs::write(game_dir.join("version.dll"), b"version").await?;
        tokio::fs::write(
            melonloader_dir.join("Latest.log"),
            "[00:00:01.000] MelonLoader\n[00:00:02.000] Game Name: Schedule I\n",
        )
        .await?;

        let future_launch_started_at =
            MelonLoaderService::system_time_to_millis(std::time::SystemTime::now()) + 60_000;
        let status = MelonLoaderService::new()
            .verify_launch_after(
                game_dir.to_string_lossy().as_ref(),
                future_launch_started_at,
                Some(1_000),
            )
            .await?;

        assert_eq!(status["status"], "staleLog");
        assert_eq!(status["confirmed"], false);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_requirements_use_shortcut_app_id_for_custom_environment() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path().join("Schedule I Custom");
        tokio::fs::create_dir_all(&game_dir).await?;
        tokio::fs::write(game_dir.join("Schedule I.exe"), b"game").await?;

        let env = Environment {
            id: "custom-schedule-i".to_string(),
            name: "Custom Schedule I".to_string(),
            description: None,
            app_id: SteamService::get_steam_app_id(),
            branch: "main".to_string(),
            output_dir: game_dir.to_string_lossy().to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: Some(Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: Some(EnvironmentType::DepotDownloader),
        };

        let shortcut_app_id = crate::services::filesystem::FileSystemService::new()
            .schedule_i_shortcut_app_id_for_dir(&env.output_dir)?;
        let status = MelonLoaderService::new()
            .get_linux_requirements_status(&env)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Linux requirements status was not returned"))?;
        let commands = status["prerequisiteCommands"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("prerequisiteCommands was not an array"))?;
        let expected_app_id = shortcut_app_id.to_string();

        assert_eq!(status["appId"], SteamService::get_steam_app_id());
        assert_eq!(status["prerequisiteAppId"], shortcut_app_id.to_string());
        assert!(
            commands
                .iter()
                .all(|command| command.as_str().is_some_and(|value| value.contains(&expected_app_id))),
            "expected all prerequisite commands to use shortcut app id {shortcut_app_id}: {commands:?}"
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Requires live Steam, Schedule I, and Protontricks on Linux"]
    async fn live_linux_requirements_status_reads_steam_and_protontricks() -> Result<()> {
        let steam = SteamService::new();
        let installations = steam.detect_steam_installations().await?;
        let installation = installations
            .first()
            .ok_or_else(|| anyhow::anyhow!("Schedule I Steam installation was not detected"))?;
        let branch = steam
            .detect_installed_branch_for_installation(installation)
            .await?
            .unwrap_or_else(|| "main".to_string());

        let env = Environment {
            id: "steam-live-schedule-i".to_string(),
            name: "Steam Schedule I".to_string(),
            description: None,
            app_id: SteamService::get_steam_app_id(),
            branch,
            output_dir: installation.path.clone(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: Some(Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: installation.steamapps_dir.clone(),
            steam_manifest_path: installation.manifest_path.clone(),
            environment_type: Some(EnvironmentType::Steam),
        };

        let status = MelonLoaderService::new()
            .get_linux_requirements_status(&env)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Linux requirements status was not returned"))?;

        assert_eq!(status["appId"], SteamService::get_steam_app_id());
        assert_eq!(
            status["launchOptions"],
            MelonLoaderService::linux_melonloader_launch_options()
        );
        assert_eq!(status["protontricksInstalled"], true);
        assert_eq!(status["canInstallPrerequisites"], true);
        assert!(
            status["steamLaunchOptionsRepairable"]
                .as_bool()
                .unwrap_or(false),
            "Expected Steam launch options to be repairable"
        );
        assert!(
            status["steamLaunchOptionsPath"]
                .as_str()
                .is_some_and(|path| path.ends_with("localconfig.vdf")),
            "Expected Steam localconfig path in Linux requirements status"
        );

        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn live_launch_opted_in() -> bool {
        std::env::var("SIMM_LIVE_LAUNCH_GAME")
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    fn live_launch_timeout_ms() -> u64 {
        std::env::var("SIMM_LIVE_LAUNCH_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(60_000)
    }

    #[cfg(target_os = "linux")]
    fn live_launch_env_from_game_dir(
        id: &str,
        name: &str,
        game_dir: String,
        branch: String,
        environment_type: EnvironmentType,
        steamapps_dir: Option<String>,
        steam_manifest_path: Option<String>,
    ) -> Environment {
        Environment {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            app_id: SteamService::get_steam_app_id(),
            branch,
            output_dir: game_dir,
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: Some(Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir,
            steam_manifest_path,
            environment_type: Some(environment_type),
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Opt-in live smoke that starts Schedule I through Steam/Proton when SIMM_LIVE_LAUNCH_GAME=1"]
    async fn live_linux_launches_schedule_i_and_confirms_melonloader_log() -> Result<()> {
        if !live_launch_opted_in() {
            eprintln!(
                "Skipping live launch smoke: set SIMM_LIVE_LAUNCH_GAME=1 to start Schedule I through Steam."
            );
            return Ok(());
        }

        let melon_loader = MelonLoaderService::new();
        let explicit_game_dir = std::env::var("SIMM_LIVE_LAUNCH_ENV_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (env, launch_game_dir) = if let Some(game_dir) = explicit_game_dir {
            let executable = Path::new(&game_dir).join("Schedule I.exe");
            if !executable.exists() {
                anyhow::bail!(
                    "SIMM_LIVE_LAUNCH_ENV_DIR must point at a Schedule I folder containing Schedule I.exe: {}",
                    game_dir
                );
            }

            (
                live_launch_env_from_game_dir(
                    "live-custom-schedule-i",
                    "Live custom Schedule I",
                    game_dir.clone(),
                    "custom".to_string(),
                    EnvironmentType::DepotDownloader,
                    None,
                    None,
                ),
                Some(game_dir),
            )
        } else {
            let steam = SteamService::new();
            let installations = steam.detect_steam_installations().await?;
            let installation = installations
                .first()
                .ok_or_else(|| anyhow::anyhow!("Schedule I Steam installation was not detected"))?;
            let branch = steam
                .detect_installed_branch_for_installation(installation)
                .await?
                .unwrap_or_else(|| "main".to_string());

            let launch_options = steam.ensure_schedule_i_launch_options()?;
            eprintln!(
                "Steam Schedule I launch options configured before launch: {}, repairable: {}",
                launch_options.configured, launch_options.repairable
            );

            (
                live_launch_env_from_game_dir(
                    "live-steam-schedule-i",
                    "Live Steam Schedule I",
                    installation.path.clone(),
                    branch,
                    EnvironmentType::Steam,
                    installation.steamapps_dir.clone(),
                    installation.manifest_path.clone(),
                ),
                None,
            )
        };

        if !melon_loader.is_melon_loader_installed(&env.output_dir) {
            anyhow::bail!(
                "MelonLoader is not installed at {}. Install MelonLoader before running the live launch smoke.",
                env.output_dir
            );
        }

        let requirements = melon_loader
            .get_linux_requirements_status(&env)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Linux requirements status was not returned"))?;
        if requirements["protontricksInstalled"] != true {
            anyhow::bail!(
                "Protontricks is required before live launch verification. Status: {}",
                requirements
            );
        }
        if requirements["prerequisitesInstalled"] == false {
            anyhow::bail!(
                "MelonLoader Proton prerequisites are missing before live launch verification. Status: {}",
                requirements
            );
        }

        let launch_started_at =
            MelonLoaderService::system_time_to_millis(std::time::SystemTime::now());
        let launch_result = FileSystemService::new()
            .launch_game(launch_game_dir.as_deref(), Some("steam"))
            .await?;
        eprintln!("Launch request accepted through {launch_result}");

        let verification = melon_loader
            .verify_launch_after(
                &env.output_dir,
                launch_started_at,
                Some(live_launch_timeout_ms()),
            )
            .await?;

        assert_eq!(
            verification["confirmed"], true,
            "MelonLoader launch verification failed: {verification}"
        );
        assert_eq!(verification["status"], "confirmed");

        Ok(())
    }
}
