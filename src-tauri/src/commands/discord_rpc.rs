// Discord RPC commands module
// Static presence: "Schedule I Mod Manager (SIMM)"

use crate::discord_rpc::{initialize_discord, shutdown_discord};

/// Initialize Discord RPC with static presence
#[tauri::command]
pub async fn discord_initialize(application_id: String) -> Result<(), String> {
    log::info!("Initializing Discord RPC with static presence");

    match initialize_discord(&application_id) {
        Ok(_) => {
            log::info!("Discord RPC initialized with static presence");
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to initialize Discord RPC: {}", e);
            Err(format!("Failed to initialize: {}", e))
        }
    }
}

/// Shutdown Discord RPC connection
#[tauri::command]
pub async fn discord_shutdown() -> Result<(), String> {
    match shutdown_discord() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to shutdown: {}", e)),
    }
}
