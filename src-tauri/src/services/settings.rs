use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json;
use sqlx::SqlitePool;
use tokio::fs;
use tokio::sync::{watch, Mutex, RwLock};

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use sha2::{Digest, Sha256};

use crate::types::{
    AppUpdateChannel, AppUpdateSettings, CustomThemeDefinition, Settings, WindowCloseBehavior,
};

pub struct SettingsService {
    pool: Arc<SqlitePool>,
}

/// The process-local settings snapshot used by long-lived backend services.
///
/// SQLite remains the durable source across launches. Keeping this snapshot in
/// process prevents background jobs from deserializing the same singleton row
/// on every wake-up, while `save_lock` makes read/merge/write updates atomic
/// within SIMM's single-instance process.
#[derive(Clone)]
pub struct RuntimeSettingsState {
    settings: Arc<RwLock<Settings>>,
    save_lock: Arc<Mutex<()>>,
    changes: watch::Sender<u64>,
}

impl RuntimeSettingsState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Arc::new(RwLock::new(settings)),
            save_lock: Arc::new(Mutex::new(())),
            changes: watch::channel(0).0,
        }
    }

    pub async fn snapshot(&self) -> Settings {
        self.settings.read().await.clone()
    }

    /// Replaces the runtime snapshot after startup migration/loading.
    pub async fn replace(&self, settings: Settings) {
        *self.settings.write().await = settings;
        self.bump_change_version();
    }

    /// Subscribe before calculating a wait deadline. Unlike `Notify`, the
    /// watch version retains a change that happens just before `changed()` is
    /// awaited, so schedulers cannot lose a reschedule request.
    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn notify_changed(&self) {
        self.bump_change_version();
    }

    fn bump_change_version(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    pub async fn save_settings(
        &self,
        pool: &SqlitePool,
        updates: serde_json::Value,
    ) -> Result<Settings> {
        let _save_guard = self.save_lock.lock().await;
        let current = self.snapshot().await;
        let current_json = serde_json::to_value(&current)?;
        let merged = SettingsService::sanitize_legacy_settings_value(SettingsService::merge_json(
            &current_json,
            &updates,
        ));
        let mut updated: Settings = serde_json::from_value(merged)?;
        updated.theme = SettingsService::normalize_theme_selection(&updated.theme);

        let content = serde_json::to_string(&updated).context("Failed to serialize settings")?;
        sqlx::query(
            "INSERT INTO settings (id, data) VALUES (?, ?) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(SETTINGS_ID)
        .bind(content)
        .execute(pool)
        .await
        .context("Failed to save settings")?;

        *self.settings.write().await = updated.clone();
        self.bump_change_version();
        Ok(updated)
    }
}

const SETTINGS_ID: i64 = 1;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTelemetryPreferences {
    close_behavior: Option<WindowCloseBehavior>,
}
const STEAM_CREDENTIALS_KEY: &str = "steam_credentials";
const NEXUS_MODS_API_KEY: &str = "nexus_mods_api_key";
const NEXUS_OAUTH_SESSION_KEY: &str = "nexus_oauth_session";
const NEXUS_OAUTH_PENDING_KEY: &str = "nexus_oauth_pending";
const NEXUS_OAUTH_LAST_CALLBACK_KEY: &str = "nexus_oauth_last_callback";
const NEXUS_NXM_PENDING_DOWNLOAD_KEY: &str = "nexus_nxm_pending_download";
const NEXUS_NXM_PROTOCOL_BACKUP_KEY: &str = "nexus_nxm_protocol_backup";
const THEMES_DIR_NAME: &str = "themes";
const INSTALLATION_KEY_FILE_NAME: &str = "credentials.key";
const INSTALLATION_KEY_ENVELOPE_PREFIX: &str = "SIMM_INSTALLATION_KEY_V1:";
const WINDOWS_INSTALLATION_KEY_ENVELOPE_PREFIX: &str = "SIMM_INSTALLATION_KEY_V2:DPAPI:";
const CREDENTIALS_ENVELOPE_PREFIX: &str = "v2";
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
// Stored API keys and auth sessions are intentionally small. Bound the value
// before hex decoding so a damaged database cannot trigger an unbounded
// allocation while trying to recover credentials.
const MAX_ENCRYPTED_SECRET_BYTES: usize = 1024 * 1024;
// This was the historic implicit production key. It is intentionally retained
// only to read existing ciphertext so it can be immediately re-encrypted with
// the per-installation key below.
const LEGACY_FALLBACK_ENCRYPTION_KEY: &str = "default-key-change-in-production";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CustomThemeFile {
    id: Option<String>,
    name: Option<String>,
    #[serde(default, alias = "extends", alias = "base")]
    base_theme: Option<String>,
    #[serde(default, alias = "tokens")]
    variables: HashMap<String, String>,
}

impl SettingsService {
    pub fn new(pool: Arc<SqlitePool>) -> Result<Self> {
        Ok(Self { pool })
    }

    pub fn default_settings() -> Settings {
        let platform = if cfg!(target_os = "windows") {
            crate::types::Platform::Windows
        } else if cfg!(target_os = "macos") {
            crate::types::Platform::Macos
        } else {
            crate::types::Platform::Linux
        };

        Settings {
            default_download_dir: dirs::home_dir()
                .map(|p| {
                    let mut path = p.to_path_buf();
                    path.push("SIMM");
                    path.to_string_lossy().to_string()
                })
                .unwrap_or_else(|| ".".to_string()),
            depot_downloader_path: None,
            steam_username: None,
            max_concurrent_downloads: 2,
            platform,
            language: "english".to_string(),
            theme: "modern-blue".to_string(),
            melon_loader_version: None,
            auto_install_melon_loader: Some(true),
            enable_security_scanner: Some(true),
            auto_install_security_scanner: Some(true),
            block_critical_scans: Some(true),
            prompt_on_high_scans: Some(true),
            show_security_scan_badges: Some(true),
            update_check_interval: Some(60),
            auto_check_updates: Some(true),
            log_level: Some(crate::types::LogLevel::Warn),
            nexus_mods_api_key: None,
            nexus_mods_rate_limits: None,
            nexus_mods_game_id: Some("schedule1".to_string()),
            nexus_mods_app_slug: None,
            thunderstore_game_id: Some("schedule-i".to_string()),
            auto_update_mods: None,
            mod_update_check_interval: None,
            mod_icon_cache_limit_mb: Some(500),
            database_backup_count: Some(10),
            log_retention_days: Some(7),
            app_update: Some(AppUpdateSettings {
                last_checked_at: None,
                last_seen_version_raw: None,
                last_seen_version_normalized: None,
                last_resolved_url: None,
                snoozed_until: None,
                skipped_version_normalized: None,
                channel: Some(AppUpdateChannel::Stable),
                by_channel: None,
            }),
            experience_mode: Some(crate::types::ExperienceMode::Player),
            show_advanced_game_tools: Some(false),
            window_close_behavior: Some(WindowCloseBehavior::Ask),
            setup_guide_completed: Some(false),
        }
    }

    fn key_from_material(key_str: &str) -> Key<Aes256Gcm> {
        let mut hasher = Sha256::new();
        hasher.update(key_str.as_bytes());
        let key_bytes = hasher.finalize();

        *Key::<Aes256Gcm>::from_slice(&key_bytes)
    }

    fn configured_encryption_key() -> Option<Key<Aes256Gcm>> {
        std::env::var("ENCRYPTION_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| Self::key_from_material(&value))
    }

    fn installation_key_path() -> Result<PathBuf> {
        Ok(crate::db::get_data_dir()?.join(INSTALLATION_KEY_FILE_NAME))
    }

    fn parse_raw_installation_key(contents: &str) -> Result<Key<Aes256Gcm>> {
        let encoded = contents
            .trim()
            .strip_prefix(INSTALLATION_KEY_ENVELOPE_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("Unsupported SIMM installation key format"))?;
        let bytes = hex::decode(encoded).context("Failed to decode SIMM installation key")?;
        if bytes.len() != 32 {
            return Err(anyhow::anyhow!(
                "SIMM installation key has an invalid length"
            ));
        }

        Ok(*Key::<Aes256Gcm>::from_slice(&bytes))
    }

    #[cfg(target_os = "windows")]
    fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>> {
        use winapi::um::dpapi::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN};
        use winapi::um::winbase::LocalFree;
        use winapi::um::wincrypt::DATA_BLOB;

        let mut input = DATA_BLOB {
            cbData: u32::try_from(data.len()).context("SIMM installation key is too large")?,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let succeeded = unsafe {
            CryptProtectData(
                &mut input,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error())
                .context("Windows DPAPI failed to protect the SIMM installation key");
        }

        let protected =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        let free_result = unsafe { LocalFree(output.pbData as _) };
        if !free_result.is_null() {
            return Err(std::io::Error::last_os_error())
                .context("Windows DPAPI output buffer could not be released");
        }
        Ok(protected)
    }

    #[cfg(target_os = "windows")]
    fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
        use winapi::um::dpapi::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN};
        use winapi::um::winbase::LocalFree;
        use winapi::um::wincrypt::DATA_BLOB;

        let mut input = DATA_BLOB {
            cbData: u32::try_from(data.len())
                .context("SIMM protected installation key is too large")?,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let succeeded = unsafe {
            CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error())
                .context("Windows DPAPI could not unprotect the SIMM installation key");
        }

        let plaintext =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe { LocalFree(output.pbData as _) };
        Ok(plaintext)
    }

    fn parse_installation_key(contents: &str) -> Result<(Key<Aes256Gcm>, bool)> {
        #[cfg(target_os = "windows")]
        if let Some(protected) = contents
            .trim()
            .strip_prefix(WINDOWS_INSTALLATION_KEY_ENVELOPE_PREFIX)
        {
            let decoded = hex::decode(protected).context("Failed to decode protected SIMM key")?;
            let raw = Self::dpapi_unprotect(&decoded)?;
            if raw.len() != 32 {
                return Err(anyhow::anyhow!(
                    "Windows DPAPI returned an invalid SIMM key length"
                ));
            }
            return Ok((*Key::<Aes256Gcm>::from_slice(&raw), false));
        }

        // V1 stores raw key material. It remains readable only long enough to
        // re-wrap it on Windows; new writes never use this format there.
        Ok((
            Self::parse_raw_installation_key(contents)?,
            cfg!(target_os = "windows"),
        ))
    }

    fn serialized_installation_key(key: &Key<Aes256Gcm>) -> Result<String> {
        #[cfg(target_os = "windows")]
        {
            return Ok(format!(
                "{}{}\n",
                WINDOWS_INSTALLATION_KEY_ENVELOPE_PREFIX,
                hex::encode(Self::dpapi_protect(key.as_slice())?)
            ));
        }
        #[cfg(not(target_os = "windows"))]
        Ok(format!(
            "{}{}\n",
            INSTALLATION_KEY_ENVELOPE_PREFIX,
            hex::encode(key.as_slice())
        ))
    }

    fn write_installation_key(path: &Path, key: &Key<Aes256Gcm>) -> Result<()> {
        use std::io::Write;

        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("SIMM installation key has no parent directory"))?;
        std::fs::create_dir_all(parent).context("Failed to create SIMM data directory")?;

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        let mut file = options
            .open(path)
            .context("Failed to create SIMM installation key")?;
        file.write_all(Self::serialized_installation_key(key)?.as_bytes())
            .context("Failed to write SIMM installation key")?;
        file.sync_all()
            .context("Failed to flush SIMM installation key")?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .context("Failed to restrict SIMM installation key permissions")?;
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn rewrap_legacy_installation_key(path: &Path, key: &Key<Aes256Gcm>) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::winbase::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

        let suffix = uuid::Uuid::new_v4();
        let staged = path.with_file_name(format!("credentials.key.{suffix}.staged"));
        Self::write_installation_key(&staged, key)?;

        let to_wide = |value: &Path| {
            value
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>()
        };
        let path_wide = to_wide(path);
        let staged_wide = to_wide(&staged);
        let replaced = unsafe {
            MoveFileExW(
                staged_wide.as_ptr(),
                path_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            return Err(std::io::Error::last_os_error()).context(
                "Failed to atomically re-wrap the legacy SIMM installation key with DPAPI",
            );
        }
        Ok(())
    }

    fn installation_encryption_key() -> Result<Key<Aes256Gcm>> {
        let path = Self::installation_key_path()?;
        match std::fs::read_to_string(&path) {
            Ok(contents) => {
                let (key, _needs_dpapi_rewrap) = Self::parse_installation_key(&contents)?;
                #[cfg(target_os = "windows")]
                if _needs_dpapi_rewrap {
                    Self::rewrap_legacy_installation_key(&path, &key)?;
                }
                Ok(key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let key = Aes256Gcm::generate_key(&mut OsRng);
                match Self::write_installation_key(&path, &key) {
                    Ok(()) => Ok(key),
                    Err(error)
                        if error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|io_error| {
                                io_error.kind() == std::io::ErrorKind::AlreadyExists
                            }) =>
                    {
                        let contents = std::fs::read_to_string(&path)
                            .context("Failed to read concurrently-created SIMM installation key")?;
                        Self::parse_installation_key(&contents).map(|(key, _)| key)
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error).context("Failed to read SIMM installation key"),
        }
    }

    fn get_encryption_key() -> Result<Key<Aes256Gcm>> {
        if let Some(key) = Self::configured_encryption_key() {
            return Ok(key);
        }

        Self::installation_encryption_key()
    }

    fn get_legacy_encryption_key() -> Key<Aes256Gcm> {
        Self::configured_encryption_key()
            .unwrap_or_else(|| Self::key_from_material(LEGACY_FALLBACK_ENCRYPTION_KEY))
    }

    async fn encrypt_credentials(data: &str) -> Result<String> {
        let key = Self::get_encryption_key()?;
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

        let ciphertext = cipher
            .encrypt(&nonce, data.as_bytes())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        Ok(format!(
            "{}:{}:{}",
            CREDENTIALS_ENVELOPE_PREFIX,
            hex::encode(nonce),
            hex::encode(ciphertext)
        ))
    }

    async fn decrypt_credentials(encrypted: &str) -> Result<(String, bool)> {
        let (key, encrypted, legacy) =
            match encrypted.strip_prefix(&format!("{}:", CREDENTIALS_ENVELOPE_PREFIX)) {
                Some(versioned) => (Self::get_encryption_key()?, versioned, false),
                None => (Self::get_legacy_encryption_key(), encrypted, true),
            };
        let cipher = Aes256Gcm::new(&key);

        let parts: Vec<&str> = encrypted.split(':').collect();
        if parts.len() != 2 {
            return Err(anyhow::anyhow!("Invalid encrypted format"));
        }

        let nonce_bytes = hex::decode(parts[0]).context("Failed to decode nonce")?;
        if nonce_bytes.len() != AES_GCM_NONCE_BYTES {
            return Err(anyhow::anyhow!(
                "Invalid credential nonce length: expected {AES_GCM_NONCE_BYTES} bytes"
            ));
        }
        if parts[1].len() > MAX_ENCRYPTED_SECRET_BYTES * 2 {
            return Err(anyhow::anyhow!("Encrypted credential value is too large"));
        }
        let ciphertext = hex::decode(parts[1]).context("Failed to decode ciphertext")?;
        if ciphertext.len() < AES_GCM_TAG_BYTES {
            return Err(anyhow::anyhow!(
                "Invalid credential ciphertext length: expected at least {AES_GCM_TAG_BYTES} bytes"
            ));
        }

        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))?;

        Ok((
            String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted data")?,
            legacy,
        ))
    }

    fn sanitize_legacy_settings_value(mut value: serde_json::Value) -> serde_json::Value {
        if let Some(settings) = value.as_object_mut() {
            if matches!(settings.get("theme"), Some(serde_json::Value::String(theme)) if theme == "custom")
            {
                settings.insert(
                    "theme".to_string(),
                    serde_json::Value::String("modern-blue".to_string()),
                );
            }
            settings.remove("customTheme");
            settings.remove("custom_theme");
        }

        value
    }

    fn normalize_builtin_theme_id(theme: &str) -> Option<&'static str> {
        if theme.eq_ignore_ascii_case("modern-blue") || theme.eq_ignore_ascii_case("custom") {
            Some("modern-blue")
        } else if theme.eq_ignore_ascii_case("dark") {
            Some("dark")
        } else if theme.eq_ignore_ascii_case("light") {
            Some("light")
        } else {
            None
        }
    }

    fn normalize_theme_selection(theme: &str) -> String {
        let trimmed = theme.trim();
        if trimmed.is_empty() {
            return "modern-blue".to_string();
        }

        Self::normalize_builtin_theme_id(trimmed)
            .unwrap_or(trimmed)
            .to_string()
    }

    fn themes_dir_path() -> Result<PathBuf> {
        let dir = crate::db::get_data_dir()?.join(THEMES_DIR_NAME);
        std::fs::create_dir_all(&dir).context("Failed to create themes directory")?;
        Ok(dir)
    }

    fn sanitize_theme_id(value: &str) -> String {
        let mut sanitized = String::with_capacity(value.len());
        let mut last_was_separator = false;

        for ch in value.chars() {
            if ch.is_ascii_alphanumeric() {
                sanitized.push(ch.to_ascii_lowercase());
                last_was_separator = false;
            } else if !last_was_separator {
                sanitized.push('-');
                last_was_separator = true;
            }
        }

        sanitized.trim_matches('-').to_string()
    }

    fn display_name_from_file_stem(value: &str) -> String {
        let words: Vec<String> = value
            .split(['-', '_', ' '])
            .filter(|segment| !segment.trim().is_empty())
            .map(|segment| {
                let mut chars = segment.chars();
                match chars.next() {
                    Some(first) => {
                        let mut word = String::new();
                        word.extend(first.to_uppercase());
                        word.push_str(chars.as_str());
                        word
                    }
                    None => String::new(),
                }
            })
            .filter(|segment| !segment.is_empty())
            .collect();

        if words.is_empty() {
            "Custom Theme".to_string()
        } else {
            words.join(" ")
        }
    }

    fn normalize_theme_file_content<'a>(content: &'a str) -> Cow<'a, str> {
        let trimmed = content.trim_start_matches('\u{feff}').trim();

        let unwrapped = if !trimmed.starts_with("```") {
            Cow::Borrowed(trimmed)
        } else {
            let mut lines = trimmed.lines();
            let first_line = lines.next().unwrap_or_default().trim();
            if !first_line.starts_with("```") {
                Cow::Borrowed(trimmed)
            } else {
                let mut inner = String::new();
                for line in lines {
                    if line.trim_start().starts_with("```") {
                        break;
                    }

                    if !inner.is_empty() {
                        inner.push('\n');
                    }
                    inner.push_str(line);
                }

                Cow::Owned(inner)
            }
        };

        let mut normalized = String::with_capacity(unwrapped.len());
        let mut inside_string = false;
        let mut escaped = false;
        let mut modified = false;

        for ch in unwrapped.chars() {
            if !inside_string {
                if ch == '"' {
                    inside_string = true;
                }
                normalized.push(ch);
                continue;
            }

            if escaped {
                normalized.push(ch);
                escaped = false;
                continue;
            }

            match ch {
                '\\' => {
                    normalized.push(ch);
                    escaped = true;
                }
                '"' => {
                    normalized.push(ch);
                    inside_string = false;
                }
                '\n' => {
                    normalized.push_str("\\n");
                    modified = true;
                }
                '\r' => {
                    normalized.push_str("\\r");
                    modified = true;
                }
                '\t' => {
                    normalized.push_str("\\t");
                    modified = true;
                }
                '\u{08}' => {
                    normalized.push_str("\\b");
                    modified = true;
                }
                '\u{0c}' => {
                    normalized.push_str("\\f");
                    modified = true;
                }
                control if control.is_control() => {
                    normalized.push_str(&format!("\\u{:04x}", control as u32));
                    modified = true;
                }
                _ => normalized.push(ch),
            }
        }

        if modified {
            Cow::Owned(normalized)
        } else {
            unwrapped
        }
    }

    async fn parse_custom_theme_file(path: &Path) -> Result<Option<CustomThemeDefinition>> {
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !extension.eq_ignore_ascii_case("json") {
            return Ok(None);
        }

        let content = fs::read_to_string(path)
            .await
            .with_context(|| format!("Failed to read custom theme {}", path.display()))?;
        let normalized_content = Self::normalize_theme_file_content(&content);
        let parsed: CustomThemeFile =
            serde_json::from_str(normalized_content.as_ref()).map_err(|err| {
                anyhow::anyhow!(
                    "Failed to parse custom theme {} at line {}, column {}: {}",
                    path.display(),
                    err.line(),
                    err.column(),
                    err
                )
            })?;

        let file_stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("custom-theme");
        let id = parsed
            .id
            .as_deref()
            .map(Self::sanitize_theme_id)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| Self::sanitize_theme_id(file_stem));

        if id.is_empty() {
            return Err(anyhow::anyhow!(
                "Custom theme {} did not provide a usable id or filename",
                path.display()
            ));
        }

        let variables = parsed
            .variables
            .into_iter()
            .filter(|(key, value)| key.starts_with("--") && !value.trim().is_empty())
            .collect();

        let base_theme = parsed
            .base_theme
            .as_deref()
            .and_then(Self::normalize_builtin_theme_id)
            .unwrap_or("modern-blue")
            .to_string();

        Ok(Some(CustomThemeDefinition {
            id,
            name: parsed
                .name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| Self::display_name_from_file_stem(file_stem)),
            base_theme,
            file_path: path.to_string_lossy().to_string(),
            variables,
        }))
    }

    pub fn get_themes_directory(&self) -> Result<PathBuf> {
        Self::themes_dir_path()
    }

    pub async fn list_custom_themes(&self) -> Result<Vec<CustomThemeDefinition>> {
        let dir = Self::themes_dir_path()?;
        let mut reader = fs::read_dir(&dir)
            .await
            .with_context(|| format!("Failed to read themes directory {}", dir.display()))?;
        let mut theme_paths = Vec::new();

        while let Some(entry) = reader
            .next_entry()
            .await
            .context("Failed to iterate theme directory entries")?
        {
            theme_paths.push(entry.path());
        }

        theme_paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));

        let mut themes = Vec::new();
        let mut seen_theme_ids = HashSet::new();

        for path in theme_paths {
            match Self::parse_custom_theme_file(&path).await {
                Ok(Some(theme)) => {
                    let normalized_id = theme.id.to_ascii_lowercase();
                    if matches!(
                        normalized_id.as_str(),
                        "light" | "dark" | "modern-blue" | "custom"
                    ) {
                        log::warn!(
                            "Skipping custom theme {} because id '{}' is reserved",
                            path.display(),
                            theme.id
                        );
                        continue;
                    }

                    if !seen_theme_ids.insert(normalized_id.clone()) {
                        log::warn!(
                            "Skipping custom theme {} because sanitized id '{}' already exists",
                            path.display(),
                            theme.id
                        );
                        continue;
                    }

                    themes.push(theme);
                }
                Ok(None) => {}
                Err(err) => log::warn!("Skipping invalid custom theme {}: {}", path.display(), err),
            }
        }

        themes.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        Ok(themes)
    }

    pub async fn load_settings(&mut self) -> Result<Settings> {
        let stored = sqlx::query_scalar::<_, String>("SELECT data FROM settings WHERE id = ?")
            .bind(SETTINGS_ID)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to load settings")?;

        if let Some(data) = stored {
            if let Ok(mut settings) = serde_json::from_str::<Settings>(&data) {
                settings.theme = Self::normalize_theme_selection(&settings.theme);
                self.migrate_window_close_behavior(&mut settings).await?;
                return Ok(settings);
            }

            if let Ok(raw_value) = serde_json::from_str::<serde_json::Value>(&data) {
                let sanitized = Self::sanitize_legacy_settings_value(raw_value);
                if let Ok(mut settings) = serde_json::from_value::<Settings>(sanitized) {
                    settings.theme = Self::normalize_theme_selection(&settings.theme);
                    self.migrate_window_close_behavior(&mut settings).await?;
                    log::warn!("Recovered persisted settings through legacy sanitization");
                    return Ok(settings);
                }
            }

            log::warn!("Stored settings could not be parsed; falling back to defaults");
        }

        Ok(Self::default_settings())
    }

    async fn migrate_window_close_behavior(&self, settings: &mut Settings) -> Result<()> {
        if settings.window_close_behavior.is_some() {
            return Ok(());
        }

        let legacy =
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_preferences WHERE id = ?")
                .bind(1_i64)
                .fetch_optional(&*self.pool)
                .await
                .context("Failed to load legacy telemetry close behavior")?
                .and_then(|data| serde_json::from_str::<LegacyTelemetryPreferences>(&data).ok())
                .and_then(|preferences| preferences.close_behavior)
                .unwrap_or_default();

        settings.window_close_behavior = Some(legacy);
        let content = serde_json::to_string(settings)
            .context("Failed to serialize migrated application settings")?;
        sqlx::query("UPDATE settings SET data = ? WHERE id = ?")
            .bind(content)
            .bind(SETTINGS_ID)
            .execute(&*self.pool)
            .await
            .context("Failed to migrate window close behavior into application settings")?;

        Ok(())
    }

    #[cfg(test)]
    pub async fn save_settings(&mut self, updates: serde_json::Value) -> Result<()> {
        let current = self.load_settings().await?;

        let current_json = serde_json::to_value(&current)?;
        let merged =
            Self::sanitize_legacy_settings_value(Self::merge_json(&current_json, &updates));
        let mut updated: Settings = serde_json::from_value(merged)?;
        updated.theme = Self::normalize_theme_selection(&updated.theme);

        let content = serde_json::to_string(&updated).context("Failed to serialize settings")?;
        sqlx::query(
            "INSERT INTO settings (id, data) VALUES (?, ?) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(SETTINGS_ID)
        .bind(content)
        .execute(&*self.pool)
        .await
        .context("Failed to save settings")?;

        Ok(())
    }

    fn merge_json(base: &serde_json::Value, updates: &serde_json::Value) -> serde_json::Value {
        match (base, updates) {
            (serde_json::Value::Object(base_map), serde_json::Value::Object(updates_map)) => {
                let mut merged = base_map.clone();
                for (key, value) in updates_map {
                    if value.is_object() && merged.get(key).and_then(|v| v.as_object()).is_some() {
                        merged[key] = Self::merge_json(&merged[key], value);
                    } else {
                        merged[key] = value.clone();
                    }
                }
                serde_json::Value::Object(merged)
            }
            _ => updates.clone(),
        }
    }

    async fn get_secret(&self, key: &str) -> Result<Option<String>> {
        let value = sqlx::query_scalar::<_, String>("SELECT encrypted FROM secrets WHERE key = ?")
            .bind(key)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to read secret")?;

        Ok(value)
    }

    async fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO secrets (key, encrypted) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET encrypted = excluded.encrypted",
        )
        .bind(key)
        .bind(value)
        .execute(&*self.pool)
        .await
        .context("Failed to save secret")?;

        Ok(())
    }

    async fn clear_secret(&self, key: &str) -> Result<()> {
        sqlx::query("DELETE FROM secrets WHERE key = ?")
            .bind(key)
            .execute(&*self.pool)
            .await
            .context("Failed to clear secret")?;

        Ok(())
    }

    /// Reads a secret encrypted by either the current per-installation key or
    /// the historic format. A successfully decoded legacy value is upgraded
    /// before it is returned, so the public legacy fallback is never used for
    /// a subsequent write.
    async fn decrypt_secret(&self, key: &str, encrypted: &str) -> Result<String> {
        let (decrypted, legacy) = Self::decrypt_credentials(encrypted).await?;
        if legacy {
            let migrated = Self::encrypt_credentials(&decrypted).await?;
            self.set_secret(key, &migrated).await?;
        }
        Ok(decrypted)
    }

    pub async fn get_credentials(&self) -> Result<Option<(String, String)>> {
        let encrypted = match self.get_secret(STEAM_CREDENTIALS_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(STEAM_CREDENTIALS_KEY, &encrypted)
            .await?;
        let creds: serde_json::Value =
            serde_json::from_str(&decrypted).context("Failed to parse credentials")?;

        let username = creds
            .get("username")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let password = creds
            .get("password")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        match (username, password) {
            (Some(u), Some(p)) => Ok(Some((u, p))),
            _ => Ok(None),
        }
    }

    pub async fn save_credentials(&self, username: String, password: String) -> Result<()> {
        let data = serde_json::json!({
            "username": username,
            "password": password
        });

        let encrypted = Self::encrypt_credentials(&data.to_string()).await?;
        self.set_secret(STEAM_CREDENTIALS_KEY, &encrypted).await
    }

    pub async fn clear_credentials(&self) -> Result<()> {
        self.clear_secret(STEAM_CREDENTIALS_KEY).await
    }

    pub async fn get_nexus_mods_api_key(&self) -> Result<Option<String>> {
        let encrypted = match self.get_secret(NEXUS_MODS_API_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self.decrypt_secret(NEXUS_MODS_API_KEY, &encrypted).await?;
        Ok(Some(decrypted))
    }

    pub async fn save_nexus_mods_api_key(&self, api_key: String) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&api_key).await?;
        self.set_secret(NEXUS_MODS_API_KEY, &encrypted).await
    }
    pub async fn clear_nexus_mods_api_key(&self) -> Result<()> {
        self.clear_secret(NEXUS_MODS_API_KEY).await
    }

    pub async fn get_nexus_oauth_session(&self) -> Result<Option<serde_json::Value>> {
        let encrypted = match self.get_secret(NEXUS_OAUTH_SESSION_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(NEXUS_OAUTH_SESSION_KEY, &encrypted)
            .await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus oauth session json")?;
        Ok(Some(parsed))
    }

    pub async fn save_nexus_oauth_session(&self, session: &serde_json::Value) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&session.to_string()).await?;
        self.set_secret(NEXUS_OAUTH_SESSION_KEY, &encrypted).await
    }

    pub async fn clear_nexus_oauth_session(&self) -> Result<()> {
        self.clear_secret(NEXUS_OAUTH_SESSION_KEY).await
    }

    pub async fn get_nexus_oauth_pending(&self) -> Result<Option<serde_json::Value>> {
        let encrypted = match self.get_secret(NEXUS_OAUTH_PENDING_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(NEXUS_OAUTH_PENDING_KEY, &encrypted)
            .await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus oauth pending json")?;
        Ok(Some(parsed))
    }

    pub async fn save_nexus_oauth_pending(&self, pending: &serde_json::Value) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&pending.to_string()).await?;
        self.set_secret(NEXUS_OAUTH_PENDING_KEY, &encrypted).await
    }

    pub async fn clear_nexus_oauth_pending(&self) -> Result<()> {
        self.clear_secret(NEXUS_OAUTH_PENDING_KEY).await
    }

    pub async fn save_nexus_oauth_last_callback_url(&self, callback_url: &str) -> Result<()> {
        let encrypted = Self::encrypt_credentials(callback_url).await?;
        self.set_secret(NEXUS_OAUTH_LAST_CALLBACK_KEY, &encrypted)
            .await
    }

    pub async fn get_nexus_oauth_last_callback_url(&self) -> Result<Option<String>> {
        let encrypted = match self.get_secret(NEXUS_OAUTH_LAST_CALLBACK_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(NEXUS_OAUTH_LAST_CALLBACK_KEY, &encrypted)
            .await?;
        Ok(Some(decrypted))
    }

    pub async fn clear_nexus_oauth_last_callback_url(&self) -> Result<()> {
        self.clear_secret(NEXUS_OAUTH_LAST_CALLBACK_KEY).await
    }

    pub async fn get_nexus_nxm_pending_download(&self) -> Result<Option<serde_json::Value>> {
        let encrypted = match self.get_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY, &encrypted)
            .await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus nxm pending download json")?;
        Ok(Some(parsed))
    }

    /// Atomically reserves the single pending Nexus manual-download slot.
    ///
    /// Nexus invokes SIMM's protocol callback without the originating session
    /// id, so more than one pending session cannot be correlated safely. An
    /// insert-on-conflict preserves the first session instead of allowing a
    /// concurrent start to overwrite it.
    pub async fn save_nexus_nxm_pending_download_if_absent(
        &self,
        pending: &serde_json::Value,
    ) -> Result<bool> {
        let encrypted = Self::encrypt_credentials(&pending.to_string()).await?;
        let result = sqlx::query(
            "INSERT INTO secrets (key, encrypted) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
        )
        .bind(NEXUS_NXM_PENDING_DOWNLOAD_KEY)
        .bind(encrypted)
        .execute(&*self.pool)
        .await
        .context("Failed to reserve nexus nxm pending download")?;

        Ok(result.rows_affected() == 1)
    }

    pub async fn clear_nexus_nxm_pending_download(&self) -> Result<()> {
        self.clear_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY).await
    }

    /// Clear a pending manual-download row only if it is still the exact
    /// session observed by the caller. The encrypted value is included in the
    /// DELETE predicate as a compare-and-swap version, preventing a newly
    /// saved session from being removed between the identity check and delete.
    pub async fn clear_nexus_nxm_pending_download_if_identity(
        &self,
        expected_session_id: &str,
        expected_created_at: i64,
    ) -> Result<bool> {
        let Some(encrypted) = self.get_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY).await? else {
            return Ok(false);
        };
        if encrypted.is_empty() {
            return Ok(false);
        }

        let (decrypted, _) = Self::decrypt_credentials(&encrypted).await?;
        let pending: serde_json::Value = serde_json::from_str(&decrypted)
            .context("Failed to parse nexus nxm pending download json")?;
        let current_session_id = pending
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let current_created_at = pending
            .get("createdAt")
            .and_then(|value| value.as_i64())
            .unwrap_or_default();
        let identity_matches = if expected_session_id.is_empty() {
            current_session_id.is_empty() && current_created_at == expected_created_at
        } else {
            current_session_id == expected_session_id
        };
        if !identity_matches {
            return Ok(false);
        }

        let result = sqlx::query("DELETE FROM secrets WHERE key = ? AND encrypted = ?")
            .bind(NEXUS_NXM_PENDING_DOWNLOAD_KEY)
            .bind(&encrypted)
            .execute(&*self.pool)
            .await
            .context("Failed to conditionally clear nexus nxm pending download")?;
        Ok(result.rows_affected() == 1)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub async fn get_nexus_nxm_protocol_backup(&self) -> Result<Option<serde_json::Value>> {
        let encrypted = match self.get_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = self
            .decrypt_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY, &encrypted)
            .await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus nxm protocol backup json")?;
        Ok(Some(parsed))
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub async fn save_nexus_nxm_protocol_backup(&self, backup: &serde_json::Value) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&backup.to_string()).await?;
        self.set_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY, &encrypted)
            .await
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub async fn clear_nexus_nxm_protocol_backup(&self) -> Result<()> {
        self.clear_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY).await
    }
}

impl Clone for SettingsService {
    fn clone(&self) -> Self {
        Self {
            pool: Arc::clone(&self.pool),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use serial_test::serial;
    use sqlx::Row;
    use tempfile::tempdir;

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

        fn unset(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            std::env::remove_var(key);
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

    async fn encrypt_legacy_credentials_for_test(data: &str) -> Result<String> {
        let key = SettingsService::get_legacy_encryption_key();
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, data.as_bytes())
            .map_err(|error| anyhow::anyhow!("legacy encryption failed: {error}"))?;
        Ok(format!(
            "{}:{}",
            hex::encode(nonce),
            hex::encode(ciphertext)
        ))
    }

    #[tokio::test]
    #[serial]
    async fn save_and_load_settings_merges_updates() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let mut service = SettingsService::new(pool)?;

        let updates = serde_json::json!({
            "maxConcurrentDownloads": 5,
            "theme": "dark",
            "databaseBackupCount": 12,
            "logRetentionDays": 10,
            "autoCheckUpdates": false
        });

        service.save_settings(updates).await?;
        let loaded = service.load_settings().await?;

        assert_eq!(loaded.max_concurrent_downloads, 5);
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.database_backup_count, Some(12));
        assert_eq!(loaded.log_retention_days, Some(10));
        assert_eq!(loaded.auto_check_updates, Some(false));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn runtime_settings_serializes_concurrent_partial_updates() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let mut service = SettingsService::new(pool.clone())?;
        let state = RuntimeSettingsState::new(service.load_settings().await?);

        let first = state.save_settings(
            &pool,
            serde_json::json!({
                "maxConcurrentDownloads": 7
            }),
        );
        let second = state.save_settings(
            &pool,
            serde_json::json!({
                "autoCheckUpdates": false
            }),
        );
        let (first, second) = tokio::join!(first, second);
        first?;
        second?;

        let snapshot = state.snapshot().await;
        assert_eq!(snapshot.max_concurrent_downloads, 7);
        assert_eq!(snapshot.auto_check_updates, Some(false));

        let persisted = service.load_settings().await?;
        assert_eq!(persisted.max_concurrent_downloads, 7);
        assert_eq!(persisted.auto_check_updates, Some(false));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn runtime_settings_snapshot_is_not_changed_by_direct_database_mutation() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let state = RuntimeSettingsState::new(SettingsService::default_settings());
        let mut externally_written = SettingsService::default_settings();
        externally_written.max_concurrent_downloads = 99;
        sqlx::query("INSERT INTO settings (id, data) VALUES (?, ?)")
            .bind(SETTINGS_ID)
            .bind(serde_json::to_string(&externally_written)?)
            .execute(&*pool)
            .await?;

        assert_eq!(state.snapshot().await.max_concurrent_downloads, 2);
        Ok(())
    }

    #[tokio::test]
    async fn failed_runtime_settings_write_does_not_publish_snapshot() -> Result<()> {
        let pool = SqlitePool::connect("sqlite::memory:").await?;
        let state = RuntimeSettingsState::new(SettingsService::default_settings());

        assert!(state
            .save_settings(&pool, serde_json::json!({"maxConcurrentDownloads": 9}))
            .await
            .is_err());
        assert_eq!(state.snapshot().await.max_concurrent_downloads, 2);
        Ok(())
    }

    #[tokio::test]
    async fn runtime_settings_change_version_is_retained_for_late_waiter() {
        let state = RuntimeSettingsState::new(SettingsService::default_settings());
        let mut changes = state.subscribe_changes();
        state.notify_changed();

        tokio::time::timeout(std::time::Duration::from_millis(100), changes.changed())
            .await
            .expect("retained change should wake a late waiter")
            .expect("sender remains alive");
    }

    #[tokio::test]
    #[serial]
    async fn migrates_legacy_telemetry_close_behavior_into_application_settings() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let mut service = SettingsService::new(pool.clone())?;
        let mut legacy_settings = service.load_settings().await?;
        legacy_settings.window_close_behavior = None;

        sqlx::query("INSERT INTO settings (id, data) VALUES (?, ?)")
            .bind(SETTINGS_ID)
            .bind(serde_json::to_string(&legacy_settings)?)
            .execute(&*pool)
            .await?;
        sqlx::query("INSERT INTO telemetry_preferences (id, data, updated_at) VALUES (?, ?, ?)")
            .bind(1_i64)
            .bind(r#"{"closeBehavior":"tray"}"#)
            .bind("2026-07-24T00:00:00Z")
            .execute(&*pool)
            .await?;

        let migrated = service.load_settings().await?;
        assert_eq!(
            migrated.window_close_behavior,
            Some(WindowCloseBehavior::Tray)
        );

        let persisted = sqlx::query_scalar::<_, String>("SELECT data FROM settings WHERE id = ?")
            .bind(SETTINGS_ID)
            .fetch_one(&*pool)
            .await?;
        assert_eq!(
            serde_json::from_str::<Settings>(&persisted)?.window_close_behavior,
            Some(WindowCloseBehavior::Tray)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn save_and_load_settings_preserves_custom_theme_ids() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let mut service = SettingsService::new(pool)?;

        let updates = serde_json::json!({
            "theme": "sunset-glow"
        });

        service.save_settings(updates).await?;
        let loaded = service.load_settings().await?;

        assert_eq!(loaded.theme, "sunset-glow");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_custom_themes_reads_theme_files_from_disk() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool)?;
        let themes_dir = service.get_themes_directory()?;

        std::fs::write(
            themes_dir.join("sunset-glow.json"),
            r##"{
  "name": "Sunset Glow",
  "baseTheme": "dark",
  "variables": {
    "--app-bg-color": "#1b120f",
    "--primary-btn-color": "#d96b3a"
  }
}"##,
        )?;
        std::fs::write(themes_dir.join("ignore.txt"), "not a theme")?;

        let themes = service.list_custom_themes().await?;

        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].id, "sunset-glow");
        assert_eq!(themes[0].name, "Sunset Glow");
        assert_eq!(themes[0].base_theme, "dark");
        assert_eq!(
            themes[0]
                .variables
                .get("--app-bg-color")
                .map(String::as_str),
            Some("#1b120f")
        );
        assert_eq!(
            themes[0]
                .variables
                .get("--primary-btn-color")
                .map(String::as_str),
            Some("#d96b3a")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_custom_themes_accepts_bom_and_markdown_fences() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool)?;
        let themes_dir = service.get_themes_directory()?;

        std::fs::write(
            themes_dir.join("copy-paste.json"),
            "\u{feff}```json\n{\n  \"name\": \"Copy Paste\",\n  \"baseTheme\": \"light\",\n  \"variables\": {\n    \"--app-bg-color\": \"#fff7f4\"\n  }\n}\n```\n",
        )?;

        let themes = service.list_custom_themes().await?;

        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].id, "copy-paste");
        assert_eq!(themes[0].base_theme, "light");
        assert_eq!(
            themes[0]
                .variables
                .get("--app-bg-color")
                .map(String::as_str),
            Some("#fff7f4")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_custom_themes_recovers_control_characters_inside_strings() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool)?;
        let themes_dir = service.get_themes_directory()?;

        std::fs::write(
            themes_dir.join("broken-paste.json"),
            "{\n  \"name\": \"Broken Paste\",\n  \"baseTheme\": \"light\",\n  \"variables\": {\n    \"--bg-pattern\": \"radial-gradient(circle at 16% -8%, rgba(255, 214, 220, 0.46),\ntransparent 36%)\"\n  }\n}\n",
        )?;

        let themes = service.list_custom_themes().await?;

        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].id, "broken-paste");
        assert_eq!(themes[0].base_theme, "light");
        assert!(themes[0]
            .variables
            .get("--bg-pattern")
            .is_some_and(|value| value.contains("transparent 36%")));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_custom_themes_skips_reserved_and_duplicate_ids() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool)?;
        let themes_dir = service.get_themes_directory()?;

        std::fs::write(
            themes_dir.join("alpha!.json"),
            r##"{
  "name": "Alpha Scheme",
  "baseTheme": "light",
  "variables": {
    "--app-bg-color": "#111111"
  }
}"##,
        )?;
        std::fs::write(
            themes_dir.join("alpha.json"),
            r##"{
  "name": "Alpha Scheme Duplicate",
  "baseTheme": "dark",
  "variables": {
    "--app-bg-color": "#222222"
  }
}"##,
        )?;
        std::fs::write(
            themes_dir.join("Dark.json"),
            r##"{
  "name": "Reserved Dark",
  "baseTheme": "light",
  "variables": {
    "--app-bg-color": "#333333"
  }
}"##,
        )?;

        let themes = service.list_custom_themes().await?;

        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0].id, "alpha");
        assert_eq!(themes[0].base_theme, "light");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn credentials_and_nexus_round_trip() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool)?;

        service
            .save_credentials("user".to_string(), "pass".to_string())
            .await?;
        let creds = service.get_credentials().await?;
        assert_eq!(creds, Some(("user".to_string(), "pass".to_string())));

        service.save_nexus_mods_api_key("nexus".to_string()).await?;
        let nexus = service.get_nexus_mods_api_key().await?;
        assert_eq!(nexus.as_deref(), Some("nexus"));

        service.clear_credentials().await?;
        service.clear_nexus_mods_api_key().await?;

        assert!(service.get_credentials().await?.is_none());
        assert!(service.get_nexus_mods_api_key().await?.is_none());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn secrets_are_encrypted_in_database() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");

        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool.clone())?;

        service
            .save_credentials("user".to_string(), "pass".to_string())
            .await?;
        service.save_nexus_mods_api_key("nexus".to_string()).await?;

        let rows = sqlx::query("SELECT key, encrypted FROM secrets")
            .fetch_all(&*pool)
            .await?;

        let mut secrets = std::collections::HashMap::new();
        for row in rows {
            let key: String = row.try_get("key")?;
            let encrypted: String = row.try_get("encrypted")?;
            secrets.insert(key, encrypted);
        }

        let credentials = secrets
            .get(STEAM_CREDENTIALS_KEY)
            .expect("steam_credentials stored");
        assert!(credentials.contains(':'));
        assert_ne!(credentials, "user");
        assert_ne!(credentials, "pass");

        let nexus = secrets
            .get(NEXUS_MODS_API_KEY)
            .expect("nexus_mods_api_key stored");
        assert!(nexus.contains(':'));
        assert_ne!(nexus, "nexus");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn new_secrets_use_a_per_installation_key_envelope() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::unset("ENCRYPTION_KEY");
        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool.clone())?;

        service
            .save_credentials("user".to_string(), "pass".to_string())
            .await?;

        let stored: String = sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
            .bind(STEAM_CREDENTIALS_KEY)
            .fetch_one(&*pool)
            .await?;
        assert!(stored.starts_with("v2:"));

        let key_file = data_dir.join(INSTALLATION_KEY_FILE_NAME);
        let key_contents = std::fs::read_to_string(key_file)?;
        #[cfg(target_os = "windows")]
        assert!(key_contents.starts_with(WINDOWS_INSTALLATION_KEY_ENVELOPE_PREFIX));
        #[cfg(not(target_os = "windows"))]
        assert!(key_contents.starts_with(INSTALLATION_KEY_ENVELOPE_PREFIX));
        assert_eq!(
            service.get_credentials().await?,
            Some(("user".to_string(), "pass".to_string()))
        );

        Ok(())
    }

    #[test]
    #[serial]
    #[cfg(target_os = "windows")]
    fn windows_rewraps_the_legacy_raw_installation_key_with_dpapi() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::unset("ENCRYPTION_KEY");
        std::fs::create_dir_all(&data_dir)?;
        let raw_key = Aes256Gcm::generate_key(&mut OsRng);
        let key_path = data_dir.join(INSTALLATION_KEY_FILE_NAME);
        std::fs::write(
            &key_path,
            format!(
                "{}{}\n",
                INSTALLATION_KEY_ENVELOPE_PREFIX,
                hex::encode(raw_key.as_slice())
            ),
        )?;

        let loaded = SettingsService::installation_encryption_key()?;

        assert_eq!(loaded.as_slice(), raw_key.as_slice());
        let rewrapped = std::fs::read_to_string(key_path)?;
        assert!(rewrapped.starts_with(WINDOWS_INSTALLATION_KEY_ENVELOPE_PREFIX));
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn reading_legacy_secret_reencrypts_it_with_the_installation_key() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::unset("ENCRYPTION_KEY");
        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool.clone())?;
        let legacy = encrypt_legacy_credentials_for_test(
            r#"{"username":"legacy-user","password":"legacy-pass"}"#,
        )
        .await?;
        service.set_secret(STEAM_CREDENTIALS_KEY, &legacy).await?;

        assert_eq!(
            service.get_credentials().await?,
            Some(("legacy-user".to_string(), "legacy-pass".to_string()))
        );

        let migrated: String = sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
            .bind(STEAM_CREDENTIALS_KEY)
            .fetch_one(&*pool)
            .await?;
        assert!(migrated.starts_with("v2:"));
        assert_ne!(migrated, legacy);
        assert!(data_dir.join(INSTALLATION_KEY_FILE_NAME).is_file());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn malformed_current_credentials_do_not_overwrite_stored_values() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::set("ENCRYPTION_KEY", "test-key");
        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool.clone())?;

        for malformed in [
            "v2:00:00112233445566778899aabbccddeeff",
            "v2:000000000000000000000000:00",
        ] {
            service.set_secret(STEAM_CREDENTIALS_KEY, malformed).await?;

            assert!(service.get_credentials().await.is_err());
            let stored: String = sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
                .bind(STEAM_CREDENTIALS_KEY)
                .fetch_one(&*pool)
                .await?;
            assert_eq!(stored, malformed);
        }

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn malformed_legacy_credentials_do_not_overwrite_stored_values() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _key_guard = EnvVarGuard::unset("ENCRYPTION_KEY");
        let pool = initialize_pool().await?;
        let service = SettingsService::new(pool.clone())?;

        for malformed in [
            "00:00112233445566778899aabbccddeeff",
            "000000000000000000000000:00",
        ] {
            service.set_secret(STEAM_CREDENTIALS_KEY, malformed).await?;

            assert!(service.get_credentials().await.is_err());
            let stored: String = sqlx::query_scalar("SELECT encrypted FROM secrets WHERE key = ?")
                .bind(STEAM_CREDENTIALS_KEY)
                .fetch_one(&*pool)
                .await?;
            assert_eq!(stored, malformed);
        }

        Ok(())
    }
}
