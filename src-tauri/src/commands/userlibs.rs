use crate::services::userlibs::UserLibsService;
use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;
use tauri::State;

static USERLIBS_SERVICE: Lazy<AsyncMutex<Option<Arc<UserLibsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static FS_SERVICE: Lazy<AsyncMutex<Option<Arc<FileSystemService>>>> = Lazy::new(|| AsyncMutex::new(None));

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
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let userlibs_service = get_userlibs_service().await?;
    userlibs_service.list_user_libs(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_userlibs_count(
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

    let userlibs_service = get_userlibs_service().await?;
    let count = userlibs_service.count_user_libs(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "count": count }))
}

#[tauri::command]
pub async fn enable_user_lib(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let userlibs_service = get_userlibs_service().await?;
    userlibs_service.enable_user_lib(&env.output_dir, &user_lib_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_user_lib(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_file_name: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let userlibs_service = get_userlibs_service().await?;
    userlibs_service.disable_user_lib(&env.output_dir, &user_lib_file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_user_libs_folder(
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

    let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");
    let fs_service = get_fs_service().await?;
    fs_service.open_folder(&userlibs_dir.to_string_lossy().to_string())
        .await
        .map_err(|e| e.to_string())
}
