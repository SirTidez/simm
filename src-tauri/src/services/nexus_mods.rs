use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct NexusModsService {
    client: Arc<Client>,
    api_key: Arc<RwLock<Option<String>>>,
    validation_result: Arc<RwLock<Option<Value>>>,
}

impl NexusModsService {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Client::builder()
                .user_agent("Schedule-I-DevEnvManager/1.0.0")
                .build()
                .unwrap_or_else(|_| Client::new())),
            api_key: Arc::new(RwLock::new(None)),
            validation_result: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        *self.api_key.write().await = Some(api_key);
        // Clear validation result when API key changes
        *self.validation_result.write().await = None;
    }

    pub async fn validate_api_key(&self) -> Result<Value> {
        let api_key = self.api_key.read().await.clone()
            .ok_or_else(|| anyhow::anyhow!("API key not set"))?;

        // Use NexusMods REST API to validate
        let response = self.client
            .get("https://api.nexusmods.com/v1/users/validate.json")
            .header("apikey", &api_key)
            .send()
            .await
            .context("Failed to validate API key")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Invalid API key: {}", response.status()));
        }

        let validation: Value = response.json().await
            .context("Failed to parse validation response")?;

        // Store validation result
        *self.validation_result.write().await = Some(validation.clone());

        Ok(validation)
    }

    pub async fn get_rate_limits(&self) -> Result<Value> {
        let api_key = self.api_key.read().await.clone()
            .ok_or_else(|| anyhow::anyhow!("API key not set"))?;

        // Get rate limit info from headers
        let response = self.client
            .get("https://api.nexusmods.com/v1/users/validate.json")
            .header("apikey", &api_key)
            .send()
            .await
            .context("Failed to get rate limits")?;

        let daily = response.headers()
            .get("x-rl-daily-limit")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        let hourly = response.headers()
            .get("x-rl-hourly-limit")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        Ok(serde_json::json!({
            "daily": daily,
            "hourly": hourly
        }))
    }

    pub async fn get_validation_result(&self) -> Option<Value> {
        self.validation_result.read().await.clone()
    }
}

impl Default for NexusModsService {
    fn default() -> Self {
        Self::new()
    }
}
