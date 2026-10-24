//! Session details and lifecycle. The independent Windows helper never launches or kills a game.
use crate::services::{
    environment::EnvironmentService, mods::ModsService, plugins::PluginsService,
};
use crate::types::{
    NativeConsoleEntry, NativeConsolePreferences, NativeConsoleSnapshot, NativeConsoleViewport,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

mod diagnostics;
#[cfg(windows)]
mod windows;
const PREFERENCES_KEY: &str = "native_console_preferences";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ProcessIdentity {
    pub pid: u32,
    pub created: u64,
    pub path: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct HelperConfig {
    pub parent: ProcessIdentity,
    pub host: usize,
    pub expected_path: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct HelperStatus {
    pub status: String,
    pub process: Option<ProcessIdentity>,
    pub diagnostic: Option<String>,
}

struct Session {
    snapshot: NativeConsoleSnapshot,
    directory: PathBuf,
    controller: Option<std::process::Child>,
    viewport: NativeConsoleViewport,
    messages: Arc<Mutex<diagnostics::Diagnostics>>,
}
#[derive(Default)]
pub struct NativeConsoleState {
    sessions: Mutex<HashMap<String, Session>>,
    opening: tokio::sync::Mutex<()>,
    shutting_down: AtomicBool,
    viewport_revision: AtomicU64,
}

pub fn validate_caller(window: &tauri::WebviewWindow, _environment_id: &str) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Environment status is available in the main SIMM window.".into())
    }
}

async fn require_environment(pool: &SqlitePool, environment_id: &str) -> Result<()> {
    anyhow::ensure!(
        sqlx::query_scalar::<_, i64>("SELECT 1 FROM environments WHERE id = ?")
            .bind(environment_id)
            .fetch_optional(pool)
            .await?
            .is_some(),
        "Environment not found"
    );
    Ok(())
}

fn preferences_key(environment_id: &str) -> String {
    format!("{PREFERENCES_KEY}:{environment_id}")
}

pub async fn preferences(
    pool: &SqlitePool,
    environment_id: &str,
) -> Result<NativeConsolePreferences> {
    require_environment(pool, environment_id).await?;
    let key = preferences_key(environment_id);
    // Seed each environment once from the previous app-wide layout. An existing
    // environment-specific save always wins, including a concurrent first save.
    sqlx::query("INSERT INTO app_meta (key, value) SELECT ?, COALESCE((SELECT value FROM app_meta WHERE key = ?), ?) WHERE EXISTS (SELECT 1 FROM environments WHERE id = ?) ON CONFLICT(key) DO NOTHING")
        .bind(&key).bind(PREFERENCES_KEY).bind(serde_json::to_string(&NativeConsolePreferences::default())?)
        .bind(environment_id).execute(pool).await?;
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM app_meta WHERE key = ?")
        .bind(&key)
        .fetch_optional(pool)
        .await?;
    let mut preferences: NativeConsolePreferences = value
        .map(|value| serde_json::from_str(&value))
        .transpose()?
        .unwrap_or_default();
    preferences.sidebar_width = preferences.sidebar_width.clamp(280, 520);
    Ok(preferences)
}

pub async fn save_preferences(
    pool: &SqlitePool,
    state: &NativeConsoleState,
    environment_id: &str,
    mut value: NativeConsolePreferences,
) -> Result<NativeConsolePreferences> {
    let _opening = state.opening.lock().await;
    require_environment(pool, environment_id).await?;
    value.sidebar_width = value.sidebar_width.clamp(280, 520);
    sqlx::query("INSERT INTO app_meta (key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM environments WHERE id = ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(preferences_key(environment_id)).bind(serde_json::to_string(&value)?).bind(environment_id).execute(pool).await?;
    if let Some(session) = state.sessions.lock().unwrap().get_mut(environment_id) {
        session.snapshot.preferences = value.clone();
        write_json(&session.directory.join("preferences.json"), &value)?;
    }
    Ok(value)
}

async fn entries(
    value: serde_json::Value,
    key: &str,
    kind: &str,
) -> Result<Vec<NativeConsoleEntry>> {
    let installed: Vec<_> = value
        .get(key)
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .map(|entry| {
            (
                NativeConsoleEntry {
                    name: entry
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown")
                        .to_string(),
                    version: entry
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    version_source: entry
                        .get("version")
                        .and_then(|v| v.as_str())
                        .filter(|v| !v.trim().is_empty())
                        .map(|_| "installMetadata".to_owned()),
                    author: entry
                        .get("author")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    file_name: entry
                        .get("fileName")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    enabled: !entry
                        .get("disabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    kind: kind.to_string(),
                },
                entry
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from),
            )
        })
        .collect();
    tokio::task::spawn_blocking(move || {
        installed
            .into_iter()
            .map(|(mut entry, path)| {
                if let Some(path) = path {
                    match crate::services::melon_metadata::read(&path) {
                        Ok(info) => {
                            entry.name = info.name.unwrap_or(entry.name);
                            entry.author = info.author.or(entry.author);
                            entry.version = Some(info.version);
                            entry.version_source = Some(info.source.to_owned());
                        }
                        Err(error) => log::debug!(
                            "Could not extract installed version from {}: {error:#}",
                            path.display()
                        ),
                    }
                }
                entry
            })
            .collect()
    })
    .await
    .context("Installed assembly inventory scan stopped")
}

pub async fn open(
    app: &AppHandle,
    pool: Arc<SqlitePool>,
    environment_id: &str,
    navigate: bool,
) -> Result<()> {
    anyhow::ensure!(
        cfg!(windows),
        "Native console docking is available on Windows only."
    );
    let state = app.state::<NativeConsoleState>();
    let _opening = state.opening.lock().await;
    anyhow::ensure!(
        !state.shutting_down.load(Ordering::Acquire),
        "SIMM is closing."
    );
    let mut environment = EnvironmentService::new(pool.clone())?
        .get_environment(environment_id)
        .await?
        .context("Environment not found")?;
    anyhow::ensure!(
        !environment.output_dir.is_empty(),
        "Environment has no game directory."
    );
    let profile = sqlx::query_as::<_, (String, String, String)>("SELECT p.name, p.runtime, p.updated_at FROM profiles p JOIN environment_profiles ep ON ep.active_profile_id=p.id WHERE ep.environment_id=?")
        .bind(environment_id).fetch_optional(pool.as_ref()).await?;
    let mut diagnostic = Vec::new();
    if environment.melon_loader_version.is_none() {
        match crate::services::melon_loader::MelonLoaderService::new()
            .get_installed_version(&environment.output_dir)
            .await
        {
            Ok(version) => environment.melon_loader_version = version,
            Err(error) => diagnostic.push(format!("MelonLoader version unavailable: {error}")),
        }
    }
    let mut inventory = Vec::new();
    match ModsService::new(pool.clone())
        .list_mods(&environment.output_dir)
        .await
    {
        Ok(value) => inventory.extend(entries(value, "mods", "Mod").await?),
        Err(error) => diagnostic.push(format!("Mod inventory unavailable: {error}")),
    }
    match PluginsService::new(pool.clone())
        .list_plugins(&environment.output_dir)
        .await
    {
        Ok(value) => inventory.extend(entries(value, "plugins", "Plugin").await?),
        Err(error) => diagnostic.push(format!("Plugin inventory unavailable: {error}")),
    }
    inventory.sort_by_key(|entry| (entry.kind.clone(), entry.name.to_lowercase()));
    let preferences = preferences(pool.as_ref(), environment_id).await?;
    let mut snapshot = NativeConsoleSnapshot {
        supported: cfg!(windows),
        environment,
        profile_name: profile.as_ref().map(|p| p.0.clone()),
        profile_runtime: profile.as_ref().map(|p| p.1.clone()),
        profile_updated_at: profile.map(|p| p.2),
        entries: inventory,
        preferences,
        presentation: "docked".into(),
        status: "waitingForGame".into(),
        process_id: None,
        process_started_at: None,
        inventory_updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64,
        diagnostic: if diagnostic.is_empty() {
            None
        } else {
            Some(diagnostic.join(" "))
        },
        messages: Default::default(),
    };
    if let Some(session) = state.sessions.lock().unwrap().get_mut(environment_id) {
        snapshot.status = session.snapshot.status.clone();
        snapshot.presentation = session.snapshot.presentation.clone();
        session.snapshot = snapshot;
        if navigate {
            app.emit(
                "native_console_opened",
                serde_json::json!({"environmentId": environment_id}),
            )?;
        }
        return Ok(());
    }
    let directory = std::env::temp_dir()
        .join("SIMM-native-console")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory)?;
    let viewport = NativeConsoleViewport::default();
    write_json(&directory.join("viewport.json"), &viewport)?;
    state.sessions.lock().unwrap().insert(
        environment_id.into(),
        Session {
            snapshot,
            directory,
            controller: None,
            viewport,
            messages: Default::default(),
        },
    );
    if let Err(error) = start_helper(app, environment_id) {
        let state = app.state::<NativeConsoleState>();
        if let Some(session) = state.sessions.lock().unwrap().get_mut(environment_id) {
            session.snapshot.status = "unavailable".into();
            session.snapshot.diagnostic =
                Some(format!("Could not start console docking: {error:#}"));
        };
    }
    if navigate {
        app.emit(
            "native_console_opened",
            serde_json::json!({"environmentId": environment_id}),
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn start_helper(app: &AppHandle, environment_id: &str) -> Result<()> {
    let state = app.state::<NativeConsoleState>();
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(environment_id)
        .context("Console session not found")?;
    let window = app
        .get_webview_window("main")
        .context("Main SIMM window not found")?;
    let config = HelperConfig {
        parent: windows::identity(std::process::id())?,
        host: window.hwnd()?.0 as usize,
        expected_path: Path::new(&session.snapshot.environment.output_dir).join("Schedule I.exe"),
    };
    write_json(&session.directory.join("config.json"), &config)?;
    session.controller = Some(windows::spawn_helper(
        "--native-console-controller",
        &session.directory,
    )?);
    Ok(())
}
#[cfg(not(windows))]
fn start_helper(_: &AppHandle, _: &str) -> Result<()> {
    anyhow::bail!("Native console docking is available on Windows only.")
}

pub async fn snapshot(app: &AppHandle, environment_id: &str) -> Result<NativeConsoleSnapshot> {
    let state = app.state::<NativeConsoleState>();
    let (mut snapshot, messages) = {
        let mut sessions = state.sessions.lock().unwrap();
        let session = sessions
            .get_mut(environment_id)
            .context("Console session not found. Open Console again.")?;
        let mut snapshot = session.snapshot.clone();
        if let Ok(status) = read_json::<HelperStatus>(&session.directory.join("status.json")) {
            snapshot.status = status.status;
            snapshot.process_id = status.process.as_ref().map(|process| process.pid);
            snapshot.process_started_at = status
                .process
                .as_ref()
                .map(|process| process.created.saturating_sub(116_444_736_000_000_000) / 10_000);
            #[cfg(windows)]
            if status
                .process
                .as_ref()
                .is_some_and(|process| !windows::alive(process))
            {
                snapshot.status = "exited".into();
            }
            if let Some(diagnostic) = status.diagnostic {
                snapshot.diagnostic = Some(
                    [snapshot.diagnostic.unwrap_or_default(), diagnostic]
                        .into_iter()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
        }
        if session
            .controller
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_some())
            && matches!(
                snapshot.status.as_str(),
                "waitingForGame" | "waitingForConsole" | "docked"
            )
        {
            snapshot.status = "unavailable".into();
            snapshot.diagnostic =
                Some("Console disconnected. Retry connection to reconnect.".into());
        }
        (snapshot, session.messages.clone())
    };
    let path = Path::new(&snapshot.environment.output_dir).join("MelonLoader/Latest.log");
    let process = snapshot.process_id.zip(snapshot.process_started_at);
    let inventory = snapshot.entries.clone();
    snapshot.messages = tokio::task::spawn_blocking(move || {
        messages.lock().unwrap().update(&path, process, &inventory)
    })
    .await
    .context("Message log reader stopped")?;
    if snapshot.presentation == "popout"
        && snapshot.status != "exited"
        && snapshot.process_id.is_some()
    {
        snapshot.status = "poppedOut".into();
    }
    Ok(snapshot)
}

pub async fn pop_out(app: &AppHandle, environment_id: &str) -> Result<()> {
    anyhow::ensure!(
        cfg!(windows),
        "Native console docking is available on Windows only."
    );
    let state = app.state::<NativeConsoleState>();
    let _opening = state.opening.lock().await;
    anyhow::ensure!(
        !state.shutting_down.load(Ordering::Acquire),
        "SIMM is closing."
    );
    {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions
            .get(environment_id)
            .context("Console session not found")?;
        if session.snapshot.presentation == "popout" {
            return Ok(());
        }
        let status: HelperStatus = read_json(&session.directory.join("status.json"))?;
        anyhow::ensure!(
            status.status == "docked",
            "The native console is not connected yet."
        );
        // The controller restores the verified original window before acknowledging.
        std::fs::write(session.directory.join("popout"), b"")?;
    }
    detach_helper(app, environment_id).await?;
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(environment_id)
        .context("Console session not found")?;
    session.snapshot.presentation = "popout".into();
    Ok(())
}

pub async fn retry(app: &AppHandle, environment_id: &str) -> Result<()> {
    let state = app.state::<NativeConsoleState>();
    let _opening = state.opening.lock().await;
    anyhow::ensure!(
        !state.shutting_down.load(Ordering::Acquire),
        "SIMM is closing."
    );
    detach_helper(app, environment_id).await?;
    if let Some(session) = state.sessions.lock().unwrap().get_mut(environment_id) {
        // Never reuse control files while an old independent guard may still be exiting.
        session.directory = std::env::temp_dir()
            .join("SIMM-native-console")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&session.directory)?;
        write_json(&session.directory.join("viewport.json"), &session.viewport)?;
        session.snapshot.status = "waitingForGame".into();
        session.snapshot.presentation = "docked".into();
        session.snapshot.process_id = None;
        session.snapshot.process_started_at = None;
    }
    start_helper(app, environment_id)
}

pub fn update_viewport(
    app: &AppHandle,
    environment_id: &str,
    viewport: NativeConsoleViewport,
) -> Result<()> {
    anyhow::ensure!(
        [viewport.x, viewport.y, viewport.width, viewport.height]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0 && *v <= 100_000.0),
        "Invalid console pane bounds"
    );
    let state = app.state::<NativeConsoleState>();
    let mut sessions = state.sessions.lock().unwrap();
    // A cleanup from the previous view must never overtake a newer view's layout.
    if viewport.revision <= state.viewport_revision.load(Ordering::Acquire) {
        return Ok(());
    }
    anyhow::ensure!(
        sessions.contains_key(environment_id),
        "Console session not found"
    );
    for (id, session) in sessions.iter_mut() {
        if id != environment_id && viewport.visible && session.viewport.visible {
            let mut hidden = session.viewport.clone();
            hidden.visible = false;
            write_json(&session.directory.join("viewport.json"), &hidden)?;
            session.viewport = hidden;
        }
    }
    let session = sessions.get_mut(environment_id).unwrap();
    write_json(&session.directory.join("viewport.json"), &viewport)?;
    session.viewport = viewport.clone();
    state
        .viewport_revision
        .store(viewport.revision, Ordering::Release);
    Ok(())
}

pub fn close_game(app: &AppHandle, environment_id: &str) -> Result<()> {
    let state = app.state::<NativeConsoleState>();
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(environment_id)
        .context("Console session not found")?;
    let status: HelperStatus = read_json(&session.directory.join("status.json"))?;
    let process = status
        .process
        .context("No game process has been attached to this console.")?;
    #[cfg(windows)]
    {
        windows::close_game(&process, &session.directory)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = process;
        anyhow::bail!("Native console docking is available on Windows only.")
    }
}

async fn detach_helper(app: &AppHandle, environment_id: &str) -> Result<()> {
    let directory = app
        .state::<NativeConsoleState>()
        .sessions
        .lock()
        .unwrap()
        .get(environment_id)
        .map(|s| s.directory.clone());
    if let Some(directory) = directory {
        std::fs::write(directory.join("stop"), b"")?;
        for _ in 0..40 {
            if directory.join("restored").exists() {
                return Ok(());
            }
            {
                let state = app.state::<NativeConsoleState>();
                let mut sessions = state.sessions.lock().unwrap();
                if let Some(session) = sessions.get_mut(environment_id) {
                    let stopped = match session.controller.as_mut() {
                        Some(child) => child.try_wait()?.is_some(),
                        None => true,
                    };
                    if stopped && !directory.join("plan.json").exists() {
                        return Ok(());
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        anyhow::bail!(
            "Console restoration is still pending. Try again once the native window is restored."
        );
    }
    Ok(())
}

pub async fn detach(app: &AppHandle, environment_id: &str) {
    if let Err(error) = detach_helper(app, environment_id).await {
        log::warn!("Console restore pending for {environment_id}; independent recovery remains active: {error:#}");
    }
    app.state::<NativeConsoleState>()
        .sessions
        .lock()
        .unwrap()
        .remove(environment_id);
}

pub async fn shutdown(app: &AppHandle) {
    let state = app.state::<NativeConsoleState>();
    state.shutting_down.store(true, Ordering::Release);
    let _opening = state.opening.lock().await;
    let ids: Vec<String> = app
        .state::<NativeConsoleState>()
        .sessions
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for id in &ids {
        if let Some(session) = app
            .state::<NativeConsoleState>()
            .sessions
            .lock()
            .unwrap()
            .get(id)
        {
            let _ = std::fs::write(session.directory.join("stop"), b"");
        }
    }
    for id in ids {
        detach(app, &id).await;
    }
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("Missing parent directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    std::io::Write::write_all(&mut file, &serde_json::to_vec(value)?)?;
    // Windows can briefly deny replacement while another process/AV reads the
    // control file. Keep the same atomic payload and retry only sharing errors.
    for attempt in 0..8 {
        match file.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) => {
                if cfg!(windows)
                    && matches!(error.error.raw_os_error(), Some(5 | 32 | 33))
                    && attempt < 7
                {
                    file = error.file;
                    std::thread::sleep(Duration::from_millis(5 * (attempt + 1)));
                } else {
                    return Err(error.error)
                        .with_context(|| format!("Could not update {}", path.display()));
                }
            }
        }
    }
    unreachable!()
}

/// Invoked before CLI parsing and single-instance setup. Never initializes SIMM services.
pub fn run_helper_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next()?;
    if mode != "--native-console-controller" && mode != "--native-console-guard" {
        return None;
    }
    #[cfg(windows)]
    {
        let result = (|| -> Result<()> {
            let directory = PathBuf::from(args.next().context("Missing native console session")?);
            anyhow::ensure!(args.next().is_none(), "Unexpected native console arguments");
            windows::run(&mode.to_string_lossy(), &directory)
        })();
        Some(if result.is_ok() { 0 } else { 1 })
    }
    #[cfg(not(windows))]
    {
        Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn preferences_database() -> Result<SqlitePool> {
        let pool = SqlitePool::connect("sqlite::memory:").await?;
        sqlx::query("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await?;
        sqlx::query("CREATE TABLE environments (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO environments VALUES ('a'), ('b')")
            .execute(&pool)
            .await?;
        Ok(pool)
    }

    fn test_session(
        id: &str,
        directory: PathBuf,
        preferences: NativeConsolePreferences,
    ) -> Result<Session> {
        std::fs::create_dir_all(&directory)?;
        Ok(Session {
            snapshot: serde_json::from_value(serde_json::json!({
                "supported": true, "environment": {"id": id, "name": id, "appId": "3164500", "branch": "main", "outputDir": "C:/Game", "runtime": "IL2CPP", "status": "completed", "lastUpdated": null, "lastUpdateCheck": null},
                "entries": [], "preferences": preferences, "presentation": "docked", "status": "waitingForGame", "inventoryUpdatedAt": 0,
                "messages": crate::types::NativeConsoleMessages::default()
            }))?,
            directory,
            controller: None,
            viewport: Default::default(),
            messages: Default::default(),
        })
    }

    #[tokio::test]
    async fn environment_preferences_inherit_legacy_once_and_keep_auto_open_independent(
    ) -> Result<()> {
        let pool = preferences_database().await?;
        let legacy = NativeConsolePreferences {
            sidebar_width: 440,
            show_mods: false,
            ..Default::default()
        };
        sqlx::query("INSERT INTO app_meta VALUES (?, ?)")
            .bind(PREFERENCES_KEY)
            .bind(serde_json::to_string(&legacy)?)
            .execute(&pool)
            .await?;
        assert_eq!(preferences(&pool, "a").await?, legacy);
        let customized = NativeConsolePreferences {
            auto_open: false,
            sidebar_width: 280,
            ..legacy.clone()
        };
        save_preferences(
            &pool,
            &NativeConsoleState::default(),
            "a",
            customized.clone(),
        )
        .await?;
        assert_eq!(preferences(&pool, "b").await?, legacy);
        sqlx::query("UPDATE app_meta SET value = ? WHERE key = ?")
            .bind(serde_json::to_string(&NativeConsolePreferences::default())?)
            .bind(PREFERENCES_KEY)
            .execute(&pool)
            .await?;
        // Fresh reads do not depend on an in-memory session or the legacy setting.
        assert_eq!(preferences(&pool, "a").await?, customized);
        assert_eq!(preferences(&pool, "b").await?, legacy);
        Ok(())
    }

    #[tokio::test]
    async fn environment_preference_saves_update_only_the_target_session() -> Result<()> {
        let pool = preferences_database().await?;
        let scratch = tempfile::tempdir()?;
        let state = NativeConsoleState::default();
        state.sessions.lock().unwrap().insert(
            "a".into(),
            test_session("a", scratch.path().join("a"), Default::default())?,
        );
        state.sessions.lock().unwrap().insert(
            "b".into(),
            test_session("b", scratch.path().join("b"), Default::default())?,
        );
        let customized = NativeConsolePreferences {
            show_game: false,
            auto_open: false,
            sidebar_width: 440,
            ..Default::default()
        };
        save_preferences(&pool, &state, "a", customized.clone()).await?;
        let sessions = state.sessions.lock().unwrap();
        assert_eq!(sessions["a"].snapshot.preferences, customized);
        assert_eq!(
            sessions["b"].snapshot.preferences,
            NativeConsolePreferences::default()
        );
        assert!(scratch.path().join("a/preferences.json").exists());
        assert!(!scratch.path().join("b/preferences.json").exists());
        Ok(())
    }

    #[tokio::test]
    async fn preference_access_rejects_unknown_environments_without_creating_keys() -> Result<()> {
        let pool = preferences_database().await?;
        assert!(preferences(&pool, "missing").await.is_err());
        assert!(save_preferences(
            &pool,
            &NativeConsoleState::default(),
            "missing",
            Default::default()
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_meta")
                .fetch_one(&pool)
                .await?,
            0
        );
        Ok(())
    }
    #[tokio::test]
    async fn inventory_reads_every_installed_file_and_overrides_stale_package_versions(
    ) -> Result<()> {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/melon-metadata");
        let scratch = tempfile::tempdir()?;
        let disabled = scratch.path().join("Plugin.dll.disabled");
        std::fs::copy(fixtures.join("Legacy.dll"), &disabled)?;
        let broken = scratch.path().join("Broken.dll");
        std::fs::write(&broken, b"not an assembly; decoy 99.88.77")?;
        let result = entries(serde_json::json!({"mods": [
            {"name":"Cached name", "version":"0.0.1", "fileName":"Modern.dll", "path": fixtures.join("Modern.dll")},
            {"name":"Disabled", "disabled":true, "path":disabled},
            {"name":"Unreadable", "version":"7.7.7", "path":scratch.path().join("Missing.dll")},
            {"name":"Broken", "path":broken}
        ]}), "mods", "Mod").await?;
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].name, "Fixture Ω");
        assert_eq!(result[0].version.as_deref(), Some("2.7.1-beta.4+local"));
        assert_eq!(result[0].author.as_deref(), Some("Author Ω"));
        assert_eq!(result[0].version_source.as_deref(), Some("melonInfo"));
        assert_eq!(result[1].version.as_deref(), Some("1.8.2"));
        assert!(!result[1].enabled);
        assert_eq!(result[2].version.as_deref(), Some("7.7.7"));
        assert_eq!(result[2].version_source.as_deref(), Some("installMetadata"));
        assert!(result[3].version.is_none());
        Ok(())
    }
    #[cfg(windows)]
    #[test]
    fn atomic_control_update_recovers_from_a_transient_windows_reader_lock() -> Result<()> {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("viewport.json");
        write_json(&path, &serde_json::json!({"visible": false}))?;
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)?;
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(35));
            drop(reader);
        });
        let updated = write_json(&path, &serde_json::json!({"visible": true}));
        release.join().unwrap();
        updated?;
        assert_eq!(read_json::<serde_json::Value>(&path)?["visible"], true);
        Ok(())
    }
    #[tokio::test]
    async fn preferences_round_trip_and_clamp_without_telemetry() -> Result<()> {
        let pool = preferences_database().await?;
        assert!(preferences(&pool, "a").await?.auto_open);
        let state = NativeConsoleState::default();
        let requested = NativeConsolePreferences {
            sidebar_width: 900,
            show_mods: false,
            ..Default::default()
        };
        let saved = save_preferences(&pool, &state, "a", requested).await?;
        assert_eq!(saved.sidebar_width, 520);
        assert_eq!(preferences(&pool, "a").await?, saved);
        assert!(!saved.show_mods);
        Ok(())
    }
    #[tokio::test]
    async fn inventory_distinguishes_disabled_entries_and_kinds() {
        let result = entries(
            serde_json::json!({"mods":[{"name":"Enabled","version":"1.0"},{"name":"Disabled","disabled":true}]}),
            "mods",
            "Mod",
        ).await.unwrap();
        assert!(result[0].enabled);
        assert!(!result[1].enabled);
        assert_eq!(result[0].kind, "Mod");
        assert!(result[0].file_name.is_none());
    }
}
