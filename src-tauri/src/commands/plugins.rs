use crate::commands::mods::{
    finalize_security_scan_response, prepare_security_scan_with_settings, SecurityGateResult,
};
use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::mod_profiles::ModProfilesService;
use crate::services::mods::ModsService;
use crate::services::plugins::PluginsService;
use crate::services::settings::RuntimeSettingsState;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

#[cfg(test)]
fn map_source_to_mod_source(source_str: Option<&str>) -> Option<crate::types::ModSource> {
    match source_str {
        Some("thunderstore") => Some(crate::types::ModSource::Thunderstore),
        Some("nexusmods") => Some(crate::types::ModSource::Nexusmods),
        Some("github") => Some(crate::types::ModSource::Github),
        Some("unknown") => Some(crate::types::ModSource::Unknown),
        _ => Some(crate::types::ModSource::Local),
    }
}

#[cfg(test)]
fn response_source_label(mod_source: Option<crate::types::ModSource>) -> &'static str {
    match mod_source {
        Some(crate::types::ModSource::Thunderstore) => "thunderstore",
        Some(crate::types::ModSource::Nexusmods) => "nexusmods",
        Some(crate::types::ModSource::Github) => "github",
        Some(crate::types::ModSource::Unknown) => "unknown",
        Some(crate::types::ModSource::Local) => "local",
        _ => "unknown",
    }
}

async fn get_environment_output_dir(
    db: Arc<SqlitePool>,
    environment_id: &str,
) -> Result<String, String> {
    let env_service = EnvironmentService::new(db).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    Ok(env.output_dir)
}

async fn get_mlvscan_installation_status_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let output_dir = get_environment_output_dir(db.clone(), &environment_id).await?;
    let plugins_service = PluginsService::new(db);
    plugins_service
        .get_mlvscan_installation_status(&output_dir)
        .await
        .map_err(|e| e.to_string())
}

async fn get_fs_service() -> Result<Arc<FileSystemService>, String> {
    let mut service = FS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(FileSystemService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

fn parse_plugin_runtime(
    runtime: &str,
    fallback: &crate::types::Runtime,
) -> Result<crate::types::Runtime, String> {
    match runtime.trim().to_lowercase().as_str() {
        "il2cpp" => Ok(crate::types::Runtime::Il2cpp),
        "mono" => Ok(crate::types::Runtime::Mono),
        "" => Ok(fallback.clone()),
        other => Err(format!(
            "Unsupported plugin runtime '{}'. Expected IL2CPP or Mono.",
            other
        )),
    }
}

fn plugin_runtime_label(runtime: &crate::types::Runtime) -> &'static str {
    match runtime {
        crate::types::Runtime::Il2cpp => "IL2CPP",
        crate::types::Runtime::Mono => "Mono",
    }
}

fn plugin_source_label(metadata: &Option<serde_json::Value>) -> &'static str {
    match metadata
        .as_ref()
        .and_then(|value| value.get("source"))
        .and_then(|value| value.as_str())
    {
        Some("thunderstore") => "thunderstore",
        Some("nexusmods") => "nexusmods",
        Some("github") => "github",
        Some("unknown") => "unknown",
        Some("local") | None => "local",
        _ => "unknown",
    }
}

fn installed_files_from_storage_install(result: &serde_json::Value) -> Vec<String> {
    result
        .get("results")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("installedFiles")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str().map(ToString::to_string))
        })
        .collect()
}

async fn upload_plugin_impl(
    db: Arc<SqlitePool>,
    settings: &crate::types::Settings,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    metadata: Option<serde_json::Value>,
    security_override: Option<bool>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let file_path_lower = file_path.to_lowercase();
    let original_file_name_lower = original_file_name.to_lowercase();
    let is_zip = file_path_lower.ends_with(".zip") || original_file_name_lower.ends_with(".zip");
    let is_dll = file_path_lower.ends_with(".dll") || original_file_name_lower.ends_with(".dll");
    if !is_zip && !is_dll {
        return Err("Only .dll and .zip files are supported for plugins".to_string());
    }

    let requested_runtime = parse_plugin_runtime(&runtime, &env.runtime)?;
    let mods_service = ModsService::new(db).with_runtime_settings(settings.clone());
    let (metadata, security_report) = match prepare_security_scan_with_settings(
        settings,
        &file_path,
        metadata,
        security_override.unwrap_or(false),
    )
    .await?
    {
        SecurityGateResult::Continue { metadata, report } => (metadata, report),
        SecurityGateResult::EarlyResponse(response) => return Ok(response),
    };
    let store_result = mods_service
        .store_mod_archive(
            &file_path,
            &original_file_name,
            Some(requested_runtime.clone()),
            metadata.clone(),
            Some("plugins".to_string()),
        )
        .await
        .map_err(|e| e.to_string())?;

    if !store_result
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Ok(store_result);
    }

    let storage_id = store_result
        .get("storageId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Stored plugin archive did not return a storage ID".to_string())?
        .to_string();

    let install_result = mods_service
        .install_storage_mod_to_envs(&storage_id, vec![environment_id])
        .await
        .map_err(|e| e.to_string())?;
    let mut installed_files = installed_files_from_storage_install(&install_result);
    if installed_files.is_empty() {
        installed_files = store_result
            .get("installedFiles")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect();
    }

    let response = serde_json::json!({
        "success": true,
        "storageId": storage_id,
        "installedFiles": installed_files,
        "source": plugin_source_label(&metadata),
        "runtime": plugin_runtime_label(&requested_runtime),
        "storage": store_result,
        "result": install_result,
    });

    Ok(finalize_security_scan_response(
        &mods_service,
        response,
        security_report.as_ref(),
        "installing a plugin upload",
    )
    .await)
}

#[tauri::command]
pub async fn get_plugins(
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service
        .list_plugins(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_plugins_count(
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

    let plugins_service = PluginsService::new(db.inner().clone());
    let count = plugins_service
        .count_plugins(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "count": count }))
}

#[tauri::command]
pub async fn delete_plugin(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service
        .delete_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn enable_plugin(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service
        .enable_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn disable_plugin(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    plugin_file_name: String,
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

    let plugins_service = PluginsService::new(db.inner().clone());
    plugins_service
        .disable_plugin(&env.output_dir, &plugin_file_name)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn open_plugins_folder(
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

    let plugins_dir = Path::new(&env.output_dir).join("Plugins");
    let fs_service = get_fs_service().await?;
    fs_service
        .open_folder(&plugins_dir.to_string_lossy().to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_plugin(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    metadata: Option<serde_json::Value>,
    security_override: Option<bool>,
) -> Result<serde_json::Value, String> {
    let settings = runtime_settings.snapshot().await;
    let result = upload_plugin_impl(
        db.inner().clone(),
        &settings,
        environment_id.clone(),
        file_path,
        original_file_name,
        runtime,
        metadata,
        security_override,
    )
    .await?;

    if result
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        if let Err(error) = ModProfilesService::new(db.inner().clone())
            .with_runtime_settings(settings)
            .sync_active_profile_from_environment(&environment_id)
            .await
        {
            log::warn!(
                "Failed to sync active profile for {} after plugin upload: {}",
                environment_id,
                error
            );
        }
    }

    if let Err(error) = crate::events::emit_mods_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit mods_changed for {} after plugin upload: {}",
            environment_id,
            error
        );
    }

    if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_mlvscan_installation_status(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    get_mlvscan_installation_status_impl(db.inner().clone(), environment_id).await
}

#[tauri::command]
pub async fn install_mlvscan(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    environment_id: String,
    version_tag: String,
) -> Result<serde_json::Value, String> {
    eprintln!(
        "[install_mlvscan] Starting installation for environment: {}, version: {}",
        environment_id, version_tag
    );

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

    // Get release service and fetch MLVScan releases
    eprintln!("[install_mlvscan] Initializing release service...");
    let github_service = GitHubReleasesService::new();

    eprintln!("[install_mlvscan] Fetching MLVScan releases from release API...");
    let releases = match github_service
        .get_all_releases("ifBars", "MLVScan", false)
        .await
    {
        Ok(releases) => {
            eprintln!("[install_mlvscan] Found {} releases", releases.len());
            releases
        }
        Err(e) => return error_json(format!("Failed to fetch MLVScan releases: {}", e)),
    };

    // Find the release matching the version tag
    eprintln!("[install_mlvscan] Looking for version tag: {}", version_tag);
    let release = match releases.iter().find(|r| {
        r.get("tag_name")
            .and_then(|t| t.as_str())
            .map(|t| t == version_tag)
            .unwrap_or(false)
    }) {
        Some(release) => {
            eprintln!(
                "[install_mlvscan] Found release: {:?}",
                release.get("tag_name")
            );
            release
        }
        None => return error_json(format!("MLVScan version {} not found", version_tag)),
    };

    // Get the asset URL - support both DLL and ZIP files
    eprintln!("[install_mlvscan] Getting asset URL...");
    let (asset_url, is_zip, asset_label) = match release.get("assets").and_then(|a| a.as_array()) {
        Some(assets) => {
            // First, try to find MLVScan DLL files (could be MLVScan.dll, MLVScan.MelonLoader.dll, etc.)
            if let Some(dll_asset) = assets.iter().find(|asset| {
                asset
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| {
                        let name_lower = n.to_lowercase();
                        name_lower.ends_with(".dll") && name_lower.contains("mlvscan")
                    })
                    .unwrap_or(false)
            }) {
                if let Some(url) = dll_asset
                    .get("browser_download_url")
                    .and_then(|u| u.as_str())
                {
                    if let Some(name) = dll_asset.get("name").and_then(|n| n.as_str()) {
                        eprintln!("[install_mlvscan] Found MLVScan DLL asset: {}", name);
                    }
                    (
                        url.to_string(),
                        false,
                        dll_asset
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("MLVScan.dll")
                            .to_string(),
                    )
                } else {
                    // Fallback: log available assets for debugging
                    eprintln!("[install_mlvscan] Available assets:");
                    for asset in assets {
                        if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                            eprintln!("  - {}", name);
                        }
                    }
                    return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag));
                }
            } else {
                // If no DLL found, look for ZIP files that might contain MLVScan.dll
                if let Some(zip_asset) = assets.iter().find(|asset| {
                    asset
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| {
                            let name_lower = n.to_lowercase();
                            name_lower.ends_with(".zip")
                                && (name_lower.contains("mlvscan") || name_lower.contains("mlv"))
                        })
                        .unwrap_or(false)
                }) {
                    if let Some(url) = zip_asset
                        .get("browser_download_url")
                        .and_then(|u| u.as_str())
                    {
                        eprintln!(
                            "[install_mlvscan] Found ZIP asset: {:?}",
                            zip_asset.get("name")
                        );
                        (
                            url.to_string(),
                            true,
                            zip_asset
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("MLVScan.zip")
                                .to_string(),
                        )
                    } else {
                        // Fallback: log available assets for debugging
                        eprintln!("[install_mlvscan] Available assets:");
                        for asset in assets {
                            if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                                eprintln!("  - {}", name);
                            }
                        }
                        return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag));
                    }
                } else {
                    // Fallback: log available assets for debugging
                    eprintln!("[install_mlvscan] Available assets:");
                    for asset in assets {
                        if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                            eprintln!("  - {}", name);
                        }
                    }
                    return error_json(format!("No MLVScan DLL or ZIP asset found for MLVScan version {}. Please ensure the release contains a MLVScan DLL file or a ZIP file with MLVScan.dll.", version_tag));
                }
            }
        }
        None => {
            return error_json(format!(
                "No assets found for MLVScan version {}",
                version_tag
            ))
        }
    };

    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("mlvscan"),
        crate::types::TrackedDownloadKind::Plugin,
        asset_label.clone(),
        env.name.clone(),
        Some("Downloading plugin asset".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    // Download the asset
    eprintln!("[install_mlvscan] Downloading asset...");
    let asset_bytes = match github_service.download_release_asset(&asset_url).await {
        Ok(bytes) => {
            eprintln!("[install_mlvscan] Downloaded {} bytes", bytes.len());
            bytes
        }
        Err(e) => {
            let message = format!("Failed to download MLVScan: {}", e);
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
    let sanitized_tag = version_tag
        .replace('/', "_")
        .replace('\\', "_")
        .replace(':', "_");

    let plugins_service = PluginsService::new(db.inner().clone());

    let result = if is_zip {
        // Extract MLVScan.dll from ZIP
        let temp_zip_path = temp_dir.join(format!("mlvscan-{}.zip", sanitized_tag));
        if let Err(e) = tokio::fs::write(&temp_zip_path, asset_bytes).await {
            let message = format!("Failed to save downloaded ZIP file: {}", e);
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
                Some("Plugin archive downloaded".to_string()),
            ),
        );

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
            return error_json(format!(
                "MLVScan.dll not found in ZIP file for version {}",
                version_tag
            ));
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
        let install_result = plugins_service
            .install_mlvscan(
                &env.output_dir,
                &temp_dll_path.to_string_lossy(),
                &version_tag,
            )
            .await;

        // Clean up temp DLL file (ignore errors)
        let _ = tokio::fs::remove_file(&temp_dll_path).await;

        match install_result {
            Ok(value) => value,
            Err(e) => return error_json(format!("Installation failed: {}", e)),
        }
    } else {
        // Direct DLL download
        let temp_dll_path = temp_dir.join(format!("mlvscan-{}.dll", sanitized_tag));

        if let Err(e) = tokio::fs::write(&temp_dll_path, asset_bytes).await {
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
                Some("Plugin asset downloaded".to_string()),
            ),
        );

        // Install from the temp file
        let install_result = plugins_service
            .install_mlvscan(
                &env.output_dir,
                &temp_dll_path.to_string_lossy(),
                &version_tag,
            )
            .await;

        // Clean up temp file (ignore errors)
        let _ = tokio::fs::remove_file(&temp_dll_path).await;

        match install_result {
            Ok(value) => value,
            Err(e) => return error_json(format!("Installation failed: {}", e)),
        }
    };

    if result
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
            log::warn!(
                "Failed to emit plugins_changed for {}: {}",
                environment_id,
                error
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn uninstall_mlvscan(
    app: AppHandle,
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

    let plugins_service = PluginsService::new(db.inner().clone());
    let result = plugins_service
        .uninstall_mlvscan(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = crate::events::emit_plugins_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        get_mlvscan_installation_status_impl, map_source_to_mod_source, response_source_label,
        upload_plugin_impl,
    };
    use crate::commands::mods::{
        blocked_security_scan_report_for_test, install_security_scan_test_hook,
    };
    use crate::services::environment::EnvironmentService;
    use crate::services::plugins::PluginsService;
    use crate::services::settings::SettingsService;
    use crate::test_helpers::init_test_pool_with_temp_data_dir;
    use crate::types::{schedule_i_config, ModSource};
    use serial_test::serial;
    use std::io::Write;
    use tempfile::tempdir;
    use tokio::fs;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    #[test]
    fn upload_source_mapping_supports_github_and_round_trips_response_label() {
        assert!(matches!(
            map_source_to_mod_source(Some("github")),
            Some(ModSource::Github)
        ));
        assert_eq!(
            response_source_label(map_source_to_mod_source(Some("github"))),
            "github"
        );
        assert_eq!(
            response_source_label(map_source_to_mod_source(Some("unknown"))),
            "unknown"
        );
    }

    #[tokio::test]
    #[serial]
    async fn get_mlvscan_installation_status_reports_installed_and_not_installed() {
        let (_temp, _guard, pool) = init_test_pool_with_temp_data_dir()
            .await
            .expect("test pool");
        let env_root = tempdir().expect("env temp");
        let env_service = EnvironmentService::new(pool.clone()).expect("env service");

        let output_dir = env_root.path().join("env-plugins");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await
            .expect("create env");

        let status = get_mlvscan_installation_status_impl(pool.clone(), env.id.clone())
            .await
            .expect("status");
        assert_eq!(
            status.get("installed").and_then(|v| v.as_bool()),
            Some(false)
        );

        let plugins_dir = output_dir.join("Plugins");
        fs::create_dir_all(&plugins_dir).await.expect("plugins dir");
        let source_dll = env_root.path().join("MLVScanSource.dll");
        fs::write(&source_dll, b"not-a-real-dotnet-assembly")
            .await
            .expect("dll source");

        let plugins_service = PluginsService::new(pool.clone());
        plugins_service
            .install_mlvscan(
                output_dir.to_string_lossy().as_ref(),
                source_dll.to_string_lossy().as_ref(),
                "v1.0.0",
            )
            .await
            .expect("install mlvscan");

        let installed_status = get_mlvscan_installation_status_impl(pool.clone(), env.id.clone())
            .await
            .expect("installed status");
        assert_eq!(
            installed_status.get("installed").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            installed_status.get("enabled").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[tokio::test]
    #[serial]
    async fn upload_plugin_dll_stores_in_shared_plugins_and_materializes_copy() -> anyhow::Result<()>
    {
        let (temp, _guard, pool) = init_test_pool_with_temp_data_dir().await?;
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string(),
                "enableSecurityScanner": false
            }))
            .await?;
        let settings = settings_service.load_settings().await?;

        let env_root = tempdir()?;
        let output_dir = env_root.path().join("env-plugin-dll");
        let env_service = EnvironmentService::new(pool.clone())?;
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let source_dll = env_root.path().join("UploadedPlugin.dll");
        fs::write(&source_dll, b"plugin-bytes").await?;

        let result = upload_plugin_impl(
            pool.clone(),
            &settings,
            env.id,
            source_dll.to_string_lossy().to_string(),
            "UploadedPlugin.dll".to_string(),
            "IL2CPP".to_string(),
            Some(serde_json::json!({
                "source": "local",
                "modName": "Uploaded Plugin",
                "sourceId": "local/uploaded-plugin",
                "sourceVersion": "1.0.0"
            })),
            None,
        )
        .await
        .map_err(anyhow::Error::msg)?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            result.get("source").and_then(|value| value.as_str()),
            Some("local")
        );
        let storage_id = result
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");

        let env_plugin = output_dir.join("Plugins").join("UploadedPlugin.dll");
        let env_plugin_meta = fs::symlink_metadata(&env_plugin).await?;
        assert!(env_plugin_meta.is_file());
        assert!(!env_plugin_meta.file_type().is_symlink());
        assert!(!output_dir.join("Mods").join("UploadedPlugin.dll").exists());

        let storage_plugin = download_dir
            .join("Mods")
            .join(storage_id)
            .join("Plugins")
            .join("UploadedPlugin.dll");
        let storage_plugin_meta = fs::symlink_metadata(&storage_plugin).await?;
        assert!(storage_plugin_meta.is_file());
        assert!(!storage_plugin_meta.file_type().is_symlink());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn upload_plugin_blocks_once_before_storage_or_plugin_materialization(
    ) -> anyhow::Result<()> {
        let (temp, _guard, pool) = init_test_pool_with_temp_data_dir().await?;
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string(),
                "enableSecurityScanner": false
            }))
            .await?;
        let settings = settings_service.load_settings().await?;

        let env_root = tempdir()?;
        let output_dir = env_root.path().join("env-plugin-blocked");
        let env_service = EnvironmentService::new(pool.clone())?;
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        let source_dll = env_root.path().join("BlockedPlugin.dll");
        fs::write(&source_dll, b"plugin-bytes").await?;
        let scan_hook = install_security_scan_test_hook(
            source_dll.to_string_lossy().to_string(),
            blocked_security_scan_report_for_test(),
        );

        let response = upload_plugin_impl(
            pool,
            &settings,
            env.id,
            source_dll.to_string_lossy().to_string(),
            "BlockedPlugin.dll".to_string(),
            "IL2CPP".to_string(),
            Some(serde_json::json!({ "source": "local" })),
            // A caller-provided override may bypass a review confirmation, but
            // never a blocked/unavailable policy.
            Some(true),
        )
        .await
        .map_err(anyhow::Error::msg)?;

        assert_eq!(scan_hook.call_count(), 1);
        assert_eq!(
            response
                .get("securityScanBlocked")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(!download_dir.join("Mods").exists());
        assert!(!output_dir.join("Plugins").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn upload_plugin_zip_with_root_dll_materializes_to_plugins_not_mods() -> anyhow::Result<()>
    {
        let (temp, _guard, pool) = init_test_pool_with_temp_data_dir().await?;
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string(),
                "enableSecurityScanner": false
            }))
            .await?;
        let settings = settings_service.load_settings().await?;

        let env_root = tempdir()?;
        let output_dir = env_root.path().join("env-plugin-zip");
        let env_service = EnvironmentService::new(pool.clone())?;
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = env_root.path().join("LoosePlugin.zip");
        let zip_file = std::fs::File::create(&zip_path)?;
        let mut zip = ZipWriter::new(zip_file);
        zip.start_file("LoosePlugin.dll", FileOptions::default())?;
        zip.write_all(b"plugin-bytes")?;
        zip.start_file("readme.txt", FileOptions::default())?;
        zip.write_all(b"ignored")?;
        zip.finish()?;

        let result = upload_plugin_impl(
            pool,
            &settings,
            env.id,
            zip_path.to_string_lossy().to_string(),
            "LoosePlugin.zip".to_string(),
            "IL2CPP".to_string(),
            Some(serde_json::json!({ "source": "local" })),
            None,
        )
        .await
        .map_err(anyhow::Error::msg)?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        let storage_id = result
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");

        let env_plugin = output_dir.join("Plugins").join("LoosePlugin.dll");
        let env_plugin_meta = fs::symlink_metadata(&env_plugin).await?;
        assert!(env_plugin_meta.is_file());
        assert!(!env_plugin_meta.file_type().is_symlink());
        assert!(!output_dir.join("Mods").join("LoosePlugin.dll").exists());
        assert!(!output_dir.join("Plugins").join("readme.txt").exists());

        let storage_plugin = download_dir
            .join("Mods")
            .join(storage_id)
            .join("Plugins")
            .join("LoosePlugin.dll");
        assert!(storage_plugin.exists());
        assert!(!download_dir
            .join("Mods")
            .join(storage_id)
            .join("Mods")
            .join("LoosePlugin.dll")
            .exists());

        Ok(())
    }
}
