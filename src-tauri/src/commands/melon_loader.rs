use crate::services::melon_loader::MelonLoaderService;
use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MELON_LOADER_SERVICE: Lazy<AsyncMutex<Option<Arc<MelonLoaderService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));
static GITHUB_RELEASES_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_melon_loader_service() -> Result<Arc<MelonLoaderService>, String> {
    let mut service = MELON_LOADER_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(MelonLoaderService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_env_service() -> Result<Arc<EnvironmentService>, String> {
    let mut service = ENV_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(EnvironmentService::new().map_err(|e| e.to_string())?));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_github_service() -> Result<Arc<GitHubReleasesService>, String> {
    let mut service = GITHUB_RELEASES_SERVICE.lock().await;
    if service.is_none() {
        // Load GitHub token from encrypted storage
        let settings_service = SettingsService::new().map_err(|e| e.to_string())?;
        let token = settings_service.get_github_token().await.map_err(|e| e.to_string())?;
        *service = Some(Arc::new(GitHubReleasesService::with_token(token)));
    }
    Ok(service.as_ref().unwrap().clone())
}


#[tauri::command]
pub async fn get_melon_loader_status(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let melon_loader_service = get_melon_loader_service().await?;
    let installed = melon_loader_service.is_melon_loader_installed(&env.output_dir);
    let version = if installed {
        melon_loader_service.get_installed_version(&env.output_dir)
            .await
            .map_err(|e| e.to_string())?
    } else {
        None
    };

    Ok(serde_json::json!({
        "installed": installed,
        "version": version
    }))
}

#[tauri::command]
pub async fn install_melon_loader(environment_id: String, version_tag: String) -> Result<serde_json::Value, String> {
    eprintln!("[install_melon_loader] Starting installation for environment: {}, version: {}", environment_id, version_tag);
    
    // Helper to return error as JSON
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        eprintln!("[install_melon_loader] Error: {}", msg);
        Ok(serde_json::json!({
            "success": false,
            "error": msg
        }))
    };
    
    let env_service = match get_env_service().await {
        Ok(service) => service,
        Err(e) => return error_json(format!("Failed to get environment service: {}", e))
    };
    
    let env = match env_service.get_environment(&environment_id).await {
        Ok(Some(env)) => env,
        Ok(None) => return error_json("Environment not found".to_string()),
        Err(e) => return error_json(format!("Failed to get environment: {}", e))
    };

    if env.output_dir.is_empty() {
        return error_json("Output directory not set".to_string());
    }

    // Get all MelonLoader releases to find the one matching the version tag
    eprintln!("[install_melon_loader] Getting GitHub service...");
    let github_service = match get_github_service().await {
        Ok(service) => {
            eprintln!("[install_melon_loader] GitHub service obtained");
            service
        },
        Err(e) => return error_json(format!("Failed to get GitHub service: {}", e))
    };
    
    eprintln!("[install_melon_loader] Fetching MelonLoader releases from GitHub...");
    let releases = match github_service.get_all_releases("LavaGang", "MelonLoader", false).await {
        Ok(releases) => {
            eprintln!("[install_melon_loader] Found {} releases", releases.len());
            releases
        },
        Err(e) => return error_json(format!("Failed to fetch MelonLoader releases: {}", e))
    };
    
    // Find the release matching the version tag
    eprintln!("[install_melon_loader] Looking for version tag: {}", version_tag);
    let release = match releases.iter()
        .find(|r| r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)) {
        Some(release) => {
            eprintln!("[install_melon_loader] Found release: {:?}", release.get("tag_name"));
            release
        },
        None => return error_json(format!("MelonLoader version {} not found", version_tag))
    };
    
    // Get the Windows x64 ZIP asset URL
    eprintln!("[install_melon_loader] Getting Windows x64 ZIP asset URL...");
    let zip_url = match github_service.get_melonloader_x64_asset_url(release) {
        Some(url) => {
            eprintln!("[install_melon_loader] Windows x64 ZIP URL: {}", url);
            url
        },
        None => {
            // Fallback: log available assets for debugging
            if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
                eprintln!("[install_melon_loader] Available assets:");
                for asset in assets {
                    if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                        eprintln!("  - {}", name);
                    }
                }
            }
            return error_json(format!("No Windows x64 ZIP asset found for MelonLoader version {}. Please ensure the release contains a MelonLoader.x64.zip file.", version_tag))
        }
    };
    
    // Download the ZIP file
    eprintln!("[install_melon_loader] Downloading ZIP file from GitHub...");
    let zip_bytes = match github_service.download_release_asset(&zip_url).await {
        Ok(bytes) => {
            eprintln!("[install_melon_loader] Downloaded {} bytes", bytes.len());
            bytes
        },
        Err(e) => return error_json(format!("Failed to download MelonLoader: {}", e))
    };
    
    // Save to temp file
    let temp_dir = std::env::temp_dir();
    // Sanitize version tag for filename (remove invalid characters)
    let sanitized_tag = version_tag.replace('/', "_").replace('\\', "_").replace(':', "_");
    let temp_zip_path = temp_dir.join(format!("melonloader-{}.zip", sanitized_tag));
    
    if let Err(e) = tokio::fs::write(&temp_zip_path, zip_bytes).await {
        return error_json(format!("Failed to save downloaded file: {}", e));
    }
    
    // Install from the temp file
    let melon_loader_service = match get_melon_loader_service().await {
        Ok(service) => service,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_zip_path).await;
            return error_json(format!("Failed to get MelonLoader service: {}", e));
        }
    };
    
    let result = melon_loader_service.install_melon_loader(
        &env.output_dir,
        &temp_zip_path.to_string_lossy()
    ).await;
    
    // Clean up temp file (ignore errors)
    let _ = tokio::fs::remove_file(&temp_zip_path).await;
    
    // The service returns Ok(serde_json::Value) with success/error fields
    // So we just return it directly
    match result {
        Ok(json_result) => Ok(json_result),
        Err(e) => error_json(format!("Installation failed: {}", e))
    }
}

#[tauri::command]
pub async fn uninstall_melon_loader(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let melon_loader_service = get_melon_loader_service().await?;
    melon_loader_service.uninstall_melon_loader(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

