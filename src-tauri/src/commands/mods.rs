use crate::services::mods::ModsService;
use crate::services::mods_snapshot_cache;
use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::github_releases::GitHubReleasesService;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> = Lazy::new(|| AsyncMutex::new(None));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadKind {
    Zip,
    Dll,
    Unsupported,
}

fn detect_upload_kind(file_path: &str) -> UploadKind {
    let file_path_lower = file_path.to_lowercase();
    if file_path_lower.ends_with(".zip") {
        UploadKind::Zip
    } else if file_path_lower.ends_with(".dll") {
        UploadKind::Dll
    } else {
        UploadKind::Unsupported
    }
}

fn parse_runtime_label(runtime: Option<&str>) -> Option<crate::types::Runtime> {
    runtime.and_then(|value| match value.trim().to_lowercase().as_str() {
        "il2cpp" => Some(crate::types::Runtime::Il2cpp),
        "mono" => Some(crate::types::Runtime::Mono),
        _ => None,
    })
}

fn build_s1api_library_metadata(version_tag: &str) -> serde_json::Value {
    serde_json::json!({
        "source": "github",
        "sourceId": "ifBars/S1API",
        "sourceVersion": version_tag,
        "sourceUrl": "https://github.com/ifBars/S1API",
        "modName": "S1API",
        "author": "ScheduleI-Dev",
    })
}

fn build_mlvscan_library_metadata(version_tag: &str) -> serde_json::Value {
    serde_json::json!({
        "source": "github",
        "sourceId": "ifBars/MLVScan",
        "sourceVersion": version_tag,
        "sourceUrl": "https://github.com/ifBars/MLVScan",
        "modName": "MLVScan",
        "author": "ifBars",
    })
}

async fn get_fs_service() -> Result<Arc<FileSystemService>, String> {
    let mut service = FS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(FileSystemService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_mods(
    app: tauri::AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    if !refresh.unwrap_or(false) {
        if let Some(cached) = mods_snapshot_cache::get(&environment_id).await {
            let db_pool = db.inner().clone();
            let environment_id_for_refresh = environment_id.clone();
            let app_for_refresh = app.clone();

            tokio::spawn(async move {
                let env_service = match EnvironmentService::new(db_pool.clone()) {
                    Ok(service) => service,
                    Err(_) => return,
                };

                let env = match env_service.get_environment(&environment_id_for_refresh).await {
                    Ok(Some(env)) => env,
                    _ => return,
                };

                if env.output_dir.is_empty() {
                    return;
                }

                let mods_service = ModsService::new(db_pool);
                if let Ok(snapshot) = mods_service.list_mods(&env.output_dir).await {
                    mods_snapshot_cache::set(environment_id_for_refresh.clone(), snapshot.clone()).await;
                    let _ = crate::events::emit_mods_snapshot_updated(
                        &app_for_refresh,
                        environment_id_for_refresh,
                        snapshot,
                    );
                }
            });

            return Ok(cached);
        }
    }

    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    let result = mods_service
        .list_mods(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    mods_snapshot_cache::set(environment_id, result.clone()).await;
    Ok(result)
}

#[tauri::command]
pub async fn get_mods_count(db: State<'_, Arc<SqlitePool>>, environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    let count = mods_service.count_mods(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "count": count }))
}

#[tauri::command]
pub async fn get_mod_library(db: State<'_, Arc<SqlitePool>>) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    let library = mods_service.get_mod_library().await.map_err(|e| e.to_string())?;
    serde_json::to_value(library).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_downloaded_mod(
    db: State<'_, Arc<SqlitePool>>,
    storage_id: String,
    environment_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    mods_service
        .install_storage_mod_to_envs(&storage_id, environment_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_downloaded_mod(
    db: State<'_, Arc<SqlitePool>>,
    storage_id: String,
    environment_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    mods_service
        .uninstall_storage_mod_from_envs(&storage_id, environment_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_downloaded_mod(
    db: State<'_, Arc<SqlitePool>>,
    storage_id: String,
) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    mods_service
        .delete_downloaded_mod(&storage_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    mods_service.delete_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enable_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    mods_service.enable_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    mods_service.disable_mod(&env.output_dir, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_mods_folder(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
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
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    source_id: Option<String>,
    source_version: Option<String>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
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
pub async fn find_existing_mod_storage(
    db: State<'_, Arc<SqlitePool>>,
    source_id: String,
    source_version: String,
    runtime: Option<String>,
) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    let runtime_parsed = runtime.as_deref().and_then(|value| match value.trim().to_lowercase().as_str() {
        "il2cpp" => Some(crate::types::Runtime::Il2cpp),
        "mono" => Some(crate::types::Runtime::Mono),
        _ => None,
    });
    match mods_service
        .find_existing_mod_storage_by_source_version(&source_id, &source_version, runtime_parsed)
        .await
    {
        Ok(Some(storage_id)) => Ok(serde_json::json!({
            "found": true,
            "storageId": storage_id
        })),
        Ok(None) => Ok(serde_json::json!({
            "found": false
        })),
        Err(e) => Err(format!("Failed to check mod storage: {}", e)),
    }
}

#[tauri::command]
pub async fn cleanup_duplicate_mod_storage(db: State<'_, Arc<SqlitePool>>) -> Result<serde_json::Value, String> {
    let mods_service = ModsService::new(db.inner().clone());
    mods_service.cleanup_duplicate_mod_storage().await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_s1api_installation_status(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
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

    let mods_service = ModsService::new(db.inner().clone());
    mods_service.get_s1api_installation_status(&env.output_dir, runtime_str)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    branch: String,
    metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    
    match detect_upload_kind(&file_path) {
        UploadKind::Zip => {
        mods_service.install_zip_mod(&env.output_dir, &file_path, &original_file_name, &runtime, &branch, metadata)
            .await
            .map_err(|e| e.to_string())
        }
        UploadKind::Dll => {
        mods_service.install_dll_mod(&env.output_dir, &file_path, &runtime, metadata)
            .await
            .map_err(|e| e.to_string())
        }
        UploadKind::Unsupported => Err("Only .zip and .dll files are supported".to_string()),
    }
}

#[tauri::command]
pub async fn store_mod_archive(
    db: State<'_, Arc<SqlitePool>>,
    file_path: String,
    original_file_name: String,
    runtime: Option<String>,
    metadata: Option<serde_json::Value>,
    target: Option<String>,
    cleanup: Option<bool>,
) -> Result<serde_json::Value, String> {
    let runtime_parsed = parse_runtime_label(runtime.as_deref());

    let mods_service = ModsService::new(db.inner().clone());
    let result = mods_service
        .store_mod_archive(&file_path, &original_file_name, runtime_parsed, metadata, target)
        .await
        .map_err(|e| e.to_string())?;

    if cleanup.unwrap_or(false) {
        let _ = tokio::fs::remove_file(&file_path).await;
    }

    Ok(result)
}

#[tauri::command]
pub async fn install_s1api(
    db: State<'_, Arc<SqlitePool>>,
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
    
    let env_service = match EnvironmentService::new(db.inner().clone()) {
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

    // Check if we already have this version stored before downloading
    let mods_service = ModsService::new(db.inner().clone());
    let source_id = "ifBars/S1API".to_string();
    if let Ok(Some(existing_mod_id)) = mods_service
        .find_existing_mod_storage_by_source_version(&source_id, &version_tag, Some(env.runtime.clone()))
        .await
    {
        eprintln!("[install_s1api] S1API version {} already stored with storage_id: {}, installing from storage", version_tag, existing_mod_id);
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

    // Get release service and fetch S1API releases
    eprintln!("[install_s1api] Initializing release service...");
    let github_service = GitHubReleasesService::new();
    
    eprintln!("[install_s1api] Fetching S1API releases from release API...");
    let releases = match github_service.get_all_releases_with_latest("ifBars", "S1API", false).await {
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
    eprintln!("[install_s1api] Downloading ZIP asset...");
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
    let mods_service = ModsService::new(db.inner().clone());
    
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
pub async fn download_s1api_to_library(
    db: State<'_, Arc<SqlitePool>>,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({
            "success": false,
            "error": msg
        }))
    };

    let github_service = GitHubReleasesService::new();

    let releases = github_service.get_all_releases_with_latest("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())?;

    let release = match releases.iter()
        .find(|r| r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)) {
        Some(release) => release,
        None => return error_json(format!("S1API version {} not found", version_tag)),
    };

    let zip_url = match github_service.get_zip_asset_url(release) {
        Some(url) => url,
        None => return error_json(format!("No ZIP asset found for S1API version {}", version_tag)),
    };

    let zip_bytes = github_service.download_release_asset(&zip_url)
        .await
        .map_err(|e| e.to_string())?;

    let temp_dir = std::env::temp_dir();
    let sanitized_tag = version_tag.replace('/', "_").replace('\\', "_").replace(':', "_");
    let temp_zip_path = temp_dir.join(format!("s1api-{}.zip", sanitized_tag));
    tokio::fs::write(&temp_zip_path, zip_bytes).await
        .map_err(|e| format!("Failed to save downloaded file: {}", e))?;

    let metadata = build_s1api_library_metadata(&version_tag);

    let mods_service = ModsService::new(db.inner().clone());
    let result = mods_service
        .store_mod_archive(
            &temp_zip_path.to_string_lossy(),
            "S1API.zip",
            None,
            Some(metadata),
            None,
        )
        .await;

    let _ = tokio::fs::remove_file(&temp_zip_path).await;

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_mlvscan_to_library(
    db: State<'_, Arc<SqlitePool>>,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({
            "success": false,
            "error": msg
        }))
    };

    let github_service = GitHubReleasesService::new();

    let releases = github_service.get_all_releases_with_latest("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())?;

    let release = match releases.iter()
        .find(|r| r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)) {
        Some(release) => release,
        None => return error_json(format!("MLVScan version {} not found", version_tag)),
    };

    let assets = release.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let zip_asset = assets.iter().find(|asset| {
        asset.get("name")
            .and_then(|n| n.as_str())
            .map(|name| name.to_lowercase().ends_with(".zip"))
            .unwrap_or(false)
    });
    let dll_asset = assets.iter().find(|asset| {
        asset.get("name")
            .and_then(|n| n.as_str())
            .map(|name| name.to_lowercase().ends_with(".dll") && name.to_lowercase().contains("mlvscan"))
            .unwrap_or(false)
    });

    let (asset_url, asset_name, target) = if let Some(asset) = zip_asset {
        let url = asset.get("browser_download_url").and_then(|v| v.as_str());
        let name = asset.get("name").and_then(|v| v.as_str());
        match (url, name) {
            (Some(url), Some(name)) => (url.to_string(), name.to_string(), None),
            _ => return error_json(format!("Invalid ZIP asset for MLVScan version {}", version_tag)),
        }
    } else if let Some(asset) = dll_asset {
        let url = asset.get("browser_download_url").and_then(|v| v.as_str());
        match url {
            Some(url) => (url.to_string(), "MLVScan.dll".to_string(), Some("plugins".to_string())),
            None => return error_json(format!("Invalid DLL asset for MLVScan version {}", version_tag)),
        }
    } else {
        return error_json(format!("No ZIP or DLL asset found for MLVScan version {}", version_tag));
    };

    let bytes = github_service.download_release_asset(&asset_url)
        .await
        .map_err(|e| e.to_string())?;

    let temp_dir = std::env::temp_dir();
    let sanitized_tag = version_tag.replace('/', "_").replace('\\', "_").replace(':', "_");
    let temp_path = temp_dir.join(format!("mlvscan-{}-{}", sanitized_tag, asset_name));
    tokio::fs::write(&temp_path, bytes).await
        .map_err(|e| format!("Failed to save downloaded file: {}", e))?;

    let metadata = build_mlvscan_library_metadata(&version_tag);

    let mods_service = ModsService::new(db.inner().clone());
    let result = mods_service
        .store_mod_archive(
            &temp_path.to_string_lossy(),
            &asset_name,
            None,
            Some(metadata),
            target,
        )
        .await;

    let _ = tokio::fs::remove_file(&temp_path).await;

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_s1api(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let mods_service = ModsService::new(db.inner().clone());
    mods_service.uninstall_s1api(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_mlvscan_library_metadata, build_s1api_library_metadata, detect_upload_kind,
        parse_runtime_label, UploadKind,
    };

    #[test]
    fn detect_upload_kind_matches_supported_extensions() {
        assert_eq!(detect_upload_kind("C:/mods/a.zip"), UploadKind::Zip);
        assert_eq!(detect_upload_kind("C:/mods/a.ZIP"), UploadKind::Zip);
        assert_eq!(detect_upload_kind("C:/mods/a.dll"), UploadKind::Dll);
        assert_eq!(detect_upload_kind("C:/mods/a.DLL"), UploadKind::Dll);
        assert_eq!(
            detect_upload_kind("C:/mods/readme.txt"),
            UploadKind::Unsupported
        );
    }

    #[test]
    fn parse_runtime_label_accepts_case_insensitive_values() {
        assert!(matches!(
            parse_runtime_label(Some("IL2CPP")),
            Some(crate::types::Runtime::Il2cpp)
        ));
        assert!(matches!(
            parse_runtime_label(Some("mono")),
            Some(crate::types::Runtime::Mono)
        ));
        assert!(parse_runtime_label(Some("unknown")).is_none());
        assert!(parse_runtime_label(None).is_none());
    }

    #[test]
    fn s1api_library_metadata_is_github_sourced() {
        let metadata = build_s1api_library_metadata("v1.2.3");
        assert_eq!(metadata.get("source").and_then(|v| v.as_str()), Some("github"));
        assert_eq!(
            metadata.get("sourceId").and_then(|v| v.as_str()),
            Some("ifBars/S1API")
        );
        assert_eq!(
            metadata.get("sourceVersion").and_then(|v| v.as_str()),
            Some("v1.2.3")
        );
    }

    #[test]
    fn mlvscan_library_metadata_is_github_sourced() {
        let metadata = build_mlvscan_library_metadata("v0.9.1");
        assert_eq!(metadata.get("source").and_then(|v| v.as_str()), Some("github"));
        assert_eq!(
            metadata.get("sourceId").and_then(|v| v.as_str()),
            Some("ifBars/MLVScan")
        );
        assert_eq!(
            metadata.get("sourceVersion").and_then(|v| v.as_str()),
            Some("v0.9.1")
        );
    }
}
