use anyhow::Result;
use regex::Regex;
use serial_test::serial;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db::initialize_pool;
use crate::services::telemetry::TelemetryService;
use crate::services::telemetry_upload::{
    normalize_upload_envelope_timestamps, TelemetryUploadService,
};
use crate::test_helpers::EnvVarGuard;
use crate::types::{TelemetryPreferencesUpdate, TelemetryUploadEnvelope, TelemetryUploadState};

#[tokio::test]
#[serial]
async fn queueing_requires_collection_and_upload_opt_in() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    let service = TelemetryUploadService::new(pool.clone());

    let result = service.queue_upload(None).await;

    assert!(result.unwrap_err().to_string().contains("upload opt-in"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn preview_excludes_local_environment_ids_and_paths() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    let telemetry = TelemetryService::new(pool.clone());
    telemetry
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::new(pool);

    let preview = service
        .preview_upload(Some("local-env-id".to_string()))
        .await?;

    assert!(!preview.payload.contains("local-env-id"));
    assert!(!preview.payload.contains("C:\\"));
    assert!(!preview.payload.contains("C:/"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn retry_reuses_one_upload_id_and_never_rebuilds_the_payload() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    let telemetry = TelemetryService::new(pool.clone());
    telemetry
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::new(pool);

    let preview = service.preview_upload(None).await?;
    let queued = service.queue_reviewed_upload(&preview.payload).await?;
    let retried = service.retry_upload(&queued.id).await?;

    assert_eq!(queued.upload_id, retried.upload_id);
    assert_eq!(queued.payload, retried.payload);
    assert_eq!(queued.payload, preview.payload);
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_forward_slash_windows_paths_before_they_can_be_queued() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::new(pool.clone());
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "uploadId": "00000000-0000-4000-8000-000000000001",
        "exportedAt": "2026-07-14T00:00:00Z",
        "sessions": [{
            "sessionId": "session-1", "startedAt": "2026-07-14T00:00:00Z", "endedAt": "2026-07-14T00:01:00Z",
            "environment": { "appId": "3164500", "branch": "default", "runtime": "Mono", "s1Version": null },
            "mods": [],
            "events": [{
                "eventId": "event-1", "occurredAt": "2026-07-14T00:00:01Z", "severity": "ERROR", "attribution": "system",
                "modKey": null, "modName": null, "fingerprint": "sig-1", "message": "C:/Users/Alice/Secrets/log.txt",
                "source": "Latest.log", "lineNumber": 1, "origin": "live"
            }]
        }]
    }).to_string();

    let error = service.queue_reviewed_upload(&payload).await.unwrap_err();

    assert!(error.to_string().contains("path"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_upload_queue")
        .fetch_one(pool.as_ref())
        .await?;
    assert_eq!(count, 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_unix_and_file_uri_paths_embedded_in_an_excerpt() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let payload = serde_json::json!({
        "schemaVersion": 1, "uploadId": "00000000-0000-4000-8000-000000000002", "exportedAt": "2026-07-14T00:00:00Z",
        "sessions": [{ "sessionId": "session-1", "startedAt": "2026-07-14T00:00:00Z", "endedAt": "2026-07-14T00:01:00Z",
            "environment": { "appId": "3164500", "branch": "default", "runtime": "Mono", "s1Version": null }, "mods": [],
            "events": [{ "eventId": "event-1", "occurredAt": "2026-07-14T00:00:01Z", "severity": "ERROR", "attribution": "system",
                "modKey": null, "modName": null, "fingerprint": "sig-1", "message": "failed at /home/alice/private.txt",
                "source": "Latest.log", "lineNumber": 1, "origin": "live" }]
        }]
    }).to_string();

    let error = TelemetryUploadService::new(pool)
        .queue_reviewed_upload(&payload)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("path"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_unix_paths_after_non_whitespace_delimiters_before_queueing() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let mut payload: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    payload["sessions"][0]["events"][0]["message"] =
        serde_json::Value::String("setting=/home/alice/private.txt".to_string());

    let error = TelemetryUploadService::new(pool.clone())
        .queue_reviewed_upload(&payload.to_string())
        .await
        .unwrap_err();

    assert!(error.to_string().contains("path"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_upload_queue")
        .fetch_one(pool.as_ref())
        .await?;
    assert_eq!(count, 0);
    Ok(())
}

#[test]
fn normalized_envelope_serializes_with_api_zulu_datetime_semantics() -> Result<()> {
    let mut envelope: TelemetryUploadEnvelope = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    envelope.exported_at = "2026-07-14T18:30:00+00:00".to_string();
    envelope.sessions[0].started_at = "2026-07-14T11:00:00-07:00".to_string();
    envelope.sessions[0].ended_at = Some("2026-07-14T18:20:00+00:00".to_string());
    envelope.sessions[0].events[0].occurred_at = "2026-07-14T11:10:00-07:00".to_string();

    normalize_upload_envelope_timestamps(&mut envelope)?;
    let payload = serde_json::to_string(&envelope)?;

    assert_api_v1_fixture_semantics(&payload)?;
    assert!(payload.contains("2026-07-14T18:30:00.000Z"));
    assert!(payload.contains("2026-07-14T18:00:00.000Z"));
    assert!(payload.contains("2026-07-14T18:20:00.000Z"));
    assert!(payload.contains("2026-07-14T18:10:00.000Z"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn queued_fixture_payload_matches_api_v1_contract_semantics() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;

    let receipt = TelemetryUploadService::with_base_url(pool, "not a url".to_string())
        .queue_reviewed_upload(include_str!(
            "../../../test-fixtures/live-telemetry-v1.json"
        ))
        .await?;

    assert_eq!(receipt.state, TelemetryUploadState::Failed);
    assert_api_v1_fixture_semantics(&receipt.payload)?;
    Ok(())
}

fn assert_api_v1_fixture_semantics(payload: &str) -> Result<()> {
    let batch: serde_json::Value = serde_json::from_str(payload)?;
    let batch = batch
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("batch must be an object"))?;
    assert_eq!(batch.len(), 4, "the API TelemetryBatchSchema is strict");
    assert_eq!(
        batch
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64),
        Some(1)
    );
    uuid::Uuid::parse_str(
        batch
            .get("uploadId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing uploadId"))?,
    )?;
    assert_api_zulu_datetime(
        batch
            .get("exportedAt")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing exportedAt"))?,
    );
    let sessions = batch
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("missing sessions"))?;
    assert!(!sessions.is_empty() && sessions.len() <= 100);
    for session in sessions {
        let session = session
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("session must be an object"))?;
        assert_eq!(session.len(), 6, "the API SessionSchema is strict");
        let session_id = session
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing sessionId"))?;
        assert!(
            session_id.starts_with("session-")
                && session_id["session-".len()..]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()
                        && !character.is_ascii_uppercase())
        );
        assert_api_zulu_datetime(
            session
                .get("startedAt")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing startedAt"))?,
        );
        assert_api_zulu_datetime(
            session
                .get("endedAt")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing endedAt"))?,
        );
        for event in session
            .get("events")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("missing events"))?
        {
            let event = event
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("event must be an object"))?;
            assert_eq!(event.len(), 11, "the API EventSchema is strict");
            let event_id = event
                .get("eventId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing eventId"))?;
            assert!(
                event_id.starts_with("event-")
                    && event_id["event-".len()..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit()
                            && !character.is_ascii_uppercase())
            );
            assert_api_zulu_datetime(
                event
                    .get("occurredAt")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("missing occurredAt"))?,
            );
            let fingerprint = event
                .get("fingerprint")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing fingerprint"))?;
            assert_eq!(fingerprint.len(), 64);
            assert!(fingerprint
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        }
    }
    Ok(())
}

fn assert_api_zulu_datetime(value: &str) {
    assert!(
        Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
            .expect("timestamp regex")
            .is_match(value),
        "timestamp must be canonical UTC milliseconds ending in Z: {value}"
    );
    assert!(
        value.ends_with('Z'),
        "the API Zod datetime contract requires Zulu timestamps"
    );
    chrono::DateTime::parse_from_rfc3339(value).expect("valid ISO-8601 timestamp");
}

#[tokio::test]
#[serial]
async fn config_failure_marks_the_queued_item_failed_without_entering_sending() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, "not a url".to_string());
    let preview = service.preview_upload(None).await?;

    let receipt = service.queue_reviewed_upload(&preview.payload).await?;

    assert_eq!(receipt.state, TelemetryUploadState::Failed);
    assert_eq!(
        receipt.last_error_code.as_deref(),
        Some("configuration_error")
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn listing_recovers_interrupted_sending_items_as_failed() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    sqlx::query("INSERT INTO telemetry_upload_queue (id, upload_id, payload, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'sending', 1, ?, ?)")
        .bind("interrupted").bind("00000000-0000-4000-8000-000000000001").bind("{}")
        .bind("2026-07-14T00:00:00Z").bind("2026-07-14T00:00:00Z").execute(pool.as_ref()).await?;

    let uploads = TelemetryUploadService::new(pool).list_uploads().await?;

    assert_eq!(uploads[0].state, TelemetryUploadState::Failed);
    assert_eq!(
        uploads[0].last_error_code.as_deref(),
        Some("failed_before_acceptance")
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_successful_http_response_marks_the_local_item_accepted() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, base_url);

    let receipt = service.queue_upload(None).await?;

    assert_eq!(receipt.state, crate::types::TelemetryUploadState::Accepted);
    server.await?;
    Ok(())
}
