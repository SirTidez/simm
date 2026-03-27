use crate::services::environment::EnvironmentService;
use crate::services::filesystem::FileSystemService;
use crate::services::userlibs::UserLibsService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
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
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    enable_user_lib_impl(db.inner().clone(), environment_id, user_lib_path).await
}

#[tauri::command]
pub async fn disable_user_lib(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    user_lib_path: String,
) -> Result<(), String> {
    disable_user_lib_impl(db.inner().clone(), environment_id, user_lib_path).await
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

#[cfg(test)]
mod tests {
    use super::{
        disable_user_lib_impl, enable_user_lib_impl, get_userlibs_count_impl, get_userlibs_impl,
    };
    use crate::services::environment::EnvironmentService;
    use crate::test_helpers::init_test_pool_with_temp_data_dir;
    use crate::types::schedule_i_config;
    use serial_test::serial;
    use tempfile::tempdir;
    use tokio::fs;

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
}
