use crate::services::settings::SettingsService;
use crate::types::WindowCloseBehavior;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    HideToTray,
    Quit,
    AskFrontend,
}

fn close_action_for_behavior(behavior: &WindowCloseBehavior) -> CloseAction {
    match behavior {
        WindowCloseBehavior::Tray => CloseAction::HideToTray,
        WindowCloseBehavior::Quit => CloseAction::Quit,
        WindowCloseBehavior::Ask => CloseAction::AskFrontend,
    }
}

pub async fn handle_main_window_close(app: AppHandle) {
    let action = if let Some(pool) = app.try_state::<Arc<SqlitePool>>() {
        match SettingsService::new(pool.inner().clone()) {
            Ok(mut service) => match service.load_settings().await {
                Ok(settings) => {
                    close_action_for_behavior(&settings.window_close_behavior.unwrap_or_default())
                }
                Err(error) => {
                    log::warn!(
                        "Failed to load close behavior; hiding SIMM to the tray: {:#}",
                        error
                    );
                    CloseAction::HideToTray
                }
            },
            Err(error) => {
                log::warn!(
                    "Failed to initialize settings for close behavior; hiding SIMM to the tray: {:#}",
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
    use crate::types::WindowCloseBehavior;

    #[test]
    fn close_behavior_maps_to_the_expected_runtime_action() {
        assert_eq!(
            close_action_for_behavior(&WindowCloseBehavior::Tray),
            CloseAction::HideToTray
        );
        assert_eq!(
            close_action_for_behavior(&WindowCloseBehavior::Quit),
            CloseAction::Quit
        );
        assert_eq!(
            close_action_for_behavior(&WindowCloseBehavior::Ask),
            CloseAction::AskFrontend
        );
    }
}
