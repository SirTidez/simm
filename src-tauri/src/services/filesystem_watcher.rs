use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use crate::services::mods_snapshot_cache;
use anyhow::{Context, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

pub struct FileSystemWatcherService {
    watchers: Arc<RwLock<std::collections::HashMap<String, RecommendedWatcher>>>,
    app_handle: Option<Arc<tauri::AppHandle>>,
}

impl FileSystemWatcherService {
    pub fn new() -> Self {
        Self {
            watchers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, app: tauri::AppHandle) {
        self.app_handle = Some(Arc::new(app));
    }

    pub async fn start_watching(
        &self,
        environment_id: &str,
        directory: &str,
        watch_type: &str,
    ) -> Result<()> {
        let watch_key = format!("{}-{}", environment_id, watch_type);
        let dir_path = PathBuf::from(directory);

        // Stop existing watcher if any
        self.stop_watching(environment_id, watch_type).await?;

        if !dir_path.exists() {
            // Directory doesn't exist yet, but we'll still set up the watch
            // The watch will start working once the directory is created
            return Ok(());
        }

        // Capture Tokio runtime handle for spawning from notify's callback thread.
        // The notify callback runs in a separate OS thread (not in Tokio runtime), so we cannot
        // use tokio::spawn() directly - it would panic "there is no reactor running".
        let rt_handle = tokio::runtime::Handle::current();
        let app_handle_clone = self.app_handle.clone();
        let environment_id_clone = environment_id.to_string();
        let watch_type_clone = watch_type.to_string();

        let mut watcher = notify::recommended_watcher(move |res: std::result::Result<notify::Event, notify::Error>| {
            match res {
                Ok(_event) => {
                    // Emit Tauri event for file changes using event emitter functions
                    if let Some(app_arc) = app_handle_clone.as_ref() {
                        // Use Arc::as_ref() to get &AppHandle
                        let app_ref: &tauri::AppHandle = app_arc.as_ref();
                        let _ = match watch_type_clone.as_str() {
                            "mods" => events::emit_mods_changed(app_ref, environment_id_clone.clone()),
                            "plugins" => events::emit_plugins_changed(app_ref, environment_id_clone.clone()),
                            "userlibs" => events::emit_userlibs_changed(app_ref, environment_id_clone.clone()),
                            _ => Ok(()),
                        };

                        if watch_type_clone == "mods" {
                            let app_for_refresh = app_ref.clone();
                            let environment_id_for_refresh = environment_id_clone.clone();
                            // Spawn on Tokio runtime via handle - callback runs in notify's thread, not Tokio.
                            let _ = rt_handle.spawn(async move {
                                let Some(pool_state) = app_for_refresh.try_state::<Arc<SqlitePool>>() else {
                                    return;
                                };
                                let pool = pool_state.inner().clone();

                                let env_service = match EnvironmentService::new(pool.clone()) {
                                    Ok(service) => service,
                                    Err(err) => {
                                        log::warn!("Failed to create EnvironmentService during mods snapshot refresh: {}", err);
                                        return;
                                    }
                                };

                                let environment = match env_service.get_environment(&environment_id_for_refresh).await {
                                    Ok(Some(env)) => env,
                                    Ok(None) => return,
                                    Err(err) => {
                                        log::warn!(
                                            "Failed to load environment {} during mods snapshot refresh: {}",
                                            environment_id_for_refresh,
                                            err
                                        );
                                        return;
                                    }
                                };

                                if environment.output_dir.is_empty() {
                                    return;
                                }

                                let mods_service = ModsService::new(pool);
                                match mods_service.list_mods(&environment.output_dir).await {
                                    Ok(snapshot) => {
                                        mods_snapshot_cache::set(
                                            environment_id_for_refresh.clone(),
                                            snapshot.clone(),
                                        )
                                        .await;

                                        if let Err(err) = events::emit_mods_snapshot_updated(
                                            &app_for_refresh,
                                            environment_id_for_refresh,
                                            snapshot,
                                        ) {
                                            log::warn!("Failed to emit mods_snapshot_updated event: {}", err);
                                        }
                                    }
                                    Err(err) => {
                                        log::warn!("Failed to refresh mods snapshot from watcher event: {}", err);
                                    }
                                }
                            });
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Watch error: {:?}", e);
                }
            }
        })
        .context("Failed to create file watcher")?;

        <RecommendedWatcher as Watcher>::watch(
            &mut watcher,
            &dir_path,
            RecursiveMode::NonRecursive,
        )
        .context("Failed to start watching directory")?;

        let mut watchers = self.watchers.write().await;
        watchers.insert(watch_key, watcher);

        Ok(())
    }

    pub async fn stop_watching(&self, environment_id: &str, watch_type: &str) -> Result<()> {
        let watch_key = format!("{}-{}", environment_id, watch_type);
        let mut watchers = self.watchers.write().await;

        if let Some(_watcher) = watchers.remove(&watch_key) {
            // Watcher is dropped when removed from map
        }

        Ok(())
    }

    pub async fn stop_watching_environment(&self, environment_id: &str) -> Result<()> {
        self.stop_watching(environment_id, "mods").await?;
        self.stop_watching(environment_id, "plugins").await?;
        self.stop_watching(environment_id, "userlibs").await?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn stop_all(&self) -> Result<()> {
        let mut watchers = self.watchers.write().await;
        watchers.clear(); // Dropping watchers will stop them
        Ok(())
    }
}

impl Default for FileSystemWatcherService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn start_and_stop_watching_existing_dir() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;

        service
            .start_watching("env-1", temp.path().to_string_lossy().as_ref(), "mods")
            .await?;
        service.stop_watching("env-1", "mods").await?;

        Ok(())
    }

    #[tokio::test]
    async fn start_watching_missing_dir_is_noop() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;
        let missing = temp.path().join("missing");

        service
            .start_watching("env-1", missing.to_string_lossy().as_ref(), "mods")
            .await?;
        service.stop_all().await?;

        Ok(())
    }

    #[tokio::test]
    async fn stop_watching_environment_clears_watchers() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;

        service
            .start_watching("env-1", temp.path().to_string_lossy().as_ref(), "mods")
            .await?;
        service
            .start_watching("env-1", temp.path().to_string_lossy().as_ref(), "plugins")
            .await?;
        service.stop_watching_environment("env-1").await?;

        Ok(())
    }
}
