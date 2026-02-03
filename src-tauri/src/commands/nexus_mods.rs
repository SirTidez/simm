use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;
use tauri::State;

static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_nexus_mods_service(db: Arc<SqlitePool>) -> Result<Arc<NexusModsService>, String> {
    let mut service = NEXUS_MODS_SERVICE.lock().await;
    if service.is_none() {
        let nexus_service = Arc::new(NexusModsService::new());
        
        // Try to load API key from encrypted storage
        let settings_service = SettingsService::new(db.clone()).map_err(|e| e.to_string())?;
        if let Ok(Some(api_key)) = settings_service.get_nexus_mods_api_key().await {
            nexus_service.set_api_key(api_key).await;
        }
        
        *service = Some(nexus_service);
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn validate_nexus_mods_api_key(
    db: State<'_, Arc<SqlitePool>>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let db_pool = db.inner().clone();
    let service = get_nexus_mods_service(db_pool.clone()).await?;
    service.set_api_key(api_key.clone()).await;
    
    match service.validate_api_key().await {
        Ok(validation) => {
            // If valid, save to encrypted storage
            let settings_service = SettingsService::new(db_pool.clone()).map_err(|e| e.to_string())?;
            if let Err(e) = settings_service.save_nexus_mods_api_key(api_key).await {
                return Ok(serde_json::json!({
                    "success": false,
                    "error": format!("Failed to save API key: {}", e)
                }));
            }
            
            let rate_limits = service.get_rate_limits().await
                .unwrap_or_else(|_| serde_json::json!({ "daily": 0, "hourly": 0 }));
            
            Ok(serde_json::json!({
                "success": true,
                "rateLimits": rate_limits,
                "user": validation.get("name").and_then(|n| n.as_str()).map(|n| serde_json::json!({
                    "name": n,
                    "isPremium": validation.get("is_premium").and_then(|p| p.as_bool()).unwrap_or(false),
                    "isSupporter": validation.get("is_supporter").and_then(|s| s.as_bool()).unwrap_or(false)
                }))
            }))
        }
        Err(e) => {
            Ok(serde_json::json!({
                "success": false,
                "error": e.to_string()
            }))
        }
    }
}

#[tauri::command]
pub async fn get_nexus_mods_rate_limits(db: State<'_, Arc<SqlitePool>>) -> Result<serde_json::Value, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_rate_limits()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_games(db: State<'_, Arc<SqlitePool>>) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_games()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_nexus_mods_mods(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    query: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.search_mods(&game_id, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_latest_added(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_latest_added_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_latest_updated(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_latest_updated_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_trending(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_trending_mods(&game_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_mod(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
) -> Result<serde_json::Value, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_mod(&game_id, mod_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_mod_files(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.get_mod_files(&game_id, mod_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_nexus_mods_mod_file(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    mod_id: u32,
    file_id: u32,
) -> Result<String, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    let bytes = service.download_mod_file(&game_id, mod_id, file_id)
        .await
        .map_err(|e| e.to_string())?;

    // Save to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("nexusmods-{}-{}.zip", mod_id, file_id));
    tokio::fs::write(&temp_file, bytes).await
        .map_err(|e| format!("Failed to save downloaded file: {}", e))?;

    Ok(temp_file.to_string_lossy().to_string())
}
#[tauri::command]
pub async fn check_nexus_mods_mod_update(
    db: State<'_, Arc<SqlitePool>>,
    game_domain: String,
    mod_id: u32,
    current_version: String,
) -> Result<serde_json::Value, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.check_mod_update(&game_domain, mod_id, &current_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_nexus_mods_for_updates(
    db: State<'_, Arc<SqlitePool>>,
    game_domain: String,
    mods: Vec<(u32, String)>, // Vec of (mod_id, current_version)
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_nexus_mods_service(db.inner().clone()).await?;
    service.check_mods_for_updates(&game_domain, mods)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_nexus_mods_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_id: u32,
    file_id: u32,
) -> Result<serde_json::Value, String> {
    use crate::services::environment::EnvironmentService;
    use crate::services::mods::ModsService;

    let db_pool = db.inner().clone();
    let env_service = EnvironmentService::new(db_pool.clone()).map_err(|e| e.to_string())?;
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

    // Get mod info for metadata
    let nexus_service = get_nexus_mods_service(db_pool.clone()).await
        .map_err(|e| format!("Failed to get NexusMods service: {}", e))?;
    let game_id = "schedule1".to_string();
    let mod_info = nexus_service.get_mod(&game_id, mod_id)
        .await
        .map_err(|e| format!("Failed to fetch mod info for mod {}: {}", mod_id, e))?;

    // Get file info
    let files = nexus_service.get_mod_files(&game_id, mod_id)
        .await
        .map_err(|e| format!("Failed to fetch files for mod {}: {}", mod_id, e))?;

    let file_info = files.iter()
        .find(|f| f.get("file_id").and_then(|id| id.as_u64()) == Some(file_id as u64))
        .ok_or_else(|| format!("File {} not found in mod {}", file_id, mod_id))?;

    // Extract metadata for duplicate check
    let version = file_info.get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();
    let source_id = Some(mod_id.to_string());
    let source_version = Some(version.clone());

    // Check if we already have this mod/version stored anywhere before downloading
    let mods_service = ModsService::new(db_pool.clone());
    if let Ok(Some(existing_mod_id)) = mods_service
        .find_existing_mod_storage_by_source_version(&mod_id.to_string(), &version)
        .await
    {
        eprintln!("[DEBUG] install_nexus_mods_mod: Found existing storage for mod {} version {}: {}, installing from storage", mod_id, version, existing_mod_id);
        let install_result = mods_service
            .install_storage_mod_to_envs(&existing_mod_id, vec![environment_id.clone()])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({
            "success": true,
            "fromStorage": true,
            "result": install_result
        }));
    }

    // Download the file using service
    let bytes = nexus_service.download_mod_file(&game_id, mod_id, file_id)
        .await
        .map_err(|e| format!("Failed to download file {} from mod {}: {}", file_id, mod_id, e))?;

    // Get the original filename to preserve extension
    let default_filename = format!("nexusmods-{}-{}.zip", mod_id, file_id);
    let original_filename = file_info.get("file_name")
        .and_then(|f| f.as_str())
        .unwrap_or(&default_filename);

    // Save to temp file with original extension
    let temp_dir = std::env::temp_dir();
    let archive_path = temp_dir.join(format!("nexusmods-{}-{}-{}", mod_id, file_id, original_filename));
    tokio::fs::write(&archive_path, bytes).await
        .map_err(|e| format!("Failed to save downloaded file: {}", e))?;

    let zip_path_str = archive_path.to_string_lossy().to_string();

    // Extract metadata
    let mod_name = mod_info.get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Unknown Mod")
        .to_string();
    let author = mod_info.get("author")
        .and_then(|a| a.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let version = file_info.get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();
    let source_url = format!("https://www.nexusmods.com/schedule1/mods/{}", mod_id);

    // Install using mods service
    let mods_service = ModsService::new(db_pool.clone());
    let metadata = serde_json::json!({
        "source": "nexusmods",
        "sourceId": mod_id.to_string(),
        "sourceVersion": version,
        "sourceUrl": source_url,
        "modName": mod_name,
        "author": author,
    });

    eprintln!("[DEBUG] About to call install_zip_mod for mod {} file {}", mod_id, file_id);
    let result = mods_service.install_zip_mod(
        &env.output_dir,
        &zip_path_str,
        original_filename,
        runtime_str,
        &env.branch,
        Some(metadata),
    ).await.map_err(|e| {
        let error_msg = format!("Failed to install mod {} file {}: {}", mod_id, file_id, e);
        eprintln!("[ERROR] {}", error_msg);
        error_msg
    })?;

    // Clean up temp file
    let _ = tokio::fs::remove_file(&archive_path).await;

    Ok(result)
}
