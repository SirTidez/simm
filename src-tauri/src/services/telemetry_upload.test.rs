use anyhow::Result;
use serial_test::serial;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db::initialize_pool;
use crate::services::telemetry::TelemetryService;
use crate::services::telemetry_upload::TelemetryUploadService;
use crate::test_helpers::EnvVarGuard;
use crate::types::{TelemetryPreferencesUpdate, TelemetryUploadState};

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
    TelemetryService::new(pool.clone()).save_preferences(TelemetryPreferencesUpdate {
        collection_enabled: Some(true), upload_enabled: Some(true), error_excerpts_enabled: Some(false),
        retention_days: None, close_behavior: None,
    }).await?;
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
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_upload_queue").fetch_one(pool.as_ref()).await?;
    assert_eq!(count, 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_unix_and_file_uri_paths_embedded_in_an_excerpt() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().join("simmrust").to_string_lossy().as_ref());
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone()).save_preferences(TelemetryPreferencesUpdate {
        collection_enabled: Some(true), upload_enabled: Some(true), error_excerpts_enabled: Some(false), retention_days: None, close_behavior: None,
    }).await?;
    let payload = serde_json::json!({
        "schemaVersion": 1, "uploadId": "00000000-0000-4000-8000-000000000002", "exportedAt": "2026-07-14T00:00:00Z",
        "sessions": [{ "sessionId": "session-1", "startedAt": "2026-07-14T00:00:00Z", "endedAt": "2026-07-14T00:01:00Z",
            "environment": { "appId": "3164500", "branch": "default", "runtime": "Mono", "s1Version": null }, "mods": [],
            "events": [{ "eventId": "event-1", "occurredAt": "2026-07-14T00:00:01Z", "severity": "ERROR", "attribution": "system",
                "modKey": null, "modName": null, "fingerprint": "sig-1", "message": "failed at /home/alice/private.txt",
                "source": "Latest.log", "lineNumber": 1, "origin": "live" }]
        }]
    }).to_string();

    let error = TelemetryUploadService::new(pool).queue_reviewed_upload(&payload).await.unwrap_err();

    assert!(error.to_string().contains("path"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn config_failure_marks_the_queued_item_failed_without_entering_sending() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().join("simmrust").to_string_lossy().as_ref());
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone()).save_preferences(TelemetryPreferencesUpdate {
        collection_enabled: Some(true), upload_enabled: Some(true), error_excerpts_enabled: Some(false), retention_days: None, close_behavior: None,
    }).await?;
    let service = TelemetryUploadService::with_base_url(pool, "not a url".to_string());
    let preview = service.preview_upload(None).await?;

    let receipt = service.queue_reviewed_upload(&preview.payload).await?;

    assert_eq!(receipt.state, TelemetryUploadState::Failed);
    assert_eq!(receipt.last_error_code.as_deref(), Some("configuration_error"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn listing_recovers_interrupted_sending_items_as_failed() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", temp.path().join("simmrust").to_string_lossy().as_ref());
    let pool = initialize_pool().await?;
    sqlx::query("INSERT INTO telemetry_upload_queue (id, upload_id, payload, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'sending', 1, ?, ?)")
        .bind("interrupted").bind("00000000-0000-4000-8000-000000000001").bind("{}")
        .bind("2026-07-14T00:00:00Z").bind("2026-07-14T00:00:00Z").execute(pool.as_ref()).await?;

    let uploads = TelemetryUploadService::new(pool).list_uploads().await?;

    assert_eq!(uploads[0].state, TelemetryUploadState::Failed);
    assert_eq!(uploads[0].last_error_code.as_deref(), Some("failed_before_acceptance"));
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
        stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true), upload_enabled: Some(true), error_excerpts_enabled: Some(false),
            retention_days: None, close_behavior: None,
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, base_url);

    let receipt = service.queue_upload(None).await?;

    assert_eq!(receipt.state, crate::types::TelemetryUploadState::Accepted);
    server.await?;
    Ok(())
}
