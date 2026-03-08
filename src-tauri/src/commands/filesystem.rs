use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::fs;
use tokio::sync::Mutex as AsyncMutex;

static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_fs_service() -> Result<Arc<FileSystemService>, String> {
    let mut service = FS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(FileSystemService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn open_folder(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let fs_service = get_fs_service().await?;
    fs_service
        .open_folder(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn launch_game(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    launch_method: Option<String>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    match env.status {
        crate::types::EnvironmentStatus::Completed => {}
        _ => return Err("Game must be downloaded before launching".to_string()),
    }

    let fs_service = get_fs_service().await?;

    // Determine launch method based on environment type or provided method
    let method_str = if let Some(ref m) = launch_method {
        eprintln!("[Launch] Using provided launch method: {}", m);
        m.as_str()
    } else if env.environment_type == Some(crate::types::EnvironmentType::Steam) {
        eprintln!("[Launch] Defaulting to Steam for Steam environment");
        "steam" // Steam environments should launch via Steam
    } else {
        eprintln!("[Launch] Defaulting to direct for DepotDownloader environment");
        "direct" // DepotDownloader environments should launch directly
    };

    eprintln!(
        "[Launch] Final method_str: {}, environment_type: {:?}",
        method_str, env.environment_type
    );

    let is_steam_environment = env.environment_type == Some(crate::types::EnvironmentType::Steam);
    let game_dir_for_launch = if method_str == "steam" && is_steam_environment {
        eprintln!("[Launch] Steam environment + steam method: launching via Steam client");
        None
    } else {
        Some(env.output_dir.as_str())
    };

    let result = fs_service
        .launch_game(game_dir_for_launch, Some(method_str))
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "success": true,
        "executablePath": result
    }))
}

#[tauri::command]
pub async fn browse_directory(path: Option<String>) -> Result<serde_json::Value, String> {
    // Use the provided path or default to home/SIMM directory
    let start_path: PathBuf = if let Some(ref p) = path {
        if p.is_empty() {
            // If empty string, use default home/SIMM
            dirs::home_dir()
                .map(|p| {
                    let mut path = p.to_path_buf();
                    path.push("SIMM");
                    path
                })
                .unwrap_or_else(|| PathBuf::from("."))
        } else {
            PathBuf::from(p)
        }
    } else {
        // If None, use default home/SIMM
        dirs::home_dir()
            .map(|p| {
                let mut path = p.to_path_buf();
                path.push("SIMM");
                path
            })
            .unwrap_or_else(|| PathBuf::from("."))
    };

    // If path doesn't exist, use parent or home/SIMM
    let default_simm_path = dirs::home_dir()
        .map(|p| {
            let mut path = p.to_path_buf();
            path.push("SIMM");
            path
        })
        .unwrap_or_else(|| PathBuf::from("."));

    let browse_path: PathBuf = if start_path.exists() && start_path.is_dir() {
        start_path
    } else if let Some(parent) = start_path.parent() {
        if parent.exists() && parent.is_dir() {
            parent.to_path_buf()
        } else {
            default_simm_path
        }
    } else {
        default_simm_path
    };

    // Read directory contents
    let current_path = browse_path.to_string_lossy().to_string();
    let mut directories = Vec::new();

    match fs::read_dir(&browse_path).await {
        Ok(mut entries) => {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let entry_path = entry.path();
                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_dir() {
                        if let Some(name) = entry_path.file_name() {
                            directories.push(serde_json::json!({
                                "name": name.to_string_lossy(),
                                "path": entry_path.to_string_lossy()
                            }));
                        }
                    }
                }
            }
        }
        Err(e) => {
            return Err(format!("Failed to read directory: {}", e));
        }
    }

    // Sort directories by name
    directories.sort_by(|a, b| {
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");
        a_name.cmp(b_name)
    });

    Ok(serde_json::json!({
        "currentPath": current_path,
        "directories": directories
    }))
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<serde_json::Value, String> {
    let dir_path = PathBuf::from(&path);

    // Validate path
    if dir_path.exists() {
        return Err("Directory already exists".to_string());
    }

    // Create the directory
    match fs::create_dir_all(&dir_path).await {
        Ok(_) => Ok(serde_json::json!({
            "success": true,
            "path": dir_path.to_string_lossy().to_string()
        })),
        Err(e) => Err(format!("Failed to create directory: {}", e)),
    }
}

#[tauri::command]
pub async fn browse_files(
    path: Option<String>,
    file_extension: Option<String>,
) -> Result<serde_json::Value, String> {
    // Use the provided path or default to home directory
    let start_path: PathBuf = if let Some(ref p) = path {
        PathBuf::from(p)
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    };

    // If path doesn't exist, use parent or home
    let browse_path: PathBuf = if start_path.exists() && start_path.is_dir() {
        start_path
    } else if let Some(parent) = start_path.parent() {
        if parent.exists() && parent.is_dir() {
            parent.to_path_buf()
        } else {
            dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
        }
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    };

    // Read directory contents
    let current_path = browse_path.to_string_lossy().to_string();
    let mut items = Vec::new();

    match fs::read_dir(&browse_path).await {
        Ok(mut entries) => {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let entry_path = entry.path();
                if let Ok(metadata) = entry.metadata().await {
                    let item_type = if metadata.is_dir() {
                        "directory"
                    } else {
                        "file"
                    };

                    // Filter by file extension if provided
                    if let Some(ref ext) = file_extension {
                        if item_type == "file" {
                            if let Some(entry_ext) = entry_path.extension() {
                                if entry_ext.to_string_lossy().to_lowercase()
                                    != ext.trim_start_matches('.').to_lowercase()
                                {
                                    continue;
                                }
                            } else {
                                continue;
                            }
                        }
                    }

                    if let Some(name) = entry_path.file_name() {
                        items.push(serde_json::json!({
                            "name": name.to_string_lossy(),
                            "path": entry_path.to_string_lossy(),
                            "type": item_type
                        }));
                    }
                }
            }
        }
        Err(e) => {
            return Err(format!("Failed to read directory: {}", e));
        }
    }

    // Sort items: directories first, then files, both alphabetically
    items.sort_by(|a, b| {
        let a_type = a["type"].as_str().unwrap_or("");
        let b_type = b["type"].as_str().unwrap_or("");
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");

        match (a_type == "directory", b_type == "directory") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a_name.cmp(b_name),
        }
    });

    Ok(serde_json::json!({
        "currentPath": current_path,
        "items": items
    }))
}
