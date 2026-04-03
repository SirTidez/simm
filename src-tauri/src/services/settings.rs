use std::collections::HashMap;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json;
use sqlx::SqlitePool;
use tokio::fs;

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use sha2::{Digest, Sha256};

use crate::types::{CustomThemeDefinition, Settings};

pub struct SettingsService {
    pool: Arc<SqlitePool>,
}

const SETTINGS_ID: i64 = 1;
const STEAM_CREDENTIALS_KEY: &str = "steam_credentials";
const NEXUS_MODS_API_KEY: &str = "nexus_mods_api_key";
const NEXUS_OAUTH_SESSION_KEY: &str = "nexus_oauth_session";
const NEXUS_OAUTH_PENDING_KEY: &str = "nexus_oauth_pending";
const NEXUS_OAUTH_LAST_CALLBACK_KEY: &str = "nexus_oauth_last_callback";
const NEXUS_NXM_PENDING_DOWNLOAD_KEY: &str = "nexus_nxm_pending_download";
const NEXUS_NXM_PROTOCOL_BACKUP_KEY: &str = "nexus_nxm_protocol_backup";
const THEMES_DIR_NAME: &str = "themes";

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

    fn get_encryption_key() -> Result<Key<Aes256Gcm>> {
        let key_str = std::env::var("ENCRYPTION_KEY")
            .unwrap_or_else(|_| "default-key-change-in-production".to_string());

        let mut hasher = Sha256::new();
        hasher.update(key_str.as_bytes());
        let key_bytes = hasher.finalize();

        Ok(*Key::<Aes256Gcm>::from_slice(&key_bytes))
    }

    async fn encrypt_credentials(data: &str) -> Result<String> {
        let key = Self::get_encryption_key()?;
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

        let ciphertext = cipher
            .encrypt(&nonce, data.as_bytes())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        Ok(format!(
            "{}:{}",
            hex::encode(nonce),
            hex::encode(ciphertext)
        ))
    }

    async fn decrypt_credentials(encrypted: &str) -> Result<String> {
        let key = Self::get_encryption_key()?;
        let cipher = Aes256Gcm::new(&key);

        let parts: Vec<&str> = encrypted.split(':').collect();
        if parts.len() != 2 {
            return Err(anyhow::anyhow!("Invalid encrypted format"));
        }

        let nonce_bytes = hex::decode(parts[0]).context("Failed to decode nonce")?;
        let ciphertext = hex::decode(parts[1]).context("Failed to decode ciphertext")?;

        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))?;

        String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted data")
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
        let parsed: CustomThemeFile = serde_json::from_str(normalized_content.as_ref())
            .map_err(|err| {
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
        let mut themes = Vec::new();

        while let Some(entry) = reader
            .next_entry()
            .await
            .context("Failed to iterate theme directory entries")?
        {
            let path = entry.path();
            match Self::parse_custom_theme_file(&path).await {
                Ok(Some(theme)) => themes.push(theme),
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
                return Ok(settings);
            }

            if let Ok(raw_value) = serde_json::from_str::<serde_json::Value>(&data) {
                let sanitized = Self::sanitize_legacy_settings_value(raw_value);
                if let Ok(mut settings) = serde_json::from_value::<Settings>(sanitized) {
                    settings.theme = Self::normalize_theme_selection(&settings.theme);
                    log::warn!("Recovered persisted settings through legacy sanitization");
                    return Ok(settings);
                }
            }

            log::warn!("Stored settings could not be parsed; falling back to defaults");
        }

        let platform = if cfg!(target_os = "windows") {
            crate::types::Platform::Windows
        } else if cfg!(target_os = "macos") {
            crate::types::Platform::Macos
        } else {
            crate::types::Platform::Linux
        };

        let default_settings = Settings {
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
            auto_install_melon_loader: Some(false),
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
            app_update: None,
        };

        Ok(default_settings)
    }

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

    pub async fn get_credentials(&self) -> Result<Option<(String, String)>> {
        let encrypted = match self.get_secret(STEAM_CREDENTIALS_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
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

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
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

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
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

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
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

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
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

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus nxm pending download json")?;
        Ok(Some(parsed))
    }

    pub async fn save_nexus_nxm_pending_download(&self, pending: &serde_json::Value) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&pending.to_string()).await?;
        self.set_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY, &encrypted)
            .await
    }

    pub async fn clear_nexus_nxm_pending_download(&self) -> Result<()> {
        self.clear_secret(NEXUS_NXM_PENDING_DOWNLOAD_KEY).await
    }

    pub async fn get_nexus_nxm_protocol_backup(&self) -> Result<Option<serde_json::Value>> {
        let encrypted = match self.get_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY).await? {
            Some(value) => value,
            None => return Ok(None),
        };

        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
        let parsed = serde_json::from_str::<serde_json::Value>(&decrypted)
            .context("Failed to parse nexus nxm protocol backup json")?;
        Ok(Some(parsed))
    }

    pub async fn save_nexus_nxm_protocol_backup(&self, backup: &serde_json::Value) -> Result<()> {
        let encrypted = Self::encrypt_credentials(&backup.to_string()).await?;
        self.set_secret(NEXUS_NXM_PROTOCOL_BACKUP_KEY, &encrypted)
            .await
    }

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
            themes[0].variables.get("--app-bg-color").map(String::as_str),
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
            themes[0].variables.get("--app-bg-color").map(String::as_str),
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
        assert!(
            themes[0]
                .variables
                .get("--bg-pattern")
                .is_some_and(|value| value.contains("transparent 36%"))
        );

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
}
