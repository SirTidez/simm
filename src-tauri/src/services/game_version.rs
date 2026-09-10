use anyhow::{Context, Result};
use regex::Regex;
use std::path::Path;
use tokio::fs;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

pub struct GameVersionService;

impl GameVersionService {
    pub fn new() -> Self {
        Self
    }

    fn is_unity_editor_version(&self, version: &str) -> bool {
        let unity_editor_pattern = Regex::new(r"^20\d{2}\.").unwrap();
        unity_editor_pattern.is_match(version)
    }

    fn is_game_version(&self, version: &str) -> bool {
        if self.is_unity_editor_version(version) {
            eprintln!(
                "[GameVersion] Version {} is Unity editor version, rejecting",
                version
            );
            return false;
        }

        let game_version_pattern = Regex::new(r"^[01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*$").unwrap();
        let matches = game_version_pattern.is_match(version);
        if !matches {
            eprintln!(
                "[GameVersion] Version {} does not match game version pattern",
                version
            );
        }
        matches
    }

    pub async fn extract_game_version(&self, game_dir: &str) -> Result<Option<String>> {
        eprintln!("[GameVersion] Extracting version from: {}", game_dir);
        let game_path = Path::new(game_dir);

        if !game_path.exists() {
            eprintln!("[GameVersion] Game directory does not exist: {}", game_dir);
            return Ok(None);
        }

        eprintln!("[GameVersion] Reading globalgamemanagers...");
        let version = self
            .extract_version_from_global_game_managers(game_path)
            .await?;

        if let Some(version) = &version {
            eprintln!(
                "[GameVersion] Found version in globalgamemanagers: {}",
                version
            );
        } else {
            eprintln!("[GameVersion] No version found in globalgamemanagers");
        }

        Ok(version)
    }

    async fn extract_version_from_global_game_managers(
        &self,
        game_dir: &Path,
    ) -> Result<Option<String>> {
        const DATA_FOLDERS: [&str; 5] = [
            "Schedule I_Data",
            "ScheduleI_Data",
            "Schedule1_Data",
            "Game_Data",
            "Data",
        ];

        let game_version_pattern = Regex::new(r"\b([01]\.[0-9]+\.[0-9]+[a-z]?[0-9]*)\b")
            .context("Failed to compile game version regex")?;

        for data_folder_name in DATA_FOLDERS {
            let global_game_managers_path =
                game_dir.join(data_folder_name).join("globalgamemanagers");
            if !global_game_managers_path.is_file() {
                continue;
            }

            eprintln!(
                "[GameVersion] Found globalgamemanagers: {:?}",
                global_game_managers_path
            );
            let bytes = fs::read(&global_game_managers_path)
                .await
                .with_context(|| {
                    format!(
                        "Failed to read globalgamemanagers at {}",
                        global_game_managers_path.display()
                    )
                })?;
            let search_len = std::cmp::min(bytes.len(), 2 * 1024 * 1024);
            let text = String::from_utf8_lossy(&bytes[..search_len]);

            for captures in game_version_pattern.captures_iter(&text) {
                let Some(version) = captures.get(1).map(|capture| capture.as_str()) else {
                    continue;
                };
                if self.is_game_version(version) {
                    return Ok(Some(version.to_string()));
                }
            }
        }

        Ok(None)
    }
}

impl Default for GameVersionService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn extracts_game_version_from_global_game_managers() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let data_dir = temp.path().join("Schedule I_Data");
        fs::create_dir_all(&data_dir).await?;
        fs::write(
            data_dir.join("globalgamemanagers"),
            b"Unity 2022.3.62f2\0Schedule I 0.4.5f2\0",
        )
        .await?;

        let version = GameVersionService::new()
            .extract_game_version(&temp.path().to_string_lossy())
            .await?;

        assert_eq!(version.as_deref(), Some("0.4.5f2"));
        Ok(())
    }

    #[tokio::test]
    async fn ignores_versions_outside_global_game_managers() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let data_dir = temp.path().join("Schedule I_Data");
        fs::create_dir_all(data_dir.join("Managed")).await?;
        fs::write(temp.path().join("version.txt"), b"0.4.5f2").await?;
        fs::write(data_dir.join("app.info"), b"0.4.5f2").await?;
        fs::write(data_dir.join("globalgamemanagers.assets"), b"0.4.5f2").await?;
        fs::write(data_dir.join("Managed/Assembly-CSharp.dll"), b"0.4.5f2").await?;

        let version = GameVersionService::new()
            .extract_game_version(&temp.path().to_string_lossy())
            .await?;

        assert_eq!(version, None);
        Ok(())
    }
}
