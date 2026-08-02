use crate::services::environment::EnvironmentService;
use crate::services::filesystem_watcher::FileSystemWatcherService;
use crate::services::logger::LoggerService;
use crate::services::mods::ModsService;
use crate::services::mods_snapshot_cache;
use crate::utils::directory_init;
use anyhow::Result;
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

/// Initialize SIMM directory and return whether it was just created
pub fn initialize_simm_directory() -> Result<bool> {
    match directory_init::initialize_simm_directory() {
        Ok((simm_dir, was_created)) => {
            log::info!(
                "SIMM directory initialized at: {:?} (was_created: {})",
                simm_dir,
                was_created
            );
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

    if crate::services::telemetry::telemetry_feature_enabled() {
        crate::services::game_session_monitor::GameSessionMonitor::new(pool.clone(), app.clone())
            .start();
        log::info!("Live telemetry game-session monitor initialized");
    } else {
        log::info!("Live telemetry is disabled by the SIMM_ENABLE_TELEMETRY feature flag");
    }
    crate::services::runtime_update_scheduler::start(pool.clone(), app.clone());
    log::info!("Background update scheduler initialized");

    let env_service = match EnvironmentService::new(pool.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to create EnvironmentService: {}", e);
            log::info!("Application initialization complete");
            return Ok(());
        }
    };

    let startup_mods_service = ModsService::new(pool.clone());
    match startup_mods_service
        .migrate_legacy_symlink_installs_to_managed_copies()
        .await
    {
        Ok(affected_envs) => {
            for env_id in affected_envs {
                if let Err(err) = crate::events::emit_mods_changed(&app, env_id.clone()) {
                    log::warn!(
                        "Failed to emit mods_changed after legacy symlink migration for {}: {}",
                        env_id,
                        err
                    );
                }
            }
        }
        Err(err) => {
            log::warn!(
                "Failed to migrate legacy symlink-backed mod installs: {}",
                err
            );
        }
    }

    match env_service.get_environments().await {
        Ok(environments) => {
            let env_count = environments.len();
            log::info!("Found {} existing environment(s) to watch", env_count);

            let cache_seed_environments = environments.clone();
            let cache_seed_pool = pool.clone();
            tokio::spawn(async move {
                let mods_service = ModsService::new(cache_seed_pool);
                for env in cache_seed_environments {
                    if env.output_dir.is_empty() {
                        continue;
                    }

                    match mods_service.list_mods(&env.output_dir).await {
                        Ok(snapshot) => {
                            mods_snapshot_cache::set(env.id.clone(), snapshot).await;
                        }
                        Err(err) => {
                            log::warn!(
                                "Failed to seed mods snapshot cache for {}: {}",
                                env.id,
                                err
                            );
                        }
                    }
                }
            });

            let watcher_guard = watcher_arc.lock().await;
            for env in &environments {
                if !env.output_dir.is_empty() {
                    let watch_targets = [
                        ("mods", std::path::Path::new(&env.output_dir).join("Mods")),
                        (
                            "plugins",
                            std::path::Path::new(&env.output_dir).join("Plugins"),
                        ),
                        (
                            "userlibs",
                            std::path::Path::new(&env.output_dir).join("UserLibs"),
                        ),
                    ];

                    for (kind, path) in watch_targets {
                        let path_string = path.to_string_lossy().to_string();
                        match watcher_guard
                            .start_watching(&env.id, &path_string, kind)
                            .await
                        {
                            Ok(_) => {}
                            Err(error) => {
                                log::warn!(
                                    "Failed to start {} watcher for {} at {}: {}",
                                    kind,
                                    env.id,
                                    LoggerService::sanitize_log_text(&path_string),
                                    error
                                );
                            }
                        }
                    }
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

            match maintenance_mods_service
                .migrate_legacy_symlink_installs_to_managed_copies()
                .await
            {
                Ok(affected_envs) => {
                    for env_id in affected_envs {
                        if let Err(err) =
                            crate::events::emit_mods_changed(&maintenance_app, env_id.clone())
                        {
                            log::warn!(
                                "Failed to emit mods_changed after legacy symlink migration for {}: {}",
                                env_id,
                                err
                            );
                        }
                    }
                }
                Err(err) => {
                    log::warn!("Failed to run legacy symlink migration: {}", err);
                }
            }

            match maintenance_mods_service.reconcile_tracked_mod_state().await {
                Ok(affected_envs) => {
                    for env_id in affected_envs {
                        if let Err(err) =
                            crate::events::emit_mods_changed(&maintenance_app, env_id.clone())
                        {
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
