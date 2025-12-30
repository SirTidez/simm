use std::path::PathBuf;
use anyhow::{Context, Result};
use serde_json;
use tokio::fs;
use crate::types::Settings;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use sha2::{Sha256, Digest};

pub struct SettingsService {
    settings: Option<Settings>,
    data_dir: PathBuf,
}

impl SettingsService {
    pub fn new() -> Result<Self> {
        let data_dir = Self::get_data_dir()?;
        Ok(Self {
            settings: None,
            data_dir,
        })
    }

    fn get_data_dir() -> Result<PathBuf> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?
            .join("s1devenvmanager");
        
        std::fs::create_dir_all(&data_dir)
            .context("Failed to create data directory")?;
        
        Ok(data_dir)
    }

    fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    fn credentials_file(&self) -> PathBuf {
        self.data_dir.join("credentials.enc")
    }

    fn github_token_file(&self) -> PathBuf {
        self.data_dir.join("github_token.enc")
    }

    fn get_encryption_key() -> Result<Key<Aes256Gcm>> {
        let key_str = std::env::var("ENCRYPTION_KEY")
            .unwrap_or_else(|_| "default-key-change-in-production".to_string());
        
        // Derive 32-byte key from string using SHA-256
        let mut hasher = Sha256::new();
        hasher.update(key_str.as_bytes());
        let key_bytes = hasher.finalize();
        
        Ok(*Key::<Aes256Gcm>::from_slice(&key_bytes))
    }

    async fn encrypt_credentials(data: &str) -> Result<String> {
        let key = Self::get_encryption_key()?;
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        
        let ciphertext = cipher.encrypt(&nonce, data.as_bytes())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;
        
        // Format: nonce_hex:ciphertext_hex
        Ok(format!("{}:{}", hex::encode(nonce), hex::encode(ciphertext)))
    }

    async fn decrypt_credentials(encrypted: &str) -> Result<String> {
        let key = Self::get_encryption_key()?;
        let cipher = Aes256Gcm::new(&key);
        
        let parts: Vec<&str> = encrypted.split(':').collect();
        if parts.len() != 2 {
            return Err(anyhow::anyhow!("Invalid encrypted format"));
        }
        
        let nonce_bytes = hex::decode(parts[0])
            .context("Failed to decode nonce")?;
        let ciphertext = hex::decode(parts[1])
            .context("Failed to decode ciphertext")?;
        
        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher.decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))?;
        
        String::from_utf8(plaintext)
            .context("Invalid UTF-8 in decrypted data")
    }

    pub async fn load_settings(&mut self) -> Result<Settings> {
        if let Some(ref settings) = self.settings {
            return Ok(settings.clone());
        }

        let file_path = self.settings_file();
        
        if file_path.exists() {
            let content = fs::read_to_string(&file_path)
                .await
                .context("Failed to read settings file")?;
            
            self.settings = Some(serde_json::from_str(&content)
                .context("Failed to parse settings file")?);
            
            return Ok(self.settings.as_ref().unwrap().clone());
        }

        // Return default settings
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
            melon_loader_zip_path: None,
            auto_install_melon_loader: Some(false),
            update_check_interval: Some(60),
            auto_check_updates: Some(true),
            log_level: Some(crate::types::LogLevel::Info),
            nexus_mods_api_key: None,
            nexus_mods_game_id: Some("schedule1".to_string()),
            thunderstore_game_id: Some("schedule-i".to_string()),
            auto_update_mods: None,
            mod_update_check_interval: None,
            custom_theme: None,
        };

        self.settings = Some(default_settings.clone());
        Ok(default_settings)
    }

    pub async fn save_settings(&mut self, updates: serde_json::Value) -> Result<()> {
        let current = self.load_settings().await?;
        
        // Merge updates into current settings
        let current_json = serde_json::to_value(&current)?;
        let merged = Self::merge_json(&current_json, &updates);
        
        self.settings = Some(serde_json::from_value(merged)?);
        
        let content = serde_json::to_string_pretty(&self.settings.as_ref().unwrap())
            .context("Failed to serialize settings")?;
        
        fs::write(self.settings_file(), content)
            .await
            .context("Failed to write settings file")?;
        
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

    pub async fn get_credentials(&self) -> Result<Option<(String, String)>> {
        let file_path = self.credentials_file();
        
        if !file_path.exists() {
            return Ok(None);
        }

        let encrypted = fs::read_to_string(&file_path)
            .await
            .context("Failed to read credentials file")?;
        
        if encrypted.is_empty() {
            return Ok(None);
        }

        let decrypted = Self::decrypt_credentials(&encrypted).await?;
        let creds: serde_json::Value = serde_json::from_str(&decrypted)
            .context("Failed to parse credentials")?;
        
        let username = creds.get("username")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let password = creds.get("password")
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
        
        fs::write(self.credentials_file(), encrypted)
            .await
            .context("Failed to write credentials file")?;
        
        Ok(())
    }

    pub async fn clear_credentials(&self) -> Result<()> {
        let file_path = self.credentials_file();
        if file_path.exists() {
            fs::write(&file_path, "")
                .await
                .context("Failed to clear credentials file")?;
        }
        Ok(())
    }

    /// Get GitHub token from encrypted storage
    /// Returns None if token is not set or cannot be decrypted
    pub async fn get_github_token(&self) -> Result<Option<String>> {
        let file_path = self.github_token_file();
        
        if !file_path.exists() {
            return Ok(None);
        }

        let encrypted = fs::read_to_string(&file_path)
            .await
            .context("Failed to read GitHub token file")?;
        
        if encrypted.is_empty() {
            return Ok(None);
        }

        // Decrypt the token
        let decrypted = Self::decrypt_credentials(&encrypted).await?;
        Ok(Some(decrypted))
    }

    /// Save GitHub token to encrypted storage
    /// The token is encrypted and never logged
    pub async fn save_github_token(&self, token: String) -> Result<()> {
        // Encrypt the token
        let encrypted = Self::encrypt_credentials(&token).await?;
        
        fs::write(self.github_token_file(), encrypted)
            .await
            .context("Failed to write GitHub token file")?;
        
        Ok(())
    }

    /// Clear GitHub token from storage
    pub async fn clear_github_token(&self) -> Result<()> {
        let file_path = self.github_token_file();
        if file_path.exists() {
            fs::write(&file_path, "")
                .await
                .context("Failed to clear GitHub token file")?;
        }
        Ok(())
    }
}

impl Clone for SettingsService {
    fn clone(&self) -> Self {
        Self {
            settings: self.settings.clone(),
            data_dir: self.data_dir.clone(),
        }
    }
}

impl Default for SettingsService {
    fn default() -> Self {
        Self::new().expect("Failed to create SettingsService")
    }
}

