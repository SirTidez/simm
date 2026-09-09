use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::config::telemetry_upload::{upload_base_url, validate_upload_base_url};
use crate::services::telemetry::{ensure_telemetry_feature_enabled, TelemetryService};
use crate::types::{
    TelemetryUploadEnvelope, TelemetryUploadPreview, TelemetryUploadReceipt, TelemetryUploadState,
};

const UPLOAD_PATH: &str = "/v1/telemetry/batches";
const TELEMETRY_SCHEMA_VERSION: u32 = 1;

pub struct TelemetryUploadService {
    pool: Arc<SqlitePool>,
    client: reqwest::Client,
    base_url: Option<String>,
}

impl TelemetryUploadService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self {
            pool,
            client: reqwest::Client::new(),
            base_url: None,
        }
    }

    #[cfg(test)]
    pub fn with_base_url(pool: Arc<SqlitePool>, base_url: String) -> Self {
        Self {
            pool,
            client: reqwest::Client::new(),
            base_url: Some(base_url),
        }
    }

    pub async fn preview_upload(
        &self,
        environment_id: Option<String>,
    ) -> Result<TelemetryUploadPreview> {
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled {
            return Err(anyhow!(
                "Telemetry collection is disabled. Enable collection before reviewing an upload."
            ));
        }

        let export = TelemetryService::new(self.pool.clone())
            .export_shareable_live_history(environment_id)
            .await?;
        self.preview_export(export, &preferences)
    }

    pub async fn queue_finished_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TelemetryUploadReceipt>> {
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Ok(None);
        }
        let export = TelemetryService::new(self.pool.clone())
            .export_shareable_live_session(session_id)
            .await?;
        let preview = self.preview_export(export, &preferences)?;
        if preview.session_count == 0 {
            return Ok(None);
        }

        self.queue_reviewed_upload_internal(&preview.payload).await
    }

    async fn queue_unqueued_finished_sessions(&self) -> Result<()> {
        let session_ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM telemetry_sessions WHERE ended_at IS NOT NULL ORDER BY ended_at ASC",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to load completed telemetry sessions")?;

        for session_id in session_ids {
            self.queue_finished_session(&session_id).await?;
        }
        Ok(())
    }

    async fn session_is_already_queued(&self, session_id: &str) -> Result<bool> {
        let claimed = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM telemetry_upload_sessions WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_one(self.pool.as_ref())
        .await
        .context("Failed to check telemetry session upload claim")?;
        if claimed > 0 {
            return Ok(true);
        }

        // Keep the payload scan for queues created before upload-scoped IDs and
        // the session claim table were introduced.
        let payloads =
            sqlx::query_scalar::<_, String>("SELECT payload FROM telemetry_upload_queue")
                .fetch_all(self.pool.as_ref())
                .await
                .context("Failed to load queued telemetry payloads")?;

        Ok(payloads.into_iter().any(|payload| {
            serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .is_some_and(|envelope| {
                    envelope["sessions"].as_array().is_some_and(|sessions| {
                        sessions
                            .iter()
                            .any(|session| session["sessionId"].as_str() == Some(session_id))
                    })
                })
        }))
    }

    fn preview_export(
        &self,
        filtered_export: crate::services::telemetry::ShareableTelemetryExport,
        preferences: &crate::types::TelemetryPreferences,
    ) -> Result<TelemetryUploadPreview> {
        let mut export = filtered_export.export;
        if !preferences.error_excerpts_enabled {
            for session in &mut export.sessions {
                for event in &mut session.events {
                    event.message = None;
                }
            }
        }
        let session_count = export.sessions.len() as u64;
        let event_count = export
            .sessions
            .iter()
            .map(|session| session.events.len() as u64)
            .sum();
        let mut envelope = TelemetryUploadEnvelope {
            schema_version: TELEMETRY_SCHEMA_VERSION,
            upload_id: Uuid::new_v4().to_string(),
            exported_at: export.exported_at,
            diagnostic_text_consent: preferences.error_excerpts_enabled,
            sessions: export.sessions,
        };
        normalize_upload_envelope_timestamps(&mut envelope)?;
        rekey_upload_envelope_identities(&mut envelope);
        ensure_upload_envelope_is_safe(&envelope)?;
        let payload = serde_json::to_string_pretty(&envelope)
            .context("Failed to serialize the local telemetry upload preview")?;

        Ok(TelemetryUploadPreview {
            upload_id: envelope.upload_id,
            payload,
            session_count,
            event_count,
            exclusions: {
                let mut exclusions = vec![
                    "Active sessions are excluded.".to_string(),
                    "Local environment IDs and filesystem paths are excluded.".to_string(),
                    "No SIMM, Nexus Mods, Steam, or other account identifiers are included."
                        .to_string(),
                ];
                if filtered_export.excluded_mod_count > 0 {
                    exclusions.push(format!(
                        "{} mod entr{} excluded by your development-data rules.",
                        filtered_export.excluded_mod_count,
                        if filtered_export.excluded_mod_count == 1 {
                            "y was"
                        } else {
                            "ies were"
                        },
                    ));
                }
                if filtered_export.excluded_event_count > 0 {
                    exclusions.push(format!(
                        "{} warning{} or error{} excluded by your development-data rules.",
                        filtered_export.excluded_event_count,
                        if filtered_export.excluded_event_count == 1 {
                            ""
                        } else {
                            "s"
                        },
                        if filtered_export.excluded_event_count == 1 {
                            " was"
                        } else {
                            "s were"
                        },
                    ));
                }
                if filtered_export.excluded_session_count > 0 {
                    exclusions.push(format!(
                        "{} completed session{} contained only excluded data and will not be uploaded.",
                        filtered_export.excluded_session_count,
                        if filtered_export.excluded_session_count == 1 { "" } else { "s" },
                    ));
                }
                exclusions
            },
        })
    }

    /// Pending payloads are rebuilt after the privacy policy changes. Accepted uploads are
    /// immutable receipts, and an in-flight upload is left alone to avoid racing the sender.
    pub async fn discard_unaccepted_uploads(&self) -> Result<u64> {
        let result =
            sqlx::query("DELETE FROM telemetry_upload_queue WHERE state IN ('pending', 'failed')")
                .execute(self.pool.as_ref())
                .await
                .context("Failed to discard queued telemetry uploads after rule changes")?;
        Ok(result.rows_affected())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn queue_upload(
        &self,
        environment_id: Option<String>,
    ) -> Result<TelemetryUploadReceipt> {
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be queued"
            ));
        }
        let preview = self.preview_upload(environment_id).await?;
        self.queue_reviewed_upload(&preview.payload).await
    }

    pub async fn queue_reviewed_upload(
        &self,
        preview_payload: &str,
    ) -> Result<TelemetryUploadReceipt> {
        self.queue_reviewed_upload_internal(preview_payload)
            .await?
            .ok_or_else(|| anyhow!("One or more telemetry sessions are already queued"))
    }

    async fn queue_reviewed_upload_internal(
        &self,
        preview_payload: &str,
    ) -> Result<Option<TelemetryUploadReceipt>> {
        let raw_payload = serde_json::from_str::<serde_json::Value>(preview_payload)
            .context("The reviewed telemetry payload is invalid")?;
        if has_unsafe_upload_value(&raw_payload) {
            return Err(anyhow!(
                "Telemetry upload preview contains a local identifier or path"
            ));
        }
        let mut envelope = serde_json::from_value::<TelemetryUploadEnvelope>(raw_payload.clone())
            .context("The reviewed telemetry payload is invalid")?;
        if raw_payload != serde_json::to_value(&envelope)? {
            return Err(anyhow!(
                "The reviewed telemetry payload contains unsupported fields"
            ));
        }
        ensure_upload_envelope_is_safe(&envelope)?;
        if self
            .upload_id_is_already_queued(&envelope.upload_id)
            .await?
        {
            return Ok(None);
        }
        let (session_ids, contains_local_identities) =
            self.resolve_durably_ended_session_ids(&envelope).await?;

        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be queued"
            ));
        }
        if envelope.diagnostic_text_consent && !preferences.error_excerpts_enabled {
            return Err(anyhow!(
                "Readable diagnostic excerpts must remain enabled to upload this preview"
            ));
        }

        for session_id in &session_ids {
            if self.session_is_already_queued(session_id).await? {
                return Ok(None);
            }
        }

        // Older/manual payloads may still contain local database IDs. Rekey
        // them before persistence; previews produced by this version are
        // already upload-scoped and remain byte-identical through retries.
        let queued_payload = if contains_local_identities {
            rekey_upload_envelope_identities(&mut envelope);
            serde_json::to_string_pretty(&envelope)
                .context("Failed to serialize the anonymous telemetry upload")?
        } else {
            preview_payload.to_string()
        };

        let upload = UploadRecord {
            id: format!("telemetry-upload-{}", Uuid::new_v4().simple()),
            upload_id: envelope.upload_id,
            payload: queued_payload,
            state: TelemetryUploadState::Pending,
            attempts: 0,
            last_error_code: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        if !self.insert_upload(&upload, &session_ids).await? {
            return Ok(None);
        }
        upload.into_receipt().map(Some)
    }

    /// A renderer-supplied review payload is never sufficient proof that a
    /// session ended. Each referenced session must still exist locally with a
    /// committed end timestamp before it becomes queue-eligible.
    async fn upload_id_is_already_queued(&self, upload_id: &str) -> Result<bool> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM telemetry_upload_queue WHERE upload_id = ?",
        )
        .bind(upload_id)
        .fetch_one(self.pool.as_ref())
        .await
        .context("Failed to check telemetry upload identity")?;
        Ok(count > 0)
    }

    async fn resolve_durably_ended_session_ids(
        &self,
        envelope: &TelemetryUploadEnvelope,
    ) -> Result<(Vec<String>, bool)> {
        let ended_session_ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM telemetry_sessions WHERE ended_at IS NOT NULL",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to load completed telemetry sessions")?;
        let mut resolved = Vec::with_capacity(envelope.sessions.len());
        let mut contains_local_identities = false;
        for session in &envelope.sessions {
            let (local_id, local_session_identity) =
                if ended_session_ids.iter().any(|id| id == &session.session_id) {
                    (session.session_id.clone(), true)
                } else if let Some(local_id) = ended_session_ids.iter().find(|local_id| {
                    upload_scoped_identity("session", &envelope.upload_id, local_id)
                        == session.session_id
                }) {
                    (local_id.clone(), false)
                } else {
                    return Err(anyhow!(
                        "Telemetry session {} is not durably ended and cannot be queued",
                        session.session_id
                    ));
                };
            contains_local_identities |= local_session_identity;

            let local_event_ids = sqlx::query_scalar::<_, String>(
                "SELECT id FROM telemetry_events WHERE session_id = ?",
            )
            .bind(&local_id)
            .fetch_all(self.pool.as_ref())
            .await
            .context("Failed to verify telemetry upload event identities")?;
            for event in &session.events {
                if local_event_ids.iter().any(|id| id == &event.event_id) {
                    contains_local_identities = true;
                    continue;
                }
                if !local_event_ids.iter().any(|local_event_id| {
                    upload_scoped_identity("event", &envelope.upload_id, local_event_id)
                        == event.event_id
                }) {
                    return Err(anyhow!(
                        "Telemetry event {} is not part of the reviewed local session",
                        event.event_id
                    ));
                }
            }

            resolved.push(local_id);
        }
        Ok((resolved, contains_local_identities))
    }

    pub async fn retry_upload(&self, id: &str) -> Result<TelemetryUploadReceipt> {
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be retried"
            ));
        }
        self.send_upload(id).await
    }

    pub async fn flush_queued_uploads(&self) -> Result<Vec<TelemetryUploadReceipt>> {
        // Update checks call this service directly, bypassing the Tauri command
        // boundary. Keep the runtime flag at the send boundary so queued data
        // cannot leave the device unless telemetry was explicitly enabled.
        ensure_telemetry_feature_enabled()?;

        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Ok(Vec::new());
        }

        self.queue_unqueued_finished_sessions().await?;
        self.recover_interrupted_uploads().await?;
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM telemetry_upload_queue \
             WHERE state IN ('pending', 'failed') ORDER BY created_at ASC",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to load queued telemetry uploads")?;

        let mut receipts = Vec::with_capacity(ids.len());
        for id in ids {
            receipts.push(self.send_upload(&id).await?);
        }
        Ok(receipts)
    }

    pub async fn list_uploads(&self) -> Result<Vec<TelemetryUploadReceipt>> {
        self.recover_interrupted_uploads().await?;
        let rows = sqlx::query_as::<_, UploadRow>(
            "SELECT id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at \
             FROM telemetry_upload_queue ORDER BY created_at DESC",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to list telemetry upload queue")?;
        rows.into_iter()
            .map(UploadRow::into_record)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .map(UploadRecord::into_receipt)
            .collect()
    }

    async fn insert_upload(&self, upload: &UploadRecord, session_ids: &[String]) -> Result<bool> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("Failed to begin telemetry upload queue transaction")?;
        sqlx::query(
            "INSERT INTO telemetry_upload_queue \
             (id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&upload.id)
        .bind(&upload.upload_id)
        .bind(&upload.payload)
        .bind(upload.state.as_db_value())
        .bind(upload.attempts as i64)
        .bind(&upload.last_error_code)
        .bind(&upload.created_at)
        .bind(&upload.updated_at)
        .execute(&mut *transaction)
        .await
        .context("Failed to queue telemetry upload")?;

        for session_id in session_ids {
            let claimed = sqlx::query(
                "INSERT OR IGNORE INTO telemetry_upload_sessions (session_id, queue_id) VALUES (?, ?)",
            )
            .bind(session_id)
            .bind(&upload.id)
            .execute(&mut *transaction)
            .await
            .context("Failed to claim telemetry session for upload")?;
            if claimed.rows_affected() != 1 {
                transaction.rollback().await?;
                return Ok(false);
            }
        }
        transaction
            .commit()
            .await
            .context("Failed to commit telemetry upload queue transaction")?;
        Ok(true)
    }

    async fn send_upload(&self, id: &str) -> Result<TelemetryUploadReceipt> {
        // `retry_upload` reaches this method directly, so this is the final
        // non-bypassable guard before a queued payload can leave the device.
        ensure_telemetry_feature_enabled()?;

        let receipt = self.get_upload(id).await?;
        if receipt.state == TelemetryUploadState::Accepted {
            return receipt.into_receipt();
        }

        // Preferences may change after a payload was reviewed and queued. Do
        // not rely on the queue-time check: this is the last local boundary
        // before the HTTP request is constructed.
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be sent"
            ));
        }
        let envelope: TelemetryUploadEnvelope = serde_json::from_str(&receipt.payload)
            .context("Queued telemetry payload is invalid")?;
        if envelope.diagnostic_text_consent && !preferences.error_excerpts_enabled {
            self.update_state(
                id,
                TelemetryUploadState::Failed,
                receipt.attempts,
                Some("diagnostic_text_consent_revoked".to_string()),
            )
            .await?;
            return self.get_upload(id).await?.into_receipt();
        }

        let base_url = match self.resolve_base_url() {
            Ok(base_url) => base_url,
            Err(_) => {
                self.update_state(
                    id,
                    TelemetryUploadState::Failed,
                    receipt.attempts,
                    Some("configuration_error".to_string()),
                )
                .await?;
                return self.get_upload(id).await?.into_receipt();
            }
        };
        let attempts = receipt.attempts.saturating_add(1);
        self.update_state(id, TelemetryUploadState::Sending, attempts, None)
            .await?;
        let request_url = format!("{base_url}{UPLOAD_PATH}");
        let result = self
            .client
            .post(request_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(receipt.payload.clone())
            .send()
            .await;

        match result {
            Ok(response) if response.status().is_success() => {
                self.update_state(id, TelemetryUploadState::Accepted, attempts, None)
                    .await?;
            }
            Ok(response) if response.status() == reqwest::StatusCode::CONFLICT => {
                self.update_state(
                    id,
                    TelemetryUploadState::Accepted,
                    attempts,
                    Some("already_accepted".to_string()),
                )
                .await?;
            }
            Ok(response) if response.status().is_server_error() => {
                self.update_state(
                    id,
                    TelemetryUploadState::Failed,
                    attempts,
                    Some("failed_before_acceptance".to_string()),
                )
                .await?;
            }
            Ok(response) => {
                self.update_state(
                    id,
                    TelemetryUploadState::Failed,
                    attempts,
                    Some(format!("rejected_http_{}", response.status().as_u16())),
                )
                .await?;
            }
            Err(_) => {
                self.update_state(
                    id,
                    TelemetryUploadState::Failed,
                    attempts,
                    Some("failed_before_acceptance".to_string()),
                )
                .await?;
            }
        }

        self.get_upload(id).await?.into_receipt()
    }

    fn resolve_base_url(&self) -> Result<String> {
        match &self.base_url {
            Some(base_url) => validate_upload_base_url(base_url),
            None => upload_base_url(),
        }
    }

    async fn recover_interrupted_uploads(&self) -> Result<()> {
        sqlx::query(
            "UPDATE telemetry_upload_queue SET state = 'failed', last_error_code = ?, updated_at = ? WHERE state = 'sending'",
        )
        .bind("failed_before_acceptance")
        .bind(Utc::now().to_rfc3339())
        .execute(self.pool.as_ref())
        .await
        .context("Failed to recover interrupted telemetry uploads")?;
        Ok(())
    }

    async fn get_upload(&self, id: &str) -> Result<UploadRecord> {
        let row = sqlx::query_as::<_, UploadRow>(
            "SELECT id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at \
             FROM telemetry_upload_queue WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to load telemetry upload")?
        .ok_or_else(|| anyhow!("Telemetry upload not found"))?;
        row.into_record()
    }

    async fn update_state(
        &self,
        id: &str,
        state: TelemetryUploadState,
        attempts: u32,
        last_error_code: Option<String>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE telemetry_upload_queue \
             SET state = ?, attempts = ?, last_error_code = ?, updated_at = ? WHERE id = ?",
        )
        .bind(state.as_db_value())
        .bind(attempts as i64)
        .bind(last_error_code)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to update telemetry upload state")?;
        Ok(())
    }
}

fn ensure_upload_envelope_is_safe(envelope: &TelemetryUploadEnvelope) -> Result<()> {
    validate_upload_envelope_timestamps(envelope)?;
    let value = serde_json::to_value(envelope)?;
    if has_unsafe_upload_value(&value) {
        return Err(anyhow!(
            "Telemetry upload preview contains a local identifier or path"
        ));
    }
    if !envelope.diagnostic_text_consent
        && envelope
            .sessions
            .iter()
            .flat_map(|session| &session.events)
            .any(|event| event.message.is_some())
    {
        return Err(anyhow!(
            "Telemetry upload contains readable diagnostics without consent"
        ));
    }
    Ok(())
}

pub(super) fn rekey_upload_envelope_identities(envelope: &mut TelemetryUploadEnvelope) {
    for session in &mut envelope.sessions {
        session.session_id =
            upload_scoped_identity("session", &envelope.upload_id, &session.session_id);
        for event in &mut session.events {
            event.event_id = upload_scoped_identity("event", &envelope.upload_id, &event.event_id);
        }
    }
}

fn upload_scoped_identity(prefix: &str, upload_id: &str, local_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"simm-telemetry-upload-identity-v1\0");
    hasher.update(prefix.as_bytes());
    hasher.update(b"\0");
    hasher.update(upload_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(local_id.as_bytes());
    let digest = hasher.finalize();
    format!("{prefix}-{}", hex::encode(&digest[..16]))
}

fn has_unsafe_upload_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => is_local_path(value),
        serde_json::Value::Array(values) => values.iter().any(has_unsafe_upload_value),
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "environmentId" | "accountId" | "userId" | "token" | "apiKey"
            ) || has_unsafe_upload_value(value)
        }),
        _ => false,
    }
}

pub(super) fn is_local_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("file://")
        || contains_windows_rooted_path(value)
        || contains_absolute_unix_path(value)
        || value.as_bytes().windows(3).any(|window| {
            window[0].is_ascii_alphabetic()
                && window[1] == b':'
                && matches!(window[2], b'\\' | b'/')
        })
}

fn contains_windows_rooted_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (0..bytes.len()).any(|index| {
        if bytes[index] != b'\\' {
            return false;
        }

        let at_boundary = index == 0
            || matches!(
                bytes[index - 1],
                b' ' | b'\t' | b'\r' | b'\n' | b'=' | b'(' | b'[' | b'{' | b'"' | b'\''
            );
        if !at_boundary {
            return false;
        }

        // UNC/device paths begin with two separators. A single leading
        // separator is a root-relative Windows path even when it has only one
        // component (for example \Windows).
        bytes.get(index + 1).is_some_and(|next| {
            *next == b'\\' || next.is_ascii_alphanumeric() || matches!(next, b'_' | b'.' | b'-')
        })
    })
}

fn contains_absolute_unix_path(value: &str) -> bool {
    value.char_indices().any(|(index, character)| {
        if character != '/' {
            return false;
        }

        let next_is_path_segment = value[index + character.len_utf8()..]
            .chars()
            .next()
            .is_some_and(|next| next.is_ascii_alphanumeric() || matches!(next, '_' | '.' | '-'));
        let previous_is_delimiter = value[..index].chars().next_back().map_or(true, |previous| {
            !previous.is_ascii_alphanumeric() && previous != '_'
        });

        next_is_path_segment && previous_is_delimiter
    })
}

pub(super) fn normalize_upload_envelope_timestamps(
    envelope: &mut TelemetryUploadEnvelope,
) -> Result<()> {
    envelope.exported_at = normalize_zulu_timestamp(&envelope.exported_at, "exportedAt")?;
    for session in &mut envelope.sessions {
        session.started_at = normalize_zulu_timestamp(&session.started_at, "startedAt")?;
        if let Some(ended_at) = &session.ended_at {
            session.ended_at = Some(normalize_zulu_timestamp(ended_at, "endedAt")?);
        }
        for event in &mut session.events {
            event.occurred_at = normalize_zulu_timestamp(&event.occurred_at, "occurredAt")?;
        }
    }
    Ok(())
}

fn validate_upload_envelope_timestamps(envelope: &TelemetryUploadEnvelope) -> Result<()> {
    validate_zulu_timestamp(&envelope.exported_at, "exportedAt")?;
    for session in &envelope.sessions {
        validate_zulu_timestamp(&session.started_at, "startedAt")?;
        if let Some(ended_at) = &session.ended_at {
            validate_zulu_timestamp(ended_at, "endedAt")?;
        }
        for event in &session.events {
            validate_zulu_timestamp(&event.occurred_at, "occurredAt")?;
        }
    }
    Ok(())
}

fn normalize_zulu_timestamp(value: &str, field: &str) -> Result<String> {
    DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("Telemetry upload {field} must be an ISO-8601 timestamp"))
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

fn validate_zulu_timestamp(value: &str, field: &str) -> Result<()> {
    let normalized = normalize_zulu_timestamp(value, field)?;
    if value != normalized {
        return Err(anyhow!(
            "Telemetry upload {field} must be canonical UTC milliseconds ending in Z"
        ));
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct UploadRow {
    id: String,
    upload_id: String,
    payload: String,
    state: String,
    attempts: i64,
    last_error_code: Option<String>,
    created_at: String,
    updated_at: String,
}

impl UploadRow {
    fn into_record(self) -> Result<UploadRecord> {
        let state = match self.state.as_str() {
            "pending" => TelemetryUploadState::Pending,
            "sending" => TelemetryUploadState::Sending,
            "accepted" => TelemetryUploadState::Accepted,
            "failed" => TelemetryUploadState::Failed,
            _ => return Err(anyhow!("Invalid telemetry upload queue state")),
        };
        Ok(UploadRecord {
            id: self.id,
            upload_id: self.upload_id,
            payload: self.payload,
            state,
            attempts: self.attempts.max(0) as u32,
            last_error_code: self.last_error_code,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// Private queue record: the serialized telemetry payload is only ever read
/// locally for transmission and is never included in renderer-facing DTOs.
struct UploadRecord {
    id: String,
    upload_id: String,
    payload: String,
    state: TelemetryUploadState,
    attempts: u32,
    last_error_code: Option<String>,
    created_at: String,
    updated_at: String,
}

impl UploadRecord {
    fn into_receipt(self) -> Result<TelemetryUploadReceipt> {
        Ok(TelemetryUploadReceipt {
            id: self.id,
            upload_id: self.upload_id,
            state: self.state,
            attempts: self.attempts,
            last_error_code: self.last_error_code,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl TelemetryUploadState {
    fn as_db_value(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Accepted => "accepted",
            Self::Failed => "failed",
        }
    }
}
