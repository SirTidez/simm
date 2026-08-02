use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use once_cell::sync::Lazy;
use regex::Regex;
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
    ModTelemetrySnapshotSummary, ModTelemetrySourceError, TelemetryModCaptureMode,
    TelemetryModPolicyItem, TelemetryModRuleUpdate, TelemetryPreferences,
    TelemetryPreferencesUpdate,
};

const TELEMETRY_SCHEMA_VERSION: u32 = 1;
const TELEMETRY_PREFERENCES_ID: i64 = 1;
const TELEMETRY_FEATURE_FLAG: &str = "SIMM_ENABLE_TELEMETRY";
const DEFAULT_MAX_LOG_LINES: usize = 2_000;
const MAX_LOG_LINES: usize = 10_000;
const MAX_ERROR_EXCERPT_CHARS: usize = 600;
const LIVE_TELEMETRY_SCHEMA_VERSION: u32 = 1;
static ERROR_CLASS_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b([A-Za-z_][A-Za-z0-9_.]{0,119}(?:Exception|Error|Fault))\b")
        .expect("error class regex should compile")
});
static ERROR_CODE_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(0x[0-9a-f]{4,16}|ERR[_-][A-Z0-9]{2,32}|HRESULT[_-]?[A-Z0-9]{2,32})\b")
        .expect("error code regex should compile")
});
static MELON_MOD_VERSION_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?<name>.+?)\s+v(?<version>\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\s*$")
        .expect("MelonLoader mod version regex should compile")
});
static MELON_MOD_AUTHOR_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^by\s+(?<author>.+?)\s*$")
        .expect("MelonLoader mod author regex should compile")
});
static MELON_MOD_ASSEMBLY_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^Assembly:\s*(?:.*[\\/])?(?<file>[^\\/]+\.dll)\s*$")
        .expect("MelonLoader mod assembly regex should compile")
});
static KNOWN_IL2CPP_INTEROP_WARNING_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\[il2cppinterop\]\s+class::init signatures have been exhausted,\s*using a substitute!?")
        .expect("known Il2CppInterop warning regex should compile")
});

pub fn telemetry_feature_enabled() -> bool {
    telemetry_feature_enabled_from_value(std::env::var(TELEMETRY_FEATURE_FLAG).ok().as_deref())
}

fn telemetry_feature_enabled_from_value(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim),
        Some(value) if value == "1" || value.eq_ignore_ascii_case("true")
    )
}

pub fn ensure_telemetry_feature_enabled() -> Result<()> {
    if telemetry_feature_enabled() {
        return Ok(());
    }

    Err(anyhow!(
        "Telemetry is disabled. Launch SIMM with {TELEMETRY_FEATURE_FLAG}=1 to enable it."
    ))
}

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

#[derive(Debug, Default)]
struct MelonLoaderModMetadata {
    version: Option<String>,
    author: Option<String>,
}

#[derive(Debug)]
struct PendingMelonLoaderMetadata {
    version: String,
    author: Option<String>,
}

#[derive(Debug, Default)]
struct TelemetryModRules {
    global: HashMap<String, TelemetryModCaptureMode>,
    environment: HashMap<(String, String), TelemetryModCaptureMode>,
}

#[derive(Debug)]
pub(crate) struct ShareableTelemetryExport {
    pub export: LiveTelemetryExport,
    pub excluded_mod_count: usize,
    pub excluded_event_count: usize,
    pub excluded_session_count: usize,
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
            protect_local_mods: updates
                .protect_local_mods
                .unwrap_or(current.protect_local_mods),
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

    /// Fills metadata that MelonLoader prints during startup for unmanaged local mods.
    ///
    /// The session snapshot is persisted again before upload, but only missing values are
    /// supplemented. This never retains the source log line or changes explicit metadata that
    /// SIMM already knows about the installed mod.
    pub async fn enrich_live_session_mod_metadata(
        &self,
        session: &mut LiveTelemetrySession,
        lines: &[LogLine],
    ) -> Result<()> {
        let metadata_by_file = melonloader_mod_metadata(lines);
        if metadata_by_file.is_empty() {
            return Ok(());
        }

        let mut changed = false;
        for entry in &mut session.mods {
            let Some(metadata) = metadata_by_file.get(&normalize_mod_file_name(&entry.file_name))
            else {
                continue;
            };

            if entry.version.is_none() {
                if let Some(version) = &metadata.version {
                    entry.version = Some(version.clone());
                    changed = true;
                }
            }
            if entry.author.is_none() {
                if let Some(author) = &metadata.author {
                    entry.author = Some(author.clone());
                    changed = true;
                }
            }
        }

        if changed {
            sqlx::query("UPDATE telemetry_sessions SET data = ? WHERE id = ?")
                .bind(serde_json::to_string(session)?)
                .bind(&session.session_id)
                .execute(self.pool.as_ref())
                .await
                .context("Failed to persist MelonLoader metadata for telemetry session")?;
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

        let rules = self.load_mod_rules().await?;
        let mut events = Vec::new();
        for line in lines {
            if should_ignore_telemetry_line(&line.content) {
                continue;
            }
            let severity = line
                .level
                .unwrap_or_else(|| "INFO".to_string())
                .to_ascii_uppercase();
            if !matches!(severity.as_str(), "WARN" | "WARNING" | "ERROR" | "FATAL") {
                continue;
            }
            let sanitized = truncate_excerpt(&LoggerService::sanitize_log_text(&line.content));
            let (error_class, error_code) = error_identity(&sanitized);
            let mod_name = line.mod_tag.clone();
            let matching_mod = mod_name.as_ref().and_then(|name| {
                session
                    .mods
                    .iter()
                    .find(|entry| names_match(&entry.name, name))
            });
            if matching_mod.is_some_and(|entry| {
                effective_capture_mode(entry, &session.environment_id, preferences, &rules)
                    == TelemetryModCaptureMode::Ignore
            }) {
                continue;
            }
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
                error_class,
                error_code,
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
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_sessions WHERE environment_id = ? AND ended_at IS NOT NULL ORDER BY started_at ASC")
                .bind(environment_id).fetch_all(self.pool.as_ref()).await?
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT data FROM telemetry_sessions WHERE ended_at IS NOT NULL ORDER BY started_at ASC",
            )
            .fetch_all(self.pool.as_ref())
            .await?
        };
        self.export_session_rows(session_rows).await
    }

    pub async fn export_live_session(&self, session_id: &str) -> Result<LiveTelemetryExport> {
        let session_rows = sqlx::query_scalar::<_, String>(
            "SELECT data FROM telemetry_sessions WHERE id = ? AND ended_at IS NOT NULL",
        )
        .bind(session_id)
        .fetch_all(self.pool.as_ref())
        .await?;
        self.export_session_rows(session_rows).await
    }

    pub async fn export_shareable_live_history(
        &self,
        environment_id: Option<String>,
    ) -> Result<ShareableTelemetryExport> {
        let export = self.export_live_history(environment_id).await?;
        self.filter_export_for_upload(export).await
    }

    pub async fn export_shareable_live_session(
        &self,
        session_id: &str,
    ) -> Result<ShareableTelemetryExport> {
        let export = self.export_live_session(session_id).await?;
        self.filter_export_for_upload(export).await
    }

    async fn filter_export_for_upload(
        &self,
        mut export: LiveTelemetryExport,
    ) -> Result<ShareableTelemetryExport> {
        let preferences = self.get_preferences().await?;
        let rules = self.load_mod_rules().await?;
        let session_environment_ids = sqlx::query_as::<_, (String, String)>(
            "SELECT id, environment_id FROM telemetry_sessions",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to resolve telemetry session environments")?
        .into_iter()
        .collect::<HashMap<_, _>>();
        let mut excluded_mods = HashSet::new();
        let mut excluded_event_count = 0;
        let mut excluded_session_count = 0;
        let mut shareable_sessions = Vec::with_capacity(export.sessions.len());

        for mut session in export.sessions.drain(..) {
            let session_environment_id = session_environment_ids
                .get(&session.session_id)
                .map(String::as_str)
                .unwrap_or_default();
            let all_session_mods = session.mods.clone();
            let protected_mod_keys = session
                .mods
                .iter()
                .filter(|entry| {
                    effective_capture_mode(entry, session_environment_id, &preferences, &rules)
                        != TelemetryModCaptureMode::Share
                })
                .map(|entry| entry.mod_key.clone())
                .collect::<HashSet<_>>();
            excluded_mods.extend(protected_mod_keys.iter().cloned());
            session
                .mods
                .retain(|entry| !protected_mod_keys.contains(&entry.mod_key));

            let initial_event_count = session.events.len();
            session.events.retain(|event| {
                event_capture_mode(
                    event,
                    &all_session_mods,
                    session_environment_id,
                    &preferences,
                    &rules,
                ) == TelemetryModCaptureMode::Share
            });
            excluded_event_count += initial_event_count.saturating_sub(session.events.len());

            if session.mods.is_empty() && session.events.is_empty() {
                excluded_session_count += 1;
            } else {
                shareable_sessions.push(session);
            }
        }
        export.sessions = shareable_sessions;

        Ok(ShareableTelemetryExport {
            export,
            excluded_mod_count: excluded_mods.len(),
            excluded_event_count,
            excluded_session_count,
        })
    }

    pub async fn list_mod_policies(
        &self,
        environment_id: &str,
    ) -> Result<Vec<TelemetryModPolicyItem>> {
        let environment = EnvironmentService::new(self.pool.clone())?
            .get_environment(environment_id)
            .await?
            .ok_or_else(|| anyhow!("Environment not found"))?;
        let raw_mods = ModsService::new(self.pool.clone())
            .list_mods(&environment.output_dir)
            .await
            .context("Failed to list installed mods for telemetry rules")?;
        let preferences = self.get_preferences().await?;
        let rules = self.load_mod_rules().await?;

        Ok(self
            .telemetry_mods_from_value(raw_mods)?
            .into_iter()
            .map(|mod_entry| {
                let automatic_mode = automatic_capture_mode(&mod_entry, &preferences);
                let automatic_reason = automatic_capture_reason(&mod_entry, &preferences);
                let global_override = rules.global.get(&mod_entry.mod_key).copied();
                let environment_override = rules
                    .environment
                    .get(&(environment_id.to_string(), mod_entry.mod_key.clone()))
                    .copied();
                let effective_mode = environment_override
                    .or(global_override)
                    .unwrap_or(automatic_mode);
                TelemetryModPolicyItem {
                    mod_entry,
                    automatic_mode,
                    automatic_reason,
                    effective_mode,
                    global_override,
                    environment_override,
                }
            })
            .collect())
    }

    pub async fn save_mod_rule(&self, update: TelemetryModRuleUpdate) -> Result<()> {
        let mod_key = update.mod_key.trim();
        if mod_key.is_empty() {
            return Err(anyhow!("A telemetry mod rule needs a mod identifier"));
        }
        let environment_id = update.environment_id.unwrap_or_default();
        if let Some(mode) = update.mode {
            let now = Utc::now().to_rfc3339();
            sqlx::query(
                "INSERT INTO telemetry_mod_rules (id, mod_key, environment_id, mode, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(mod_key, environment_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at",
            )
            .bind(format!("telemetry-rule-{}", Uuid::new_v4().simple()))
            .bind(mod_key)
            .bind(&environment_id)
            .bind(telemetry_capture_mode_value(mode))
            .bind(&now)
            .bind(&now)
            .execute(self.pool.as_ref())
            .await
            .context("Failed to save telemetry mod rule")?;
        } else {
            sqlx::query("DELETE FROM telemetry_mod_rules WHERE mod_key = ? AND environment_id = ?")
                .bind(mod_key)
                .bind(environment_id)
                .execute(self.pool.as_ref())
                .await
                .context("Failed to remove telemetry mod rule")?;
        }
        Ok(())
    }

    async fn load_mod_rules(&self) -> Result<TelemetryModRules> {
        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT mod_key, environment_id, mode FROM telemetry_mod_rules",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to load telemetry mod rules")?;
        let mut rules = TelemetryModRules::default();
        for (mod_key, environment_id, mode) in rows {
            let mode = parse_telemetry_capture_mode(&mode)?;
            if environment_id.is_empty() {
                rules.global.insert(mod_key, mode);
            } else {
                rules.environment.insert((environment_id, mod_key), mode);
            }
        }
        Ok(rules)
    }

    async fn export_session_rows(&self, session_rows: Vec<String>) -> Result<LiveTelemetryExport> {
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
                        event_id: event.event_id,
                        occurred_at: event.occurred_at,
                        severity: event.severity,
                        attribution: event.attribution,
                        mod_key: event.mod_key,
                        mod_name: event.mod_name,
                        fingerprint: event.fingerprint,
                        error_class: if event.error_class.trim().is_empty() {
                            "unclassified".to_string()
                        } else {
                            event.error_class
                        },
                        error_code: event.error_code,
                        message: event.message,
                        source: event.source,
                        line_number: event.line_number,
                        origin: event.origin,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            sessions.push(LiveTelemetryExportSession {
                session_id: session.session_id,
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
            if should_ignore_telemetry_line(&line.content) {
                continue;
            }
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
            let sanitized = truncate_excerpt(&LoggerService::sanitize_log_text(&line.content));
            let (error_class, error_code) = error_identity(&sanitized);

            errors.push(ModTelemetrySourceError {
                mod_key,
                mod_name,
                level: normalized_level,
                error_class,
                error_code,
                message: include_excerpts.then_some(sanitized),
                timestamp: line.timestamp,
                source: Some("Latest.log".to_string()),
                line_number: Some(line.line_number as u32),
            });
        }

        Ok(errors)
    }
}

fn telemetry_capture_mode_value(mode: TelemetryModCaptureMode) -> &'static str {
    match mode {
        TelemetryModCaptureMode::Share => "share",
        TelemetryModCaptureMode::LocalOnly => "local_only",
        TelemetryModCaptureMode::Ignore => "ignore",
    }
}

fn parse_telemetry_capture_mode(value: &str) -> Result<TelemetryModCaptureMode> {
    match value {
        "share" => Ok(TelemetryModCaptureMode::Share),
        "local_only" => Ok(TelemetryModCaptureMode::LocalOnly),
        "ignore" => Ok(TelemetryModCaptureMode::Ignore),
        _ => Err(anyhow!("Unknown telemetry mod capture mode")),
    }
}

fn automatic_capture_mode(
    entry: &ModTelemetryModEntry,
    preferences: &TelemetryPreferences,
) -> TelemetryModCaptureMode {
    if preferences.protect_local_mods
        && (matches!(&entry.source, Some(ModSource::Local)) || !entry.managed)
    {
        TelemetryModCaptureMode::LocalOnly
    } else {
        TelemetryModCaptureMode::Share
    }
}

fn automatic_capture_reason(
    entry: &ModTelemetryModEntry,
    preferences: &TelemetryPreferences,
) -> Option<String> {
    if preferences.protect_local_mods
        && (matches!(&entry.source, Some(ModSource::Local)) || !entry.managed)
    {
        Some("Locally sourced or unmanaged mods stay on this device by default.".to_string())
    } else {
        None
    }
}

fn effective_capture_mode(
    entry: &ModTelemetryModEntry,
    environment_id: &str,
    preferences: &TelemetryPreferences,
    rules: &TelemetryModRules,
) -> TelemetryModCaptureMode {
    rules
        .environment
        .get(&(environment_id.to_string(), entry.mod_key.clone()))
        .copied()
        .or_else(|| rules.global.get(&entry.mod_key).copied())
        .unwrap_or_else(|| automatic_capture_mode(entry, preferences))
}

fn event_capture_mode(
    event: &LiveTelemetryExportEvent,
    session_mods: &[ModTelemetryModEntry],
    environment_id: &str,
    preferences: &TelemetryPreferences,
    rules: &TelemetryModRules,
) -> TelemetryModCaptureMode {
    let matched_mod = event
        .mod_key
        .as_ref()
        .and_then(|mod_key| session_mods.iter().find(|entry| entry.mod_key == *mod_key))
        .or_else(|| {
            event.mod_name.as_ref().and_then(|name| {
                session_mods
                    .iter()
                    .find(|entry| names_match(&entry.name, name))
            })
        });
    matched_mod
        .map(|entry| effective_capture_mode(entry, environment_id, preferences, rules))
        .unwrap_or(TelemetryModCaptureMode::Share)
}

fn should_ignore_telemetry_line(content: &str) -> bool {
    KNOWN_IL2CPP_INTEROP_WARNING_PATTERN.is_match(content)
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

fn normalize_mod_file_name(value: &str) -> String {
    value
        .rsplit(|character| matches!(character, '\\' | '/'))
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches(['\'', '"'])
        .trim_end_matches(".dll")
        .trim_end_matches(".DLL")
        .to_ascii_lowercase()
}

fn melonloader_mod_metadata(lines: &[LogLine]) -> HashMap<String, MelonLoaderModMetadata> {
    let mut metadata_by_file = HashMap::new();
    let mut pending = None::<PendingMelonLoaderMetadata>;

    for line in lines {
        let content = line.content.trim();
        if is_melonloader_separator(content) {
            pending = None;
            continue;
        }

        if let Some(captures) = MELON_MOD_VERSION_PATTERN.captures(content) {
            pending = Some(PendingMelonLoaderMetadata {
                version: captures["version"].to_string(),
                author: None,
            });
            continue;
        }

        if let (Some(pending_metadata), Some(captures)) =
            (pending.as_mut(), MELON_MOD_AUTHOR_PATTERN.captures(content))
        {
            pending_metadata.author = Some(captures["author"].trim().to_string());
            continue;
        }

        if let (Some(pending_metadata), Some(captures)) =
            (pending.take(), MELON_MOD_ASSEMBLY_PATTERN.captures(content))
        {
            metadata_by_file.insert(
                normalize_mod_file_name(&captures["file"]),
                MelonLoaderModMetadata {
                    version: Some(pending_metadata.version),
                    author: pending_metadata.author,
                },
            );
        }
    }

    metadata_by_file
}

fn is_melonloader_separator(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|character| character == '-')
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
    use crate::services::logs::LogCategory;
    use crate::test_helpers::EnvVarGuard;
    use crate::types::Runtime;
    use serial_test::serial;

    #[test]
    fn telemetry_feature_flag_requires_an_explicit_opt_in() {
        assert!(!telemetry_feature_enabled_from_value(None));
        assert!(!telemetry_feature_enabled_from_value(Some("")));
        assert!(!telemetry_feature_enabled_from_value(Some("false")));
        assert!(telemetry_feature_enabled_from_value(Some("1")));
        assert!(telemetry_feature_enabled_from_value(Some(" true ")));
    }

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
        assert!(preferences.protect_local_mods);
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
                protect_local_mods: None,
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
                protect_local_mods: None,
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
    fn error_identity_retains_exception_class_and_optional_code_without_excerpt_text() {
        assert_eq!(
            error_identity("NullReferenceException while loading slot 42 (0x80131500)"),
            (
                "NullReferenceException".to_string(),
                Some("0X80131500".to_string())
            )
        );
        assert_eq!(
            error_identity("ordinary error line"),
            ("unclassified".to_string(), None)
        );
    }

    #[test]
    fn ignores_the_known_melonloader_il2cppinterop_signature_warning() {
        assert!(should_ignore_telemetry_line(
            "[Il2CppInterop] Class::Init signatures have been exhausted, using a substitute!"
        ));
        assert!(!should_ignore_telemetry_line(
            "[Il2CppInterop] Could not initialize a custom native type"
        ));
    }

    #[test]
    fn local_or_unmanaged_mods_default_to_local_only_but_can_be_shared() {
        let local_mod = ModTelemetryModEntry {
            mod_key: "mod-local".to_string(),
            name: "Development Mod".to_string(),
            file_name: "Development.Mod.dll".to_string(),
            version: None,
            source: Some(ModSource::Local),
            author: None,
            managed: false,
            disabled: false,
        };
        assert_eq!(
            automatic_capture_mode(&local_mod, &TelemetryPreferences::default()),
            TelemetryModCaptureMode::LocalOnly
        );
        let preferences = TelemetryPreferences {
            protect_local_mods: false,
            ..TelemetryPreferences::default()
        };
        assert_eq!(
            automatic_capture_mode(&local_mod, &preferences),
            TelemetryModCaptureMode::Share
        );
    }

    #[tokio::test]
    #[serial]
    async fn locally_sourced_mod_events_are_removed_from_the_public_export() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let _guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let service = TelemetryService::new(pool.clone());
        let environment_id = "development-environment";
        let session_id = "development-session";
        sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
            .bind(environment_id)
            .bind("C:\\telemetry-test")
            .bind("{}")
            .execute(pool.as_ref())
            .await?;
        sqlx::query(
            "INSERT INTO telemetry_sessions (id, environment_id, started_at, ended_at, data) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(environment_id)
        .bind("2026-07-28T00:00:00Z")
        .bind("2026-07-28T00:01:00Z")
        .bind("{}")
        .execute(pool.as_ref())
        .await?;

        let local_mod = ModTelemetryModEntry {
            mod_key: "mod-development".to_string(),
            name: "Development Mod".to_string(),
            file_name: "Development.Mod.dll".to_string(),
            version: None,
            source: Some(ModSource::Local),
            author: None,
            managed: false,
            disabled: false,
        };
        let export = LiveTelemetryExport {
            schema_version: LIVE_TELEMETRY_SCHEMA_VERSION,
            exported_at: "2026-07-28T00:01:00Z".to_string(),
            sessions: vec![LiveTelemetryExportSession {
                session_id: session_id.to_string(),
                started_at: "2026-07-28T00:00:00Z".to_string(),
                ended_at: Some("2026-07-28T00:01:00Z".to_string()),
                environment: ModTelemetryEnvironment {
                    app_id: "3164500".to_string(),
                    branch: "main".to_string(),
                    runtime: Runtime::Il2cpp,
                    s1_version: None,
                },
                mods: vec![local_mod.clone()],
                events: vec![LiveTelemetryExportEvent {
                    event_id: "local-event".to_string(),
                    occurred_at: "2026-07-28T00:00:30Z".to_string(),
                    severity: "WARN".to_string(),
                    attribution: "mod".to_string(),
                    mod_key: Some(local_mod.mod_key),
                    mod_name: Some(local_mod.name),
                    fingerprint: "sig-local".to_string(),
                    error_class: "unclassified".to_string(),
                    error_code: None,
                    message: None,
                    source: "Latest.log".to_string(),
                    line_number: Some(1),
                    origin: "live".to_string(),
                }],
            }],
        };

        let filtered = service.filter_export_for_upload(export).await?;
        assert!(filtered.export.sessions.is_empty());
        assert_eq!(filtered.excluded_mod_count, 1);
        assert_eq!(filtered.excluded_event_count, 1);
        assert_eq!(filtered.excluded_session_count, 1);

        Ok(())
    }

    #[test]
    fn melonloader_metadata_links_version_and_author_to_the_assembly() {
        let lines = vec![
            telemetry_log_line("------------------------------"),
            telemetry_log_line("Example Mod v1.2.3-beta.4"),
            telemetry_log_line("by Example Creator"),
            telemetry_log_line("Assembly: Example-Mod.Mono.dll"),
            telemetry_log_line("------------------------------"),
        ];

        let metadata = melonloader_mod_metadata(&lines);
        let entry = metadata
            .get(&normalize_mod_file_name("Example-Mod.Mono.dll"))
            .expect("metadata should be keyed by the emitted assembly file name");

        assert_eq!(entry.version.as_deref(), Some("1.2.3-beta.4"));
        assert_eq!(entry.author.as_deref(), Some("Example Creator"));
    }

    #[tokio::test]
    #[serial]
    async fn startup_log_metadata_only_fills_missing_session_values() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let _guard = EnvVarGuard::set(
            "SIMMRUST_DATA_DIR",
            temp.path().join("simmrust").to_string_lossy().as_ref(),
        );
        let pool = initialize_pool().await?;
        let service = TelemetryService::new(pool.clone());
        let mut session = LiveTelemetrySession {
            session_id: "session-melonloader-metadata".to_string(),
            environment_id: "environment-melonloader-metadata".to_string(),
            started_at: "2026-07-25T00:00:00Z".to_string(),
            ended_at: None,
            environment: ModTelemetryEnvironment {
                app_id: "3164500".to_string(),
                branch: "main".to_string(),
                runtime: Runtime::Mono,
                s1_version: None,
            },
            mods: vec![
                ModTelemetryModEntry {
                    mod_key: "mod-missing".to_string(),
                    name: "Example Mod".to_string(),
                    file_name: "Example-Mod.Mono.dll".to_string(),
                    version: None,
                    source: None,
                    author: None,
                    managed: false,
                    disabled: false,
                },
                ModTelemetryModEntry {
                    mod_key: "mod-explicit".to_string(),
                    name: "Explicit Mod".to_string(),
                    file_name: "Explicit-Mod.dll".to_string(),
                    version: Some("9.9.9".to_string()),
                    source: None,
                    author: Some("Explicit Creator".to_string()),
                    managed: false,
                    disabled: false,
                },
            ],
            monitoring: true,
        };
        sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
            .bind(&session.environment_id)
            .bind("C:\\telemetry-test")
            .bind("{}")
            .execute(pool.as_ref())
            .await?;
        sqlx::query(
            "INSERT INTO telemetry_sessions (id, environment_id, started_at, ended_at, data) VALUES (?, ?, ?, NULL, ?)",
        )
        .bind(&session.session_id)
        .bind(&session.environment_id)
        .bind(&session.started_at)
        .bind(serde_json::to_string(&session)?)
        .execute(pool.as_ref())
        .await?;

        service
            .enrich_live_session_mod_metadata(
                &mut session,
                &[
                    telemetry_log_line("Example Mod v1.2.3"),
                    telemetry_log_line("by Example Creator"),
                    telemetry_log_line("Assembly: Example-Mod.Mono.dll"),
                    telemetry_log_line("Explicit Mod v2.0.0"),
                    telemetry_log_line("by Different Creator"),
                    telemetry_log_line("Assembly: Explicit-Mod.dll"),
                ],
            )
            .await?;

        assert_eq!(session.mods[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(session.mods[0].author.as_deref(), Some("Example Creator"));
        assert_eq!(session.mods[1].version.as_deref(), Some("9.9.9"));
        assert_eq!(session.mods[1].author.as_deref(), Some("Explicit Creator"));

        let stored =
            sqlx::query_scalar::<_, String>("SELECT data FROM telemetry_sessions WHERE id = ?")
                .bind(&session.session_id)
                .fetch_one(pool.as_ref())
                .await?;
        let persisted: LiveTelemetrySession = serde_json::from_str(&stored)?;
        assert_eq!(persisted.mods[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(persisted.mods[0].author.as_deref(), Some("Example Creator"));

        Ok(())
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

    fn telemetry_log_line(content: &str) -> LogLine {
        LogLine {
            line_number: 1,
            content: content.to_string(),
            level: None,
            timestamp: None,
            mod_tag: None,
            category: LogCategory::MelonLoader,
        }
    }
}

fn error_identity(sanitized: &str) -> (String, Option<String>) {
    let error_class = ERROR_CLASS_PATTERN
        .captures(sanitized)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_string())
        .unwrap_or_else(|| "unclassified".to_string());
    let error_code = ERROR_CODE_PATTERN
        .captures(sanitized)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_ascii_uppercase());
    (error_class, error_code)
}
