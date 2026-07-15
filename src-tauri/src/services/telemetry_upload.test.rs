use anyhow::Result;
use serial_test::serial;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db::initialize_pool;
use crate::services::telemetry::TelemetryService;
use crate::services::telemetry_upload::TelemetryUploadService;
use crate::test_helpers::EnvVarGuard;
use crate::types::TelemetryPreferencesUpdate;

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
    let preview: serde_json::Value = serde_json::from_str(&preview.payload)?;
    let queued: serde_json::Value = serde_json::from_str(&queued.payload)?;
    assert_eq!(queued["sessions"], preview["sessions"]);
    assert_eq!(queued["exportedAt"], preview["exportedAt"]);
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
