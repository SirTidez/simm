use crate::services::telemetry::TelemetryService;
use crate::types::TelemetryCloseBehavior;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    HideToTray,
    Quit,
    AskFrontend,
}

fn close_action_for_behavior(behavior: &TelemetryCloseBehavior) -> CloseAction {
    match behavior {
        TelemetryCloseBehavior::Tray => CloseAction::HideToTray,
        TelemetryCloseBehavior::Quit => CloseAction::Quit,
        TelemetryCloseBehavior::Ask => CloseAction::AskFrontend,
    }
}

pub async fn handle_main_window_close(app: AppHandle) {
    let action = if let Some(pool) = app.try_state::<Arc<SqlitePool>>() {
        let service = TelemetryService::new(pool.inner().clone());
        match service.get_preferences().await {
            Ok(preferences) => close_action_for_behavior(&preferences.close_behavior),
            Err(error) => {
                log::warn!(
                    "Failed to load close behavior; hiding SIMM to the tray: {:#}",
                    error
                );
                CloseAction::HideToTray
            }
        }
    } else {
        log::warn!("SIMM database is not ready during a close request; hiding to the tray");
        CloseAction::HideToTray
    };

    match action {
        CloseAction::HideToTray => {
            if let Err(error) = hide_main_window(app) {
                log::error!("Failed to hide SIMM to the tray: {}", error);
            }
        }
        CloseAction::Quit => app.exit(0),
        CloseAction::AskFrontend => {
            if let Err(error) = app.emit("simm_close_requested", serde_json::json!({})) {
                log::error!(
                    "Failed to request close behavior from the frontend: {}",
                    error
                );
                if let Err(error) = hide_main_window(app) {
                    log::error!(
                        "Failed to hide SIMM to the tray after close request failed: {}",
                        error
                    );
                }
            }
        }
    }
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quit_simm(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::{close_action_for_behavior, CloseAction};
    use crate::types::TelemetryCloseBehavior;

    #[test]
    fn close_behavior_maps_to_the_expected_runtime_action() {
        assert_eq!(
            close_action_for_behavior(&TelemetryCloseBehavior::Tray),
            CloseAction::HideToTray
        );
        assert_eq!(
            close_action_for_behavior(&TelemetryCloseBehavior::Quit),
            CloseAction::Quit
        );
        assert_eq!(
            close_action_for_behavior(&TelemetryCloseBehavior::Ask),
            CloseAction::AskFrontend
        );
    }
}
