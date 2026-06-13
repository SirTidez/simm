use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::utils::logging::{error_with_location, warn_with_location};
use crate::utils::validation::validate_directory_path;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;
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

#[track_caller]
fn command_warn(message: impl Into<String>) -> String {
    let message = message.into();
    warn_with_location(&message);
    message
}

#[track_caller]
fn command_error(message: impl Into<String>) -> String {
    let message = message.into();
    error_with_location(&message);
    message
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn resolve_launch_method<'a>(
    requested_method: Option<&'a str>,
    is_steam_environment: bool,
) -> &'a str {
    match requested_method {
        Some(method) => method,
        None if cfg!(target_os = "linux") => "steam",
        None if is_steam_environment => "steam",
        None => "direct",
    }
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
pub async fn open_path(path: String) -> Result<(), String> {
    let path = validate_directory_path(&path, None).map_err(|e| format!("Invalid path: {}", e))?;
    let fs_service = get_fs_service().await?;
    fs_service.open_path(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS URLs can be opened externally".to_string());
    }

    #[allow(deprecated)]
    app.shell()
        .open(parsed.to_string(), None)
        .map_err(|e| format!("Failed to open URL: {}", e))
}

#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    let path = validate_directory_path(&path, None).map_err(|e| format!("Invalid path: {}", e))?;
    let fs_service = get_fs_service().await?;
    fs_service
        .reveal_path(&path)
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
        .ok_or_else(|| {
            command_warn(format!(
                "Launch requested for unknown environment {}",
                environment_id
            ))
        })?;

    if env.output_dir.is_empty() {
        return Err(command_warn(format!(
            "Launch requested for environment {} but output directory is not set",
            environment_id
        )));
    }

    match env.status {
        crate::types::EnvironmentStatus::Completed => {}
        _ => {
            return Err(command_warn(format!(
                "Launch requested for environment {} before download completed",
                environment_id
            )))
        }
    }

    let fs_service = get_fs_service().await?;

    let is_steam_environment = env.environment_type == Some(crate::types::EnvironmentType::Steam);
    let method_str = resolve_launch_method(launch_method.as_deref(), is_steam_environment);
    if cfg!(target_os = "linux") && method_str == "direct" {
        return Err(command_warn(
            "Direct local launch is not supported on Linux because Schedule I runs through Steam Proton. Use Steam launch instead.",
        ));
    }
    let game_dir_for_launch = if method_str == "steam" && is_steam_environment {
        None
    } else {
        Some(env.output_dir.as_str())
    };

    let launch_started_at = now_epoch_millis();
    let result = fs_service
        .launch_game(game_dir_for_launch, Some(method_str))
        .await
        .map_err(|e| {
            let launch_error = e.to_string();
            command_error(format!(
                "Launch command failed for environment {} via {}: {}",
                environment_id, method_str, launch_error
            ));
            launch_error
        })?;

    Ok(serde_json::json!({
        "success": true,
        "executablePath": result,
        "launchStartedAt": launch_started_at,
        "launchMethod": method_str,
        "environmentId": environment_id
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

#[cfg(test)]
mod tests {
    use super::resolve_launch_method;

    #[test]
    fn launch_method_defaults_to_steam_for_steam_environments() {
        assert_eq!(resolve_launch_method(None, true), "steam");
    }

    #[test]
    fn launch_method_defaults_for_non_steam_environments() {
        #[cfg(target_os = "linux")]
        assert_eq!(resolve_launch_method(None, false), "steam");
        #[cfg(not(target_os = "linux"))]
        assert_eq!(resolve_launch_method(None, false), "direct");
    }

    #[test]
    fn launch_method_preserves_explicit_steam_for_non_steam_environments() {
        assert_eq!(resolve_launch_method(Some("steam"), false), "steam");
    }

    #[test]
    fn launch_method_preserves_known_and_unknown_explicit_methods_for_steam_environments() {
        assert_eq!(resolve_launch_method(Some("direct"), true), "direct");
        assert_eq!(
            resolve_launch_method(Some("steam_restart"), false),
            "steam_restart"
        );
        assert_eq!(resolve_launch_method(Some("mystery"), true), "mystery");
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
