// Discord Rich Presence module for Tauri application
// Static presence showing "Schedule I Mod Manager (SIMM)"

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use once_cell::sync::Lazy;
use std::error::Error;
use std::sync::Mutex;

static DISCORD_CLIENT: Lazy<Mutex<Option<DiscordIpcClient>>> = Lazy::new(|| Mutex::new(None));

/// Initialize Discord RPC with static presence
pub fn initialize_discord(application_id: &str) -> Result<(), Box<dyn Error>> {
    let mut client_guard = DISCORD_CLIENT.lock().unwrap();
    
    log::info!("[RPC] Initializing Discord with ID: {}", application_id);
    
    // Close existing connection if any
    if let Some(mut client) = client_guard.take() {
        let _ = client.close();
        log::info!("[RPC] Closed existing connection");
    }
    
    // Create new client - DiscordIpcClient::new returns the client directly (not a Result)
    let mut client = DiscordIpcClient::new(application_id);
    
    // Connect to Discord - this CAN fail, so we use ?
    client.connect()?;
    log::info!("[RPC] Connected to Discord");
    
    // Set static presence
    let activity = activity::Activity::new()
        .details("Schedule I Mod Manager")
        .assets(activity::Assets::new().large_image("app_logo"));
    
    client.set_activity(activity)?;
    log::info!("[RPC] Presence set: Schedule I Mod Manager");
    
    // Store client for later use
    *client_guard = Some(client);
    
    Ok(())
}

/// Shutdown Discord RPC connection
pub fn shutdown_discord() -> Result<(), Box<dyn Error>> {
    let mut client_guard = DISCORD_CLIENT.lock().unwrap();
    
    if let Some(mut client) = client_guard.take() {
        client.close()?;
        log::info!("[RPC] Discord disconnected");
    }
    
    Ok(())
}
