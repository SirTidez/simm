use anyhow::{anyhow, Result};
use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Url;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::types::AppUpdateChannel;

const STABLE_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/SirTidez/simm/master/updater/stable/latest.json";
const BETA_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/SirTidez/simm/master/updater/beta/latest-beta.json";
const PLACEHOLDER_UPDATER_PUBKEY: &str = "REPLACE_WITH_SIMM_UPDATER_PUBLIC_KEY";

static VERSION_CORE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\d+(?:\.\d+)*").expect("version normalization regex should compile")
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateStatus {
    current_version: String,
    version: String,
    version_normalized: String,
    update_available: bool,
    notes: Option<String>,
    pub_date: Option<String>,
    channel: AppUpdateChannel,
    manifest_url: String,
    checked_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInstallResult {
    installed: bool,
    version: String,
    channel: AppUpdateChannel,
}

fn normalize_release_version(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    VERSION_CORE_REGEX
        .find(trimmed)
        .map(|m| m.as_str().trim_matches('.').to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn parse_channel(value: Option<String>) -> AppUpdateChannel {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("beta") => AppUpdateChannel::Beta,
        _ => AppUpdateChannel::Stable,
    }
}

fn manifest_url_for_channel(channel: &AppUpdateChannel) -> &'static str {
    match channel {
        AppUpdateChannel::Stable => STABLE_MANIFEST_URL,
        AppUpdateChannel::Beta => BETA_MANIFEST_URL,
    }
}

fn is_flatpak_runtime_with(flatpak_id: Option<&str>, flatpak_info_exists: bool) -> bool {
    flatpak_info_exists
        || flatpak_id
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

fn is_flatpak_runtime() -> bool {
    is_flatpak_runtime_with(
        std::env::var("FLATPAK_ID").ok().as_deref(),
        Path::new("/.flatpak-info").is_file(),
    )
}

fn updater_pubkey(app: &AppHandle) -> Result<String> {
    let build_time = option_env!("SIMM_UPDATER_PUBKEY")
        .unwrap_or(PLACEHOLDER_UPDATER_PUBKEY)
        .trim();
    if !build_time.is_empty() && build_time != PLACEHOLDER_UPDATER_PUBKEY {
        return Ok(build_time.to_string());
    }

    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != PLACEHOLDER_UPDATER_PUBKEY);

    configured
        .map(|value| value.to_string())
        .ok_or_else(|| anyhow!("SIMM updater public key is not configured"))
}

async fn build_update(
    app: &AppHandle,
    channel: AppUpdateChannel,
) -> Result<Option<tauri_plugin_updater::Update>> {
    let manifest_url = manifest_url_for_channel(&channel);
    let manifest = Url::parse(manifest_url)?;
    let pubkey = updater_pubkey(app)?;

    let updater = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![manifest])?
        .build()?;

    Ok(updater.check().await?)
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    let channel = parse_channel(channel);
    let manifest_url = manifest_url_for_channel(&channel).to_string();
    let current_version = app.package_info().version.to_string();

    // Flatpak owns its update lifecycle. Tauri's self-updater would otherwise
    // infer AppImage behavior and attempt to replace the immutable /app binary.
    if is_flatpak_runtime() {
        let status = AppUpdateStatus {
            current_version: current_version.clone(),
            version_normalized: normalize_release_version(&current_version),
            version: current_version,
            update_available: false,
            notes: None,
            pub_date: None,
            channel,
            manifest_url,
            checked_at: Utc::now().to_rfc3339(),
        };
        return serde_json::to_value(status).map_err(|error| error.to_string());
    }

    let status = match build_update(&app, channel.clone()).await {
        Ok(Some(update)) => AppUpdateStatus {
            current_version: update.current_version,
            version_normalized: normalize_release_version(&update.version),
            version: update.version,
            update_available: true,
            notes: update.body,
            pub_date: update.date.map(|date| date.to_string()),
            channel,
            manifest_url,
            checked_at: Utc::now().to_rfc3339(),
        },
        Ok(None) => AppUpdateStatus {
            current_version: current_version.clone(),
            version_normalized: normalize_release_version(&current_version),
            version: current_version,
            update_available: false,
            notes: None,
            pub_date: None,
            channel,
            manifest_url,
            checked_at: Utc::now().to_rfc3339(),
        },
        Err(error) => return Err(error.to_string()),
    };

    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    channel: Option<String>,
) -> Result<serde_json::Value, String> {
    if is_flatpak_runtime() {
        return Err(
            "SIMM is installed as a Flatpak. Install updates through your Flatpak distribution."
                .to_string(),
        );
    }

    let channel = parse_channel(channel);
    let Some(update) = build_update(&app, channel.clone())
        .await
        .map_err(|e| e.to_string())?
    else {
        return Err("No update is currently available".to_string());
    };

    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    let result = AppUpdateInstallResult {
        installed: true,
        version,
        channel,
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_flatpak_runtime_with, normalize_release_version, parse_channel};
    use crate::types::AppUpdateChannel;

    #[test]
    fn flatpak_detection_accepts_runtime_marker_or_flatpak_id() {
        assert!(is_flatpak_runtime_with(
            Some("dev.lockwirelabs.simm"),
            false
        ));
        assert!(is_flatpak_runtime_with(None, true));
        assert!(!is_flatpak_runtime_with(None, false));
        assert!(!is_flatpak_runtime_with(Some("   "), false));
    }

    #[test]
    fn update_channel_and_version_helpers_keep_existing_contract() {
        assert_eq!(
            parse_channel(Some("BETA".to_string())),
            AppUpdateChannel::Beta
        );
        assert_eq!(parse_channel(None), AppUpdateChannel::Stable);
        assert_eq!(normalize_release_version("v0.8.6-beta"), "0.8.6");
    }
}
