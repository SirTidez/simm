use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Listener};
use tokio::sync::mpsc;
use tokio::time::{Duration, MissedTickBehavior};

use crate::services::environment::EnvironmentService;
use crate::services::logs::LogsService;
use crate::services::telemetry::TelemetryService;
use crate::services::telemetry_upload::TelemetryUploadService;
use crate::types::{LiveTelemetrySession, TelemetryPreferences};

const PROCESS_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(2);
const LOG_RECONCILIATION_LINES: usize = 500;
const LATE_ATTACH_LINES: usize = 250;

struct ActiveSession {
    session: LiveTelemetrySession,
    last_line_number: usize,
}

pub struct GameSessionMonitor {
    pool: Arc<SqlitePool>,
    app: AppHandle,
}

impl GameSessionMonitor {
    pub fn new(pool: Arc<SqlitePool>, app: AppHandle) -> Self {
        Self { pool, app }
    }

    pub fn start(self) {
        tokio::spawn(async move {
            if let Err(error) = self.run().await {
                log::error!("Live telemetry monitor stopped: {}", error);
            }
        });
    }

    async fn run(self) -> Result<()> {
        let (change_tx, mut change_rx) = mpsc::unbounded_channel::<String>();
        let (preferences_tx, mut preferences_rx) =
            mpsc::unbounded_channel::<TelemetryPreferences>();
        self.app.listen(
            "telemetry_preferences_changed",
            move |event| match serde_json::from_str::<TelemetryPreferences>(event.payload()) {
                Ok(preferences) => {
                    let _ = preferences_tx.send(preferences);
                }
                Err(error) => log::warn!(
                    "Ignoring invalid telemetry preference update event: {}",
                    error
                ),
            },
        );

        let telemetry = TelemetryService::new(self.pool.clone());
        let mut preferences = telemetry.get_preferences().await?;
        let mut active = HashMap::<String, ActiveSession>::new();
        let mut watchers = HashMap::<String, RecommendedWatcher>::new();
        let mut interval = tokio::time::interval(PROCESS_RECONCILIATION_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    self.reconcile(&preferences, &mut active, &mut watchers, &change_tx, true).await?;
                }
                Some(environment_id) = change_rx.recv() => {
                    let mut changed = HashSet::from([environment_id]);
                    while let Ok(next_environment_id) = change_rx.try_recv() {
                        changed.insert(next_environment_id);
                    }
                    for environment_id in changed {
                        self.ingest_environment(&environment_id, &mut active, "live", false, &preferences).await?;
                    }
                }
                Some(updated_preferences) = preferences_rx.recv() => {
                    preferences = updated_preferences;
                    self.reconcile(&preferences, &mut active, &mut watchers, &change_tx, false).await?;
                }
            }
        }
    }

    async fn reconcile(
        &self,
        preferences: &TelemetryPreferences,
        active: &mut HashMap<String, ActiveSession>,
        watchers: &mut HashMap<String, RecommendedWatcher>,
        change_tx: &mpsc::UnboundedSender<String>,
        reconcile_logs: bool,
    ) -> Result<()> {
        if !preferences.collection_enabled {
            self.stop_all(active, watchers).await?;
            return Ok(());
        }

        let environments = EnvironmentService::new(self.pool.clone())?
            .get_environments()
            .await?;
        let running_directories = running_schedule_directories().await;
        let known_ids = environments
            .iter()
            .map(|environment| environment.id.clone())
            .collect::<HashSet<_>>();

        for environment in &environments {
            if environment.output_dir.trim().is_empty() {
                continue;
            }
            let normalized_output = normalize_path(Path::new(&environment.output_dir));
            let running = running_directories.contains(&normalized_output);
            if running && !active.contains_key(&environment.id) {
                let session = TelemetryService::new(self.pool.clone())
                    .start_live_session(&environment.id)
                    .await?;
                self.emit_status(&session.environment_id, true, Some(&session.session_id));
                self.start_log_watcher(
                    &environment.id,
                    &environment.output_dir,
                    change_tx,
                    watchers,
                )?;
                active.insert(
                    environment.id.clone(),
                    ActiveSession {
                        session,
                        last_line_number: 0,
                    },
                );
                self.ingest_environment(&environment.id, active, "attach", true, preferences)
                    .await?;
            } else if !running && active.contains_key(&environment.id) {
                self.stop_environment(&environment.id, active, watchers)
                    .await?;
            }
        }

        let stale_ids = active
            .keys()
            .filter(|environment_id| !known_ids.contains(*environment_id))
            .cloned()
            .collect::<Vec<_>>();
        for environment_id in stale_ids {
            self.stop_environment(&environment_id, active, watchers)
                .await?;
        }

        if reconcile_logs {
            let active_ids = active.keys().cloned().collect::<Vec<_>>();
            for environment_id in active_ids {
                self.ingest_environment(&environment_id, active, "live", false, preferences)
                    .await?;
            }
        }
        Ok(())
    }

    fn start_log_watcher(
        &self,
        environment_id: &str,
        output_dir: &str,
        change_tx: &mpsc::UnboundedSender<String>,
        watchers: &mut HashMap<String, RecommendedWatcher>,
    ) -> Result<()> {
        let path = LogsService::new().get_latest_log_path(output_dir);
        let id = environment_id.to_string();
        let tx = change_tx.clone();
        let mut watcher = notify::recommended_watcher(
            move |result: std::result::Result<notify::Event, notify::Error>| {
                if result.is_ok() {
                    let _ = tx.send(id.clone());
                }
            },
        )
        .context("Failed to create telemetry log watcher")?;
        if let Some(parent) = path.parent() {
            if parent.exists() {
                watcher
                    .watch(parent, RecursiveMode::NonRecursive)
                    .context("Failed to watch telemetry log directory")?;
            }
        }
        watchers.insert(environment_id.to_string(), watcher);
        Ok(())
    }

    async fn ingest_environment(
        &self,
        environment_id: &str,
        active: &mut HashMap<String, ActiveSession>,
        origin: &str,
        attach: bool,
        preferences: &TelemetryPreferences,
    ) -> Result<()> {
        let Some(active_session) = active.get_mut(environment_id) else {
            return Ok(());
        };
        let environment = EnvironmentService::new(self.pool.clone())
            .and_then(|service| Ok(service))?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        let log_path = LogsService::new().get_latest_log_path(&environment.output_dir);
        if !log_path.exists() {
            return Ok(());
        }
        let max_lines = if attach {
            LATE_ATTACH_LINES
        } else {
            LOG_RECONCILIATION_LINES
        };
        let lines = LogsService::new()
            .read_log_file(&log_path.to_string_lossy(), Some(max_lines))
            .await?;
        let latest_line = lines.last().map(|line| line.line_number).unwrap_or(0);
        if latest_line < active_session.last_line_number {
            active_session.last_line_number = 0;
        }
        let new_lines = lines
            .into_iter()
            .filter(|line| attach || line.line_number > active_session.last_line_number)
            .collect::<Vec<_>>();
        active_session.last_line_number = latest_line.max(active_session.last_line_number);
        let telemetry_service = TelemetryService::new(self.pool.clone());
        telemetry_service
            .enrich_live_session_mod_metadata(&mut active_session.session, &new_lines)
            .await?;
        let events = telemetry_service
            .record_live_lines_with_preferences(
                &active_session.session,
                new_lines,
                origin,
                preferences,
            )
            .await?;
        for event in events {
            let _ = self.app.emit("live_telemetry_event", &event);
        }
        Ok(())
    }

    async fn stop_environment(
        &self,
        environment_id: &str,
        active: &mut HashMap<String, ActiveSession>,
        watchers: &mut HashMap<String, RecommendedWatcher>,
    ) -> Result<()> {
        if let Some(active_session) = active.remove(environment_id) {
            TelemetryService::new(self.pool.clone())
                .end_live_session(&active_session.session.session_id)
                .await?;
            match TelemetryUploadService::new(self.pool.clone())
                .queue_finished_session(&active_session.session.session_id)
                .await
            {
                Ok(Some(receipt)) => {
                    let _ = self.app.emit("live_telemetry_upload", &receipt);
                }
                Ok(None) => {}
                Err(error) => log::warn!(
                    "Failed to automatically upload finished telemetry session: {}",
                    error
                ),
            }
            watchers.remove(environment_id);
            self.emit_status(environment_id, false, None);
        }
        Ok(())
    }

    async fn stop_all(
        &self,
        active: &mut HashMap<String, ActiveSession>,
        watchers: &mut HashMap<String, RecommendedWatcher>,
    ) -> Result<()> {
        let ids = active.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            self.stop_environment(&id, active, watchers).await?;
        }
        Ok(())
    }

    fn emit_status(&self, environment_id: &str, running: bool, session_id: Option<&str>) {
        let _ = self.app.emit(
            "live_telemetry_status",
            serde_json::json!({
                "environmentId": environment_id,
                "running": running,
                "monitoring": running,
                "activeSessionId": session_id,
            }),
        );
    }
}

async fn running_schedule_directories() -> HashSet<String> {
    let paths = tokio::task::spawn_blocking(discover_schedule_process_paths)
        .await
        .unwrap_or_default();
    paths
        .into_iter()
        .map(|path| normalize_path(&path))
        .collect()
}

#[cfg(windows)]
fn discover_schedule_process_paths() -> Vec<PathBuf> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name = 'Schedule I.exe'\" | Select-Object ExecutablePath | ConvertTo-Json -Compress";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
        return Vec::new();
    };
    let values = match value {
        Value::Array(values) => values,
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|value| {
            value
                .get("ExecutablePath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect()
}

#[cfg(target_os = "linux")]
fn discover_schedule_process_paths() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .chars()
                .all(|character| character.is_ascii_digit())
        })
        .filter_map(|entry| {
            let pid_path = entry.path();
            let command_line = std::fs::read(pid_path.join("cmdline")).ok()?;
            let arguments = command_line
                .split(|byte| *byte == 0)
                .filter_map(|value| std::str::from_utf8(value).ok());
            arguments
                .filter_map(|argument| {
                    let path = Path::new(argument);
                    let name = path.file_name()?.to_string_lossy();
                    (name.eq_ignore_ascii_case("Schedule I.exe")
                        || name.eq_ignore_ascii_case("Schedule I"))
                    .then(|| path.parent().map(Path::to_path_buf))
                    .flatten()
                })
                .next()
        })
        .collect()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn discover_schedule_process_paths() -> Vec<PathBuf> {
    Vec::new()
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_environment_paths_for_matching() {
        assert_eq!(
            normalize_path(Path::new("C:/Games/Schedule I/")),
            normalize_path(Path::new("c:\\games\\schedule i"))
        );
    }
}
