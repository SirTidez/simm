use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::melon_loader::MelonLoaderService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

static MELON_LOADER_SERVICE: Lazy<AsyncMutex<Option<Arc<MelonLoaderService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_melon_loader_service() -> Result<Arc<MelonLoaderService>, String> {
    let mut service = MELON_LOADER_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(MelonLoaderService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_melon_loader_status(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
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

    let melon_loader_service = get_melon_loader_service().await?;
    let installed = melon_loader_service.is_melon_loader_installed(&env.output_dir);
    let version = if installed {
        melon_loader_service
            .get_installed_version(&env.output_dir)
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
pub async fn install_melon_loader(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    environment_id: String,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    eprintln!(
        "[install_melon_loader] Starting installation for environment: {}, version: {}",
        environment_id, version_tag
    );

    // Generate a download_id for tracking this installation
    let download_id = format!(
        "melonloader-{}-{}",
        environment_id,
        chrono::Utc::now().timestamp_millis()
    );

    // Emit installing event
    let _ = events::emit_melonloader_installing(
        &app,
        download_id.clone(),
        format!("Starting MelonLoader {} installation...", version_tag),
    );

    // Helper to return error as JSON
    let error_json = |msg: String| -> Result<serde_json::Value, String> {
        eprintln!("[install_melon_loader] Error: {}", msg);
        Ok(serde_json::json!({
            "success": false,
            "error": msg
        }))
    };

    let env_service = match EnvironmentService::new(db.inner().clone()) {
        Ok(service) => service,
        Err(e) => return error_json(format!("Failed to get environment service: {}", e)),
    };

    let env = match env_service.get_environment(&environment_id).await {
        Ok(Some(env)) => env,
        Ok(None) => return error_json("Environment not found".to_string()),
        Err(e) => return error_json(format!("Failed to get environment: {}", e)),
    };

    if env.output_dir.is_empty() {
        return error_json("Output directory not set".to_string());
    }

    // Get all MelonLoader releases to find the one matching the version tag
    eprintln!("[install_melon_loader] Initializing release service...");
    let github_service = GitHubReleasesService::new();

    eprintln!("[install_melon_loader] Fetching MelonLoader releases from release API...");
    let releases = match github_service
        .get_all_releases("LavaGang", "MelonLoader", false)
        .await
    {
        Ok(releases) => {
            eprintln!("[install_melon_loader] Found {} releases", releases.len());
            releases
        }
        Err(e) => return error_json(format!("Failed to fetch MelonLoader releases: {}", e)),
    };

    // Find the release matching the version tag
    eprintln!(
        "[install_melon_loader] Looking for version tag: {}",
        version_tag
    );
    let release = match releases.iter().find(|r| {
        r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)
    }) {
        Some(release) => {
            eprintln!(
                "[install_melon_loader] Found release: {:?}",
                release.get("tag_name")
            );
            release
        }
        None => return error_json(format!("MelonLoader version {} not found", version_tag)),
    };

    // Get the Windows x64 ZIP asset URL
    eprintln!("[install_melon_loader] Getting Windows x64 ZIP asset URL...");
    let zip_url = match github_service.get_melonloader_x64_asset_url(release) {
        Some(url) => {
            eprintln!("[install_melon_loader] Windows x64 ZIP URL: {}", url);
            url
        }
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
            return error_json(format!("No Windows x64 ZIP asset found for MelonLoader version {}. Please ensure the release contains a MelonLoader.x64.zip file.", version_tag));
        }
    };

    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("melonloader"),
        crate::types::TrackedDownloadKind::Framework,
        format!("MelonLoader-{}.zip", version_tag),
        env.name.clone(),
        Some("Downloading framework".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    // Download the ZIP file
    eprintln!("[install_melon_loader] Downloading ZIP asset...");
    let zip_bytes = match github_service.download_release_asset(&zip_url).await {
        Ok(bytes) => {
            eprintln!("[install_melon_loader] Downloaded {} bytes", bytes.len());
            bytes
        }
        Err(e) => {
            let message = format!("Failed to download MelonLoader: {}", e);
            let _ = crate::services::tracked_downloads::emit(
                &app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    message.clone(),
                    Some("Download failed".to_string()),
                ),
            );
            return error_json(message);
        }
    };

    // Save to temp file
    let temp_dir = std::env::temp_dir();
    // Sanitize version tag for filename (remove invalid characters)
    let sanitized_tag = version_tag
        .replace('/', "_")
        .replace('\\', "_")
        .replace(':', "_");
    let temp_zip_path = temp_dir.join(format!("melonloader-{}.zip", sanitized_tag));

    if let Err(e) = tokio::fs::write(&temp_zip_path, zip_bytes).await {
        let message = format!("Failed to save downloaded file: {}", e);
        let _ = crate::services::tracked_downloads::emit(
            &app,
            crate::services::tracked_downloads::fail_file_download(
                &tracked_download,
                message.clone(),
                Some("Download failed".to_string()),
            ),
        );
        return error_json(message);
    }
    let _ = crate::services::tracked_downloads::emit(
        &app,
        crate::services::tracked_downloads::complete_file_download(
            &tracked_download,
            Some("Framework downloaded".to_string()),
        ),
    );

    // Install from the temp file
    let melon_loader_service = match get_melon_loader_service().await {
        Ok(service) => service,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_zip_path).await;
            return error_json(format!("Failed to get MelonLoader service: {}", e));
        }
    };

    let result = melon_loader_service
        .install_melon_loader(&env.output_dir, &temp_zip_path.to_string_lossy())
        .await;

    // Clean up temp file (ignore errors)
    let _ = tokio::fs::remove_file(&temp_zip_path).await;

    // The service returns Ok(serde_json::Value) with success/error fields
    // So we just return it directly
    match result {
        Ok(json_result) => {
            // Check if installation was successful
            if let Some(success) = json_result.get("success").and_then(|s| s.as_bool()) {
                if success {
                    // Extract version from result if available
                    let version = json_result
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let _ = events::emit_melonloader_installed(
                        &app,
                        download_id.clone(),
                        format!("MelonLoader {} installed successfully", version_tag),
                        version,
                    );
                } else {
                    // Installation failed
                    let error_msg = json_result
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("Installation failed")
                        .to_string();

                    let _ = events::emit_melonloader_error(
                        &app,
                        download_id.clone(),
                        error_msg.clone(),
                    );
                }
            }
            Ok(json_result)
        }
        Err(e) => {
            let error_msg = format!("Installation failed: {}", e);
            let _ = events::emit_melonloader_error(&app, download_id.clone(), error_msg.clone());
            error_json(error_msg)
        }
    }
}

#[tauri::command]
pub async fn get_available_melonloader_versions(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let _ = db;
    let github_service = GitHubReleasesService::new();

    let releases = github_service
        .get_all_releases("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| format!("Failed to fetch MelonLoader releases: {}", e))?;

    // Map to simplified version objects
    let versions: Vec<serde_json::Value> = releases
        .into_iter()
        .map(|release| {
            serde_json::json!({
                "tag": release.get("tag_name").and_then(|t| t.as_str()).unwrap_or(""),
                "name": release.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                "publishedAt": release.get("published_at"),
                "prerelease": release.get("prerelease").and_then(|p| p.as_bool()).unwrap_or(false),
            })
        })
        .collect();

    Ok(versions)
}

#[tauri::command]
pub async fn uninstall_melon_loader(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
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

    let melon_loader_service = get_melon_loader_service().await?;
    melon_loader_service
        .uninstall_melon_loader(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}
