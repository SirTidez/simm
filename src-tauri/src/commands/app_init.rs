use tauri::State;

/// Check if the SIMM directory was just created on this app launch
#[tauri::command]
pub async fn was_simm_directory_just_created(
    startup_state: State<'_, crate::types::AppStartupState>,
) -> Result<bool, String> {
    Ok(startup_state.simm_directory_created)
}

#[tauri::command]
pub async fn get_app_startup_state(
    startup_state: State<'_, crate::types::AppStartupState>,
) -> Result<crate::types::AppStartupState, String> {
    Ok(startup_state.inner().clone())
}

/// Get the user's home directory path
#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Mark that the user has seen the welcome message (so we don't show it again)
#[allow(dead_code)]
#[tauri::command]
pub async fn mark_welcome_message_seen() -> Result<(), String> {
    // This could be stored in settings if we want to persist it
    // For now, we'll just use the was_created flag which resets on each launch
    Ok(())
}
