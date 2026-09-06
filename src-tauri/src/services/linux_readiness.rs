use crate::types::{
    LinuxDesktopSchemeStatus, LinuxReadinessCheck, LinuxReadinessCheckStatus, LinuxReadinessStatus,
    Platform,
};

#[derive(Clone)]
pub struct LinuxReadinessService;

impl LinuxReadinessService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_status(&self) -> LinuxReadinessStatus {
        if !cfg!(target_os = "linux") {
            return LinuxReadinessStatus {
                platform: current_platform(),
                available: false,
                summary: LinuxReadinessCheckStatus::NotApplicable,
                checks: vec![LinuxReadinessCheck {
                    id: "platform".to_string(),
                    label: "Linux compatibility".to_string(),
                    status: LinuxReadinessCheckStatus::NotApplicable,
                    detail: "Linux readiness checks only run on Linux hosts.".to_string(),
                    command: None,
                    path: None,
                }],
                scheme_handlers: Vec::new(),
            };
        }

        let mut checks = Vec::new();

        checks.push(check_steam());
        checks.push(check_protontricks().await);
        checks.push(check_depot_downloader().await);
        checks.push(check_dotnet_sdk_8().await);

        let scheme_handlers = check_desktop_scheme_handlers(&["simm", "nxm"]).await;
        checks.push(check_desktop_integration(&scheme_handlers));

        let summary = summarize_checks(&checks);

        LinuxReadinessStatus {
            platform: Platform::Linux,
            available: true,
            summary,
            checks,
            scheme_handlers,
        }
    }
}

fn current_platform() -> Platform {
    if cfg!(target_os = "linux") {
        Platform::Linux
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else {
        Platform::Windows
    }
}

fn summarize_checks(checks: &[LinuxReadinessCheck]) -> LinuxReadinessCheckStatus {
    if checks
        .iter()
        .any(|check| check.status == LinuxReadinessCheckStatus::Missing)
    {
        return LinuxReadinessCheckStatus::Missing;
    }

    if checks
        .iter()
        .any(|check| check.status == LinuxReadinessCheckStatus::Warning)
    {
        return LinuxReadinessCheckStatus::Warning;
    }

    if checks
        .iter()
        .any(|check| check.status == LinuxReadinessCheckStatus::Unknown)
    {
        return LinuxReadinessCheckStatus::Unknown;
    }

    LinuxReadinessCheckStatus::Ready
}

fn check_steam() -> LinuxReadinessCheck {
    match crate::services::steam::SteamService::get_steam_path() {
        Some(path) => LinuxReadinessCheck {
            id: "steam".to_string(),
            label: "Steam".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: "Steam was detected for Schedule I Proton launches.".to_string(),
            command: None,
            path: Some(path.to_string_lossy().to_string()),
        },
        None => LinuxReadinessCheck {
            id: "steam".to_string(),
            label: "Steam".to_string(),
            status: LinuxReadinessCheckStatus::Missing,
            detail: "Steam was not detected. SIMM needs Steam to launch Schedule I through Proton."
                .to_string(),
            command: None,
            path: None,
        },
    }
}

async fn check_protontricks() -> LinuxReadinessCheck {
    match detect_protontricks_command().await {
        Some(command) => LinuxReadinessCheck {
            id: "protontricks".to_string(),
            label: "Protontricks".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: "Protontricks is available for installing dotnet6 and vcrun2015 into Schedule I Proton prefixes.".to_string(),
            command: Some(command),
            path: None,
        },
        None => LinuxReadinessCheck {
            id: "protontricks".to_string(),
            label: "Protontricks".to_string(),
            status: LinuxReadinessCheckStatus::Missing,
            detail: "Install Protontricks before installing MelonLoader on Linux.".to_string(),
            command: Some("protontricks 3164500 dotnet6 && protontricks 3164500 vcrun2015".to_string()),
            path: None,
        },
    }
}

async fn detect_protontricks_command() -> Option<String> {
    if command_status("protontricks", &["--version"]).await {
        return Some("protontricks".to_string());
    }

    if command_status("flatpak", &["info", "com.github.Matoking.protontricks"]).await {
        return Some("flatpak run com.github.Matoking.protontricks".to_string());
    }

    None
}

async fn check_depot_downloader() -> LinuxReadinessCheck {
    match crate::utils::depot_downloader_detector::detect_depot_downloader().await {
        Ok(info) if info.installed => LinuxReadinessCheck {
            id: "depotDownloader".to_string(),
            label: "DepotDownloader".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: "DepotDownloader is available for managed game downloads.".to_string(),
            command: None,
            path: info.path,
        },
        Ok(info) => LinuxReadinessCheck {
            id: "depotDownloader".to_string(),
            label: "DepotDownloader".to_string(),
            status: LinuxReadinessCheckStatus::Warning,
            detail: info.install_hint,
            command: None,
            path: None,
        },
        Err(error) => LinuxReadinessCheck {
            id: "depotDownloader".to_string(),
            label: "DepotDownloader".to_string(),
            status: LinuxReadinessCheckStatus::Unknown,
            detail: format!("Could not inspect DepotDownloader: {error}"),
            command: None,
            path: None,
        },
    }
}

async fn check_dotnet_sdk_8() -> LinuxReadinessCheck {
    match dotnet_sdk_8_status().await {
        Ok(Some(version)) => LinuxReadinessCheck {
            id: "dotnetSdk8".to_string(),
            label: ".NET SDK 8".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: format!(
                "Detected .NET SDK {version}; MLVScan can install as a managed dotnet tool."
            ),
            command: Some("dotnet --list-sdks".to_string()),
            path: None,
        },
        Ok(None) => LinuxReadinessCheck {
            id: "dotnetSdk8".to_string(),
            label: ".NET SDK 8".to_string(),
            status: LinuxReadinessCheckStatus::Warning,
            detail: "System .NET SDK 8 was not detected. SIMM can install a private .NET SDK before installing MLVScan.".to_string(),
            command: Some("dotnet --list-sdks".to_string()),
            path: None,
        },
        Err(error) => LinuxReadinessCheck {
            id: "dotnetSdk8".to_string(),
            label: ".NET SDK 8".to_string(),
            status: LinuxReadinessCheckStatus::Warning,
            detail: format!(
                "Could not verify system .NET SDK 8 for MLVScan: {error}. SIMM can install a private .NET SDK if needed."
            ),
            command: Some("dotnet --list-sdks".to_string()),
            path: None,
        },
    }
}

async fn dotnet_sdk_8_status() -> Result<Option<String>, String> {
    let output = tokio::process::Command::new("dotnet")
        .arg("--list-sdks")
        .output()
        .await
        .map_err(|error| format!("dotnet was not available: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "dotnet --list-sdks failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(first_dotnet_sdk_8_version(&stdout))
}

fn first_dotnet_sdk_8_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let version = line.split_whitespace().next()?.trim();
        let major = version.split('.').next()?.parse::<u32>().ok()?;
        (major >= 8).then(|| version.to_string())
    })
}

async fn check_desktop_scheme_handlers(schemes: &[&str]) -> Vec<LinuxDesktopSchemeStatus> {
    let mut statuses = Vec::new();
    for scheme in schemes {
        statuses.push(check_desktop_scheme_handler(scheme).await);
    }
    statuses
}

async fn check_desktop_scheme_handler(scheme: &str) -> LinuxDesktopSchemeStatus {
    match query_linux_default_scheme_handler(scheme).await {
        Ok(Some(handler)) if linux_desktop_id_looks_like_simm(&handler) => {
            LinuxDesktopSchemeStatus {
                scheme: scheme.to_string(),
                handler: Some(handler),
                ready: true,
                detail: format!("{scheme}:// is registered to SIMM."),
            }
        }
        Ok(Some(handler)) => LinuxDesktopSchemeStatus {
            scheme: scheme.to_string(),
            handler: Some(handler.clone()),
            ready: false,
            detail: format!("{scheme}:// is currently registered to {handler}."),
        },
        Ok(None) => LinuxDesktopSchemeStatus {
            scheme: scheme.to_string(),
            handler: None,
            ready: false,
            detail: format!("No default Linux desktop handler is registered for {scheme}://."),
        },
        Err(error) => LinuxDesktopSchemeStatus {
            scheme: scheme.to_string(),
            handler: None,
            ready: false,
            detail: error,
        },
    }
}

fn check_desktop_integration(scheme_handlers: &[LinuxDesktopSchemeStatus]) -> LinuxReadinessCheck {
    let ready_count = scheme_handlers.iter().filter(|scheme| scheme.ready).count();
    let required_count = scheme_handlers.len();

    if ready_count == required_count {
        return LinuxReadinessCheck {
            id: "desktopIntegration".to_string(),
            label: "Desktop links".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: "simm:// and nxm:// links are registered to SIMM.".to_string(),
            command: Some("xdg-mime query default x-scheme-handler/nxm".to_string()),
            path: None,
        };
    }

    LinuxReadinessCheck {
        id: "desktopIntegration".to_string(),
        label: "Desktop links".to_string(),
        status: LinuxReadinessCheckStatus::Warning,
        detail: "Some Linux desktop link handlers are missing or point to another app. Use Repair Desktop Links after moving an AppImage or installing a new package.".to_string(),
        command: Some("xdg-mime query default x-scheme-handler/nxm".to_string()),
        path: None,
    }
}

async fn query_linux_default_scheme_handler(protocol: &str) -> Result<Option<String>, String> {
    let output = tokio::process::Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{protocol}")])
        .output()
        .await
        .map_err(|error| {
            format!("Failed to query Linux desktop scheme handler with xdg-mime: {error}")
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "xdg-mime could not query the Linux desktop scheme handler".to_string()
        } else {
            format!("xdg-mime could not query the Linux desktop scheme handler: {stderr}")
        });
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

pub(crate) fn linux_desktop_id_looks_like_simm(desktop_id: &str) -> bool {
    // These IDs are emitted by the Tauri deep-link plugin, the AppImage
    // installer, and the Flatpak manifest. Keep the list exact: readiness is
    // asserting ownership of a protocol handler, not doing a fuzzy product
    // name search that could accept another application's desktop file.
    const SIMM_DESKTOP_IDS: &[&str] = &[
        "simm.desktop",
        "simmrust.desktop",
        "simmrust-handler.desktop",
        "dev.lockwirelabs.simm.desktop",
        "com.s1devenvmanager.app.desktop",
        "schedule i mod manager.desktop",
        "schedule-i-mod-manager.desktop",
    ];

    let normalized = desktop_id.trim().to_ascii_lowercase();
    SIMM_DESKTOP_IDS.contains(&normalized.as_str())
}

async fn command_status(program: &str, args: &[&str]) -> bool {
    tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::{first_dotnet_sdk_8_version, linux_desktop_id_looks_like_simm, summarize_checks};
    use crate::types::{LinuxReadinessCheck, LinuxReadinessCheckStatus};

    #[test]
    fn linux_desktop_id_matching_accepts_packaged_simm_handlers() {
        assert!(linux_desktop_id_looks_like_simm(
            "Schedule I Mod Manager.desktop"
        ));
        assert!(linux_desktop_id_looks_like_simm(
            "schedule-i-mod-manager.desktop"
        ));
        assert!(linux_desktop_id_looks_like_simm(
            "com.s1devenvmanager.app.desktop"
        ));
        assert!(linux_desktop_id_looks_like_simm("simmrust.desktop"));
        assert!(linux_desktop_id_looks_like_simm("simmrust-handler.desktop"));
        assert!(linux_desktop_id_looks_like_simm(
            "dev.lockwirelabs.simm.desktop"
        ));
        assert!(linux_desktop_id_looks_like_simm("simm.desktop"));
        assert!(!linux_desktop_id_looks_like_simm("vortex.desktop"));
        assert!(!linux_desktop_id_looks_like_simm("nexusmods-app.desktop"));
        assert!(!linux_desktop_id_looks_like_simm(
            "another-schedule-mod-manager.desktop"
        ));
    }

    #[test]
    fn dotnet_sdk_detection_accepts_sdk_8_or_newer() {
        assert_eq!(
            first_dotnet_sdk_8_version(
                "7.0.410 [/usr/lib/dotnet/sdk]\n8.0.100 [/usr/lib/dotnet/sdk]\n"
            ),
            Some("8.0.100".to_string())
        );
        assert_eq!(
            first_dotnet_sdk_8_version("9.0.100 [/usr/lib/dotnet/sdk]\n"),
            Some("9.0.100".to_string())
        );
        assert_eq!(first_dotnet_sdk_8_version("6.0.420 [/sdk]\n"), None);
    }

    #[test]
    fn summarize_checks_prioritizes_missing_then_warning() {
        let ready = LinuxReadinessCheck {
            id: "ready".to_string(),
            label: "Ready".to_string(),
            status: LinuxReadinessCheckStatus::Ready,
            detail: String::new(),
            command: None,
            path: None,
        };
        let warning = LinuxReadinessCheck {
            status: LinuxReadinessCheckStatus::Warning,
            ..ready.clone()
        };
        let missing = LinuxReadinessCheck {
            status: LinuxReadinessCheckStatus::Missing,
            ..ready.clone()
        };

        assert_eq!(
            summarize_checks(&[ready.clone()]),
            LinuxReadinessCheckStatus::Ready
        );
        assert_eq!(
            summarize_checks(&[ready.clone(), warning]),
            LinuxReadinessCheckStatus::Warning
        );
        assert_eq!(
            summarize_checks(&[ready, missing]),
            LinuxReadinessCheckStatus::Missing
        );
    }
}
