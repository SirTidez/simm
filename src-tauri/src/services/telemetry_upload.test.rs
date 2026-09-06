use anyhow::Result;
use regex::Regex;
use serial_test::serial;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

use crate::db::initialize_pool;
use crate::services::telemetry::TelemetryService;
use crate::services::telemetry_upload::{
    is_local_path, normalize_upload_envelope_timestamps, rekey_upload_envelope_identities,
    TelemetryUploadService,
};
use crate::test_helpers::EnvVarGuard;
use crate::types::{TelemetryPreferencesUpdate, TelemetryUploadEnvelope, TelemetryUploadState};

async fn persist_durably_ended_fixture_session(
    pool: &std::sync::Arc<sqlx::SqlitePool>,
) -> Result<()> {
    let session_id = "session-1a2b3c4d5e6f7890a1b2c3d4e5f60708";
    let environment_id = "fixture-environment";
    sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
        .bind(environment_id)
        .bind("C:\\fixture")
        .bind("{}")
        .execute(pool.as_ref())
        .await?;
    sqlx::query(
        "INSERT INTO telemetry_sessions (id, environment_id, started_at, ended_at, data) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(environment_id)
    .bind("2026-07-14T18:00:00.000Z")
    .bind("2026-07-14T18:20:00.000Z")
    .bind("{}")
    .execute(pool.as_ref())
    .await?;
    sqlx::query(
        "INSERT INTO telemetry_events (id, session_id, environment_id, occurred_at, severity, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("event-1a2b3c4d5e6f7890a1b2c3d4e5f60708")
    .bind(session_id)
    .bind(environment_id)
    .bind("2026-07-14T18:10:00.000Z")
    .bind("ERROR")
    .bind("2f5ed08d6cc08918781a50c95cda51a6a85cb4c70b901b079c3a7cc8ac522a12")
    .bind("{}")
    .execute(pool.as_ref())
    .await?;
    Ok(())
}

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
async fn reviewed_payload_cannot_queue_a_session_without_a_durable_end_row() -> Result<()> {
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
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;

    let error = TelemetryUploadService::new(pool)
        .queue_reviewed_upload(include_str!(
            "../../../test-fixtures/live-telemetry-v1.json"
        ))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not durably ended"));
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
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
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
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    let telemetry = TelemetryService::new(pool.clone());
    telemetry
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool.clone(), "not a url".to_string());

    let preview = service.preview_upload(None).await?;
    let queued = service.queue_reviewed_upload(&preview.payload).await?;
    assert_eq!(queued.state, TelemetryUploadState::Pending);
    let retried = service.retry_upload(&queued.id).await?;

    assert_eq!(queued.upload_id, retried.upload_id);
    let stored_payload: String =
        sqlx::query_scalar("SELECT payload FROM telemetry_upload_queue WHERE id = ?")
            .bind(&queued.id)
            .fetch_one(pool.as_ref())
            .await?;
    assert_eq!(stored_payload, preview.payload);
    Ok(())
}

#[test]
fn upload_preview_rekeys_session_and_event_ids_per_upload() -> Result<()> {
    let original: TelemetryUploadEnvelope = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    let mut first = original.clone();
    let mut second = original.clone();
    second.upload_id = "4a167917-5221-4519-9f4f-7f585de76445".to_string();

    rekey_upload_envelope_identities(&mut first);
    rekey_upload_envelope_identities(&mut second);

    assert_ne!(
        first.sessions[0].session_id,
        original.sessions[0].session_id
    );
    assert_ne!(
        first.sessions[0].events[0].event_id,
        original.sessions[0].events[0].event_id
    );
    assert_ne!(first.sessions[0].session_id, second.sessions[0].session_id);
    assert_ne!(
        first.sessions[0].events[0].event_id,
        second.sessions[0].events[0].event_id
    );
    assert_api_v1_fixture_semantics(&serde_json::to_string(&first)?)?;
    Ok(())
}

#[tokio::test]
#[serial]
async fn queue_rejects_an_event_identity_not_derived_from_the_local_session() -> Result<()> {
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
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    persist_durably_ended_fixture_session(&pool).await?;
    let mut envelope: TelemetryUploadEnvelope = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    rekey_upload_envelope_identities(&mut envelope);
    envelope.sessions[0].events[0].event_id = "event-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();

    let error = TelemetryUploadService::new(pool)
        .queue_reviewed_upload(&serde_json::to_string(&envelope)?)
        .await
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("not part of the reviewed local session"));
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
            protect_local_mods: Some(false),
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

#[test]
fn rejects_unc_and_root_relative_windows_paths_but_allows_normal_slash_text() {
    assert!(is_local_path(r"\\server\private\Latest.log"));
    assert!(is_local_path(r"\Users\Alice\AppData\Local\SIMM"));
    assert!(is_local_path(r"\Windows"));
    assert!(is_local_path(r"failure at \.\private\Latest.log"));
    assert!(!is_local_path("processed 1/2 files"));
    assert!(!is_local_path("mod/category label"));
}

#[tokio::test]
#[serial]
async fn excerpt_consent_is_rechecked_immediately_before_network_send() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let temp = tempfile::tempdir()?;
    let _data_dir = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    persist_durably_ended_fixture_session(&pool).await?;
    let telemetry = TelemetryService::new(pool.clone());
    telemetry
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool.clone(), base_url);
    let queued = service
        .queue_reviewed_upload(include_str!(
            "../../../test-fixtures/live-telemetry-v1.json"
        ))
        .await?;

    telemetry
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: None,
            upload_enabled: None,
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: None,
        })
        .await?;
    let receipt = service.retry_upload(&queued.id).await?;

    assert_eq!(receipt.state, TelemetryUploadState::Failed);
    assert_eq!(
        receipt.last_error_code.as_deref(),
        Some("diagnostic_text_consent_revoked")
    );
    assert_eq!(receipt.attempts, 0);
    assert!(timeout(Duration::from_millis(150), listener.accept())
        .await
        .is_err());
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
            protect_local_mods: Some(false),
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
            protect_local_mods: Some(false),
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
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    persist_durably_ended_fixture_session(&pool).await?;

    let receipt = TelemetryUploadService::with_base_url(pool.clone(), "not a url".to_string())
        .queue_reviewed_upload(include_str!(
            "../../../test-fixtures/live-telemetry-v1.json"
        ))
        .await?;

    assert_eq!(receipt.state, TelemetryUploadState::Pending);
    let stored_payload: String =
        sqlx::query_scalar("SELECT payload FROM telemetry_upload_queue WHERE id = ?")
            .bind(&receipt.id)
            .fetch_one(pool.as_ref())
            .await?;
    assert_api_v1_fixture_semantics(&stored_payload)?;
    assert!(!stored_payload.contains("session-1a2b3c4d5e6f7890a1b2c3d4e5f60708"));
    assert!(!stored_payload.contains("event-1a2b3c4d5e6f7890a1b2c3d4e5f60708"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn queue_rejects_noncanonical_timestamps_but_accepts_preview_bytes() -> Result<()> {
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
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, "not a url".to_string());
    let mut noncanonical: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    noncanonical["exportedAt"] = serde_json::Value::String("2026-07-14T18:30:00Z".to_string());

    let error = service
        .queue_reviewed_upload(&noncanonical.to_string())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("canonical UTC milliseconds"));

    let preview = service.preview_upload(None).await?;
    let accepted_preview = service.queue_reviewed_upload(&preview.payload).await?;
    assert_eq!(accepted_preview.state, TelemetryUploadState::Pending);
    Ok(())
}

#[tokio::test]
#[serial]
async fn renderer_facing_receipts_never_serialize_the_private_payload() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(true),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    persist_durably_ended_fixture_session(&pool).await?;
    let service = TelemetryUploadService::with_base_url(pool, "not a url".to_string());
    let private_message = "private telemetry message that must stay local";
    let mut payload: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/live-telemetry-v1.json"
    ))?;
    payload["sessions"][0]["events"][0]["message"] =
        serde_json::Value::String(private_message.to_string());

    let queued = service.queue_reviewed_upload(&payload.to_string()).await?;
    let listed = service.list_uploads().await?;
    let retried = service.retry_upload(&queued.id).await?;
    for status in [
        queued,
        listed.into_iter().next().expect("queued upload"),
        retried,
    ] {
        let rendered = serde_json::to_value(status)?;
        assert!(rendered.get("payload").is_none());
        assert!(!rendered.to_string().contains(private_message));
    }
    Ok(())
}

fn assert_api_v1_fixture_semantics(payload: &str) -> Result<()> {
    let batch: serde_json::Value = serde_json::from_str(payload)?;
    let batch = batch
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("batch must be an object"))?;
    assert_eq!(batch.len(), 5, "the API TelemetryBatchSchema is strict");
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
    assert_eq!(
        batch
            .get("diagnosticTextConsent")
            .and_then(serde_json::Value::as_bool),
        Some(true)
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
            assert_eq!(event.len(), 13, "the API EventSchema is strict");
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
async fn update_check_flush_marks_a_misconfigured_queued_item_failed() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _guard = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, "not a url".to_string());
    let preview = service.preview_upload(None).await?;

    let queued = service.queue_reviewed_upload(&preview.payload).await?;
    assert_eq!(queued.state, TelemetryUploadState::Pending);
    let receipt = service
        .flush_queued_uploads()
        .await?
        .into_iter()
        .next()
        .expect("queued item should be processed");

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
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool, base_url);

    let queued = service.queue_upload(None).await?;
    assert_eq!(queued.state, TelemetryUploadState::Pending);
    let receipt = service
        .flush_queued_uploads()
        .await?
        .into_iter()
        .next()
        .expect("queued item should be uploaded");

    assert_eq!(receipt.state, crate::types::TelemetryUploadState::Accepted);
    server.await?;
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_finished_session_is_queued_then_uploaded_during_a_flush() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 8192];
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
    let _telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let session_id = "captured-session";
    sqlx::query("INSERT INTO environments (id, output_dir, data) VALUES (?, ?, ?)")
        .bind("local-environment-id")
        .bind("C:\\telemetry-test")
        .bind("{}")
        .execute(pool.as_ref())
        .await?;
    sqlx::query(
        "INSERT INTO telemetry_sessions (id, environment_id, started_at, ended_at, data) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind("local-environment-id")
    .bind("2026-07-14T00:00:00Z")
    .bind("2026-07-14T00:01:00Z")
    .bind(serde_json::json!({
        "sessionId": session_id,
        "environmentId": "local-environment-id",
        "startedAt": "2026-07-14T00:00:00Z",
        "endedAt": "2026-07-14T00:01:00Z",
        "environment": { "appId": "3164500", "branch": "default", "runtime": "Mono", "s1Version": null },
        "mods": [],
        "monitoring": false
    }).to_string())
    .execute(pool.as_ref())
    .await?;
    sqlx::query(
        "INSERT INTO telemetry_events (id, session_id, environment_id, occurred_at, severity, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("captured-event")
    .bind(session_id)
    .bind("local-environment-id")
    .bind("2026-07-14T00:00:30Z")
    .bind("ERROR")
    .bind("a".repeat(64))
    .bind(serde_json::json!({
        "eventId": "captured-event",
        "sessionId": session_id,
        "environmentId": "local-environment-id",
        "occurredAt": "2026-07-14T00:00:30Z",
        "severity": "ERROR",
        "attribution": "system",
        "modKey": null,
        "modName": null,
        "fingerprint": "a".repeat(64),
        "errorClass": "NullReferenceException",
        "errorCode": null,
        "message": null,
        "source": "Latest.log",
        "lineNumber": 1,
        "origin": "live"
    }).to_string())
    .execute(pool.as_ref())
    .await?;

    let service = TelemetryUploadService::with_base_url(pool.clone(), base_url);
    let receipt = service
        .queue_finished_session(session_id)
        .await?
        .expect("finished sessions with events should queue");

    assert_eq!(receipt.state, TelemetryUploadState::Pending);
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM telemetry_upload_queue WHERE id = ?")
            .bind(&receipt.id)
            .fetch_one(pool.as_ref())
            .await?;
    assert!(!payload.contains("local-environment-id"));
    assert!(!payload.contains(session_id));
    assert!(!payload.contains("captured-event"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&payload)?["sessions"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let flushed = service.flush_queued_uploads().await?;
    assert_eq!(flushed.len(), 1);
    assert_eq!(flushed[0].state, TelemetryUploadState::Accepted);
    server.await?;
    Ok(())
}

#[tokio::test]
#[serial]
async fn disabled_feature_flag_does_not_flush_or_send_queued_uploads() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let _data_dir = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool.clone(), "not a url".to_string());
    let queued = service.queue_upload(None).await?;
    assert_eq!(queued.state, TelemetryUploadState::Pending);

    drop(telemetry_enabled);
    let _telemetry_disabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "false");
    let error = service.flush_queued_uploads().await.unwrap_err();
    assert!(error.to_string().contains("SIMM_ENABLE_TELEMETRY=1"));

    let queued_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM telemetry_upload_queue WHERE id = ? AND state = 'pending'",
    )
    .bind(&queued.id)
    .fetch_one(pool.as_ref())
    .await?;
    assert_eq!(queued_count, 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn disabled_feature_flag_prevents_retry_from_sending_a_queued_upload() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let temp = tempfile::tempdir()?;
    let _data_dir = EnvVarGuard::set(
        "SIMMRUST_DATA_DIR",
        temp.path().join("simmrust").to_string_lossy().as_ref(),
    );
    let telemetry_enabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "true");
    let pool = initialize_pool().await?;
    TelemetryService::new(pool.clone())
        .save_preferences(TelemetryPreferencesUpdate {
            collection_enabled: Some(true),
            upload_enabled: Some(true),
            error_excerpts_enabled: Some(false),
            retention_days: None,
            protect_local_mods: Some(false),
        })
        .await?;
    let service = TelemetryUploadService::with_base_url(pool.clone(), base_url);
    let queued = service.queue_upload(None).await?;

    drop(telemetry_enabled);
    let _telemetry_disabled = EnvVarGuard::set("SIMM_ENABLE_TELEMETRY", "false");
    let error = service.retry_upload(&queued.id).await.unwrap_err();
    assert!(error.to_string().contains("SIMM_ENABLE_TELEMETRY=1"));
    assert!(timeout(Duration::from_millis(150), listener.accept())
        .await
        .is_err());

    let (state, attempts): (String, i64) =
        sqlx::query_as("SELECT state, attempts FROM telemetry_upload_queue WHERE id = ?")
            .bind(&queued.id)
            .fetch_one(pool.as_ref())
            .await?;
    assert_eq!(state, "pending");
    assert_eq!(attempts, 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_finished_session_without_events_queues_its_mod_snapshot() -> Result<()> {
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
            protect_local_mods: Some(false),
        })
        .await?;

    let environment_id = "empty-event-environment";
    let session_id = "empty-event-session";
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
    .bind("2026-07-14T00:00:00Z")
    .bind("2026-07-14T00:01:00Z")
    .bind(serde_json::json!({
        "sessionId": session_id,
        "environmentId": environment_id,
        "startedAt": "2026-07-14T00:00:00Z",
        "endedAt": "2026-07-14T00:01:00Z",
        "environment": { "appId": "3164500", "branch": "default", "runtime": "Mono", "s1Version": null },
        "mods": [{
            "modKey": "mod-example", "name": "Example Mod", "fileName": "Example.Mod.dll",
            "version": "1.0.0", "source": "local", "author": null, "managed": false, "disabled": false
        }],
        "monitoring": false
    }).to_string())
    .execute(pool.as_ref())
    .await?;

    let first_service =
        TelemetryUploadService::with_base_url(pool.clone(), "not a url".to_string());
    let second_service =
        TelemetryUploadService::with_base_url(pool.clone(), "not a url".to_string());
    let (first, second) = tokio::join!(
        first_service.queue_finished_session(session_id),
        second_service.queue_finished_session(session_id)
    );
    let receipt = first?
        .or(second?)
        .expect("exactly one concurrent request should queue the finished session");

    assert_eq!(receipt.state, TelemetryUploadState::Pending);
    let payload: serde_json::Value = serde_json::from_str(
        &sqlx::query_scalar::<_, String>("SELECT payload FROM telemetry_upload_queue WHERE id = ?")
            .bind(&receipt.id)
            .fetch_one(pool.as_ref())
            .await?,
    )?;
    assert_eq!(
        payload["sessions"][0]["events"].as_array().map(Vec::len),
        Some(0)
    );
    assert_eq!(
        payload["sessions"][0]["mods"].as_array().map(Vec::len),
        Some(1)
    );
    let manual_duplicate = first_service
        .queue_reviewed_upload(&payload.to_string())
        .await
        .expect_err("manual review must not requeue an automatically claimed session");
    assert!(manual_duplicate.to_string().contains("already queued"));
    assert!(first_service
        .queue_finished_session(session_id)
        .await?
        .is_none());
    let queued_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_upload_queue")
        .fetch_one(pool.as_ref())
        .await?;
    assert_eq!(queued_count, 1);
    let queued_session_id: String =
        sqlx::query_scalar("SELECT session_id FROM telemetry_upload_sessions WHERE queue_id = ?")
            .bind(&receipt.id)
            .fetch_one(pool.as_ref())
            .await?;
    assert_eq!(queued_session_id, session_id);
    assert_ne!(payload["sessions"][0]["sessionId"], session_id);
    Ok(())
}
