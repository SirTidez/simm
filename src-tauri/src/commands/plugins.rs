use crate::services::plugins::PluginsService;
use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_fs_service() -> Result<Arc<FileSystemService>, String> {
    let mut service = FS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(FileSystemService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_plugins(db: State<'_, Arc<SqlitePool>>, environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.list_plugins(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_plugins_count(db: State<'_, Arc<SqlitePool>>, environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let plugins_service = PluginsService::new(db.inner().clone());
    let count = plugins_service.count_plugins(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "count": count }))
}

#[tauri::command]
pub async fn delete_plugin(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.delete_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn enable_plugin(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.enable_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_plugin(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.disable_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_plugins_folder(
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

    let plugins_dir = Path::new(&env.output_dir).join("Plugins");
    let fs_service = get_fs_service().await?;
    fs_service.open_folder(&plugins_dir.to_string_lossy().to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_plugin(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    _runtime: String,
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

    let plugins_service = PluginsService::new(db.inner().clone());

    // Check if file is ZIP or DLL
    let file_path_lower = file_path.to_lowercase();
    if file_path_lower.ends_with(".zip") {
        // Handle ZIP files (may contain Thunderstore manifest)
        plugins_service.install_zip_plugin(&env.output_dir, &file_path, metadata)
            .await
            .map_err(|e| e.to_string())
    } else if file_path_lower.ends_with(".dll") {
        // Handle DLL files
        let plugins_directory = Path::new(&env.output_dir).join("Plugins");
        tokio::fs::create_dir_all(&plugins_directory).await
            .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

        let source_path = Path::new(&file_path);
        let dest_path = plugins_directory.join(&original_file_name);
        tokio::fs::copy(source_path, &dest_path).await
            .map_err(|e| format!("Failed to copy plugin file: {}", e))?;

        // Extract metadata
        let source_str = metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));

        let mod_source = match source_str {
            Some("thunderstore") => Some(crate::types::ModSource::Thunderstore),
            Some("nexusmods") => Some(crate::types::ModSource::Nexusmods),
            Some("github") => Some(crate::types::ModSource::Github),
            Some("unknown") => Some(crate::types::ModSource::Unknown),
            _ => Some(crate::types::ModSource::Local),
        };

        let source_id = metadata
            .as_ref()
            .and_then(|m| m.get("sourceId").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let source_version = metadata
            .as_ref()
            .and_then(|m| m.get("sourceVersion").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let source_url = metadata
            .as_ref()
            .and_then(|m| m.get("sourceUrl").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let mod_name = metadata
            .as_ref()
            .and_then(|m| m.get("modName").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let author = metadata
            .as_ref()
            .and_then(|m| m.get("author").and_then(|s| s.as_str()).map(|s| s.to_string()));

        // Update plugin metadata
        let mut plugin_metadata = plugins_service
            .load_plugin_metadata(&plugins_directory)
            .await
            .map_err(|e| e.to_string())?;

        plugin_metadata.insert(original_file_name.clone(), crate::types::ModMetadata {
            source: mod_source.clone(),
            source_id,
            source_version,
            author,
            mod_name,
            source_url,
            installed_version: None,
            installed_at: Some(chrono::Utc::now()),
            last_update_check: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
            mod_storage_id: None,
            symlink_paths: None,
        });

        plugins_service.save_plugin_metadata(&plugins_directory, &plugin_metadata).await
            .map_err(|e| e.to_string())?;

        let response_source = match mod_source {
            Some(crate::types::ModSource::Thunderstore) => "thunderstore",
            Some(crate::types::ModSource::Nexusmods) => "nexusmods",
            Some(crate::types::ModSource::Github) => "github",
            Some(crate::types::ModSource::Unknown) => "unknown",
            Some(crate::types::ModSource::Local) => "local",
            _ => "unknown",
        };

        Ok(serde_json::json!({
            "success": true,
            "fileName": original_file_name,
            "source": response_source
        }))
    } else {
        Err("Only .dll and .zip files are supported for plugins".to_string())
    }
}

#[tauri::command]
pub async fn get_mlvscan_installation_status(
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.get_mlvscan_installation_status(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_mlvscan(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    eprintln!("[install_mlvscan] Starting installation for environment: {}, version: {}", environment_id, version_tag);
    
    // Helper to return error as JSON
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        eprintln!("[install_mlvscan] Error: {}", msg);
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

    // Get GitHub service and fetch MLVScan releases
    eprintln!("[install_mlvscan] Getting GitHub service...");
    let github_service = {
        let settings_service = match SettingsService::new(db.inner().clone()) {
            Ok(service) => service,
            Err(e) => return error_json(format!("Failed to get settings service: {}", e)),
        };
        let token = match settings_service.get_github_token().await {
            Ok(token) => token,
            Err(e) => return error_json(format!("Failed to load GitHub token: {}", e)),
        };
        eprintln!("[install_mlvscan] GitHub service obtained");
        GitHubReleasesService::with_token(token)
    };
    
    eprintln!("[install_mlvscan] Fetching MLVScan releases from GitHub...");
    let releases = match github_service.get_all_releases("ifBars", "MLVScan", false).await {
        Ok(releases) => {
            eprintln!("[install_mlvscan] Found {} releases", releases.len());
            releases
        },
        Err(e) => return error_json(format!("Failed to fetch MLVScan releases: {}", e))
    };
    
    // Find the release matching the version tag
    eprintln!("[install_mlvscan] Looking for version tag: {}", version_tag);
    let release = match releases.iter()
        .find(|r| r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)) {
        Some(release) => {
            eprintln!("[install_mlvscan] Found release: {:?}", release.get("tag_name"));
            release
        },
        None => return error_json(format!("MLVScan version {} not found", version_tag))
    };
    
    // Get the asset URL - support both DLL and ZIP files
    eprintln!("[install_mlvscan] Getting asset URL...");
    let (asset_url, is_zip) = match release.get("assets")
        .and_then(|a| a.as_array()) {
        Some(assets) => {
            // First, try to find MLVScan DLL files (could be MLVScan.dll, MLVScan.MelonLoader.dll, etc.)
            if let Some(dll_asset) = assets.iter()
                .find(|asset| {
                    asset.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| {
                            let name_lower = n.to_lowercase();
                            name_lower.ends_with(".dll") && name_lower.contains("mlvscan")
                        })
                        .unwrap_or(false)
                }) {
                if let Some(url) = dll_asset.get("browser_download_url")
                    .and_then(|u| u.as_str()) {
                    if let Some(name) = dll_asset.get("name").and_then(|n| n.as_str()) {
                        eprintln!("[install_mlvscan] Found MLVScan DLL asset: {}", name);
                    }
                    (url.to_string(), false)
                } else {
                    // Fallback: log available assets for debugging
                    eprintln!("[install_mlvscan] Available assets:");
                    for asset in assets {
                        if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                            eprintln!("  - {}", name);
                        }
                    }
                    return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag))
                }
            } else {
                // If no DLL found, look for ZIP files that might contain MLVScan.dll
                if let Some(zip_asset) = assets.iter()
                    .find(|asset| {
                        asset.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| {
                                let name_lower = n.to_lowercase();
                                name_lower.ends_with(".zip") && 
                                (name_lower.contains("mlvscan") || name_lower.contains("mlv"))
                            })
                            .unwrap_or(false)
                    }) {
                    if let Some(url) = zip_asset.get("browser_download_url")
                        .and_then(|u| u.as_str()) {
                        eprintln!("[install_mlvscan] Found ZIP asset: {:?}", zip_asset.get("name"));
                        (url.to_string(), true)
                    } else {
                        // Fallback: log available assets for debugging
                        eprintln!("[install_mlvscan] Available assets:");
                        for asset in assets {
                            if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                                eprintln!("  - {}", name);
                            }
                        }
                        return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag))
                    }
                } else {
                    // Fallback: log available assets for debugging
                    eprintln!("[install_mlvscan] Available assets:");
                    for asset in assets {
                        if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                            eprintln!("  - {}", name);
                        }
                    }
                    return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag))
                }
            }
        },
        None => return error_json(format!("No assets found for MLVScan version {}", version_tag))
    };
    
    // Download the asset
    eprintln!("[install_mlvscan] Downloading asset from GitHub...");
    let asset_bytes = match github_service.download_release_asset(&asset_url).await {
        Ok(bytes) => {
            eprintln!("[install_mlvscan] Downloaded {} bytes", bytes.len());
            bytes
        },
        Err(e) => return error_json(format!("Failed to download MLVScan: {}", e))
    };
    
    // Save to temp file
    let temp_dir = std::env::temp_dir();
    let sanitized_tag = version_tag.replace('/', "_").replace('\\', "_").replace(':', "_");
    
    let plugins_service = PluginsService::new(db.inner().clone());
    
    let result = if is_zip {
        // Extract MLVScan.dll from ZIP
        let temp_zip_path = temp_dir.join(format!("mlvscan-{}.zip", sanitized_tag));
        if let Err(e) = tokio::fs::write(&temp_zip_path, asset_bytes).await {
            return error_json(format!("Failed to save downloaded ZIP file: {}", e));
        }
        
        // Extract MLVScan.dll from the ZIP - read all data synchronously before any await
        use std::fs::File;
        use zip::ZipArchive;
        let file = match File::open(&temp_zip_path) {
            Ok(f) => f,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_zip_path);
                return error_json(format!("Failed to open ZIP file: {}", e));
            }
        };
        let mut archive = match ZipArchive::new(file) {
            Ok(a) => a,
            Err(e) => {
                let _ = std::fs::remove_file(&temp_zip_path);
                return error_json(format!("Failed to read ZIP archive: {}", e));
            }
        };
        
        let temp_dll_path = temp_dir.join(format!("mlvscan-{}.dll", sanitized_tag));
        let mut found_dll = false;
        let mut dll_content: Option<Vec<u8>> = None;
        
        // Read all ZIP data synchronously before any await
        // We need to collect all data before any await point
        for i in 0..archive.len() {
            // Get file name first (drop the file handle immediately)
            let file_name = {
                let file = match archive.by_index(i) {
                    Ok(f) => f,
                    Err(e) => {
                        // File is dropped here automatically, then we can drop archive
                        let _ = std::fs::remove_file(&temp_zip_path);
                        return error_json(format!("Failed to read ZIP entry {}: {}", i, e));
                    }
                };
                let name = file.name().to_string();
                // File is dropped here when it goes out of scope
                name
            };
            
            // Look for MLVScan DLL files in the ZIP (could be MLVScan.dll, MLVScan.MelonLoader.dll, etc.)
            let name_lower = file_name.to_lowercase();
            if name_lower.ends_with(".dll") && name_lower.contains("mlvscan") {
                // Get the file again to read its contents
                let mut file = match archive.by_index(i) {
                    Ok(f) => f,
                    Err(e) => {
                        // File is dropped here automatically, then we can drop archive
                        let _ = std::fs::remove_file(&temp_zip_path);
                        return error_json(format!("Failed to read ZIP entry {}: {}", i, e));
                    }
                };
                
                let mut content = Vec::new();
                if let Err(e) = std::io::copy(&mut file, &mut content) {
                    // Drop file first, then we can drop archive
                    drop(file);
                    let _ = std::fs::remove_file(&temp_zip_path);
                    return error_json(format!("Failed to extract DLL from ZIP: {}", e));
                }
                
                // Drop file before storing content and breaking
                drop(file);
                dll_content = Some(content);
                found_dll = true;
                break;
            }
        }
        
        // Clean up ZIP file synchronously (before await)
        drop(archive);
        let _ = std::fs::remove_file(&temp_zip_path);
        
        if !found_dll {
            return error_json(format!("MLVScan.dll not found in ZIP file for version {}", version_tag));
        }
        
        // Now we can use await - write the DLL content we extracted
        let content = match dll_content {
            Some(c) => c,
            None => return error_json(format!("MLVScan.dll content not found")),
        };
        
        if let Err(e) = tokio::fs::write(&temp_dll_path, content).await {
            return error_json(format!("Failed to write extracted DLL: {}", e));
        }
        
        // Install from the extracted DLL
        let install_result = plugins_service.install_mlvscan(
            &env.output_dir,
            &temp_dll_path.to_string_lossy(),
            &version_tag
        ).await;
        
        // Clean up temp DLL file (ignore errors)
        let _ = tokio::fs::remove_file(&temp_dll_path).await;
        
        match install_result {
            Ok(value) => value,
            Err(e) => return error_json(format!("Installation failed: {}", e))
        }
    } else {
        // Direct DLL download
        let temp_dll_path = temp_dir.join(format!("mlvscan-{}.dll", sanitized_tag));
        
        if let Err(e) = tokio::fs::write(&temp_dll_path, asset_bytes).await {
            return error_json(format!("Failed to save downloaded file: {}", e));
        }
        
        // Install from the temp file
        let install_result = plugins_service.install_mlvscan(
            &env.output_dir,
            &temp_dll_path.to_string_lossy(),
            &version_tag
        ).await;
        
        // Clean up temp file (ignore errors)
        let _ = tokio::fs::remove_file(&temp_dll_path).await;
        
        match install_result {
            Ok(value) => value,
            Err(e) => return error_json(format!("Installation failed: {}", e))
        }
    };
    
    Ok(result)
}

#[tauri::command]
pub async fn uninstall_mlvscan(
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service.uninstall_mlvscan(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}
