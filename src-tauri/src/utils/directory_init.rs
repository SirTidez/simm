use std::path::PathBuf;
use anyhow::{Context, Result};

/// Initialize the default SIMM directory structure in the user's home directory
/// Creates: home/SIMM/{downloads, backups, logs, depots}
/// Returns: (directory_path, was_just_created)
pub fn initialize_simm_directory() -> Result<(PathBuf, bool)> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))?;

    let simm_dir = home_dir.join("SIMM");

    // Check if directory already exists
    let was_just_created = !simm_dir.exists();

    // Create main SIMM directory
    std::fs::create_dir_all(&simm_dir)
        .context("Failed to create SIMM directory")?;

    // Create subdirectories
    let downloads_dir = simm_dir.join("downloads");
    let backups_dir = simm_dir.join("backups");
    let logs_dir = simm_dir.join("logs");
    let depots_dir = simm_dir.join("depots");
    let mods_dir = simm_dir.join("Mods");

    std::fs::create_dir_all(&downloads_dir)
        .context("Failed to create downloads directory")?;
    std::fs::create_dir_all(&backups_dir)
        .context("Failed to create backups directory")?;
    std::fs::create_dir_all(&logs_dir)
        .context("Failed to create logs directory")?;
    std::fs::create_dir_all(&depots_dir)
        .context("Failed to create depots directory")?;
    std::fs::create_dir_all(&mods_dir)
        .context("Failed to create Mods directory")?;

    Ok((simm_dir, was_just_created))
}

/// Get the Mods storage directory path
pub fn get_mods_storage_dir() -> Result<PathBuf> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))?;
    
    let mods_storage_dir = home_dir.join("SIMM").join("Mods");
    std::fs::create_dir_all(&mods_storage_dir)
        .context("Failed to create Mods storage directory")?;
    
    Ok(mods_storage_dir)
}

/// Get the depots directory path
pub fn get_depots_dir() -> Result<PathBuf> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))?;

    let depots_dir = home_dir.join("SIMM").join("depots");
    std::fs::create_dir_all(&depots_dir)
        .context("Failed to create depots directory")?;

    Ok(depots_dir)
}

