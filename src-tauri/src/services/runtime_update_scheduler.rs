use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::AppHandle;
use tokio::time::{Duration, MissedTickBehavior};

pub fn start(pool: Arc<SqlitePool>, app: AppHandle) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = crate::commands::update_check::run_background_update_checks(
                pool.clone(),
                app.clone(),
                false,
            )
            .await
            {
                log::warn!("Background game update check failed: {}", error);
            }
        }
    });
}
