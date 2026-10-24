use crate::{
    services::native_console::{self, NativeConsoleState},
    types::{NativeConsolePreferences, NativeConsoleSnapshot, NativeConsoleViewport},
};
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};

#[tauri::command]
pub async fn get_native_console_preferences(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<NativeConsolePreferences, String> {
    native_console::preferences(db.inner(), &environment_id)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn save_native_console_preferences(
    db: State<'_, Arc<SqlitePool>>,
    state: State<'_, NativeConsoleState>,
    environment_id: String,
    preferences: NativeConsolePreferences,
) -> Result<NativeConsolePreferences, String> {
    native_console::save_preferences(db.inner(), state.inner(), &environment_id, preferences)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn open_native_console(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    navigate: Option<bool>,
) -> Result<(), String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::open(
        &app,
        db.inner().clone(),
        &environment_id,
        navigate.unwrap_or(true),
    )
    .await
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn get_native_console_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    environment_id: String,
) -> Result<NativeConsoleSnapshot, String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::snapshot(&app, &environment_id)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn retry_native_console(
    app: AppHandle,
    window: WebviewWindow,
    environment_id: String,
) -> Result<(), String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::retry(&app, &environment_id)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn pop_out_native_console(
    app: AppHandle,
    window: WebviewWindow,
    environment_id: String,
) -> Result<(), String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::pop_out(&app, &environment_id)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn close_native_console_game(
    app: AppHandle,
    window: WebviewWindow,
    environment_id: String,
) -> Result<(), String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::close_game(&app, &environment_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_native_console_viewport(
    app: AppHandle,
    window: WebviewWindow,
    environment_id: String,
    viewport: NativeConsoleViewport,
) -> Result<(), String> {
    native_console::validate_caller(&window, &environment_id)?;
    native_console::update_viewport(&app, &environment_id, viewport)
        .map_err(|error| error.to_string())
}
