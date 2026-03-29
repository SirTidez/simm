use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use crate::services::mods_snapshot_cache;
use anyhow::Result;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;

const MODS_SNAPSHOT_REFRESH_DEBOUNCE_MS: u64 = 250;

#[derive(Debug, Default, Clone, Copy)]
struct RefreshState {
    in_progress: bool,
    rerun_requested: bool,
}

static REFRESH_STATES: Lazy<Mutex<HashMap<String, RefreshState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

async fn begin_refresh(environment_id: &str) -> bool {
    let mut states = REFRESH_STATES.lock().await;
    let state = states.entry(environment_id.to_string()).or_default();
    if state.in_progress {
        state.rerun_requested = true;
        return false;
    }

    state.in_progress = true;
    state.rerun_requested = false;
    true
}

async fn finish_refresh(environment_id: &str) -> bool {
    let mut states = REFRESH_STATES.lock().await;
    let Some(state) = states.get_mut(environment_id) else {
        return false;
    };

    if state.rerun_requested {
        state.rerun_requested = false;
        return true;
    }

    states.remove(environment_id);
    false
}

async fn refresh_mods_snapshot(
    app: &AppHandle,
    pool: Arc<SqlitePool>,
    environment_id: &str,
) -> Result<()> {
    let env_service = EnvironmentService::new(pool.clone())?;
    let Some(environment) = env_service.get_environment(environment_id).await? else {
        mods_snapshot_cache::remove(environment_id).await;
        return Ok(());
    };

    if environment.output_dir.is_empty() {
        mods_snapshot_cache::remove(environment_id).await;
        return Ok(());
    }

    let mods_service = ModsService::new(pool);
    let snapshot = mods_service.list_mods(&environment.output_dir).await?;
    mods_snapshot_cache::set(environment_id.to_string(), snapshot.clone()).await;
    events::emit_mods_snapshot_updated(app, environment_id.to_string(), snapshot)?;
    Ok(())
}

pub async fn request_mods_snapshot_refresh(
    app: AppHandle,
    pool: Arc<SqlitePool>,
    environment_id: String,
    reason: &'static str,
) {
    if !begin_refresh(&environment_id).await {
        log::debug!(
            "Mods snapshot refresh already in progress for {} (reason: {}), queued one follow-up pass",
            environment_id,
            reason
        );
        return;
    }

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(MODS_SNAPSHOT_REFRESH_DEBOUNCE_MS)).await;

            if let Err(err) = refresh_mods_snapshot(&app, pool.clone(), &environment_id).await {
                log::warn!(
                    "Failed to refresh mods snapshot for {} (reason: {}): {}",
                    environment_id,
                    reason,
                    err
                );
            }

            if !finish_refresh(&environment_id).await {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn refresh_state_requests_one_follow_up_pass() {
        let environment_id = format!("env-{}", Uuid::new_v4());

        assert!(begin_refresh(&environment_id).await);
        assert!(!begin_refresh(&environment_id).await);
        assert!(finish_refresh(&environment_id).await);
        assert!(!finish_refresh(&environment_id).await);
    }
}
