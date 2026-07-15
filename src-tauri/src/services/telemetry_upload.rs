use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::config::telemetry_upload::upload_base_url;
use crate::services::telemetry::TelemetryService;
use crate::types::{
    LiveTelemetryExport, TelemetryUploadEnvelope, TelemetryUploadPreview, TelemetryUploadReceipt,
    TelemetryUploadState,
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
        let payload = serde_json::to_string_pretty(&export)
            .context("Failed to serialize the local telemetry upload preview")?;

        Ok(TelemetryUploadPreview {
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
        let export = TelemetryService::new(self.pool.clone())
            .export_live_history(environment_id)
            .await?;
        self.queue_export(export).await
    }

    pub async fn queue_reviewed_upload(
        &self,
        preview_payload: &str,
    ) -> Result<TelemetryUploadReceipt> {
        let export = serde_json::from_str::<LiveTelemetryExport>(preview_payload)
            .context("The reviewed telemetry payload is invalid")?;
        self.queue_export(export).await
    }

    async fn queue_export(&self, export: LiveTelemetryExport) -> Result<TelemetryUploadReceipt> {
        let preferences = TelemetryService::new(self.pool.clone())
            .get_preferences()
            .await?;
        if !preferences.collection_enabled || !preferences.upload_enabled {
            return Err(anyhow!(
                "Telemetry upload requires collection and upload opt-in before it can be queued"
            ));
        }

        ensure_upload_export_is_safe(&export)?;
        let envelope = TelemetryUploadEnvelope {
            schema_version: TELEMETRY_SCHEMA_VERSION,
            upload_id: Uuid::new_v4().to_string(),
            exported_at: export.exported_at,
            sessions: export.sessions,
        };
        let payload = serde_json::to_string(&envelope)
            .context("Failed to serialize telemetry upload payload")?;
        let receipt = TelemetryUploadReceipt {
            id: format!("telemetry-upload-{}", Uuid::new_v4().simple()),
            upload_id: envelope.upload_id,
            payload,
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

        let attempts = receipt.attempts.saturating_add(1);
        self.update_state(id, TelemetryUploadState::Sending, attempts, None)
            .await?;
        let base_url = match &self.base_url {
            Some(base_url) => base_url.clone(),
            None => upload_base_url()?,
        };
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

fn ensure_upload_export_is_safe(export: &LiveTelemetryExport) -> Result<()> {
    let serialized = serde_json::to_string(export)?;
    if serialized.contains("environmentId") || contains_path_shaped_value(&serialized) {
        return Err(anyhow!("Telemetry upload preview contains a local identifier or path"));
    }
    Ok(())
}

fn contains_path_shaped_value(value: &str) -> bool {
    value.contains(":\\") || value.contains("\\\\") || value.contains("\"/")
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
