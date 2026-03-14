use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json;
use sqlx::SqlitePool;

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use sha2::{Digest, Sha256};

use crate::types::Settings;

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

    pub async fn load_settings(&mut self) -> Result<Settings> {
        let stored = sqlx::query_scalar::<_, String>("SELECT data FROM settings WHERE id = ?")
            .bind(SETTINGS_ID)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to load settings")?;

        if let Some(data) = stored {
            if let Ok(settings) = serde_json::from_str::<Settings>(&data) {
                return Ok(settings);
            }
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
            theme: crate::types::Theme::ModernBlue,
            melon_loader_version: None,
            auto_install_melon_loader: Some(false),
            update_check_interval: Some(60),
            auto_check_updates: Some(true),
            log_level: Some(crate::types::LogLevel::Info),
            nexus_mods_api_key: None,
            nexus_mods_rate_limits: None,
            nexus_mods_game_id: Some("schedule1".to_string()),
            nexus_mods_app_slug: None,
            thunderstore_game_id: Some("schedule-i".to_string()),
            auto_update_mods: None,
            mod_update_check_interval: None,
            mod_icon_cache_limit_mb: Some(500),
            custom_theme: None,
            log_retention_days: Some(7),
        };

        Ok(default_settings)
    }

    pub async fn save_settings(&mut self, updates: serde_json::Value) -> Result<()> {
        let current = self.load_settings().await?;

        let current_json = serde_json::to_value(&current)?;
        let merged = Self::merge_json(&current_json, &updates);
        let updated: Settings = serde_json::from_value(merged)?;

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
    use crate::types::Theme;
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
            "logRetentionDays": 10,
            "autoCheckUpdates": false
        });

        service.save_settings(updates).await?;
        let loaded = service.load_settings().await?;

        assert_eq!(loaded.max_concurrent_downloads, 5);
        assert!(matches!(loaded.theme, Theme::Dark));
        assert_eq!(loaded.log_retention_days, Some(10));
        assert_eq!(loaded.auto_check_updates, Some(false));

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
