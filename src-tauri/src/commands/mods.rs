use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<ModsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));
static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> = Lazy::new(|| AsyncMutex::new(None));
static GITHUB_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_mods_service() -> Result<Arc<ModsService>, String> {
    let mut service = MODS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ModsService::new()));
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

async fn get_fs_service() -> Result<Arc<FileSystemService>, String> {
    let mut service = FS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(FileSystemService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_github_service() -> Result<Arc<GitHubReleasesService>, String> {
    let mut service = GITHUB_SERVICE.lock().await;
    if service.is_none() {
        // Load GitHub token from encrypted storage
        let settings_service = SettingsService::new().map_err(|e| e.to_string())?;
        let token = settings_service.get_github_token().await.map_err(|e| e.to_string())?;
        *service = Some(Arc::new(GitHubReleasesService::with_token(token)));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_mods(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    mods_service.list_mods(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mods_count(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    let count = mods_service.count_mods(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "count": count }))
}

#[tauri::command]
pub async fn delete_mod(environment_id: String, mod_file_name: String) -> Result<(), String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    mods_service.delete_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enable_mod(environment_id: String, mod_file_name: String) -> Result<(), String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    mods_service.enable_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_mod(environment_id: String, mod_file_name: String) -> Result<(), String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    mods_service.disable_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_mods_folder(environment_id: String) -> Result<(), String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_dir = Path::new(&env.output_dir).join("Mods");
    let fs_service = get_fs_service().await?;
    fs_service.open_folder(&mods_dir.to_string_lossy().to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_mod_installed(
    environment_id: String,
    source_id: Option<String>,
    source_version: Option<String>,
) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    match mods_service.find_existing_mod_installation(&env.output_dir, &source_id, &source_version).await {
        Ok(Some(mod_storage_id)) => Ok(serde_json::json!({
            "installed": true,
            "modStorageId": mod_storage_id
        })),
        Ok(None) => Ok(serde_json::json!({
            "installed": false
        })),
        Err(e) => Err(format!("Failed to check mod installation: {}", e))
    }
}

#[tauri::command]
pub async fn cleanup_duplicate_mod_storage() -> Result<serde_json::Value, String> {
    let mods_service = get_mods_service().await?;
    mods_service.cleanup_duplicate_mod_storage().await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_s1api_installation_status(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
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

    let mods_service = get_mods_service().await?;
    mods_service.get_s1api_installation_status(&env.output_dir, runtime_str)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_mod(
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    branch: String,
    metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    
    // Check if file is ZIP or DLL
    let file_path_lower = file_path.to_lowercase();
    if file_path_lower.ends_with(".zip") {
        mods_service.install_zip_mod(&env.output_dir, &file_path, &original_file_name, &runtime, &branch, metadata)
            .await
            .map_err(|e| e.to_string())
    } else if file_path_lower.ends_with(".dll") {
        mods_service.install_dll_mod(&env.output_dir, &file_path, &runtime, metadata)
            .await
            .map_err(|e| e.to_string())
    } else {
        Err("Only .zip and .dll files are supported".to_string())
    }
}

#[tauri::command]
pub async fn install_s1api(
    environment_id: String,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    eprintln!("[install_s1api] Starting installation for environment: {}, version: {}", environment_id, version_tag);
    
    // Helper to return error as JSON
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        eprintln!("[install_s1api] Error: {}", msg);
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

    let runtime_str = match env.runtime {
        crate::types::Runtime::Il2cpp => "IL2CPP",
        crate::types::Runtime::Mono => "Mono",
    };

    // Check if we already have this version installed before downloading
    let mods_service = match get_mods_service().await {
        Ok(service) => service,
        Err(e) => return error_json(format!("Failed to get mods service: {}", e))
    };
    
    let source_id = Some("ifBars/S1API".to_string());
    let source_version = Some(version_tag.clone());
    if let Ok(Some(existing_mod_id)) = mods_service.find_existing_mod_installation(&env.output_dir, &source_id, &source_version).await {
        eprintln!("[install_s1api] S1API version {} already installed with storage_id: {}, skipping download", version_tag, existing_mod_id);
        return Ok(serde_json::json!({
            "success": true,
            "message": "S1API already installed",
            "alreadyInstalled": true
        }));
    }

    // Get GitHub service and fetch S1API releases
    eprintln!("[install_s1api] Getting GitHub service...");
    let github_service = match get_github_service().await {
        Ok(service) => {
            eprintln!("[install_s1api] GitHub service obtained");
            service
        },
        Err(e) => return error_json(format!("Failed to get GitHub service: {}", e))
    };
    
    eprintln!("[install_s1api] Fetching S1API releases from GitHub...");
    let releases = match github_service.get_all_releases("ifBars", "S1API", false).await {
        Ok(releases) => {
            eprintln!("[install_s1api] Found {} releases", releases.len());
            releases
        },
        Err(e) => return error_json(format!("Failed to fetch S1API releases: {}", e))
    };
    
    // Find the release matching the version tag
    eprintln!("[install_s1api] Looking for version tag: {}", version_tag);
    let release = match releases.iter()
        .find(|r| r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)) {
        Some(release) => {
            eprintln!("[install_s1api] Found release: {:?}", release.get("tag_name"));
            release
        },
        None => return error_json(format!("S1API version {} not found", version_tag))
    };
    
    // Get the ZIP asset URL (S1API releases typically have a single ZIP file)
    eprintln!("[install_s1api] Getting ZIP asset URL...");
    let zip_url = match github_service.get_zip_asset_url(release) {
        Some(url) => {
            eprintln!("[install_s1api] ZIP URL: {}", url);
            url
        },
        None => {
            // Fallback: log available assets for debugging
            if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
                eprintln!("[install_s1api] Available assets:");
                for asset in assets {
                    if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                        eprintln!("  - {}", name);
                    }
                }
            }
            return error_json(format!("No ZIP asset found for S1API version {}. Please ensure the release contains a ZIP file.", version_tag))
        }
    };
    
    // Download the ZIP file
    eprintln!("[install_s1api] Downloading ZIP file from GitHub...");
    let zip_bytes = match github_service.download_release_asset(&zip_url).await {
        Ok(bytes) => {
            eprintln!("[install_s1api] Downloaded {} bytes", bytes.len());
            bytes
        },
        Err(e) => return error_json(format!("Failed to download S1API: {}", e))
    };
    
    // Save to temp file
    let temp_dir = std::env::temp_dir();
    // Sanitize version tag for filename (remove invalid characters)
    let sanitized_tag = version_tag.replace('/', "_").replace('\\', "_").replace(':', "_");
    let temp_zip_path = temp_dir.join(format!("s1api-{}.zip", sanitized_tag));
    
    if let Err(e) = tokio::fs::write(&temp_zip_path, zip_bytes).await {
        return error_json(format!("Failed to save downloaded file: {}", e));
    }
    
    // Install from the temp file
    let mods_service = match get_mods_service().await {
        Ok(service) => service,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_zip_path).await;
            return error_json(format!("Failed to get mods service: {}", e));
        }
    };
    
    let result = mods_service.install_s1api(
        &env.output_dir,
        &temp_zip_path.to_string_lossy(),
        runtime_str,
        &env.branch,
        &version_tag
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
pub async fn uninstall_s1api(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = get_mods_service().await?;
    mods_service.uninstall_s1api(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}
