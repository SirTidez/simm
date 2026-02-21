use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use crate::utils::directory_init;
use crate::services::filesystem_watcher::FileSystemWatcherService;
use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use tauri::{AppHandle, Manager};
use sqlx::SqlitePool;

/// Initialize SIMM directory and return whether it was just created
pub fn initialize_simm_directory() -> Result<bool> {
    match directory_init::initialize_simm_directory() {
        Ok((simm_dir, was_created)) => {
            log::info!("SIMM directory initialized at: {:?} (was_created: {})", simm_dir, was_created);
            Ok(was_created)
        }
        Err(e) => {
            log::warn!("Failed to initialize SIMM directory: {}", e);
            Ok(false)
        }
    }
}

/// Initialize services (async part)
pub async fn initialize_services(app: AppHandle) -> Result<()> {
    // Initialize the LoggerService for the global logger (starts background thread)
    log::info!("Initializing LoggerService for global logger");
    crate::utils::global_logger::init_logger_service();
    log::info!("LoggerService initialized - logs will now be written to file");

    // Initialize filesystem watcher service
    let mut watcher = FileSystemWatcherService::new();
    watcher.set_app_handle(app.clone());
    // Store watcher in app state (wrapped in Arc<AsyncMutex> for thread safety)
    let watcher_arc = Arc::new(AsyncMutex::new(watcher));
    app.manage(watcher_arc.clone());
    log::info!("FileSystem watcher service initialized");

    let pool = match app.try_state::<Arc<SqlitePool>>() {
        Some(p) => p.inner().clone(),
        None => {
            log::error!("SQLite pool not registered; skipping environment watcher setup");
            log::info!("Application initialization complete");
            return Ok(());
        }
    };

    let env_service = match EnvironmentService::new(pool.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to create EnvironmentService: {}", e);
            log::info!("Application initialization complete");
            return Ok(());
        }
    };

    match env_service.get_environments().await {
        Ok(environments) => {
            let env_count = environments.len();
            log::info!("Found {} existing environment(s) to watch", env_count);

            let watcher_guard = watcher_arc.lock().await;
            for env in &environments {
                if !env.output_dir.is_empty() {
                    let mods_dir = std::path::Path::new(&env.output_dir).join("Mods");
                    let plugins_dir = std::path::Path::new(&env.output_dir).join("Plugins");
                    let userlibs_dir = std::path::Path::new(&env.output_dir).join("UserLibs");

                    let _ = watcher_guard.start_watching(&env.id, mods_dir.to_str().unwrap_or(""), "mods").await;
                    let _ = watcher_guard.start_watching(&env.id, plugins_dir.to_str().unwrap_or(""), "plugins").await;
                    let _ = watcher_guard.start_watching(&env.id, userlibs_dir.to_str().unwrap_or(""), "userlibs").await;
                }
            }
            log::info!("Started watching {} environment(s)", env_count);
        }
        Err(e) => {
            log::error!("Failed to get environments: {:?}", e);
        }
    }

    let maintenance_mods_service = ModsService::new(pool.clone());
    let maintenance_app = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            match maintenance_mods_service.reconcile_tracked_mod_state().await {
                Ok(affected_envs) => {
                    for env_id in affected_envs {
                        if let Err(err) = crate::events::emit_mods_changed(&maintenance_app, env_id.clone()) {
                            log::warn!("Failed to emit mods_changed for {}: {}", env_id, err);
                        }
                    }
                }
                Err(err) => {
                    log::warn!("Failed to run mod metadata reconciliation: {}", err);
                }
            }
        }
    });
    log::info!("Started mod metadata reconciliation maintenance task");

    log::info!("Application initialization complete");

    Ok(())
}
