use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::config::telemetry_upload::{upload_base_url, validate_upload_base_url};
use crate::services::telemetry::TelemetryService;
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
            .export_live_history(environment_id)
            .await?;
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
            sessions: export.sessions,
        };
        normalize_upload_envelope_timestamps(&mut envelope)?;
        ensure_upload_envelope_is_safe(&envelope)?;
        let payload = serde_json::to_string_pretty(&envelope)
            .context("Failed to serialize the local telemetry upload preview")?;

        Ok(TelemetryUploadPreview {
            upload_id: envelope.upload_id,
            payload,
            session_count,
            event_count,
            exclusions: vec![
                "Active sessions are excluded.".to_string(),
                "Local environment IDs and filesystem paths are excluded.".to_string(),
                "No SIMM, Nexus Mods, Steam, or other account identifiers are included."
                    .to_string(),
            ],
        })
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
        let raw_payload = serde_json::from_str::<serde_json::Value>(preview_payload)
            .context("The reviewed telemetry payload is invalid")?;
        if has_unsafe_upload_value(&raw_payload) {
            return Err(anyhow!(
                "Telemetry upload preview contains a local identifier or path"
            ));
        }
        let envelope = serde_json::from_value::<TelemetryUploadEnvelope>(raw_payload.clone())
            .context("The reviewed telemetry payload is invalid")?;
        if raw_payload != serde_json::to_value(&envelope)? {
            return Err(anyhow!(
                "The reviewed telemetry payload contains unsupported fields"
            ));
        }
        ensure_upload_envelope_is_safe(&envelope)?;

        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be queued"
            ));
        }

        let receipt = TelemetryUploadReceipt {
            id: format!("telemetry-upload-{}", Uuid::new_v4().simple()),
            upload_id: envelope.upload_id,
            payload: preview_payload.to_string(),
            state: TelemetryUploadState::Pending,
            attempts: 0,
            last_error_code: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.insert_receipt(&receipt).await?;

        self.send_upload(&receipt.id).await
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

    pub async fn list_uploads(&self) -> Result<Vec<TelemetryUploadReceipt>> {
        self.recover_interrupted_uploads().await?;
        let rows = sqlx::query_as::<_, UploadRow>(
            "SELECT id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at \
             FROM telemetry_upload_queue ORDER BY created_at DESC",
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to list telemetry upload queue")?;
        rows.into_iter().map(UploadRow::into_receipt).collect()
    }

    async fn insert_receipt(&self, receipt: &TelemetryUploadReceipt) -> Result<()> {
        sqlx::query(
            "INSERT INTO telemetry_upload_queue \
             (id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&receipt.id)
        .bind(&receipt.upload_id)
        .bind(&receipt.payload)
        .bind(receipt.state.as_db_value())
        .bind(receipt.attempts as i64)
        .bind(&receipt.last_error_code)
        .bind(&receipt.created_at)
        .bind(&receipt.updated_at)
        .execute(self.pool.as_ref())
        .await
        .context("Failed to queue telemetry upload")?;
        Ok(())
    }

    async fn send_upload(&self, id: &str) -> Result<TelemetryUploadReceipt> {
        let receipt = self.get_upload(id).await?;
        if receipt.state == TelemetryUploadState::Accepted {
            return Ok(receipt);
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
                return self.get_upload(id).await;
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

        self.get_upload(id).await
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

    async fn get_upload(&self, id: &str) -> Result<TelemetryUploadReceipt> {
        let row = sqlx::query_as::<_, UploadRow>(
            "SELECT id, upload_id, payload, state, attempts, last_error_code, created_at, updated_at \
             FROM telemetry_upload_queue WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(self.pool.as_ref())
        .await
        .context("Failed to load telemetry upload")?
        .ok_or_else(|| anyhow!("Telemetry upload not found"))?;
        row.into_receipt()
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
    Ok(())
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

fn is_local_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("file://")
        || contains_absolute_unix_path(value)
        || value.as_bytes().windows(3).any(|window| {
            window[0].is_ascii_alphabetic()
                && window[1] == b':'
                && matches!(window[2], b'\\' | b'/')
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
    if !value.ends_with('Z') {
        return Err(anyhow!(
            "Telemetry upload {field} must use a Zulu ISO-8601 timestamp"
        ));
    }
    normalize_zulu_timestamp(value, field).map(|_| ())
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
    fn into_receipt(self) -> Result<TelemetryUploadReceipt> {
        let state = match self.state.as_str() {
            "pending" => TelemetryUploadState::Pending,
            "sending" => TelemetryUploadState::Sending,
            "accepted" => TelemetryUploadState::Accepted,
            "failed" => TelemetryUploadState::Failed,
            _ => return Err(anyhow!("Invalid telemetry upload queue state")),
        };
        Ok(TelemetryUploadReceipt {
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
