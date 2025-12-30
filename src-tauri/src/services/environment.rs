use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::RwLock;
use anyhow::{Context, Result};
use serde_json;
use chrono::{DateTime, Utc};
use crate::types::{Environment, schedule_i_config};

pub struct EnvironmentService {
    environments: Arc<RwLock<HashMap<String, Environment>>>,
    data_dir: PathBuf,
}

impl EnvironmentService {
    pub fn new() -> Result<Self> {
        let data_dir = Self::get_data_dir()?;
        Ok(Self {
            environments: Arc::new(RwLock::new(HashMap::new())),
            data_dir,
        })
    }

    fn get_data_dir() -> Result<PathBuf> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?
            .join("s1devenvmanager");
        
        // Ensure directory exists
        std::fs::create_dir_all(&data_dir)
            .context("Failed to create data directory")?;
        
        Ok(data_dir)
    }

    fn environments_file(&self) -> PathBuf {
        self.data_dir.join("environments.json")
    }

    async fn load_environments(&self) -> Result<Vec<Environment>> {
        let file_path = self.environments_file();
        
        if !file_path.exists() {
            return Ok(vec![]);
        }

        let content = fs::read_to_string(&file_path)
            .await
            .context("Failed to read environments file")?;
        
        let mut envs: Vec<Environment> = serde_json::from_str(&content)
            .context("Failed to parse environments file")?;
        
        // Data migration: Set environment_type for existing environments
        let mut needs_save = false;
        for env in &mut envs {
            if env.environment_type.is_none() {
                env.environment_type = Some(crate::types::EnvironmentType::DepotDownloader);
                needs_save = true;
            }
        }
        
        // Save if migration was needed
        if needs_save {
            let content = serde_json::to_string_pretty(&envs)
                .context("Failed to serialize environments for migration")?;
            fs::write(&file_path, content).await
                .context("Failed to save migrated environments")?;
        }
        
        let mut map = self.environments.write().await;
        map.clear();
        for env in &envs {
            map.insert(env.id.clone(), env.clone());
        }
        
        Ok(envs)
    }

    async fn save_environments(&self) -> Result<()> {
        let map = self.environments.read().await;
        let envs: Vec<Environment> = map.values().cloned().collect();
        drop(map);
        
        let content = serde_json::to_string_pretty(&envs)
            .context("Failed to serialize environments")?;
        
        fs::write(self.environments_file(), content)
            .await
            .context("Failed to write environments file")?;
        
        Ok(())
    }

    pub async fn get_environments(&self) -> Result<Vec<Environment>> {
        self.load_environments().await
    }

    pub async fn get_environment(&self, id: &str) -> Result<Option<Environment>> {
        self.load_environments().await?;
        let map = self.environments.read().await;
        Ok(map.get(id).cloned())
    }

    pub async fn create_environment(
        &self,
        app_id: String,
        branch: String,
        output_dir: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        self.load_environments().await?;

        let app_config = if app_id == schedule_i_config().app_id {
            schedule_i_config()
        } else {
            return Err(anyhow::anyhow!("Unknown app ID: {}", app_id));
        };

        let branch_config = app_config.branches
            .iter()
            .find(|b| b.name == branch)
            .ok_or_else(|| anyhow::anyhow!("Unknown branch: {} for app {}", branch, app_id))?;

        let id = format!("{}-{}-{}", app_id, branch, chrono::Utc::now().timestamp_millis());
        
        // Generate name - remove runtime suffix from display name
        let branch_name = branch_config.display_name
            .replace(" (IL2CPP)", "")
            .replace(" (Mono)", "")
            .trim()
            .to_string();

        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or(branch_name),
            description,
            app_id,
            branch,
            output_dir,
            runtime: branch_config.runtime.clone(),
            status: crate::types::EnvironmentStatus::NotDownloaded,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(crate::types::EnvironmentType::DepotDownloader),
        };

        let mut map = self.environments.write().await;
        map.insert(id.clone(), env.clone());
        drop(map);
        
        self.save_environments().await?;
        
        Ok(env)
    }

    pub async fn create_steam_environment(
        &self,
        steam_path: String,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<Environment> {
        self.load_environments().await?;

        // Validate Steam installation
        let path = Path::new(&steam_path);
        if !crate::services::steam::SteamService::validate_steam_installation(path)? {
            return Err(anyhow::anyhow!("Invalid Steam installation path: {}", steam_path));
        }

        // Extract game version
        let game_version_service = crate::services::game_version::GameVersionService::new();
        let current_game_version = game_version_service.extract_game_version(&steam_path).await?;

        // Determine runtime by checking for Mono/IL2CPP indicators
        // Default to IL2CPP for Steam installations (most common)
        let runtime = if steam_path.to_lowercase().contains("mono") {
            crate::types::Runtime::Mono
        } else {
            crate::types::Runtime::Il2cpp
        };

        let id = format!("steam-{}", chrono::Utc::now().timestamp_millis());
        
        let env = Environment {
            id: id.clone(),
            name: name.unwrap_or_else(|| "Steam Installation".to_string()),
            description,
            app_id: crate::services::steam::SteamService::get_steam_app_id(),
            branch: "main".to_string(), // Steam typically has main branch
            output_dir: steam_path,
            runtime,
            status: crate::types::EnvironmentStatus::Completed, // Steam manages installation
            last_updated: Some(chrono::Utc::now()),
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version,
            update_game_version: None,
            melon_loader_version: None,
            environment_type: Some(crate::types::EnvironmentType::Steam),
        };

        let mut map = self.environments.write().await;
        map.insert(id.clone(), env.clone());
        drop(map);
        
        self.save_environments().await?;
        
        Ok(env)
    }

    pub async fn update_environment(
        &self,
        id: &str,
        updates: impl IntoIterator<Item = (String, serde_json::Value)>,
    ) -> Result<Environment> {
        self.load_environments().await?;
        
        let mut map = self.environments.write().await;
        let env = map.get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("Environment {} not found", id))?;
        
        // Apply updates
        for (key, value) in updates {
            match key.as_str() {
                "name" => if let Some(v) = value.as_str() {
                    env.name = v.to_string();
                },
                "description" => {
                    env.description = value.as_str().map(|s| s.to_string());
                },
                "status" => if let Some(v) = value.as_str() {
                    env.status = match v {
                        "not_downloaded" => crate::types::EnvironmentStatus::NotDownloaded,
                        "downloading" => crate::types::EnvironmentStatus::Downloading,
                        "completed" => crate::types::EnvironmentStatus::Completed,
                        "error" => crate::types::EnvironmentStatus::Error,
                        _ => return Err(anyhow::anyhow!("Invalid status: {}", v)),
                    };
                },
                "lastUpdated" => {
                    // Handle timestamp conversion
                },
                "size" => if let Some(v) = value.as_u64() {
                    env.size = Some(v);
                },
                "lastManifestId" => if let Some(v) = value.as_str() {
                    env.last_manifest_id = Some(v.to_string());
                },
                "lastUpdateCheck" => {
                    // Convert timestamp (seconds since epoch) to DateTime<Utc>
                    if let Some(timestamp) = value.as_i64() {
                        match DateTime::from_timestamp(timestamp, 0) {
                            Some(dt) => {
                                env.last_update_check = Some(dt.with_timezone(&Utc));
                            },
                            None => {
                                eprintln!("[EnvironmentService] Invalid timestamp for lastUpdateCheck: {}", timestamp);
                                // Don't fail, just skip the update
                            }
                        }
                    } else if value.is_null() {
                        env.last_update_check = None;
                    } else {
                        eprintln!("[EnvironmentService] Unexpected type for lastUpdateCheck: {:?}", value);
                    }
                },
                "updateAvailable" => if let Some(v) = value.as_bool() {
                    env.update_available = Some(v);
                },
                "remoteManifestId" => if let Some(v) = value.as_str() {
                    env.remote_manifest_id = Some(v.to_string());
                },
                "remoteBuildId" => if let Some(v) = value.as_str() {
                    env.remote_build_id = Some(v.to_string());
                },
                "currentGameVersion" => if let Some(v) = value.as_str() {
                    env.current_game_version = Some(v.to_string());
                },
                "updateGameVersion" => if let Some(v) = value.as_str() {
                    env.update_game_version = Some(v.to_string());
                },
                "melonLoaderVersion" => if let Some(v) = value.as_str() {
                    env.melon_loader_version = Some(v.to_string());
                },
                _ => {}
            }
        }
        
        let updated = env.clone();
        drop(map);
        
        self.save_environments().await?;
        
        Ok(updated)
    }

    pub async fn delete_environment(&self, id: &str) -> Result<bool> {
        self.load_environments().await?;
        
        let env = {
            let map = self.environments.read().await;
            map.get(id).cloned()
        };
        
        if let Some(env) = env {
            // Delete the environment's directory if it exists
            if Path::new(&env.output_dir).exists() {
                if let Err(e) = fs::remove_dir_all(&env.output_dir).await {
                    eprintln!("Failed to delete directory {}: {}", env.output_dir, e);
                    // Continue with environment deletion even if directory deletion fails
                }
            }
            
            let mut map = self.environments.write().await;
            map.remove(id);
            drop(map);
            
            self.save_environments().await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn get_environment_size(&self, output_dir: &str) -> Result<u64> {
        if !Path::new(output_dir).exists() {
            return Ok(0);
        }

        Self::calculate_size(Path::new(output_dir)).await
    }

    async fn calculate_size(path: &Path) -> Result<u64> {
        Self::calculate_size_impl(path.to_path_buf()).await
    }

    fn calculate_size_impl(path: PathBuf) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send>> {
        Box::pin(async move {
            let mut size = 0u64;
            
            let mut entries = fs::read_dir(&path).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = entry.metadata().await?;
                
                if metadata.is_dir() {
                    size += Self::calculate_size_impl(entry_path).await?;
                } else {
                    size += metadata.len();
                }
            }
            
            Ok(size)
        })
    }
}

impl Clone for EnvironmentService {
    fn clone(&self) -> Self {
        Self {
            environments: Arc::clone(&self.environments),
            data_dir: self.data_dir.clone(),
        }
    }
}

impl Default for EnvironmentService {
    fn default() -> Self {
        Self::new().expect("Failed to create EnvironmentService")
    }
}

