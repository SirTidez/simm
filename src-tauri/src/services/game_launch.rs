use crate::services::{game_process::inspect_game_process, melon_loader::MelonLoaderService};
use crate::types::{GameLaunchInspection, GameProcessState};

pub(crate) async fn inspect_game_launch(
    environment_id: &str,
    game_dir: &str,
    launch_started_at: u64,
) -> GameLaunchInspection {
    inspect_with_process(
        environment_id,
        game_dir,
        launch_started_at,
        inspect_game_process(std::path::Path::new(game_dir)),
    )
    .await
}

async fn inspect_with_process(
    environment_id: &str,
    game_dir: &str,
    launch_started_at: u64,
    process: impl std::future::Future<Output = (GameProcessState, Option<String>)>,
) -> GameLaunchInspection {
    let service = MelonLoaderService::new();
    let (process, loader) = tokio::join!(
        process,
        service.inspect_launch_after(game_dir, launch_started_at)
    );
    let diagnostics = [process.1, loader.diagnostic]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    GameLaunchInspection {
        environment_id: environment_id.into(),
        launch_started_at,
        process_state: process.0,
        loader_state: loader.loader_state,
        log_path: loader.log_path,
        modified_at: loader.modified_at,
        diagnostic: if diagnostics.is_empty() {
            None
        } else {
            Some(diagnostics.join(" "))
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GameProcessState;
    use anyhow::Result;
    #[tokio::test]
    #[serial_test::serial]
    async fn inspection_runs_with_telemetry_disabled_without_sessions_or_uploads() -> Result<()> {
        let (temp, _guard, pool) = crate::test_helpers::init_test_pool_with_temp_data_dir().await?;
        let telemetry = crate::services::telemetry::TelemetryService::new(pool.clone());
        let before = telemetry.get_preferences().await?;
        assert!(!before.collection_enabled);
        assert!(!before.upload_enabled);
        let result = inspect_with_process("captured", temp.path().to_str().unwrap(), 1234, async {
            (GameProcessState::Running, None)
        })
        .await;
        assert_eq!(result.process_state, GameProcessState::Running);
        assert_eq!(result.loader_state, "notInstalled");
        let json = serde_json::to_value(&result)?;
        assert_eq!(json["environmentId"], "captured");
        assert_eq!(json["launchStartedAt"], 1234);
        assert_eq!(json["processState"], "running");
        assert!(json["modifiedAt"].is_null());
        assert_eq!(
            serde_json::to_value(before)?,
            serde_json::to_value(telemetry.get_preferences().await?)?
        );
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_sessions")
            .fetch_one(pool.as_ref())
            .await?;
        let uploads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_upload_queue")
            .fetch_one(pool.as_ref())
            .await?;
        assert_eq!((sessions, uploads), (0, 0));
        Ok(())
    }
}
