use crate::services::environment::EnvironmentService;
use crate::services::settings::RuntimeSettingsState;
use crate::types::{Environment, Settings};
use chrono::Utc;
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

static ENVIRONMENT_CHANGE_SENDER: once_cell::sync::Lazy<watch::Sender<u64>> =
    once_cell::sync::Lazy::new(|| {
        let (sender, _receiver) = watch::channel(0_u64);
        sender
    });

/// Central notification seam for every durable environment mutation. The
/// versioned watch channel intentionally retains a mutation that precedes a
/// scheduler wait, unlike a bare `Notify` signal.
pub fn notify_environment_changed() {
    let next = (*ENVIRONMENT_CHANGE_SENDER.borrow()).wrapping_add(1);
    ENVIRONMENT_CHANGE_SENDER.send_replace(next);
}

fn subscribe_environment_changes() -> watch::Receiver<u64> {
    ENVIRONMENT_CHANGE_SENDER.subscribe()
}

/// Wake the deadline-driven scheduler after an environment mutation. Settings
/// saves use the same notification source through `RuntimeSettingsState`.
pub fn request_reschedule(app: &AppHandle) {
    if let Some(runtime_settings) = app.try_state::<RuntimeSettingsState>() {
        runtime_settings.notify_changed();
    }
}

fn update_interval(settings: &Settings) -> chrono::Duration {
    chrono::Duration::minutes(settings.update_check_interval.unwrap_or(60).max(1) as i64)
}

fn next_due_delay(settings: &Settings, environments: &[Environment]) -> Option<Duration> {
    next_due_delay_at(settings, environments, Utc::now())
}

fn next_due_delay_at(
    settings: &Settings,
    environments: &[Environment],
    now: chrono::DateTime<Utc>,
) -> Option<Duration> {
    if environments.is_empty() {
        return None;
    }

    let interval = update_interval(settings);
    environments
        .iter()
        .map(|environment| match environment.last_update_check {
            Some(last_check) => (last_check + interval - now)
                .to_std()
                .unwrap_or(Duration::ZERO),
            None => Duration::ZERO,
        })
        .min()
}

async fn next_due_delay_from_database(
    pool: Arc<SqlitePool>,
    settings: &Settings,
) -> Result<Option<Duration>, String> {
    let environments = EnvironmentService::new(pool)
        .map_err(|error| error.to_string())?
        .get_environments()
        .await
        .map_err(|error| error.to_string())?;
    Ok(next_due_delay(settings, &environments))
}

pub fn start(pool: Arc<SqlitePool>, app: AppHandle, runtime_settings: RuntimeSettingsState) {
    tokio::spawn(async move {
        log::info!("Started deadline-driven game update scheduler");
        let mut changes = runtime_settings.subscribe_changes();
        let mut environment_changes = subscribe_environment_changes();

        loop {
            let settings = runtime_settings.snapshot().await;
            if settings.auto_check_updates != Some(false) {
                if let Err(error) = crate::commands::update_check::run_background_update_checks(
                    pool.clone(),
                    app.clone(),
                    false,
                    settings.clone(),
                )
                .await
                {
                    log::warn!("Background game update check failed: {}", error);
                }
            }

            let settings = runtime_settings.snapshot().await;
            let next_due = if settings.auto_check_updates == Some(false) {
                None
            } else {
                match next_due_delay_from_database(pool.clone(), &settings).await {
                    Ok(delay) => delay,
                    Err(error) => {
                        log::warn!(
                            "Could not schedule next background game update check: {}",
                            error
                        );
                        // Avoid a tight retry loop when the database is temporarily unavailable.
                        Some(Duration::from_secs(5 * 60))
                    }
                }
            };

            match next_due {
                Some(delay) => {
                    log::debug!(
                        "[UpdateCheck] Scheduler waiting {} seconds for the next due environment or a state change",
                        delay.as_secs()
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        changed = changes.changed() => {
                            if changed.is_err() {
                                return;
                            }
                            log::debug!("[UpdateCheck] Scheduler woke after settings/environment change");
                        }
                        changed = environment_changes.changed() => {
                            if changed.is_err() {
                                return;
                            }
                            log::debug!("[UpdateCheck] Scheduler woke after durable environment mutation");
                        }
                    }
                }
                None => {
                    log::debug!(
                        "[UpdateCheck] Scheduler is idle until settings or environments change"
                    );
                    tokio::select! {
                        changed = changes.changed() => if changed.is_err() { return; },
                        changed = environment_changes.changed() => if changed.is_err() { return; },
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::SettingsService;
    use crate::types::{EnvironmentStatus, Runtime};

    #[test]
    fn unscheduled_environment_is_due_immediately() {
        let environment = Environment {
            id: "env-1".to_string(),
            name: "Test".to_string(),
            description: None,
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "C:/SIMM/test".to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        };

        assert_eq!(
            next_due_delay(&SettingsService::default_settings(), &[environment]),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn next_due_delay_uses_the_earliest_environment_deadline() {
        let settings = SettingsService::default_settings();
        let now = Utc::now();
        let mut later = Environment {
            id: "later".to_string(),
            name: "Later".to_string(),
            description: None,
            app_id: "3164500".to_string(),
            branch: "main".to_string(),
            output_dir: "C:/SIMM/later".to_string(),
            runtime: Runtime::Il2cpp,
            status: EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: Some(now),
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        };
        let mut earlier = later.clone();
        earlier.id = "earlier".to_string();
        earlier.last_update_check = Some(now - chrono::Duration::minutes(59));
        later.last_update_check = Some(now - chrono::Duration::minutes(30));

        assert_eq!(
            next_due_delay_at(&settings, &[later, earlier], now),
            Some(Duration::from_secs(60))
        );
    }

    #[test]
    fn next_due_delay_returns_none_for_empty_environments() {
        assert_eq!(
            next_due_delay(&SettingsService::default_settings(), &[]),
            None
        );
    }

    #[tokio::test]
    async fn environment_change_notification_is_retained_for_late_scheduler_receiver() {
        notify_environment_changed();
        let mut receiver = subscribe_environment_changes();
        notify_environment_changed();
        receiver
            .changed()
            .await
            .expect("environment change sender remains live");
        assert!(*receiver.borrow() >= 2);
    }
}
