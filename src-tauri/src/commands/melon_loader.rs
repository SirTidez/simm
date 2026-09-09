use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::melon_loader::MelonLoaderService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

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
    let linux_requirements = melon_loader_service
        .get_linux_requirements_status(&env)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "installed": installed,
        "version": version,
        "linuxRequirements": linux_requirements
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
        environment_id.clone(),
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

    let melon_loader_service = match get_melon_loader_service().await {
        Ok(service) => service,
        Err(e) => return error_json(format!("Failed to get MelonLoader service: {}", e)),
    };

    let linux_prerequisite_message =
        match melon_loader_service.ensure_linux_prerequisites(&env).await {
            Ok(message) => message,
            Err(e) => return error_json(e.to_string()),
        };

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
                    let version = match melon_loader_service
                        .write_installed_version(&env.output_dir, &version_tag)
                        .await
                    {
                        Ok(version) => version,
                        Err(error) => {
                            return error_json(format!(
                                "MelonLoader installed, but SIMM could not record the installed version: {}",
                                error
                            ));
                        }
                    };

                    if let Err(error) = env_service
                        .update_environment(
                            &environment_id,
                            [(
                                "melonLoaderVersion".to_string(),
                                serde_json::Value::String(version.clone()),
                            )],
                        )
                        .await
                    {
                        return error_json(format!(
                            "MelonLoader installed, but SIMM could not update the environment metadata: {}",
                            error
                        ));
                    }

                    let _ = events::emit_melonloader_installed(
                        &app,
                        download_id.clone(),
                        environment_id.clone(),
                        format!("MelonLoader {} installed successfully", version_tag),
                        Some(version.clone()),
                    );

                    let mut enriched = json_result.clone();
                    if let Some(object) = enriched.as_object_mut() {
                        object.insert(
                            "version".to_string(),
                            serde_json::Value::String(version.clone()),
                        );
                    }
                    if let Some(message) = linux_prerequisite_message {
                        if let Some(object) = enriched.as_object_mut() {
                            object.insert(
                                "linuxPrerequisiteMessage".to_string(),
                                serde_json::Value::String(message),
                            );
                            object.insert(
                                "linuxLaunchOptions".to_string(),
                                serde_json::Value::String(
                                    MelonLoaderService::linux_melonloader_launch_options()
                                        .to_string(),
                                ),
                            );
                        }
                    }
                    return Ok(enriched);
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
                        environment_id.clone(),
                        error_msg.clone(),
                    );
                }
            }
            Ok(json_result)
        }
        Err(e) => {
            let error_msg = format!("Installation failed: {}", e);
            let _ = events::emit_melonloader_error(
                &app,
                download_id.clone(),
                environment_id.clone(),
                error_msg.clone(),
            );
            error_json(error_msg)
        }
    }
}

#[tauri::command]
pub async fn repair_melonloader_launch_options(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    if !cfg!(target_os = "linux") {
        return Ok(serde_json::json!({
            "success": true,
            "message": "No Linux Proton launch option repair is required on this platform"
        }));
    }

    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let is_steam_env = env.environment_type == Some(crate::types::EnvironmentType::Steam)
        || env.id.starts_with("steam-");

    let shortcut = if is_steam_env {
        None
    } else {
        Some(
            crate::services::filesystem::FileSystemService::new()
                .ensure_schedule_i_steam_shortcut(&env.output_dir)
                .await
                .map_err(|e| e.to_string())?,
        )
    };

    let steam_launch_options = if is_steam_env {
        Some(
            crate::services::steam::SteamService::new()
                .ensure_schedule_i_launch_options()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let melon_loader_service = get_melon_loader_service().await?;
    let mut linux_requirements = melon_loader_service
        .get_linux_requirements_status(&env)
        .await
        .map_err(|e| e.to_string())?;
    let mut linux_prerequisite_message = None;

    let can_install_prerequisites = linux_requirements
        .as_ref()
        .and_then(|requirements| requirements.get("canInstallPrerequisites"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let prerequisites_missing = linux_requirements
        .as_ref()
        .and_then(|requirements| requirements.get("prerequisitesInstalled"))
        .and_then(|value| value.as_bool())
        == Some(false);

    if can_install_prerequisites && prerequisites_missing {
        linux_prerequisite_message = melon_loader_service
            .ensure_linux_prerequisites(&env)
            .await
            .map_err(|e| e.to_string())?;
        linux_requirements = melon_loader_service
            .get_linux_requirements_status(&env)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "success": true,
        "steamLaunchOptions": steam_launch_options,
        "shortcut": shortcut,
        "linuxPrerequisiteMessage": linux_prerequisite_message,
        "linuxRequirements": linux_requirements
    }))
}

#[tauri::command]
pub async fn verify_melonloader_launch(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    launch_started_at: u64,
    timeout_ms: Option<u64>,
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
        .verify_launch_after(&env.output_dir, launch_started_at, timeout_ms)
        .await
        .map_err(|e| e.to_string())
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
