use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppPreparationState {
    result: Mutex<Option<Result<crate::types::AppStartupState, String>>>,
}

#[tauri::command]
pub async fn prepare_app(
    app: AppHandle,
    preparation_state: State<'_, AppPreparationState>,
) -> Result<crate::types::AppStartupState, String> {
    let mut cached_result = preparation_state.result.lock().await;
    if let Some(result) = cached_result.as_ref() {
        return result.clone();
    }

    log::info!("Preparing SIMM application runtime...");

    let simm_was_created =
        crate::services::app_init::initialize_simm_directory().map_err(|error| {
            log::error!("Failed to initialize SIMM directory: {}", error);
            error.to_string()
        })?;

    log::info!(
        "SIMM directory initialized (was_created: {})",
        simm_was_created
    );

    let (db_pool, database_was_created) = crate::db::initialize_pool_with_startup_state()
        .await
        .map_err(|error| {
            log::error!("Failed to initialize database: {}", error);
            error.to_string()
        })?;

    let mut settings_service = crate::services::settings::SettingsService::new(db_pool.clone())
        .map_err(|error| {
            log::error!("Failed to create SettingsService during startup: {}", error);
            error.to_string()
        })?;
    match settings_service.load_settings().await {
        Ok(settings) => {
            crate::services::logger::LoggerService::apply_settings(&settings);
        }
        Err(error) => {
            log::warn!(
                "Failed to load settings for logger configuration: {}",
                error
            );
        }
    }

    app.manage(db_pool.clone());

    let startup_state = crate::types::AppStartupState {
        simm_directory_created: simm_was_created,
        database_created: database_was_created,
    };
    app.manage(startup_state.clone());

    start_post_database_services(app.clone(), db_pool);

    log::info!("SIMM application runtime prepared");
    *cached_result = Some(Ok(startup_state.clone()));
    Ok(startup_state)
}

fn start_post_database_services(app: AppHandle, db_pool: Arc<SqlitePool>) {
    #[cfg(windows)]
    let should_register_runtime_scheme = cfg!(debug_assertions)
        || std::env::current_exe()
            .ok()
            .map(|path| {
                path.components().any(|component| {
                    component
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("target")
                })
            })
            .unwrap_or(false);

    let registration_app = app.clone();
    let registration_db_pool = db_pool.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::commands::nexus_mods::cleanup_stale_nxm_runtime_registration(
            registration_db_pool.clone(),
        )
        .await
        {
            log::warn!(
                "Failed to clean up stale runtime nxm registration: {}",
                error
            );
        }

        if let Err(error) =
            crate::commands::nexus_mods::ensure_nxm_runtime_registration(registration_db_pool).await
        {
            log::warn!(
                "Failed to claim nxm protocol handler for app lifetime: {}",
                error
            );
        }

        #[cfg(windows)]
        if should_register_runtime_scheme {
            if let Err(error) = registration_app.deep_link().register_all() {
                log::warn!("Failed to register deep-link scheme at runtime: {}", error);
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::services::app_init::initialize_services(app).await {
            log::error!("Error during service initialization: {}", e);
        }
    });

    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::services::thunderstore::shared_thunderstore_service()
            .warm_community_cache("schedule-i")
            .await
        {
            log::warn!("Failed to warm Thunderstore Schedule I cache: {}", error);
        }
    });
}

/// Check if the SIMM directory was just created on this app launch
#[tauri::command]
pub async fn was_simm_directory_just_created(
    startup_state: State<'_, crate::types::AppStartupState>,
) -> Result<bool, String> {
    Ok(startup_state.simm_directory_created)
}

#[tauri::command]
pub async fn get_app_startup_state(
    startup_state: State<'_, crate::types::AppStartupState>,
) -> Result<crate::types::AppStartupState, String> {
    Ok(startup_state.inner().clone())
}

/// Get the user's home directory path
#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Mark that the user has seen the welcome message (so we don't show it again)
#[allow(dead_code)]
#[tauri::command]
pub async fn mark_welcome_message_seen() -> Result<(), String> {
    // This could be stored in settings if we want to persist it
    // For now, we'll just use the was_created flag which resets on each launch
    Ok(())
}
