use crate::events;
use crate::services::mods::ModsService;
use crate::services::mods_snapshot_refresh;
use crate::services::settings::RuntimeSettingsState;
use anyhow::{Context, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

const WATCHER_EVENT_DEBOUNCE_MS: u64 = 350;

#[derive(Debug, Default)]
struct PendingRefresh {
    /// Incremented for every event. A worker only starts a refresh after this
    /// generation remains unchanged for a full quiet window.
    generation: u64,
}

#[derive(Default)]
struct WatcherRefreshDebouncer {
    pending: Mutex<std::collections::HashMap<String, PendingRefresh>>,
}

impl WatcherRefreshDebouncer {
    /// Returns the initial generation only for the event that must spawn a
    /// worker. Later events advance the retained generation, resetting that
    /// worker's quiet-window deadline without spawning another task.
    async fn reserve(&self, key: &str) -> Option<u64> {
        let mut pending = self.pending.lock().await;
        match pending.get_mut(key) {
            Some(state) => {
                state.generation = state.generation.wrapping_add(1);
                None
            }
            None => {
                pending.insert(key.to_string(), PendingRefresh::default());
                Some(0)
            }
        }
    }

    /// Returns the latest generation when an event arrived during the quiet
    /// window or refresh pass. Callers must wait through a new quiet window
    /// before processing it. A clean pass releases the key.
    async fn complete_pass(&self, key: &str, completed_generation: u64) -> Option<u64> {
        let mut pending = self.pending.lock().await;
        let Some(state) = pending.get_mut(key) else {
            return None;
        };

        if state.generation != completed_generation {
            Some(state.generation)
        } else {
            pending.remove(key);
            None
        }
    }

    async fn latest_generation(&self, key: &str) -> Option<u64> {
        self.pending
            .lock()
            .await
            .get(key)
            .map(|state| state.generation)
    }

    async fn schedule(
        self: Arc<Self>,
        app: tauri::AppHandle,
        environment_id: String,
        watch_type: String,
    ) {
        let key = format!("{}-{}", environment_id, watch_type);
        let Some(mut generation) = self.reserve(&key).await else {
            log::debug!(
                "Reset filesystem watcher quiet window for {} ({})",
                environment_id,
                watch_type
            );
            return;
        };

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(WATCHER_EVENT_DEBOUNCE_MS))
                    .await;

                // A new event during the quiet window restarts the timer. This
                // is deliberately trailing-edge debounce rather than a fixed
                // delay from the first event in a burst.
                // If a later event won the race, wait through its full quiet
                // window before doing any refresh work.
                let Some(current_generation) = self.latest_generation(&key).await else {
                    return;
                };
                if current_generation != generation {
                    generation = current_generation;
                    continue;
                }

                let batch_started = std::time::Instant::now();
                let event_count = generation.saturating_add(1);
                let mut outcome = "event emitted";

                let emit_result = match watch_type.as_str() {
                    "mods" => events::emit_mods_changed(&app, environment_id.clone()),
                    "plugins" => events::emit_plugins_changed(&app, environment_id.clone()),
                    "userlibs" => events::emit_userlibs_changed(&app, environment_id.clone()),
                    _ => Ok(()),
                };
                if let Err(error) = emit_result {
                    log::warn!(
                        "Failed to emit debounced {} watcher event for {}: {}",
                        watch_type,
                        environment_id,
                        error
                    );
                }

                if watch_type == "mods" {
                    let pool = app
                        .try_state::<Arc<SqlitePool>>()
                        .map(|pool_state| pool_state.inner().clone());
                    if let Some(pool) = pool {
                        let reconciliation: Result<Vec<String>> = if let Some(runtime_settings) =
                            app.try_state::<RuntimeSettingsState>()
                        {
                            let settings = runtime_settings.snapshot().await;
                            let storage_dir =
                                PathBuf::from(settings.default_download_dir).join("Mods");
                            let service = ModsService::new(pool.clone());
                            service
                                .reconcile_tracked_mod_state_for_environment_at(
                                    &environment_id,
                                    &storage_dir,
                                )
                                .await
                        } else {
                            Ok(Vec::new())
                        };
                        match reconciliation {
                            Ok(affected) => {
                                outcome = if affected.is_empty() {
                                    "event emitted; targeted reconcile clean"
                                } else {
                                    "event emitted; targeted reconcile updated"
                                };
                            }
                            Err(error) => {
                                outcome = "event emitted; targeted reconcile failed";
                                log::warn!(
                                    "Failed to reconcile watcher metadata for {}: {}",
                                    environment_id,
                                    error
                                );
                            }
                        }
                        mods_snapshot_refresh::request_mods_snapshot_refresh(
                            app.clone(),
                            pool,
                            environment_id.clone(),
                            "filesystem watcher",
                        )
                        .await;
                    }
                }

                log::debug!(
                    "[Watcher] batch environment={} kind={} generation={} events={} duration_ms={} outcome={}",
                    environment_id,
                    watch_type,
                    generation,
                    event_count,
                    batch_started.elapsed().as_millis(),
                    outcome,
                );

                if self.complete_pass(&key, generation).await.is_none() {
                    break;
                }

                log::debug!(
                    "Running retained trailing filesystem watcher refresh for {} ({})",
                    environment_id,
                    watch_type
                );
            }
        });
    }
}

pub struct FileSystemWatcherService {
    watchers: Arc<RwLock<std::collections::HashMap<String, RecommendedWatcher>>>,
    app_handle: Option<Arc<tauri::AppHandle>>,
    refresh_debouncer: Arc<WatcherRefreshDebouncer>,
}

impl FileSystemWatcherService {
    pub fn new() -> Self {
        Self {
            watchers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            app_handle: None,
            refresh_debouncer: Arc::new(WatcherRefreshDebouncer::default()),
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

        // A managed subdirectory commonly does not exist until a runtime or
        // mod loader creates it.  Watch the nearest existing ancestor
        // recursively so that creation *and* nested changes are observed.
        let watch_target = nearest_existing_ancestor(&dir_path).ok_or_else(|| {
            anyhow::anyhow!(
                "Could not find an existing ancestor for watcher target {}",
                dir_path.display()
            )
        })?;

        // Capture Tokio runtime handle for spawning from notify's callback thread.
        // The notify callback runs in a separate OS thread (not in Tokio runtime), so we cannot
        // use tokio::spawn() directly - it would panic "there is no reactor running".
        let rt_handle = tokio::runtime::Handle::current();
        let app_handle_clone = self.app_handle.clone();
        let environment_id_clone = environment_id.to_string();
        let watch_type_clone = watch_type.to_string();
        let refresh_debouncer = self.refresh_debouncer.clone();

        let mut watcher = notify::recommended_watcher(
            move |res: std::result::Result<notify::Event, notify::Error>| {
                match res {
                    Ok(_event) => {
                        if let Some(app_arc) = app_handle_clone.as_ref() {
                            let app = app_arc.as_ref().clone();
                            let environment_id = environment_id_clone.clone();
                            let watch_type = watch_type_clone.clone();
                            let debouncer = refresh_debouncer.clone();
                            // Spawn on Tokio runtime via handle - callback runs in notify's thread, not Tokio.
                            let _ = rt_handle.spawn(async move {
                                debouncer.schedule(app, environment_id, watch_type).await;
                            });
                        }
                    }
                    Err(e) => {
                        log::error!("Watch error: {:?}", e);
                    }
                }
            },
        )
        .context("Failed to create file watcher")?;

        <RecommendedWatcher as Watcher>::watch(
            &mut watcher,
            &watch_target,
            RecursiveMode::Recursive,
        )
        .with_context(|| {
            format!(
                "Failed to start watching directory {}",
                watch_target.display()
            )
        })?;

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

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|candidate| candidate.is_dir())
        .map(PathBuf::from)
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
    async fn start_watching_missing_dir_arms_existing_ancestor() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;
        let missing = temp.path().join("missing");

        service
            .start_watching("env-1", missing.to_string_lossy().as_ref(), "mods")
            .await?;
        assert_eq!(service.watchers.read().await.len(), 1);
        service.stop_all().await?;

        Ok(())
    }

    #[test]
    fn nearest_existing_ancestor_handles_missing_nested_layout() -> Result<()> {
        let temp = tempdir()?;
        let nested = temp.path().join("Mods").join("Mono").join("nested");
        assert_eq!(
            nearest_existing_ancestor(&nested),
            Some(temp.path().to_path_buf())
        );
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

    #[tokio::test]
    async fn watcher_debouncer_resets_trailing_generation_and_retains_final_pass() {
        let debouncer = WatcherRefreshDebouncer::default();
        assert_eq!(debouncer.reserve("env-1-mods").await, Some(0));
        assert_eq!(debouncer.reserve("env-1-mods").await, None);
        assert_eq!(debouncer.latest_generation("env-1-mods").await, Some(1));
        assert_eq!(debouncer.reserve("env-1-plugins").await, Some(0));
        assert_eq!(debouncer.reserve("env-2-mods").await, Some(0));

        assert_eq!(
            debouncer.complete_pass("env-1-mods", 0).await,
            Some(1),
            "a same-key event resets the quiet deadline and produces one retained final pass"
        );
        assert_eq!(
            debouncer.complete_pass("env-1-mods", 1).await,
            None,
            "the final clean pass releases the key"
        );
        assert_eq!(debouncer.reserve("env-1-mods").await, Some(0));
    }
}
