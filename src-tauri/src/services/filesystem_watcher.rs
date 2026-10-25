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

                // Invalidate before publishing the edge. Consumers may request
                // a new library immediately, including on plugin-only changes
                // for which no mods snapshot follows.
                crate::commands::mods::invalidate_mod_library_cache("filesystem change").await;

                let emit_result = match watch_type.as_str() {
                    "library" => events::emit_mod_library_changed(&app),
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

struct WatchedDirectory {
    directory: PathBuf,
    _watcher: RecommendedWatcher,
}

pub struct FileSystemWatcherService {
    watchers: Arc<RwLock<std::collections::HashMap<String, WatchedDirectory>>>,
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

        // Passive library reads must not repeatedly tear down and rearm the
        // same watcher, leaving a gap in which a rebuild can be missed.
        if self
            .watchers
            .read()
            .await
            .get(&watch_key)
            .is_some_and(|watch| watch.directory == dir_path)
        {
            return Ok(());
        }

        // Stop existing watcher if any
        self.stop_watching(environment_id, watch_type).await?;

        // A managed subdirectory commonly does not exist until a runtime or
        // mod loader creates it.  Watch the nearest existing ancestor
        // recursively so that creation *and* nested changes are observed.
        // Watch the parent so deleting/recreating the logical Mods directory
        // does not detach the watch from its replacement.
        let watch_target = nearest_existing_ancestor(dir_path.parent().unwrap_or(&dir_path))
            .ok_or_else(|| {
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
        let logical_directory = dir_path.clone();

        let mut watcher = notify::recommended_watcher(
            move |res: std::result::Result<notify::Event, notify::Error>| {
                match res {
                    Ok(event) => {
                        // A missing logical directory makes us watch a broader
                        // ancestor. Ignore unrelated sibling activity there.
                        if !event_targets_directory(&event, &logical_directory)
                            || (watch_type_clone == "library"
                                && !library_event_is_relevant(&event, &logical_directory))
                        {
                            return;
                        }
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
        watchers.insert(
            watch_key,
            WatchedDirectory {
                directory: dir_path,
                _watcher: watcher,
            },
        );

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

    pub async fn watch_mod_library(&self, storage_directory: &Path) -> Result<()> {
        self.start_watching(
            "shared-library",
            &storage_directory.to_string_lossy(),
            "library",
        )
        .await
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

/// Keep unpublished staging trees and source-archive activity out of library
/// refreshes. The final staging rename includes a visible destination path.
fn library_event_is_relevant(event: &notify::Event, directory: &Path) -> bool {
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(directory) else {
            return false;
        };
        let parts: Vec<_> = relative.iter().map(|part| part.to_string_lossy()).collect();
        !parts
            .first()
            .is_some_and(|part| part.starts_with(".staging-"))
            && !parts
                .get(1)
                .is_some_and(|part| part.eq_ignore_ascii_case("Archive"))
    })
}

pub async fn ensure_mod_library_watcher(
    app: &tauri::AppHandle,
    storage_directory: &Path,
) -> Result<()> {
    if let Some(watcher) = app.try_state::<Arc<Mutex<FileSystemWatcherService>>>() {
        watcher
            .lock()
            .await
            .watch_mod_library(storage_directory)
            .await?;
    }
    Ok(())
}

fn event_targets_directory(event: &notify::Event, directory: &Path) -> bool {
    // Reading version metadata must not invalidate the inventory that read it.
    if event.kind.is_access()
        || matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::AccessTime
            ))
        )
    {
        return false;
    }
    event.paths.iter().any(|path| path.starts_with(directory))
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
    async fn library_watcher_follows_settings_directory_and_keeps_one_registration() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;
        let first = temp.path().join("first/Mods");
        let second = temp.path().join("second/Mods");
        service.watch_mod_library(&first).await?;
        service.watch_mod_library(&first).await?;
        assert_eq!(service.watchers.read().await.len(), 1);
        service.watch_mod_library(&second).await?;
        let watchers = service.watchers.read().await;
        assert_eq!(watchers.len(), 1);
        assert_eq!(watchers["shared-library-library"].directory, second);
        Ok(())
    }

    #[test]
    fn library_filter_keeps_published_dll_changes_and_ignores_staging_and_archives() {
        use notify::{Event, EventKind};
        let root = Path::new("library/Mods");
        for relative in [
            "",
            "local/Mods/Mod.dll",
            "local/Plugins/Plugin.dll.disabled",
            "local/.storage-metadata.json",
            "local",
        ] {
            let event = Event::new(EventKind::Any).add_path(root.join(relative));
            assert!(library_event_is_relevant(&event, root), "{relative}");
        }
        for relative in [".staging-id/Mods/Mod.dll", "local/Archive/Mod.dll"] {
            let event = Event::new(EventKind::Any).add_path(root.join(relative));
            assert!(!library_event_is_relevant(&event, root), "{relative}");
        }
        let publish = Event::new(EventKind::Any)
            .add_path(root.join(".staging-id"))
            .add_path(root.join("published"));
        assert!(library_event_is_relevant(&publish, root));
        assert!(!library_event_is_relevant(
            &Event::new(EventKind::Any).add_path(PathBuf::from("elsewhere/Mod.dll")),
            root
        ));
    }

    #[tokio::test]
    async fn start_and_stop_watching_existing_dir() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;
        // The service watches the parent to survive directory recreation.
        // Keep that parent inside the fixture instead of recursively watching /tmp.
        let mods = temp.path().join("Mods");
        std::fs::create_dir(&mods)?;

        service
            .start_watching("env-1", mods.to_string_lossy().as_ref(), "mods")
            .await?;
        {
            let watchers = service.watchers.read().await;
            assert_eq!(watchers.len(), 1);
            assert_eq!(watchers["env-1-mods"].directory, mods);
        }
        service.stop_watching("env-1", "mods").await?;
        assert!(service.watchers.read().await.is_empty());

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

    #[test]
    fn ancestor_watch_filters_unrelated_sibling_events() -> Result<()> {
        let temp = tempdir()?;
        let logical = temp.path().join("Mods");
        let relevant =
            notify::Event::new(notify::EventKind::Any).add_path(logical.join("Example.dll"));
        let unrelated = notify::Event::new(notify::EventKind::Any)
            .add_path(temp.path().join("Downloads").join("other.zip"));

        assert!(event_targets_directory(&relevant, &logical));
        assert!(!event_targets_directory(&unrelated, &logical));
        Ok(())
    }

    #[test]
    fn inventory_watch_ignores_reads_but_keeps_version_writes_and_enable_renames() {
        use notify::{
            event::{AccessKind, AccessMode, DataChange, MetadataKind, ModifyKind, RenameMode},
            Event, EventKind,
        };
        let root = Path::new("fixture/Mods");
        let file = root.join("Example.dll");
        for kind in [
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)),
        ] {
            assert!(!event_targets_directory(
                &Event::new(kind).add_path(file.clone()),
                root
            ));
        }
        for kind in [
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime)),
        ] {
            assert!(event_targets_directory(
                &Event::new(kind).add_path(file.clone()),
                root
            ));
        }
        assert!(event_targets_directory(
            &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(PathBuf::from("fixture/Staging/New.dll"))
                .add_path(file),
            root
        ));
    }

    #[tokio::test]
    async fn stop_watching_environment_clears_watchers() -> Result<()> {
        let service = FileSystemWatcherService::new();
        let temp = tempdir()?;

        // Each recursively watched parent belongs to this fixture, even when
        // the host's shared temporary directory contains unreadable siblings.
        for (environment_id, watch_type) in [
            ("env-1", "mods"),
            ("env-1", "plugins"),
            ("env-1", "userlibs"),
            ("env-2", "mods"),
        ] {
            let directory = temp.path().join(environment_id).join(watch_type);
            std::fs::create_dir_all(&directory)?;
            service
                .start_watching(
                    environment_id,
                    directory.to_string_lossy().as_ref(),
                    watch_type,
                )
                .await?;
        }
        assert_eq!(service.watchers.read().await.len(), 4);

        service.stop_watching_environment("env-1").await?;
        let watchers = service.watchers.read().await;
        assert_eq!(watchers.len(), 1);
        assert_eq!(
            watchers["env-2-mods"].directory,
            temp.path().join("env-2/mods")
        );

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
