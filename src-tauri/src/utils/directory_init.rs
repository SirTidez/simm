use anyhow::{Context, Result};
use std::env;
use std::path::PathBuf;

/// Initialize the default SIMM directory structure in the user's home directory
/// Creates: home/SIMM/{downloads, backups, logs, depots}
/// Returns: (directory_path, was_just_created)
pub fn initialize_simm_directory() -> Result<(PathBuf, bool)> {
    let home_dir = resolve_home_dir()?;

    let simm_dir = home_dir.join("SIMM");

    // Check if directory already exists
    let was_just_created = !simm_dir.exists();

    // Create main SIMM directory
    std::fs::create_dir_all(&simm_dir).context("Failed to create SIMM directory")?;

    // Create subdirectories
    let downloads_dir = simm_dir.join("downloads");
    let backups_dir = simm_dir.join("backups");
    let logs_dir = simm_dir.join("logs");
    let depots_dir = simm_dir.join("depots");
    let mods_dir = simm_dir.join("Mods");

    std::fs::create_dir_all(&downloads_dir).context("Failed to create downloads directory")?;
    std::fs::create_dir_all(&backups_dir).context("Failed to create backups directory")?;
    std::fs::create_dir_all(&logs_dir).context("Failed to create logs directory")?;
    std::fs::create_dir_all(&depots_dir).context("Failed to create depots directory")?;
    std::fs::create_dir_all(&mods_dir).context("Failed to create Mods directory")?;

    Ok((simm_dir, was_just_created))
}

/// Get the Mods storage directory path
pub fn get_mods_storage_dir() -> Result<PathBuf> {
    let home_dir = resolve_home_dir()?;

    let mods_storage_dir = home_dir.join("SIMM").join("Mods");
    std::fs::create_dir_all(&mods_storage_dir)
        .context("Failed to create Mods storage directory")?;

    Ok(mods_storage_dir)
}

/// Get the depots directory path
pub fn get_depots_dir() -> Result<PathBuf> {
    let home_dir = resolve_home_dir()?;

    let depots_dir = home_dir.join("SIMM").join("depots");
    std::fs::create_dir_all(&depots_dir).context("Failed to create depots directory")?;

    Ok(depots_dir)
}

fn resolve_home_dir() -> Result<PathBuf> {
    if let Ok(override_dir) = env::var("SIMMRUST_HOME_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::tempdir;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    #[serial]
    fn initialize_simm_directory_creates_structure() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());

        let (simm_dir, was_created) = initialize_simm_directory()?;
        assert!(was_created);
        assert!(simm_dir.ends_with("SIMM"));
        assert!(simm_dir.join("downloads").exists());
        assert!(simm_dir.join("backups").exists());
        assert!(simm_dir.join("logs").exists());
        assert!(simm_dir.join("depots").exists());
        assert!(simm_dir.join("Mods").exists());

        let (_, was_created_again) = initialize_simm_directory()?;
        assert!(!was_created_again);

        Ok(())
    }

    #[test]
    #[serial]
    fn storage_and_depots_dirs_use_override() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());

        let mods_dir = get_mods_storage_dir()?;
        let depots_dir = get_depots_dir()?;

        assert_eq!(mods_dir, temp.path().join("SIMM").join("Mods"));
        assert_eq!(depots_dir, temp.path().join("SIMM").join("depots"));

        Ok(())
    }
}
