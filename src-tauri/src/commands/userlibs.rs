use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::mod_profiles::ModProfilesService;
use crate::services::mods::ModsService;
use crate::services::userlibs::UserLibsService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

static USERLIBS_SERVICE: Lazy<AsyncMutex<Option<Arc<UserLibsService>>>> =
    Lazy::new(|| AsyncMutex::new(None));
static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

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

async fn get_userlibs_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let output_dir = get_environment_output_dir(db, &environment_id).await?;
    let userlibs_service = get_userlibs_service().await?;
    userlibs_service
        .list_user_libs(&output_dir)
        .await
        .map_err(|e| e.to_string())
}

async fn get_userlibs_count_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let output_dir = get_environment_output_dir(db, &environment_id).await?;
    let userlibs_service = get_userlibs_service().await?;
    let count = userlibs_service
        .count_user_libs(&output_dir)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "count": count }))
}

async fn enable_user_lib_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    let output_dir = get_environment_output_dir(db, &environment_id).await?;
    let userlibs_service = get_userlibs_service().await?;
    userlibs_service
        .enable_user_lib(&output_dir, &user_lib_path)
        .await
        .map_err(|e| e.to_string())
}

async fn disable_user_lib_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    let output_dir = get_environment_output_dir(db, &environment_id).await?;
    let userlibs_service = get_userlibs_service().await?;
    userlibs_service
        .disable_user_lib(&output_dir, &user_lib_path)
        .await
        .map_err(|e| e.to_string())
}

async fn delete_user_lib_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    let output_dir = get_environment_output_dir(db, &environment_id).await?;
    let userlibs_service = get_userlibs_service().await?;
    userlibs_service
        .delete_user_lib(&output_dir, &user_lib_path)
        .await
        .map_err(|e| e.to_string())
}

fn parse_userlib_runtime(
    runtime: &str,
    fallback: &crate::types::Runtime,
) -> Result<crate::types::Runtime, String> {
    match runtime.trim().to_lowercase().as_str() {
        "il2cpp" => Ok(crate::types::Runtime::Il2cpp),
        "mono" => Ok(crate::types::Runtime::Mono),
        "" => Ok(fallback.clone()),
        other => Err(format!(
            "Unsupported UserLib runtime '{}'. Expected IL2CPP or Mono.",
            other
        )),
    }
}

fn userlib_runtime_label(runtime: &crate::types::Runtime) -> &'static str {
    match runtime {
        crate::types::Runtime::Il2cpp => "IL2CPP",
        crate::types::Runtime::Mono => "Mono",
    }
}

fn userlib_source_label(metadata: &Option<serde_json::Value>) -> &'static str {
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

async fn upload_user_lib_impl(
    db: Arc<SqlitePool>,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    metadata: Option<serde_json::Value>,
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
        return Err("Only .dll and .zip files are supported for UserLibs".to_string());
    }

    let requested_runtime = parse_userlib_runtime(&runtime, &env.runtime)?;
    let mods_service = ModsService::new(db);
    let store_result = mods_service
        .store_mod_archive(
            &file_path,
            &original_file_name,
            Some(requested_runtime.clone()),
            metadata.clone(),
            Some("userlibs".to_string()),
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
        .ok_or_else(|| "Stored UserLib archive did not return a storage ID".to_string())?
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

    Ok(serde_json::json!({
        "success": true,
        "storageId": storage_id,
        "installedFiles": installed_files,
        "source": userlib_source_label(&metadata),
        "runtime": userlib_runtime_label(&requested_runtime),
        "storage": store_result,
        "result": install_result,
    }))
}

async fn get_userlibs_service() -> Result<Arc<UserLibsService>, String> {
    let mut service = USERLIBS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(UserLibsService::new()));
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

#[tauri::command]
pub async fn get_userlibs(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    get_userlibs_impl(db.inner().clone(), environment_id).await
}

#[tauri::command]
pub async fn get_userlibs_count(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    get_userlibs_count_impl(db.inner().clone(), environment_id).await
}

#[tauri::command]
pub async fn enable_user_lib(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    enable_user_lib_impl(db.inner().clone(), environment_id.clone(), user_lib_path).await?;

    if let Err(error) = crate::events::emit_userlibs_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit userlibs_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn disable_user_lib(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    disable_user_lib_impl(db.inner().clone(), environment_id.clone(), user_lib_path).await?;

    if let Err(error) = crate::events::emit_userlibs_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit userlibs_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_user_lib(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    delete_user_lib_impl(db.inner().clone(), environment_id.clone(), user_lib_path).await?;

    if let Err(error) = crate::events::emit_userlibs_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit userlibs_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn open_user_libs_folder(
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

    let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");
    let fs_service = get_fs_service().await?;
    fs_service
        .open_folder(&userlibs_dir.to_string_lossy().to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_user_lib(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
    original_file_name: String,
    runtime: String,
    metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let result = upload_user_lib_impl(
        db.inner().clone(),
        environment_id.clone(),
        file_path,
        original_file_name,
        runtime,
        metadata,
    )
    .await?;

    if result
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        if let Err(error) = ModProfilesService::new(db.inner().clone())
            .sync_active_profile_from_environment(&environment_id)
            .await
        {
            log::warn!(
                "Failed to sync active profile for {} after UserLib upload: {}",
                environment_id,
                error
            );
        }
    }

    if let Err(error) = crate::events::emit_mods_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit mods_changed for {} after UserLib upload: {}",
            environment_id,
            error
        );
    }

    if let Err(error) = crate::events::emit_userlibs_changed(&app, environment_id.clone()) {
        log::warn!(
            "Failed to emit userlibs_changed for {}: {}",
            environment_id,
            error
        );
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_user_lib_impl, disable_user_lib_impl, enable_user_lib_impl, get_userlibs_count_impl,
        get_userlibs_impl, upload_user_lib_impl,
    };
    use crate::services::environment::EnvironmentService;
    use crate::services::settings::SettingsService;
    use crate::test_helpers::init_test_pool_with_temp_data_dir;
    use crate::types::schedule_i_config;
    use serial_test::serial;
    use std::io::Write;
    use tempfile::tempdir;
    use tokio::fs;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    #[tokio::test]
    #[serial]
    async fn enable_disable_userlib_keeps_list_and_count_consistent() {
        let (_temp, _guard, pool) = init_test_pool_with_temp_data_dir()
            .await
            .expect("test pool");
        let env_root = tempdir().expect("env temp");
        let env_service = EnvironmentService::new(pool.clone()).expect("env service");

        let output_dir = env_root.path().join("env-userlibs");
        fs::create_dir_all(output_dir.join("UserLibs"))
            .await
            .expect("create userlibs dir");
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

        fs::write(output_dir.join("UserLibs").join("LibA.dll"), b"data")
            .await
            .expect("seed lib");

        let initial = get_userlibs_count_impl(pool.clone(), env.id.clone())
            .await
            .expect("initial count");
        assert_eq!(initial.get("count").and_then(|v| v.as_u64()), Some(1));

        disable_user_lib_impl(
            pool.clone(),
            env.id.clone(),
            output_dir
                .join("UserLibs")
                .join("LibA.dll")
                .to_string_lossy()
                .to_string(),
        )
        .await
        .expect("disable");

        let listed = get_userlibs_impl(pool.clone(), env.id.clone())
            .await
            .expect("list after disable");
        let entries = listed
            .get("userLibs")
            .and_then(|v| v.as_array())
            .expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].get("fileName").and_then(|v| v.as_str()),
            Some("LibA.dll")
        );
        assert_eq!(
            entries[0].get("disabled").and_then(|v| v.as_bool()),
            Some(true)
        );

        enable_user_lib_impl(
            pool.clone(),
            env.id.clone(),
            output_dir
                .join("UserLibs")
                .join("LibA.dll.disabled")
                .to_string_lossy()
                .to_string(),
        )
        .await
        .expect("enable");

        let final_list = get_userlibs_impl(pool.clone(), env.id.clone())
            .await
            .expect("list after enable");
        let final_entries = final_list
            .get("userLibs")
            .and_then(|v| v.as_array())
            .expect("final entries");
        assert_eq!(final_entries.len(), 1);
        assert_eq!(
            final_entries[0].get("disabled").and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[tokio::test]
    #[serial]
    async fn delete_userlib_removes_environment_file_and_updates_count() {
        let (_temp, _guard, pool) = init_test_pool_with_temp_data_dir()
            .await
            .expect("test pool");
        let env_root = tempdir().expect("env temp");
        let env_service = EnvironmentService::new(pool.clone()).expect("env service");

        let output_dir = env_root.path().join("env-userlibs-delete");
        fs::create_dir_all(output_dir.join("UserLibs"))
            .await
            .expect("create userlibs dir");
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

        let userlib_path = output_dir.join("UserLibs").join("LibA.dll");
        fs::write(&userlib_path, b"data").await.expect("seed lib");

        delete_user_lib_impl(
            pool.clone(),
            env.id.clone(),
            userlib_path.to_string_lossy().to_string(),
        )
        .await
        .expect("delete");

        assert!(!userlib_path.exists());
        let count = get_userlibs_count_impl(pool.clone(), env.id.clone())
            .await
            .expect("count");
        assert_eq!(count.get("count").and_then(|v| v.as_u64()), Some(0));
    }

    #[tokio::test]
    #[serial]
    async fn upload_userlib_dll_stores_in_shared_userlibs_and_materializes_copy(
    ) -> anyhow::Result<()> {
        let (temp, _guard, pool) = init_test_pool_with_temp_data_dir().await?;
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let env_root = tempdir()?;
        let output_dir = env_root.path().join("env-userlib-dll");
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

        let source_dll = env_root.path().join("UploadedUserLib.dll");
        fs::write(&source_dll, b"userlib-bytes").await?;

        let result = upload_user_lib_impl(
            pool.clone(),
            env.id,
            source_dll.to_string_lossy().to_string(),
            "UploadedUserLib.dll".to_string(),
            "IL2CPP".to_string(),
            Some(serde_json::json!({
                "source": "local",
                "modName": "Uploaded UserLib",
                "sourceId": "local/uploaded-userlib",
                "sourceVersion": "1.0.0"
            })),
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

        let env_userlib = output_dir.join("UserLibs").join("UploadedUserLib.dll");
        let env_userlib_meta = fs::symlink_metadata(&env_userlib).await?;
        assert!(env_userlib_meta.is_file());
        assert!(!env_userlib_meta.file_type().is_symlink());
        assert!(!output_dir.join("Mods").join("UploadedUserLib.dll").exists());

        let storage_userlib = download_dir
            .join("Mods")
            .join(storage_id)
            .join("UserLibs")
            .join("UploadedUserLib.dll");
        let storage_userlib_meta = fs::symlink_metadata(&storage_userlib).await?;
        assert!(storage_userlib_meta.is_file());
        assert!(!storage_userlib_meta.file_type().is_symlink());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn upload_userlib_zip_with_root_dll_materializes_to_userlibs_not_mods(
    ) -> anyhow::Result<()> {
        let (temp, _guard, pool) = init_test_pool_with_temp_data_dir().await?;
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let env_root = tempdir()?;
        let output_dir = env_root.path().join("env-userlib-zip");
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

        let zip_path = env_root.path().join("LooseUserLib.zip");
        let zip_file = std::fs::File::create(&zip_path)?;
        let mut zip = ZipWriter::new(zip_file);
        zip.start_file("LooseUserLib.dll", FileOptions::default())?;
        zip.write_all(b"userlib-bytes")?;
        zip.start_file("readme.txt", FileOptions::default())?;
        zip.write_all(b"kept-with-userlib")?;
        zip.finish()?;

        let result = upload_user_lib_impl(
            pool,
            env.id,
            zip_path.to_string_lossy().to_string(),
            "LooseUserLib.zip".to_string(),
            "IL2CPP".to_string(),
            Some(serde_json::json!({ "source": "local" })),
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

        let env_userlib = output_dir.join("UserLibs").join("LooseUserLib.dll");
        let env_userlib_meta = fs::symlink_metadata(&env_userlib).await?;
        assert!(env_userlib_meta.is_file());
        assert!(!env_userlib_meta.file_type().is_symlink());
        assert!(!output_dir.join("Mods").join("LooseUserLib.dll").exists());

        let storage_userlib = download_dir
            .join("Mods")
            .join(storage_id)
            .join("UserLibs")
            .join("LooseUserLib.dll");
        assert!(storage_userlib.exists());
        assert!(!download_dir
            .join("Mods")
            .join(storage_id)
            .join("Mods")
            .join("LooseUserLib.dll")
            .exists());

        Ok(())
    }
}
