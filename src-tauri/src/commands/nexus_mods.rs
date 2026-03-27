use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
#[cfg(target_os = "windows")]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(target_os = "windows")]
use winreg::RegKey;

static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> =
    Lazy::new(|| AsyncMutex::new(None));
const DEFAULT_NEXUS_OAUTH_CLIENT_ID: &str = "simm";
const NEXUS_V1_API_BASE: &str = "https://api.nexusmods.com/v1";
const NXM_PROTOCOL: &str = "nxm";
const SUPPORTED_NEXUS_GAME_ID: &str = "schedule1";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingNexusManualDownload {
    #[serde(default)]
    session_id: String,
    kind: String,
    game_id: String,
    mod_id: u32,
    file_id: u32,
    environment_id: Option<String>,
    runtime: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedNxmUrl {
    game_id: String,
    mod_id: u32,
    file_id: u32,
    key: String,
    expires: String,
    user_id: String,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowsProtocolBackup {
    existed: bool,
    default_value: Option<String>,
    url_protocol: Option<String>,
    command: Option<String>,
    default_icon: Option<String>,
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs() as i64
}

fn new_pending_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn env_or_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn oauth_client_id() -> Result<String, String> {
    let value = env_or_default("NEXUS_OAUTH_CLIENT_ID", DEFAULT_NEXUS_OAUTH_CLIENT_ID);
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("NEXUS_OAUTH_CLIENT_ID is empty".to_string());
    }
    Ok(trimmed.to_string())
}

fn oauth_scope() -> String {
    env_or_default("NEXUS_OAUTH_SCOPE", "openid public")
}

fn oauth_client_secret() -> Option<String> {
    std::env::var("NEXUS_OAUTH_CLIENT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn build_nexus_oauth_status_value(session: &Value) -> Value {
    let account = derive_account_summary(
        session.get("accessToken").and_then(|v| v.as_str()),
        session.get("userinfo"),
        session.get("account"),
    );
    let expires_at = session
        .get("expiresAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    json!({
        "connected": true,
        "expiresAt": expires_at,
        "account": account,
    })
}

fn should_require_manual_nexus_download(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("download-link request failed (403)")
        || normalized.contains("forbidden")
        || normalized.contains("requires website confirmation")
        || normalized.contains("confirm downloads")
        || normalized.contains("confirm the download")
        || normalized.contains("site confirmation")
        || normalized.contains("premium")
}

fn oauth_redirect_uri(prefer_localhost: bool) -> String {
    if prefer_localhost {
        env_or_default(
            "NEXUS_OAUTH_REDIRECT_URI_LOCALHOST",
            "http://127.0.0.1:8089/callback",
        )
    } else {
        env_or_default("NEXUS_OAUTH_REDIRECT_URI", "simm://oauth/nexus/callback")
    }
}

fn build_nexus_files_page_url(game_id: &str, mod_id: u32, _file_id: u32) -> String {
    format!(
        "https://www.nexusmods.com/{}/mods/{}?tab=files",
        game_id, mod_id
    )
}

fn parse_runtime_label(value: Option<&str>) -> Option<crate::types::Runtime> {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        Some(label) if label == "il2cpp" => Some(crate::types::Runtime::Il2cpp),
        Some(label) if label == "mono" => Some(crate::types::Runtime::Mono),
        _ => None,
    }
}

fn infer_runtime_from_file_name(file_name: &str) -> Option<crate::types::Runtime> {
    let lower = file_name.trim().to_ascii_lowercase();
    if lower.contains("il2cpp") {
        return Some(crate::types::Runtime::Il2cpp);
    }
    if lower.contains("mono") {
        return Some(crate::types::Runtime::Mono);
    }
    None
}

fn parse_nxm_callback_url(url: &str) -> Result<ParsedNxmUrl, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid nxm URL: {}", e))?;
    if parsed.scheme() != NXM_PROTOCOL {
        return Err("Expected an nxm:// URL".to_string());
    }

    let game_id = parsed
        .host_str()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.next().map(|value| value.to_string()))
        })
        .ok_or_else(|| "nxm URL is missing the game identifier".to_string())?;

    let segments: Vec<String> = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.trim().is_empty())
                .map(|segment| segment.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let segment_offset = if segments
        .first()
        .map(|value| value.eq_ignore_ascii_case(&game_id))
        .unwrap_or(false)
    {
        1
    } else {
        0
    };

    let mod_id = segments
        .get(segment_offset + 1)
        .filter(|_| {
            segments
                .get(segment_offset)
                .map(|value| value.eq_ignore_ascii_case("mods"))
                .unwrap_or(false)
        })
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "nxm URL is missing a valid mod ID".to_string())?;

    let file_id = segments
        .get(segment_offset + 3)
        .filter(|_| {
            segments
                .get(segment_offset + 2)
                .map(|value| value.eq_ignore_ascii_case("files"))
                .unwrap_or(false)
        })
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "nxm URL is missing a valid file ID".to_string())?;

    let query_params: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();

    let key = query_params
        .get("key")
        .cloned()
        .ok_or_else(|| "nxm URL is missing the download key".to_string())?;
    let expires = query_params
        .get("expires")
        .cloned()
        .ok_or_else(|| "nxm URL is missing the expiry value".to_string())?;
    let user_id = query_params
        .get("user_id")
        .or_else(|| query_params.get("userId"))
        .cloned()
        .ok_or_else(|| "nxm URL is missing the user id".to_string())?;

    Ok(ParsedNxmUrl {
        game_id,
        mod_id,
        file_id,
        key,
        expires,
        user_id,
    })
}

async fn get_nxm_download_links(
    access_token: &str,
    game_id: &str,
    mod_id: u32,
    file_id: u32,
    key: &str,
    expires: &str,
    user_id: &str,
) -> Result<Vec<String>, String> {
    let url = format!(
        "{}/games/{}/mods/{}/files/{}/download_link.json?key={}&expires={}&user_id={}",
        NEXUS_V1_API_BASE,
        game_id,
        mod_id,
        file_id,
        urlencoding::encode(key),
        urlencoding::encode(expires),
        urlencoding::encode(user_id)
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build Nexus manual download client: {}", e))?;

    let response = client
        .get(&url)
        .bearer_auth(access_token)
        .header("Application-Name", "Schedule I Mod Manager")
        .header("Application-Version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
        .map_err(|e| format!("Failed to request Nexus manual download links: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Nexus manual download response: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Nexus manual download-link request failed ({}): {}",
            status, body
        ));
    }

    let value = serde_json::from_str::<Value>(&body)
        .map_err(|e| format!("Invalid Nexus manual download response: {}", e))?;

    let links = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("URI")
                .or_else(|| item.get("uri"))
                .and_then(|v| v.as_str())
        })
        .map(|uri| uri.to_string())
        .collect::<Vec<_>>();

    if links.is_empty() {
        return Err("No Nexus manual download links returned".to_string());
    }

    Ok(links)
}

#[cfg(target_os = "windows")]
fn current_exe_path_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to resolve current executable path: {}", e))
}

#[cfg(target_os = "windows")]
fn current_exe_matches_command(command: &str) -> Result<bool, String> {
    let exe = current_exe_path_string()?.to_ascii_lowercase();
    Ok(command.to_ascii_lowercase().contains(&exe))
}

#[cfg(target_os = "windows")]
fn read_windows_protocol_backup(protocol: &str) -> Result<WindowsProtocolBackup, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{}", protocol);

    let Ok(root) = hkcu.open_subkey(&path) else {
        return Ok(WindowsProtocolBackup::default());
    };

    let command = root
        .open_subkey("shell\\open\\command")
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok());
    let default_icon = root
        .open_subkey("DefaultIcon")
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok());

    Ok(WindowsProtocolBackup {
        existed: true,
        default_value: root.get_value::<String, _>("").ok(),
        url_protocol: root.get_value::<String, _>("URL Protocol").ok(),
        command,
        default_icon,
    })
}

#[cfg(target_os = "windows")]
fn register_windows_protocol_handler(protocol: &str) -> Result<WindowsProtocolBackup, String> {
    let backup = read_windows_protocol_backup(protocol)?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{}", protocol);
    let (root, _) = hkcu
        .create_subkey(&path)
        .map_err(|e| format!("Failed to create protocol registry key: {}", e))?;

    let exe = current_exe_path_string()?;
    root.set_value("", &format!("URL:{} protocol", env!("CARGO_PKG_NAME")))
        .map_err(|e| format!("Failed to set protocol display name: {}", e))?;
    root.set_value("URL Protocol", &"")
        .map_err(|e| format!("Failed to set protocol marker: {}", e))?;

    let (icon_key, _) = root
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("Failed to create protocol icon key: {}", e))?;
    icon_key
        .set_value("", &format!("{},0", exe))
        .map_err(|e| format!("Failed to set protocol icon: {}", e))?;

    let (command_key, _) = root
        .create_subkey("shell\\open\\command")
        .map_err(|e| format!("Failed to create protocol command key: {}", e))?;
    command_key
        .set_value("", &format!("\"{}\" \"%1\"", exe))
        .map_err(|e| format!("Failed to set protocol command: {}", e))?;

    Ok(backup)
}

#[cfg(target_os = "windows")]
fn restore_windows_protocol_handler(
    protocol: &str,
    backup: Option<&WindowsProtocolBackup>,
) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\{}", protocol);

    let current_command = hkcu
        .open_subkey(format!(r"{}\shell\open\command", path))
        .ok()
        .and_then(|key| key.get_value::<String, _>("").ok());

    if let Some(command) = current_command.as_deref() {
        if !current_exe_matches_command(command)? {
            return Ok(());
        }
    } else {
        return Ok(());
    }

    match backup {
        Some(backup) if backup.existed => {
            let (root, _) = hkcu
                .create_subkey(&path)
                .map_err(|e| format!("Failed to restore protocol root key: {}", e))?;

            if let Some(default_value) = &backup.default_value {
                root.set_value("", default_value)
                    .map_err(|e| format!("Failed to restore protocol display name: {}", e))?;
            }

            match &backup.url_protocol {
                Some(value) => root
                    .set_value("URL Protocol", value)
                    .map_err(|e| format!("Failed to restore URL Protocol value: {}", e))?,
                None => {
                    let _ = root.delete_value("URL Protocol");
                }
            }

            match &backup.default_icon {
                Some(value) => {
                    let (icon_key, _) = root
                        .create_subkey("DefaultIcon")
                        .map_err(|e| format!("Failed to restore protocol icon key: {}", e))?;
                    icon_key
                        .set_value("", value)
                        .map_err(|e| format!("Failed to restore protocol icon: {}", e))?;
                }
                None => {
                    let _ = root.delete_subkey_all("DefaultIcon");
                }
            }

            match &backup.command {
                Some(value) => {
                    let (command_key, _) = root
                        .create_subkey("shell\\open\\command")
                        .map_err(|e| format!("Failed to restore protocol command key: {}", e))?;
                    command_key
                        .set_value("", value)
                        .map_err(|e| format!("Failed to restore protocol command: {}", e))?;
                }
                None => {
                    let _ = root.delete_subkey_all("shell");
                }
            }
        }
        _ => {
            if hkcu.open_subkey(&path).is_ok() {
                hkcu.delete_subkey_all(&path).map_err(|e| {
                    format!("Failed to remove temporary protocol registration: {}", e)
                })?;
            }
        }
    }

    Ok(())
}

fn base64url_sha256(input: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(input.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn generate_pkce_pair() -> (String, String) {
    let verifier = format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        now_epoch_seconds()
    );
    let challenge = base64url_sha256(&verifier);
    (verifier, challenge)
}

fn build_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    format!(
        "https://users.nexusmods.com/oauth/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&code_challenge_method=S256&code_challenge={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(state),
        urlencoding::encode(code_challenge)
    )
}

fn parse_callback_url(
    callback: &str,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    String,
> {
    let query = callback
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| "OAuth callback URL missing query string".to_string())?;

    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_description = None;

    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let decoded = urlencoding::decode(v)
            .map_err(|e| e.to_string())?
            .to_string();
        match k {
            "code" => code = Some(decoded),
            "state" => state = Some(decoded),
            "error" => error = Some(decoded),
            "error_description" => error_description = Some(decoded),
            _ => {}
        }
    }

    Ok((code, state, error, error_description))
}

async fn oauth_exchange_code_local(
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
    scope: &str,
) -> Result<Value, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", client_id.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code", code.to_string()),
        ("code_verifier", code_verifier.to_string()),
        ("scope", scope.to_string()),
    ];
    if let Some(secret) = oauth_client_secret() {
        form.push(("client_secret", secret));
    }

    let response = reqwest::Client::new()
        .post("https://users.nexusmods.com/oauth/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("OAuth token request failed: {}", e))?;

    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid OAuth token response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "OAuth token exchange failed ({}): {}",
            status, value
        ));
    }

    Ok(value)
}

async fn oauth_refresh_token_local(
    client_id: &str,
    refresh_token: &str,
    scope: &str,
) -> Result<Value, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "refresh_token".to_string()),
        ("client_id", client_id.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("scope", scope.to_string()),
    ];
    if let Some(secret) = oauth_client_secret() {
        form.push(("client_secret", secret));
    }

    let response = reqwest::Client::new()
        .post("https://users.nexusmods.com/oauth/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("OAuth refresh request failed: {}", e))?;

    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid OAuth refresh response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "OAuth token refresh failed ({}): {}",
            status, value
        ));
    }

    Ok(value)
}

async fn oauth_userinfo_local(access_token: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get("https://users.nexusmods.com/oauth/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("OAuth userinfo request failed: {}", e))?;

    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid OAuth userinfo response: {}", e))?;
    if !status.is_success() {
        return Err(format!("OAuth userinfo failed ({}): {}", status, value));
    }

    Ok(value)
}

async fn oauth_revoke_local(token: &str, client_id: &str) {
    let mut form: Vec<(&str, String)> = vec![
        ("token", token.to_string()),
        ("client_id", client_id.to_string()),
    ];
    if let Some(secret) = oauth_client_secret() {
        form.push(("client_secret", secret));
    }

    let _ = reqwest::Client::new()
        .post("https://users.nexusmods.com/oauth/revoke")
        .form(&form)
        .send()
        .await;
}
fn extract_boolish(value: Option<&Value>, needle: &str) -> bool {
    let needle_l = needle.to_ascii_lowercase();
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::String(v)) => v.to_ascii_lowercase().contains(&needle_l),
        Some(Value::Array(arr)) => arr.iter().any(|item| match item {
            Value::String(s) => s.to_ascii_lowercase().contains(&needle_l),
            Value::Object(map) => map.values().any(|v| {
                v.as_str()
                    .map(|s| s.to_ascii_lowercase().contains(&needle_l))
                    .unwrap_or(false)
            }),
            _ => false,
        }),
        _ => false,
    }
}

fn decode_jwt_payload(token: &str) -> Result<Value, String> {
    use base64::Engine as _;

    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "OAuth access token is not a JWT".to_string())?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| format!("Failed to decode OAuth access token payload: {}", e))?;

    serde_json::from_slice::<Value>(&decoded)
        .map_err(|e| format!("Failed to parse OAuth access token payload: {}", e))
}

fn role_matches(value: Option<&Value>, needle: &str) -> bool {
    let needle_l = needle.to_ascii_lowercase();
    match value {
        Some(Value::String(v)) => v.to_ascii_lowercase().contains(&needle_l),
        Some(Value::Array(arr)) => arr.iter().any(|item| role_matches(Some(item), needle)),
        Some(Value::Object(map)) => map.values().any(|item| role_matches(Some(item), needle)),
        _ => false,
    }
}

fn derive_account_flags_from_token(access_token: &str) -> Result<Option<(bool, bool)>, String> {
    let payload = decode_jwt_payload(access_token)?;
    let user = match payload.get("user") {
        Some(Value::Object(_)) => payload.get("user"),
        _ => None,
    };

    let Some(user) = user else {
        return Ok(None);
    };

    let membership_roles = user
        .get("membership_roles")
        .or_else(|| user.get("membershipRoles"));
    let roles = user.get("roles");

    if membership_roles.is_none() && roles.is_none() {
        return Ok(None);
    }

    let is_premium = role_matches(membership_roles, "premium")
        || role_matches(membership_roles, "lifetimepremium")
        || role_matches(roles, "premium")
        || role_matches(roles, "lifetimepremium");
    let is_supporter =
        role_matches(membership_roles, "supporter") || role_matches(roles, "supporter");

    Ok(Some((is_premium, is_supporter)))
}

fn extract_account_identity_from_token(
    access_token: &str,
) -> Result<Option<(String, Option<i64>)>, String> {
    let payload = decode_jwt_payload(access_token)?;
    let user = match payload.get("user") {
        Some(Value::Object(_)) => payload.get("user"),
        _ => None,
    };

    let Some(user) = user else {
        return Ok(None);
    };

    let user_name = user
        .get("username")
        .or_else(|| user.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let member_id = user
        .get("id")
        .or_else(|| user.get("member_id"))
        .or_else(|| user.get("memberId"))
        .and_then(|v| v.as_i64());

    match user_name {
        Some(name) => Ok(Some((name, member_id))),
        None => Ok(None),
    }
}

fn derive_account_flags(userinfo: &Value, access_token: &str) -> (bool, bool) {
    match derive_account_flags_from_token(access_token) {
        Ok(Some(flags)) => flags,
        Ok(None) | Err(_) => {
            let is_premium = extract_boolish(userinfo.get("is_premium"), "premium")
                || extract_boolish(userinfo.get("membership_roles"), "premium")
                || extract_boolish(userinfo.get("membershipRoles"), "premium")
                || extract_boolish(userinfo.get("roles"), "premium");
            let is_supporter = extract_boolish(userinfo.get("is_supporter"), "support")
                || extract_boolish(userinfo.get("membership_roles"), "support")
                || extract_boolish(userinfo.get("membershipRoles"), "support")
                || extract_boolish(userinfo.get("roles"), "support");
            (is_premium, is_supporter)
        }
    }
}

fn derive_account_summary(
    access_token: Option<&str>,
    userinfo: Option<&Value>,
    existing_account: Option<&Value>,
) -> Value {
    let token_identity =
        access_token.and_then(|token| extract_account_identity_from_token(token).ok().flatten());
    let flags_from_token =
        access_token.and_then(|token| derive_account_flags_from_token(token).ok().flatten());

    let flags = if let Some((is_premium, is_supporter)) = flags_from_token {
        (is_premium, is_supporter)
    } else if let (Some(info), Some(token)) = (userinfo, access_token) {
        derive_account_flags(info, token)
    } else {
        (
            existing_account
                .and_then(|account| account.get("isPremium"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            existing_account
                .and_then(|account| account.get("isSupporter"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        )
    };

    let requires_site_confirmation = !(flags.0 || flags.1);

    let name = token_identity
        .as_ref()
        .map(|(name, _)| name.clone())
        .or_else(|| {
            userinfo
                .and_then(|info| {
                    info.get("name")
                        .or_else(|| info.get("username"))
                        .or_else(|| info.get("preferred_username"))
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.to_string())
        })
        .or_else(|| {
            existing_account
                .and_then(|account| account.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    let member_id = token_identity
        .as_ref()
        .and_then(|(_, member_id)| *member_id)
        .or_else(|| {
            userinfo.and_then(|info| {
                info.get("member_id")
                    .or_else(|| info.get("memberId"))
                    .and_then(|v| v.as_i64())
            })
        })
        .or_else(|| {
            existing_account
                .and_then(|account| account.get("memberId"))
                .and_then(|v| v.as_i64())
        });

    json!({
        "name": name,
        "memberId": member_id,
        "isPremium": flags.0,
        "isSupporter": flags.1,
        "requiresSiteConfirmation": requires_site_confirmation,
        "canDirectDownload": !requires_site_confirmation,
    })
}

fn normalize_nexus_game_id(game_id: Option<&str>) -> String {
    let s = game_id.map(|s| s.trim()).unwrap_or("").to_string();
    if s.is_empty() {
        SUPPORTED_NEXUS_GAME_ID.to_string()
    } else {
        s
    }
}

async fn get_nexus_mods_service() -> Result<Arc<NexusModsService>, String> {
    let mut service = NEXUS_MODS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(NexusModsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn spawn_localhost_oauth_listener(db: Arc<SqlitePool>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:8089").await {
            Ok(listener) => listener,
            Err(_) => return,
        };

        let accepted = tokio::time::timeout(Duration::from_secs(600), listener.accept()).await;
        let (mut socket, _) = match accepted {
            Ok(Ok(pair)) => pair,
            _ => return,
        };

        let mut buffer = [0u8; 4096];
        let read_len = match socket.read(&mut buffer).await {
            Ok(n) => n,
            Err(_) => return,
        };

        if read_len == 0 {
            return;
        }

        let request = String::from_utf8_lossy(&buffer[..read_len]);
        let mut callback_url: Option<String> = None;
        if let Some(first_line) = request.lines().next() {
            let parts: Vec<&str> = first_line.split_whitespace().collect();
            if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("GET") {
                callback_url = Some(format!("http://127.0.0.1:8089{}", parts[1]));
            }
        }

        let response_body = "Nexus login received. You can close this tab and return to the app.";
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .as_bytes(),
            )
            .await;

        if let Some(url) = callback_url {
            if let Ok(settings) = SettingsService::new(db.clone()) {
                let _ = settings.save_nexus_oauth_last_callback_url(&url).await;
            }
        }
    });
}

async fn refresh_nexus_oauth_token_if_needed_inner(
    db: Arc<SqlitePool>,
) -> Result<Option<Value>, String> {
    let settings = SettingsService::new(db.clone()).map_err(|e| e.to_string())?;
    let mut session = match settings
        .get_nexus_oauth_session()
        .await
        .map_err(|e| e.to_string())?
    {
        Some(s) => s,
        None => return Ok(None),
    };

    let expires_at = session
        .get("expiresAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let now = now_epoch_seconds();
    if expires_at > now + 30 {
        return Ok(Some(session));
    }

    let refresh_token = session
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Nexus OAuth refresh token missing. Please login again.".to_string())?
        .to_string();

    let client_id = oauth_client_id()?;
    let scope = oauth_scope();
    let token = oauth_refresh_token_local(&client_id, &refresh_token, &scope).await?;

    let next_access = token
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "OAuth refresh response missing access_token".to_string())?;
    let next_refresh = token
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or(refresh_token.as_str());
    let next_scope = token
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or(&scope);
    let expires_in = token
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);

    session["accessToken"] = json!(next_access);
    session["refreshToken"] = json!(next_refresh);
    session["scope"] = json!(next_scope);
    session["expiresAt"] = json!(now_epoch_seconds() + expires_in);

    settings
        .save_nexus_oauth_session(&session)
        .await
        .map_err(|e| e.to_string())?;

    Ok(Some(session))
}

pub(crate) async fn get_valid_nexus_access_token(db: Arc<SqlitePool>) -> Result<String, String> {
    let session = refresh_nexus_oauth_token_if_needed_inner(db).await?;
    session
        .and_then(|s| {
            s.get("accessToken")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| "Nexus OAuth login required".to_string())
}

async fn clear_nxm_pending_download(db: Arc<SqlitePool>) -> Result<(), String> {
    let settings = SettingsService::new(db).map_err(|e| e.to_string())?;
    settings
        .clear_nexus_nxm_pending_download()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn ensure_nxm_runtime_registration(db: Arc<SqlitePool>) -> Result<(), String> {
    let settings = SettingsService::new(db).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let existing_backup = settings
            .get_nexus_nxm_protocol_backup()
            .await
            .map_err(|e| e.to_string())?;
        if existing_backup.is_none() {
            let backup = register_windows_protocol_handler(NXM_PROTOCOL)?;
            settings
                .save_nexus_nxm_protocol_backup(
                    &serde_json::to_value(backup).map_err(|e| e.to_string())?,
                )
                .await
                .map_err(|e| e.to_string())?;
        } else {
            let backup = register_windows_protocol_handler(NXM_PROTOCOL)?;
            settings
                .save_nexus_nxm_protocol_backup(
                    &serde_json::to_value(backup).map_err(|e| e.to_string())?,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) async fn cleanup_nxm_runtime_registration(db: Arc<SqlitePool>) -> Result<(), String> {
    let settings = SettingsService::new(db.clone()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let backup = settings
            .get_nexus_nxm_protocol_backup()
            .await
            .map_err(|e| e.to_string())?
            .map(|value| {
                serde_json::from_value::<WindowsProtocolBackup>(value).map_err(|e| e.to_string())
            })
            .transpose()?;

        restore_windows_protocol_handler(NXM_PROTOCOL, backup.as_ref())?;
    }

    clear_nxm_pending_download(db.clone()).await?;
    settings
        .clear_nexus_nxm_protocol_backup()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) async fn cleanup_stale_nxm_runtime_registration(
    db: Arc<SqlitePool>,
) -> Result<(), String> {
    cleanup_nxm_runtime_registration(db).await
}

fn build_nexus_mod_metadata(mod_info: &Value, game_id: &str, mod_id: u32, version: &str) -> Value {
    let source_url = format!("https://www.nexusmods.com/{}/mods/{}", game_id, mod_id);
    let mut metadata_obj = serde_json::Map::new();
    metadata_obj.insert("source".to_string(), json!("nexusmods"));
    metadata_obj.insert("sourceId".to_string(), json!(mod_id.to_string()));
    metadata_obj.insert("sourceVersion".to_string(), json!(version));
    metadata_obj.insert("sourceUrl".to_string(), json!(source_url));
    metadata_obj.insert(
        "modName".to_string(),
        json!(mod_info
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("Unknown Mod")),
    );
    metadata_obj.insert(
        "author".to_string(),
        json!(mod_info
            .get("author")
            .and_then(|a| a.as_str())
            .unwrap_or("Unknown")),
    );
    metadata_obj.insert(
        "summary".to_string(),
        json!(mod_info
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );
    metadata_obj.insert(
        "iconUrl".to_string(),
        json!(mod_info
            .get("picture_url")
            .or_else(|| mod_info.get("pictureUrl"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );
    metadata_obj.insert(
        "updatedAt".to_string(),
        json!(mod_info
            .get("updated_at")
            .or_else(|| mod_info.get("updatedAt"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );

    if let Some(downloads) = mod_info
        .get("mod_downloads")
        .or_else(|| mod_info.get("downloads"))
        .and_then(|v| v.as_u64())
    {
        metadata_obj.insert("downloads".to_string(), json!(downloads));
    }

    if let Some(endorsements) = mod_info
        .get("endorsement_count")
        .or_else(|| mod_info.get("endorsements"))
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().and_then(|n| i64::try_from(n).ok()))
        })
    {
        metadata_obj.insert("likesOrEndorsements".to_string(), json!(endorsements));
    }

    Value::Object(metadata_obj)
}

async fn complete_pending_nxm_download(
    app: &AppHandle,
    db: Arc<SqlitePool>,
    pending: Option<&PendingNexusManualDownload>,
    nxm: &ParsedNxmUrl,
    runtime_override: Option<crate::types::Runtime>,
    runtime_was_explicit: bool,
) -> Result<Value, String> {
    use crate::services::environment::EnvironmentService;
    use crate::services::mods::ModsService;

    let nexus_service = get_nexus_mods_service().await?;
    let mod_info = nexus_service
        .get_mod(&nxm.game_id, nxm.mod_id)
        .await
        .map_err(|e| format!("Failed to fetch mod info for mod {}: {}", nxm.mod_id, e))?;
    let files = nexus_service
        .get_mod_files(&nxm.game_id, nxm.mod_id)
        .await
        .map_err(|e| format!("Failed to fetch files for mod {}: {}", nxm.mod_id, e))?;

    let file_info = files
        .iter()
        .find(|f| f.get("file_id").and_then(|id| id.as_u64()) == Some(nxm.file_id as u64))
        .ok_or_else(|| format!("File {} not found in mod {}", nxm.file_id, nxm.mod_id))?;
    let access_token = get_valid_nexus_access_token(db.clone()).await?;
    let version = file_info
        .get("version")
        .and_then(|v| v.as_str())
        .or_else(|| file_info.get("mod_version").and_then(|v| v.as_str()))
        .unwrap_or("1.0.0")
        .to_string();
    let original_filename = file_info
        .get("file_name")
        .and_then(|f| f.as_str())
        .unwrap_or("");
    let runtime = runtime_override
        .or_else(|| pending.and_then(|value| parse_runtime_label(value.runtime.as_deref())))
        .or_else(|| infer_runtime_from_file_name(original_filename));
    let mods_service = ModsService::new(db.clone());

    let install_target = pending.and_then(|value| {
        let same_mod = value.mod_id == nxm.mod_id;
        if value.kind == "install" && same_mod {
            value.environment_id.clone()
        } else {
            None
        }
    });

    if runtime.is_none() && !runtime_was_explicit {
        return Ok(json!({
            "success": false,
            "runtimeSelectionRequired": true,
            "kind": if install_target.is_some() { "install" } else { "library" },
            "requestedKind": pending.map(|value| value.kind.clone()),
            "modId": nxm.mod_id,
            "fileId": nxm.file_id,
            "modName": mod_info.get("name").and_then(|value| value.as_str()).unwrap_or("Unknown Mod"),
            "fileName": original_filename,
            "version": version,
        }));
    }

    if install_target.is_some() {
        if let Some(existing_mod_id) = mods_service
            .find_existing_mod_storage_by_source_version(
                &nxm.mod_id.to_string(),
                &version,
                runtime.clone(),
            )
            .await
            .map_err(|e| e.to_string())?
        {
            let environment_id = install_target
                .clone()
                .ok_or_else(|| "Pending Nexus install is missing an environment id".to_string())?;
            let install_result = mods_service
                .install_storage_mod_to_envs(&existing_mod_id, vec![environment_id.clone()])
                .await
                .map_err(|e| e.to_string())?;
            return Ok(json!({
                "success": true,
                "kind": "install",
                "environmentId": environment_id,
                "storageId": existing_mod_id,
                "fromStorage": true,
                "result": install_result,
                "requestedKind": pending.map(|value| value.kind.clone()),
                "usedFallback": false,
            }));
        }
    }

    let first_url = get_nxm_download_links(
        &access_token,
        &nxm.game_id,
        nxm.mod_id,
        nxm.file_id,
        &nxm.key,
        &nxm.expires,
        &nxm.user_id,
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| "No Nexus manual download links returned".to_string())?;

    let context_label = if let Some(environment_id) = install_target.as_ref() {
        if let Ok(service) = EnvironmentService::new(db.clone()) {
            service
                .get_environment(environment_id)
                .await
                .ok()
                .flatten()
                .map(|env| env.name)
                .unwrap_or_else(|| "Nexus Mods".to_string())
        } else {
            "Nexus Mods".to_string()
        }
    } else {
        "Nexus Mods".to_string()
    };

    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("nexus-manual"),
        crate::types::TrackedDownloadKind::Mod,
        original_filename.to_string(),
        context_label,
        Some("Downloading archive".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(app, tracked_download.clone());

    let downloaded = nexus_api::download_from_url(&first_url, None)
        .await
        .map_err(|e| {
            let message = format!("Failed to download Nexus file from manual link: {}", e);
            let _ = crate::services::tracked_downloads::emit(
                app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            message
        })?;

    let default_filename = format!("nexusmods-{}-{}.zip", nxm.mod_id, nxm.file_id);
    let original_filename = if original_filename.is_empty() {
        &default_filename
    } else {
        original_filename
    };
    let archive_path = std::env::temp_dir().join(format!(
        "nexusmods-manual-{}-{}-{}",
        nxm.mod_id, nxm.file_id, original_filename
    ));
    tokio::fs::write(&archive_path, downloaded.bytes)
        .await
        .map_err(|e| {
            let message = format!("Failed to save manually downloaded Nexus file: {}", e);
            let _ = crate::services::tracked_downloads::emit(
                app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            message
        })?;
    let _ = crate::services::tracked_downloads::emit(
        app,
        crate::services::tracked_downloads::complete_file_download(
            &tracked_download,
            Some("Archive downloaded".to_string()),
        ),
    );

    let store_result = mods_service
        .store_mod_archive(
            &archive_path.to_string_lossy(),
            original_filename,
            runtime.clone(),
            Some(build_nexus_mod_metadata(
                &mod_info,
                &nxm.game_id,
                nxm.mod_id,
                &version,
            )),
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&archive_path).await;

    if install_target.is_none() {
        return Ok(json!({
            "success": true,
            "kind": "library",
            "storage": store_result,
            "modId": nxm.mod_id,
            "fileId": nxm.file_id,
            "requestedKind": pending.map(|value| value.kind.clone()),
            "usedFallback": pending
                .map(|value| value.mod_id != nxm.mod_id || value.file_id != nxm.file_id || value.kind != "library")
                .unwrap_or(true),
        }));
    }

    let environment_id = install_target
        .ok_or_else(|| "Pending Nexus install is missing an environment id".to_string())?;
    let storage_id = store_result
        .get("storageId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Stored Nexus archive did not return a storage ID".to_string())?
        .to_string();

    let env_service = EnvironmentService::new(db.clone()).map_err(|e| e.to_string())?;
    env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found for manual Nexus install".to_string())?;

    let install_result = mods_service
        .install_storage_mod_to_envs(&storage_id, vec![environment_id.clone()])
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "success": true,
        "kind": "install",
        "environmentId": environment_id,
        "storageId": storage_id,
        "storage": store_result,
        "result": install_result,
        "modId": nxm.mod_id,
        "fileId": nxm.file_id,
        "requestedKind": pending.map(|value| value.kind.clone()),
        "usedFallback": false,
    }))
}

#[tauri::command]
pub async fn begin_nexus_oauth_login(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    prefer_localhost: Option<bool>,
) -> Result<Value, String> {
    let client_id = oauth_client_id()?;
    let use_localhost = prefer_localhost.unwrap_or(false);
    let redirect_uri = oauth_redirect_uri(use_localhost);
    let scope = oauth_scope();
    let state = uuid::Uuid::new_v4().to_string();
    let (code_verifier, code_challenge) = generate_pkce_pair();

    let authorize_url =
        build_authorize_url(&client_id, &redirect_uri, &scope, &state, &code_challenge);

    let settings = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    settings
        .save_nexus_oauth_pending(&json!({
            "state": state,
            "codeVerifier": code_verifier,
            "redirectUri": redirect_uri,
            "createdAt": now_epoch_seconds(),
        }))
        .await
        .map_err(|e| e.to_string())?;
    settings
        .clear_nexus_oauth_last_callback_url()
        .await
        .map_err(|e| e.to_string())?;

    if use_localhost {
        spawn_localhost_oauth_listener(db.inner().clone()).await;
    }
    #[allow(deprecated)]
    app.shell()
        .open(authorize_url.clone(), None)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    Ok(json!({
        "authorizeUrl": authorize_url,
        "state": state,
        "redirectUri": redirect_uri,
    }))
}

#[tauri::command]
pub async fn complete_nexus_oauth_callback(
    db: State<'_, Arc<SqlitePool>>,
    callback_url: Option<String>,
) -> Result<Value, String> {
    let settings = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;

    let callback = match callback_url.filter(|u| !u.trim().is_empty()) {
        Some(url) => url,
        None => settings
            .get_nexus_oauth_last_callback_url()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No OAuth callback URL available yet".to_string())?,
    };

    let pending = settings
        .get_nexus_oauth_pending()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No pending Nexus OAuth login flow".to_string())?;

    let pending_state = pending
        .get("state")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid pending OAuth state".to_string())?;
    let code_verifier = pending
        .get("codeVerifier")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid pending PKCE verifier".to_string())?;
    let redirect_uri = pending
        .get("redirectUri")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid pending OAuth redirect URI".to_string())?;

    let (code_opt, state_opt, error_opt, error_description_opt) = parse_callback_url(&callback)?;

    if let Some(err) = error_opt {
        let description = error_description_opt.unwrap_or_default();
        return Err(format!(
            "Nexus OAuth authorization failed: {} {}",
            err, description
        ));
    }

    let code = code_opt.ok_or_else(|| "OAuth callback missing authorization code".to_string())?;

    let callback_state = state_opt.ok_or_else(|| "OAuth callback missing state".to_string())?;
    if callback_state != pending_state {
        return Err("OAuth callback state mismatch".to_string());
    }

    let client_id = oauth_client_id()?;
    let scope = oauth_scope();
    let token =
        oauth_exchange_code_local(&client_id, redirect_uri, &code, code_verifier, &scope).await?;

    let access_token = token
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "OAuth token response missing access_token".to_string())?;
    let userinfo = oauth_userinfo_local(access_token).await?;

    let account = derive_account_summary(Some(access_token), Some(&userinfo), None);

    let session = json!({
        "accessToken": access_token,
        "refreshToken": token.get("refresh_token").cloned().unwrap_or(Value::Null),
        "tokenType": token.get("token_type").cloned().unwrap_or(json!("Bearer")),
        "scope": token.get("scope").and_then(|v| v.as_str()).unwrap_or(&scope),
        "expiresAt": now_epoch_seconds() + token.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600),
        "account": account,
        "userinfo": userinfo,
        "lastCapabilityProbeAt": now_epoch_seconds(),
    });

    settings
        .save_nexus_oauth_session(&session)
        .await
        .map_err(|e| e.to_string())?;
    settings
        .clear_nexus_oauth_pending()
        .await
        .map_err(|e| e.to_string())?;
    settings
        .clear_nexus_oauth_last_callback_url()
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "success": true, "status": build_nexus_oauth_status_value(&session) }))
}

#[tauri::command]
pub async fn get_nexus_oauth_status(db: State<'_, Arc<SqlitePool>>) -> Result<Value, String> {
    let session = refresh_nexus_oauth_token_if_needed_inner(db.inner().clone()).await?;

    if let Some(session) = session {
        return Ok(build_nexus_oauth_status_value(&session));
    }

    Ok(json!({
        "connected": false,
        "account": {
            "isPremium": false,
            "isSupporter": false,
            "requiresSiteConfirmation": true,
            "canDirectDownload": false,
        }
    }))
}

#[tauri::command]
pub async fn logout_nexus_oauth(db: State<'_, Arc<SqlitePool>>) -> Result<Value, String> {
    let settings = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    if let Some(session) = settings
        .get_nexus_oauth_session()
        .await
        .map_err(|e| e.to_string())?
    {
        let access_token = session.get("accessToken").and_then(|v| v.as_str());
        let refresh_token = session.get("refreshToken").and_then(|v| v.as_str());
        let client_id = oauth_client_id().ok();
        if let (Some(token), Some(client_id)) = (refresh_token.or(access_token), client_id) {
            oauth_revoke_local(token, &client_id).await;
        }
    }

    settings
        .clear_nexus_oauth_session()
        .await
        .map_err(|e| e.to_string())?;
    settings
        .clear_nexus_oauth_pending()
        .await
        .map_err(|e| e.to_string())?;
    settings
        .clear_nexus_oauth_last_callback_url()
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn begin_nexus_manual_download_session(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    kind: String,
    mod_id: u32,
    file_id: u32,
    game_id: Option<String>,
    environment_id: Option<String>,
    runtime: Option<String>,
) -> Result<Value, String> {
    let kind = kind.trim().to_ascii_lowercase();
    if kind != "library" && kind != "install" {
        return Err("Unsupported Nexus manual download session kind".to_string());
    }

    if kind == "install"
        && environment_id
            .as_deref()
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
    {
        return Err("Nexus manual install requires an environment id".to_string());
    }

    let game_id = normalize_nexus_game_id(game_id.as_deref());
    let files_page_url = build_nexus_files_page_url(&game_id, mod_id, file_id);
    let created_at = now_epoch_seconds();

    let settings = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;

    let pending = PendingNexusManualDownload {
        session_id: new_pending_session_id(),
        kind: kind.clone(),
        game_id: game_id.clone(),
        mod_id,
        file_id,
        environment_id,
        runtime,
        created_at,
    };

    settings
        .save_nexus_nxm_pending_download(
            &serde_json::to_value(&pending).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;

    let db_for_cleanup = db.inner().clone();
    let session_id = pending.session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
        let Ok(settings) = SettingsService::new(db_for_cleanup.clone()) else {
            return;
        };
        let Ok(current) = settings.get_nexus_nxm_pending_download().await else {
            return;
        };
        let Some(current) = current else {
            return;
        };
        let Ok(current_pending) = serde_json::from_value::<PendingNexusManualDownload>(current)
        else {
            let _ = clear_nxm_pending_download(db_for_cleanup.clone()).await;
            return;
        };
        if (!current_pending.session_id.is_empty() && current_pending.session_id == session_id)
            || (current_pending.session_id.is_empty() && current_pending.created_at == created_at)
        {
            let _ = clear_nxm_pending_download(db_for_cleanup.clone()).await;
        }
    });

    #[allow(deprecated)]
    app.shell()
        .open(files_page_url.clone(), None)
        .map_err(|e| format!("Failed to open Nexus files page: {}", e))?;

    Ok(json!({
        "success": true,
        "kind": kind,
        "filesPageUrl": files_page_url,
        "modId": mod_id,
        "fileId": file_id,
        "gameId": game_id,
    }))
}

#[tauri::command]
pub async fn complete_nexus_manual_download_session(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    nxm_url: String,
    runtime_override: Option<String>,
) -> Result<Value, String> {
    let settings = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let pending = settings
        .get_nexus_nxm_pending_download()
        .await
        .map_err(|e| e.to_string())?
        .map(|value| {
            serde_json::from_value::<PendingNexusManualDownload>(value)
                .map_err(|e| format!("Invalid pending Nexus manual download session: {}", e))
        })
        .transpose()?;
    let nxm = parse_nxm_callback_url(&nxm_url)?;
    if normalize_nexus_game_id(Some(&nxm.game_id)) != SUPPORTED_NEXUS_GAME_ID {
        return Err(
            "SIMM only handles Schedule I Nexus downloads while it is open. Close SIMM to download Nexus mods for other games."
                .to_string(),
        );
    }
    let result = complete_pending_nxm_download(
        &app,
        db.inner().clone(),
        pending.as_ref(),
        &nxm,
        parse_runtime_label(runtime_override.as_deref()),
        runtime_override.is_some(),
    )
    .await;

    let requires_runtime_selection = matches!(
        &result,
        Ok(value) if value.get("runtimeSelectionRequired").and_then(|item| item.as_bool()) == Some(true)
    );

    let cleanup_result = if requires_runtime_selection {
        Ok(())
    } else if matches!(&result, Ok(value) if value.get("success").and_then(|item| item.as_bool()) == Some(true))
    {
        clear_nxm_pending_download(db.inner().clone()).await
    } else {
        Ok(())
    };

    match (result, cleanup_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Ok(json!({
            "success": false,
            "error": error,
            "requestedKind": pending.as_ref().map(|value| value.kind.clone()),
        })),
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(cleanup_error)) => {
            Err(format!("{}; cleanup failed: {}", error, cleanup_error))
        }
    }
}

#[tauri::command]
pub async fn cancel_nexus_manual_download_session(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Value, String> {
    clear_nxm_pending_download(db.inner().clone()).await?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn get_nexus_mods_games(_db: State<'_, Arc<SqlitePool>>) -> Result<Vec<Value>, String> {
    let service = get_nexus_mods_service().await?;
    service.get_games().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_nexus_mods_mods(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    query: String,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .search_mods(&game_id, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_latest_added(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .get_latest_added_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_latest_updated(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .get_latest_updated_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_trending(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .get_trending_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_mod(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
) -> Result<Value, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .get_mod(&game_id, mod_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_mod_files(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .get_mod_files(&game_id, mod_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_nexus_mods_mod_file(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
    file_id: u32,
) -> Result<String, String> {
    let service = get_nexus_mods_service().await?;
    let file_label = service
        .get_mod_files(&game_id, mod_id)
        .await
        .ok()
        .and_then(|files| {
            files
                .into_iter()
                .find(|f| f.get("file_id").and_then(|id| id.as_u64()) == Some(file_id as u64))
                .and_then(|file| {
                    file.get("file_name")
                        .or_else(|| file.get("name"))
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                })
        })
        .unwrap_or_else(|| format!("nexusmods-{}-{}.zip", mod_id, file_id));
    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("nexus"),
        crate::types::TrackedDownloadKind::Mod,
        file_label,
        "Nexus Mods",
        Some("Downloading archive".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    let token = get_valid_nexus_access_token(db.inner().clone()).await?;
    let bytes = service
        .download_mod_file(&token, &game_id, mod_id, file_id)
        .await
        .map_err(|e| {
            let message = e.to_string();
            let _ = crate::services::tracked_downloads::emit(
                &app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            message
        })?;

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("nexusmods-{}-{}.zip", mod_id, file_id));
    tokio::fs::write(&temp_file, bytes).await.map_err(|e| {
        let message = format!("Failed to save downloaded file: {}", e);
        let _ = crate::services::tracked_downloads::emit(
            &app,
            crate::services::tracked_downloads::fail_file_download(
                &tracked_download,
                message.clone(),
                Some("Download failed".to_string()),
            ),
        );
        message
    })?;
    let _ = crate::services::tracked_downloads::emit(
        &app,
        crate::services::tracked_downloads::complete_file_download(
            &tracked_download,
            Some("Archive downloaded".to_string()),
        ),
    );

    Ok(temp_file.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn check_nexus_mods_mod_update(
    db: State<'_, Arc<SqlitePool>>,
    game_domain: String,
    mod_id: u32,
    current_version: String,
) -> Result<Value, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .check_mod_update(&game_domain, mod_id, &current_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_nexus_mods_for_updates(
    db: State<'_, Arc<SqlitePool>>,
    game_domain: String,
    mods: Vec<(u32, String)>,
) -> Result<Vec<Value>, String> {
    let _ = db;
    let service = get_nexus_mods_service().await?;
    service
        .check_mods_for_updates(&game_domain, mods)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_nexus_mods_mod(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    game_id_param: Option<String>,
    mod_id: u32,
    file_id: u32,
    security_override: Option<bool>,
) -> Result<Value, String> {
    use crate::services::environment::EnvironmentService;
    use crate::services::mods::ModsService;

    let access_token = get_valid_nexus_access_token(db.inner().clone()).await?;

    let db_pool = db.inner().clone();
    let game_id = if let Some(ref id) = game_id_param {
        normalize_nexus_game_id(Some(id))
    } else {
        let mut settings_service =
            SettingsService::new(db_pool.clone()).map_err(|e| e.to_string())?;
        let settings = settings_service
            .load_settings()
            .await
            .map_err(|e| e.to_string())?;
        normalize_nexus_game_id(settings.nexus_mods_game_id.as_deref())
    };

    let env_service = EnvironmentService::new(db_pool.clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let runtime_str = match env.runtime {
        crate::types::Runtime::Il2cpp => "IL2CPP",
        crate::types::Runtime::Mono => "Mono",
    };

    let nexus_service = get_nexus_mods_service().await?;
    let mod_info = nexus_service
        .get_mod(&game_id, mod_id)
        .await
        .map_err(|e| format!("Failed to fetch mod info for mod {}: {}", mod_id, e))?;

    let files = nexus_service
        .get_mod_files(&game_id, mod_id)
        .await
        .map_err(|e| format!("Failed to fetch files for mod {}: {}", mod_id, e))?;

    let file_info = files
        .iter()
        .find(|f| f.get("file_id").and_then(|id| id.as_u64()) == Some(file_id as u64))
        .ok_or_else(|| format!("File {} not found in mod {}", file_id, mod_id))?;

    let version = file_info
        .get("version")
        .and_then(|v| v.as_str())
        .or_else(|| file_info.get("mod_version").and_then(|v| v.as_str()))
        .unwrap_or("1.0.0")
        .to_string();

    let mods_service = ModsService::new(db_pool.clone());
    if let Ok(Some(existing_mod_id)) = mods_service
        .find_existing_mod_storage_by_source_version(
            &mod_id.to_string(),
            &version,
            Some(env.runtime.clone()),
        )
        .await
    {
        let install_result = mods_service
            .install_storage_mod_to_envs(&existing_mod_id, vec![environment_id.clone()])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(json!({
            "success": true,
            "fromStorage": true,
            "result": install_result
        }));
    }

    let links = match nexus_service
        .get_oauth_download_links(&access_token, &game_id, mod_id, file_id)
        .await
    {
        Ok(links) => links,
        Err(error) if should_require_manual_nexus_download(&error.to_string()) => {
            return Ok(json!({
                "success": false,
                "requiresManualDownload": true,
                "modUrl": format!("https://www.nexusmods.com/{}/mods/{}", game_id, mod_id),
                "error": "This Nexus account must confirm downloads on Nexus Mods website.",
            }))
        }
        Err(error) => {
            return Err(format!(
                "Failed to request Nexus OAuth download links for mod {} file {}: {}",
                mod_id, file_id, error
            ))
        }
    };

    let first_url = links
        .first()
        .ok_or_else(|| "No Nexus download links returned".to_string())?
        .clone();
    let default_filename = format!("nexusmods-{}-{}.zip", mod_id, file_id);
    let original_filename = file_info
        .get("file_name")
        .and_then(|f| f.as_str())
        .unwrap_or(&default_filename);
    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("nexus-install"),
        crate::types::TrackedDownloadKind::Mod,
        original_filename.to_string(),
        env.name.clone(),
        Some("Downloading archive".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    let downloaded = nexus_api::download_from_url(&first_url, None)
        .await
        .map_err(|e| {
            let message = format!(
                "Failed to download file {} from mod {}: {}",
                file_id, mod_id, e
            );
            let _ = crate::services::tracked_downloads::emit(
                &app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            message
        })?;

    let temp_dir = std::env::temp_dir();
    let archive_path = temp_dir.join(format!(
        "nexusmods-{}-{}-{}",
        mod_id, file_id, original_filename
    ));
    tokio::fs::write(&archive_path, downloaded.bytes)
        .await
        .map_err(|e| {
            let message = format!("Failed to save downloaded file: {}", e);
            let _ = crate::services::tracked_downloads::emit(
                &app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            message
        })?;
    let _ = crate::services::tracked_downloads::emit(
        &app,
        crate::services::tracked_downloads::complete_file_download(
            &tracked_download,
            Some("Archive downloaded".to_string()),
        ),
    );

    let zip_path_str = archive_path.to_string_lossy().to_string();

    let mod_name = mod_info
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Unknown Mod")
        .to_string();
    let author = mod_info
        .get("author")
        .and_then(|a| a.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let source_url = format!("https://www.nexusmods.com/{}/mods/{}", game_id, mod_id);

    let mut metadata_obj = serde_json::Map::new();
    metadata_obj.insert("source".to_string(), json!("nexusmods"));
    metadata_obj.insert("sourceId".to_string(), json!(mod_id.to_string()));
    metadata_obj.insert("sourceVersion".to_string(), json!(version));
    metadata_obj.insert("sourceUrl".to_string(), json!(source_url));
    metadata_obj.insert("modName".to_string(), json!(mod_name));
    metadata_obj.insert("author".to_string(), json!(author));
    metadata_obj.insert(
        "summary".to_string(),
        json!(mod_info
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );
    metadata_obj.insert(
        "iconUrl".to_string(),
        json!(mod_info
            .get("picture_url")
            .or_else(|| mod_info.get("pictureUrl"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );
    metadata_obj.insert(
        "updatedAt".to_string(),
        json!(mod_info
            .get("updated_at")
            .or_else(|| mod_info.get("updatedAt"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()),
    );

    if let Some(downloads) = mod_info
        .get("mod_downloads")
        .or_else(|| mod_info.get("downloads"))
        .and_then(|v| v.as_u64())
    {
        metadata_obj.insert("downloads".to_string(), json!(downloads));
    }

    if let Some(endorsements) = mod_info
        .get("endorsement_count")
        .or_else(|| mod_info.get("endorsements"))
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_u64().and_then(|n| i64::try_from(n).ok()))
        })
    {
        metadata_obj.insert("likesOrEndorsements".to_string(), json!(endorsements));
    }

    let metadata = Value::Object(metadata_obj);

    let security_scan = crate::commands::mods::prepare_security_scan(
        db_pool.clone(),
        &zip_path_str,
        Some(metadata),
        security_override.unwrap_or(false),
    )
    .await?;

    let (metadata, security_report) = match security_scan {
        crate::commands::mods::SecurityGateResult::Continue { metadata, report } => {
            (metadata, report)
        }
        crate::commands::mods::SecurityGateResult::EarlyResponse(response) => {
            let _ = tokio::fs::remove_file(&archive_path).await;
            return Ok(response);
        }
    };

    let result = mods_service
        .install_zip_mod(
            &env.output_dir,
            &zip_path_str,
            original_filename,
            runtime_str,
            &env.branch,
            metadata,
        )
        .await
        .map_err(|e| format!("Failed to install mod {} file {}: {}", mod_id, file_id, e))?;

    let _ = tokio::fs::remove_file(&archive_path).await;

    Ok(crate::commands::mods::finalize_security_scan_response(
        &mods_service,
        result,
        security_report.as_ref(),
        "installing a Nexus mod archive",
    )
    .await)
}

#[cfg(test)]
mod tests {
    use super::{decode_jwt_payload, derive_account_flags};
    use serde_json::json;

    fn build_test_jwt(payload: serde_json::Value) -> String {
        use base64::Engine as _;

        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"alg":"none","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());

        format!("{}.{}.signature", header, payload)
    }

    #[test]
    fn decode_jwt_payload_reads_user_claims() {
        let token = build_test_jwt(json!({
            "sub": "12345",
            "user": {
                "id": 12345,
                "username": "TestAccount",
                "membership_roles": ["member", "premium", "lifetimepremium"]
            }
        }));

        let decoded = decode_jwt_payload(&token).expect("payload should decode");
        assert_eq!(
            decoded["user"]["membership_roles"],
            json!(["member", "premium", "lifetimepremium"])
        );
    }

    #[test]
    fn derive_account_flags_prefers_token_membership_roles() {
        let token = build_test_jwt(json!({
            "user": {
                "membership_roles": ["member", "supporter", "premium"]
            }
        }));

        let userinfo = json!({
            "roles": ["member"]
        });

        let (is_premium, is_supporter) = derive_account_flags(&userinfo, &token);
        assert!(is_premium);
        assert!(is_supporter);
    }

    #[test]
    fn derive_account_flags_falls_back_to_userinfo_when_token_has_no_roles() {
        let token = build_test_jwt(json!({
            "user": {
                "id": 12345
            }
        }));

        let userinfo = json!({
            "membershipRoles": ["supporter"]
        });

        let (is_premium, is_supporter) = derive_account_flags(&userinfo, &token);
        assert!(!is_premium);
        assert!(is_supporter);
    }
}
