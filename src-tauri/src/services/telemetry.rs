use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::services::environment::EnvironmentService;
use crate::services::logger::LoggerService;
use crate::services::logs::{LogLine, LogsService};
use crate::services::mods::ModsService;
use crate::types::{
    LiveTelemetryEvent, LiveTelemetryExport, LiveTelemetryExportEvent, LiveTelemetryExportSession,
    LiveTelemetrySession, LiveTelemetryStatus, ModSource, ModTelemetryCaptureRequest,
    ModTelemetryEnvironment, ModTelemetryModEntry, ModTelemetrySnapshot,
    ModTelemetrySnapshotSummary, ModTelemetrySourceError, TelemetryPreferences,
    TelemetryPreferencesUpdate,
};

const TELEMETRY_SCHEMA_VERSION: u32 = 1;
const TELEMETRY_PREFERENCES_ID: i64 = 1;
const DEFAULT_MAX_LOG_LINES: usize = 2_000;
const MAX_LOG_LINES: usize = 10_000;
const MAX_ERROR_EXCERPT_CHARS: usize = 600;
const LIVE_TELEMETRY_SCHEMA_VERSION: u32 = 1;

pub struct TelemetryService {
    pool: Arc<SqlitePool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModsListEnvelope {
    #[serde(default)]
    mods: Vec<TelemetryModListItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryModListItem {
    name: String,
    file_name: String,
    version: Option<String>,
    source: Option<ModSource>,
    author: Option<String>,
    disabled: Option<bool>,
    managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTelemetrySnapshot {
    #[serde(flatten)]
    snapshot: ModTelemetrySnapshot,
    environment_id: String,
}

impl TelemetryService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self { pool }
    }

    pub async fn get_preferences(&self) -> Result<TelemetryPreferences> {
        let stored =
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_preferences WHERE id = ?")
                .bind(TELEMETRY_PREFERENCES_ID)
                .fetch_optional(self.pool.as_ref())
                .await
                .context("Failed to load telemetry preferences")?;

        match stored {
            Some(data) => serde_json::from_str::<TelemetryPreferences>(&data)
                .context("Failed to parse telemetry preferences"),
            None => Ok(TelemetryPreferences::default()),
        }
    }

    pub async fn save_preferences(
        &self,
        updates: TelemetryPreferencesUpdate,
    ) -> Result<TelemetryPreferences> {
        let current = self.get_preferences().await?;
        let now = Utc::now().to_rfc3339();
        let mut next = TelemetryPreferences {
            collection_enabled: updates
                .collection_enabled
                .unwrap_or(current.collection_enabled),
            upload_enabled: updates.upload_enabled.unwrap_or(current.upload_enabled),
            error_excerpts_enabled: updates
                .error_excerpts_enabled
                .unwrap_or(current.error_excerpts_enabled),
            retention_days: updates
                .retention_days
                .unwrap_or(current.retention_days)
                .clamp(1, 365),
            close_behavior: updates.close_behavior.unwrap_or(current.close_behavior),
            updated_at: Some(now.clone()),
        };

        if !next.collection_enabled {
            next.upload_enabled = false;
        }

        if next.upload_enabled && !next.collection_enabled {
            return Err(anyhow!(
                "Telemetry upload cannot be enabled before telemetry collection is enabled"
            ));
        }

        let data = serde_json::to_string(&next).context("Failed to serialize preferences")?;
        sqlx::query(
            "INSERT INTO telemetry_preferences (id, data, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        )
        .bind(TELEMETRY_PREFERENCES_ID)
        .bind(data)
        .bind(now)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save telemetry preferences")?;

        Ok(next)
    }

    pub async fn start_live_session(&self, environment_id: &str) -> Result<LiveTelemetrySession> {
        let environment = EnvironmentService::new(self.pool.clone())?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;
        let raw_mods = ModsService::new(self.pool.clone())
            .list_mods(&environment.output_dir)
            .await
            .context("Failed to list installed mods for telemetry session")?;
        let session = LiveTelemetrySession {
            session_id: format!("session-{}", Uuid::new_v4().simple()),
            environment_id: environment.id,
            started_at: Utc::now().to_rfc3339(),
            ended_at: None,
            environment: ModTelemetryEnvironment {
                app_id: environment.app_id,
                branch: environment.branch,
                runtime: environment.runtime,
                s1_version: environment.current_game_version,
            },
            mods: self.telemetry_mods_from_value(raw_mods)?,
            monitoring: true,
        };
        sqlx::query(
            "INSERT INTO telemetry_sessions (id, environment_id, started_at, ended_at, data) VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(&session.session_id)
        .bind(&session.environment_id)
        .bind(&session.started_at)
        .bind(serde_json::to_string(&session)?)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save telemetry session")?;
        Ok(session)
    }

    pub async fn end_live_session(&self, session_id: &str) -> Result<()> {
        let data =
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_optional(self.pool.as_ref())
                .await?
                .ok_or_else(|| anyhow!("Telemetry session not found"))?;
        let mut session: LiveTelemetrySession = serde_json::from_str(&data)?;
        if session.ended_at.is_none() {
            session.ended_at = Some(Utc::now().to_rfc3339());
            session.monitoring = false;
            sqlx::query("UPDATE telemetry_sessions SET ended_at = ?, data = ? WHERE id = ?")
                .bind(session.ended_at.as_deref())
                .bind(serde_json::to_string(&session)?)
                .bind(session_id)
                .execute(self.pool.as_ref())
                .await?;
        }
        Ok(())
    }

    pub async fn record_live_lines_with_preferences(
        &self,
        session: &LiveTelemetrySession,
        lines: Vec<LogLine>,
        origin: &str,
        preferences: &TelemetryPreferences,
    ) -> Result<Vec<LiveTelemetryEvent>> {
        if !preferences.collection_enabled {
            return Ok(Vec::new());
        }

        let mut events = Vec::new();
        for line in lines {
            let severity = line
                .level
                .unwrap_or_else(|| "INFO".to_string())
                .to_ascii_uppercase();
            if !matches!(severity.as_str(), "WARN" | "WARNING" | "ERROR" | "FATAL") {
                continue;
            }
            let sanitized = truncate_excerpt(&LoggerService::sanitize_log_text(&line.content));
            let mod_name = line.mod_tag.clone();
            let matching_mod = mod_name.as_ref().and_then(|name| {
                session
                    .mods
                    .iter()
                    .find(|entry| names_match(&entry.name, name))
            });
            let attribution = if matching_mod.is_some() {
                "mod"
            } else if mod_name.is_some() {
                "unknown"
            } else {
                "system"
            };
            let event = LiveTelemetryEvent {
                event_id: format!("event-{}", Uuid::new_v4().simple()),
                session_id: session.session_id.clone(),
                environment_id: session.environment_id.clone(),
                occurred_at: line.timestamp.unwrap_or_else(|| Utc::now().to_rfc3339()),
                severity: if severity == "WARNING" {
                    "WARN".to_string()
                } else {
                    severity
                },
                attribution: attribution.to_string(),
                mod_key: matching_mod.map(|entry| entry.mod_key.clone()),
                mod_name,
                fingerprint: event_fingerprint(&sanitized, attribution),
                message: preferences.error_excerpts_enabled.then_some(sanitized),
                source: "Latest.log".to_string(),
                line_number: Some(line.line_number as u32),
                origin: origin.to_string(),
            };
            sqlx::query(
                "INSERT INTO telemetry_events (id, session_id, environment_id, occurred_at, severity, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&event.event_id)
            .bind(&event.session_id)
            .bind(&event.environment_id)
            .bind(&event.occurred_at)
            .bind(&event.severity)
            .bind(&event.fingerprint)
            .bind(serde_json::to_string(&event)?)
            .execute(self.pool.as_ref())
            .await?;
            events.push(event);
        }
        self.prune_live_history(preferences.retention_days).await?;
        Ok(events)
    }

    pub async fn list_live_events(
        &self,
        environment_id: Option<String>,
        limit: Option<u32>,
    ) -> Result<Vec<LiveTelemetryEvent>> {
        let limit = i64::from(limit.unwrap_or(250).clamp(1, 2_000));
        let rows = if let Some(environment_id) = environment_id {
            sqlx::query_scalar::<_, String>(
                "SELECT data FROM telemetry_events WHERE environment_id = ? ORDER BY occurred_at DESC LIMIT ?",
            )
            .bind(environment_id)
            .bind(limit)
            .fetch_all(self.pool.as_ref())
            .await?
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT data FROM telemetry_events ORDER BY occurred_at DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(self.pool.as_ref())
            .await?
        };
        rows.into_iter()
            .map(|data| serde_json::from_str(&data).context("Failed to parse telemetry event"))
            .collect()
    }

    pub async fn get_live_status(&self) -> Result<Vec<LiveTelemetryStatus>> {
        let sessions = sqlx::query_scalar::<_, String>(
            "SELECT data FROM telemetry_sessions ORDER BY started_at DESC",
        )
        .fetch_all(self.pool.as_ref())
        .await?;
        let mut statuses = std::collections::BTreeMap::new();
        for data in sessions {
            let session: LiveTelemetrySession = serde_json::from_str(&data)?;
            statuses
                .entry(session.environment_id.clone())
                .or_insert_with(|| LiveTelemetryStatus {
                    environment_id: session.environment_id.clone(),
                    running: session.monitoring,
                    monitoring: session.monitoring,
                    active_session_id: session.monitoring.then_some(session.session_id.clone()),
                    event_count: 0,
                    last_event_at: None,
                });
        }
        for status in statuses.values_mut() {
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM telemetry_events WHERE environment_id = ?",
            )
            .bind(&status.environment_id)
            .fetch_one(self.pool.as_ref())
            .await?;
            status.event_count = count.max(0) as u64;
            status.last_event_at = sqlx::query_scalar::<_, String>(
                "SELECT occurred_at FROM telemetry_events WHERE environment_id = ? ORDER BY occurred_at DESC LIMIT 1",
            )
            .bind(&status.environment_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        }
        for environment in EnvironmentService::new(self.pool.clone())?
            .get_environments()
            .await?
        {
            statuses
                .entry(environment.id.clone())
                .or_insert(LiveTelemetryStatus {
                    environment_id: environment.id,
                    running: false,
                    monitoring: false,
                    active_session_id: None,
                    event_count: 0,
                    last_event_at: None,
                });
        }
        Ok(statuses.into_values().collect())
    }

    pub async fn clear_live_history(&self, environment_id: Option<String>) -> Result<()> {
        if let Some(environment_id) = environment_id {
            sqlx::query("DELETE FROM telemetry_events WHERE environment_id = ?")
                .bind(&environment_id)
                .execute(self.pool.as_ref())
                .await?;
            sqlx::query(
                "DELETE FROM telemetry_sessions WHERE environment_id = ? AND ended_at IS NOT NULL",
            )
            .bind(environment_id)
            .execute(self.pool.as_ref())
            .await?;
        } else {
            sqlx::query("DELETE FROM telemetry_events")
                .execute(self.pool.as_ref())
                .await?;
            sqlx::query("DELETE FROM telemetry_sessions WHERE ended_at IS NOT NULL")
                .execute(self.pool.as_ref())
                .await?;
        }
        Ok(())
    }

    pub async fn export_live_history(
        &self,
        environment_id: Option<String>,
    ) -> Result<LiveTelemetryExport> {
        let session_rows = if let Some(environment_id) = environment_id {
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_sessions WHERE environment_id = ? ORDER BY started_at ASC")
                .bind(environment_id).fetch_all(self.pool.as_ref()).await?
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT data FROM telemetry_sessions ORDER BY started_at ASC",
            )
            .fetch_all(self.pool.as_ref())
            .await?
        };
        let mut sessions = Vec::new();
        for data in session_rows {
            let session: LiveTelemetrySession = serde_json::from_str(&data)?;
            let event_rows = sqlx::query_scalar::<_, String>(
                "SELECT data FROM telemetry_events WHERE session_id = ? ORDER BY occurred_at ASC",
            )
            .bind(&session.session_id)
            .fetch_all(self.pool.as_ref())
            .await?;
            let events = event_rows
                .into_iter()
                .map(|data| -> Result<LiveTelemetryExportEvent> {
                    let event: LiveTelemetryEvent = serde_json::from_str(&data)?;
                    Ok(LiveTelemetryExportEvent {
                        event_id: format!("event-{}", Uuid::new_v4().simple()),
                        occurred_at: event.occurred_at,
                        severity: event.severity,
                        attribution: event.attribution,
                        mod_key: event.mod_key,
                        mod_name: event.mod_name,
                        fingerprint: event.fingerprint,
                        message: event.message,
                        source: event.source,
                        line_number: event.line_number,
                        origin: event.origin,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            sessions.push(LiveTelemetryExportSession {
                session_id: format!("session-{}", Uuid::new_v4().simple()),
                started_at: session.started_at,
                ended_at: session.ended_at,
                environment: session.environment,
                mods: session.mods,
                events,
            });
        }
        Ok(LiveTelemetryExport {
            schema_version: LIVE_TELEMETRY_SCHEMA_VERSION,
            exported_at: Utc::now().to_rfc3339(),
            sessions,
        })
    }

    async fn prune_live_history(&self, retention_days: u32) -> Result<()> {
        let cutoff = Utc::now() - chrono::Duration::days(i64::from(retention_days.clamp(1, 365)));
        let cutoff = cutoff.to_rfc3339();
        sqlx::query("DELETE FROM telemetry_events WHERE occurred_at < ?")
            .bind(&cutoff)
            .execute(self.pool.as_ref())
            .await?;
        sqlx::query("DELETE FROM telemetry_sessions WHERE ended_at IS NOT NULL AND ended_at < ?")
            .bind(cutoff)
            .execute(self.pool.as_ref())
            .await?;
        Ok(())
    }

    pub async fn capture_snapshot(
        &self,
        request: ModTelemetryCaptureRequest,
    ) -> Result<ModTelemetrySnapshot> {
        let preferences = self.get_preferences().await?;
        if !preferences.collection_enabled {
            return Err(anyhow!(
                "Telemetry collection is disabled. Enable telemetry collection before capturing snapshots."
            ));
        }

        let environment = EnvironmentService::new(self.pool.clone())?
            .get_environment(&request.environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;

        let mods_service = ModsService::new(self.pool.clone());
        let raw_mods = mods_service
            .list_mods(&environment.output_dir)
            .await
            .context("Failed to list installed mods for telemetry snapshot")?;
        let mods = self.telemetry_mods_from_value(raw_mods)?;

        let max_log_lines = request
            .max_log_lines
            .unwrap_or(DEFAULT_MAX_LOG_LINES)
            .clamp(1, MAX_LOG_LINES);
        let errors = self
            .capture_mod_errors(
                &environment.output_dir,
                &mods,
                max_log_lines,
                preferences.error_excerpts_enabled,
            )
            .await?;

        let snapshot = ModTelemetrySnapshot {
            schema_version: TELEMETRY_SCHEMA_VERSION,
            snapshot_id: format!("snapshot-{}", Uuid::new_v4().simple()),
            created_at: Utc::now().to_rfc3339(),
            environment: ModTelemetryEnvironment {
                app_id: environment.app_id,
                branch: environment.branch,
                runtime: environment.runtime,
                s1_version: environment.current_game_version,
            },
            mods,
            errors,
            upload_ready: preferences.upload_enabled,
        };

        let stored = StoredTelemetrySnapshot {
            snapshot: snapshot.clone(),
            environment_id: request.environment_id,
        };
        let data = serde_json::to_string(&stored).context("Failed to serialize snapshot")?;
        sqlx::query(
            "INSERT INTO telemetry_snapshots (id, environment_id, created_at, data) VALUES (?, ?, ?, ?)",
        )
        .bind(&snapshot.snapshot_id)
        .bind(&stored.environment_id)
        .bind(&snapshot.created_at)
        .bind(data)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to save telemetry snapshot")?;

        Ok(snapshot)
    }

    pub async fn list_snapshots(
        &self,
        environment_id: Option<String>,
    ) -> Result<Vec<ModTelemetrySnapshotSummary>> {
        let rows = if let Some(environment_id) = environment_id {
            sqlx::query_as::<_, (String, String)>(
                "SELECT data, environment_id FROM telemetry_snapshots \
                 WHERE environment_id = ? ORDER BY created_at DESC",
            )
            .bind(environment_id)
            .fetch_all(self.pool.as_ref())
            .await
        } else {
            sqlx::query_as::<_, (String, String)>(
                "SELECT data, environment_id FROM telemetry_snapshots ORDER BY created_at DESC",
            )
            .fetch_all(self.pool.as_ref())
            .await
        }
        .context("Failed to list telemetry snapshots")?;

        rows.into_iter()
            .map(|(data, environment_id)| {
                let stored = serde_json::from_str::<StoredTelemetrySnapshot>(&data)
                    .context("Failed to parse telemetry snapshot")?;
                Ok(ModTelemetrySnapshotSummary {
                    snapshot_id: stored.snapshot.snapshot_id,
                    environment_id,
                    created_at: stored.snapshot.created_at,
                    runtime: stored.snapshot.environment.runtime,
                    s1_version: stored.snapshot.environment.s1_version,
                    mod_count: stored.snapshot.mods.len(),
                    error_count: stored.snapshot.errors.len(),
                    upload_ready: stored.snapshot.upload_ready,
                })
            })
            .collect()
    }

    pub async fn get_snapshot(&self, snapshot_id: &str) -> Result<ModTelemetrySnapshot> {
        let data =
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_snapshots WHERE id = ?")
                .bind(snapshot_id)
                .fetch_optional(self.pool.as_ref())
                .await
                .context("Failed to load telemetry snapshot")?
                .ok_or_else(|| anyhow!("Telemetry snapshot not found"))?;

        let stored = serde_json::from_str::<StoredTelemetrySnapshot>(&data)
            .context("Failed to parse telemetry snapshot")?;
        Ok(stored.snapshot)
    }

    pub async fn delete_snapshot(&self, snapshot_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM telemetry_snapshots WHERE id = ?")
            .bind(snapshot_id)
            .execute(self.pool.as_ref())
            .await
            .context("Failed to delete telemetry snapshot")?;

        Ok(())
    }

    fn telemetry_mods_from_value(
        &self,
        raw_mods: serde_json::Value,
    ) -> Result<Vec<ModTelemetryModEntry>> {
        let envelope: ModsListEnvelope =
            serde_json::from_value(raw_mods).context("Failed to parse installed mods")?;

        let mut mods = envelope
            .mods
            .into_iter()
            .map(|item| {
                let disabled = item.disabled.unwrap_or(false);
                ModTelemetryModEntry {
                    mod_key: mod_key(&item.name, &item.file_name, item.source.as_ref()),
                    name: item.name,
                    file_name: item.file_name,
                    version: item.version,
                    source: item.source,
                    author: item.author,
                    managed: item.managed,
                    disabled,
                }
            })
            .collect::<Vec<_>>();

        mods.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then(left.file_name.cmp(&right.file_name))
        });
        Ok(mods)
    }

    async fn capture_mod_errors(
        &self,
        output_dir: &str,
        mods: &[ModTelemetryModEntry],
        max_log_lines: usize,
        include_excerpts: bool,
    ) -> Result<Vec<ModTelemetrySourceError>> {
        let logs_service = LogsService::new();
        let latest_log = logs_service.get_latest_log_path(output_dir);
        if !latest_log.exists() {
            return Ok(Vec::new());
        }

        let log_path = latest_log.to_string_lossy().to_string();
        let lines = logs_service
            .read_log_file(&log_path, Some(max_log_lines))
            .await
            .context("Failed to read telemetry source log")?;

        let mut errors = Vec::new();
        for line in lines {
            let level = line.level.unwrap_or_else(|| "INFO".to_string());
            let normalized_level = level.to_ascii_uppercase();
            if !matches!(normalized_level.as_str(), "ERROR" | "FATAL") {
                continue;
            }

            let Some(mod_name) = line.mod_tag else {
                continue;
            };

            let mod_key = mods
                .iter()
                .find(|entry| names_match(&entry.name, &mod_name))
                .map(|entry| entry.mod_key.clone());

            errors.push(ModTelemetrySourceError {
                mod_key,
                mod_name,
                level: normalized_level,
                message: include_excerpts
                    .then(|| truncate_excerpt(&LoggerService::sanitize_log_text(&line.content))),
                timestamp: line.timestamp,
                source: Some("Latest.log".to_string()),
                line_number: Some(line.line_number as u32),
            });
        }

        Ok(errors)
    }
}

fn mod_key(name: &str, file_name: &str, source: Option<&ModSource>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(name.trim().to_ascii_lowercase());
    hasher.update("|");
    hasher.update(file_name.trim().to_ascii_lowercase());
    hasher.update("|");
    hasher.update(
        source
            .map(|value| format!("{:?}", value).to_ascii_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    );
    let digest = hasher.finalize();
    format!("mod-{}", hex::encode(&digest[..8]))
}

fn names_match(left: &str, right: &str) -> bool {
    normalize_mod_name(left) == normalize_mod_name(right)
}

fn normalize_mod_name(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(".dll")
        .trim_end_matches(".DLL")
        .replace(['-', '_', ' '], "")
        .to_ascii_lowercase()
}

fn truncate_excerpt(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_ERROR_EXCERPT_CHARS {
        return trimmed.to_string();
    }

    trimmed
        .chars()
        .take(MAX_ERROR_EXCERPT_CHARS)
        .collect::<String>()
}

fn event_fingerprint(sanitized: &str, attribution: &str) -> String {
    let normalized = sanitized
        .chars()
        .map(|character| {
            if character.is_ascii_digit() {
                '#'
            } else {
                character
            }
        })
        .collect::<String>();
    let mut hasher = Sha256::new();
    hasher.update(attribution.as_bytes());
    hasher.update("|");
    hasher.update(normalized.as_bytes());
    format!("sig-{}", hex::encode(&hasher.finalize()[..12]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::test_helpers::EnvVarGuard;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn preferences_default_to_disabled() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let _guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let service = TelemetryService::new(pool);

        let preferences = service.get_preferences().await?;

        assert!(!preferences.collection_enabled);
        assert!(!preferences.upload_enabled);
        assert!(!preferences.error_excerpts_enabled);
        assert_eq!(preferences.retention_days, 30);
        assert!(preferences.updated_at.is_none());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn disabling_collection_also_disables_upload() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let _guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let service = TelemetryService::new(pool);

        let enabled = service
            .save_preferences(TelemetryPreferencesUpdate {
                collection_enabled: Some(true),
                upload_enabled: Some(true),
                error_excerpts_enabled: Some(true),
                retention_days: None,
                close_behavior: None,
            })
            .await?;
        assert!(enabled.collection_enabled);
        assert!(enabled.upload_enabled);

        let disabled = service
            .save_preferences(TelemetryPreferencesUpdate {
                collection_enabled: Some(false),
                upload_enabled: None,
                error_excerpts_enabled: None,
                retention_days: None,
                close_behavior: None,
            })
            .await?;

        assert!(!disabled.collection_enabled);
        assert!(!disabled.upload_enabled);
        assert!(disabled.error_excerpts_enabled);

        Ok(())
    }

    #[test]
    fn event_fingerprint_groups_numeric_variants_without_retaining_text() {
        assert_eq!(
            event_fingerprint("System.Exception at slot 12", "system"),
            event_fingerprint("System.Exception at slot 99", "system"),
        );
        assert_ne!(
            event_fingerprint("System.Exception", "system"),
            event_fingerprint("System.Exception", "mod"),
        );
    }

    #[test]
    fn live_telemetry_v1_fixture_uses_the_documented_contract() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test-fixtures/live-telemetry-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture["schemaVersion"], 1);
        assert!(fixture["uploadId"]
            .as_str()
            .unwrap()
            .parse::<uuid::Uuid>()
            .is_ok());
    }
}
