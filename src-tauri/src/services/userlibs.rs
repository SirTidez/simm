use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Clone)]
pub struct UserLibsService;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserLibInfo {
    name: String,
    file_name: String,
    path: String,
    size: Option<u64>,
    is_directory: bool,
    disabled: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserLibsListResult {
    user_libs: Vec<UserLibInfo>,
    user_libs_directory: String,
    count: usize,
}

fn strip_disabled_suffix_case_insensitive(file_name: &str) -> Option<String> {
    let suffix = ".disabled";
    if file_name.to_ascii_lowercase().ends_with(suffix) {
        Some(file_name[..file_name.len() - suffix.len()].to_string())
    } else {
        None
    }
}

impl UserLibsService {
    pub fn new() -> Self {
        Self
    }

    fn get_user_libs_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("UserLibs")
    }

    fn resolve_user_lib_path(&self, output_dir: &str, user_lib_path: &str) -> Result<PathBuf> {
        let user_libs_directory = self.get_user_libs_directory(output_dir);
        let requested_path = PathBuf::from(user_lib_path);
        let normalized_path = if requested_path.is_absolute() {
            requested_path
        } else {
            user_libs_directory.join(requested_path)
        };

        let normalized_root = if user_libs_directory.exists() {
            user_libs_directory
                .canonicalize()
                .context("Failed to canonicalize UserLibs directory")?
        } else {
            user_libs_directory
        };

        let mut candidate_paths = vec![normalized_path.clone()];
        if let Some(file_name) = normalized_path.file_name().and_then(|value| value.to_str()) {
            if let Some(stripped_name) = strip_disabled_suffix_case_insensitive(file_name) {
                candidate_paths.push(normalized_path.with_file_name(stripped_name));
            } else {
                candidate_paths.push(normalized_path.with_file_name(format!("{file_name}.disabled")));
            }
        }

        let resolved_candidate = candidate_paths
            .into_iter()
            .find(|candidate| candidate.exists())
            .unwrap_or(normalized_path);

        let normalized_path = if resolved_candidate.exists() {
            resolved_candidate
                .canonicalize()
                .context("Failed to canonicalize user lib path")?
        } else {
            resolved_candidate
        };

        if normalized_path == normalized_root {
            return Err(anyhow::anyhow!(
                "UserLib path must point to a file or directory inside the UserLibs directory"
            ));
        }

        if !normalized_path.starts_with(&normalized_root) {
            return Err(anyhow::anyhow!("UserLib path must be within the UserLibs directory"));
        }

        Ok(normalized_path)
    }

    pub async fn list_user_libs(&self, game_dir: &str) -> Result<serde_json::Value> {
        let user_libs_directory = self.get_user_libs_directory(game_dir);

        if !user_libs_directory.exists() {
            return Ok(serde_json::json!({
                "userLibs": [],
                "userLibsDirectory": user_libs_directory.to_string_lossy().to_string(),
                "count": 0
            }));
        }

        let mut entries = fs::read_dir(&user_libs_directory)
            .await
            .context("Failed to read UserLibs directory")?;

        let mut user_libs = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = fs::metadata(&entry_path).await?;

            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let is_disabled = file_name.to_ascii_lowercase().ends_with(".disabled");
            let original_file_name = if is_disabled {
                strip_disabled_suffix_case_insensitive(file_name).unwrap_or_else(|| file_name.to_string())
            } else {
                file_name.to_string()
            };

            let size = if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            };

            user_libs.push(UserLibInfo {
                name: original_file_name.clone(),
                file_name: original_file_name,
                path: entry_path.to_string_lossy().to_string(),
                size,
                is_directory: metadata.is_dir(),
                disabled: Some(is_disabled),
            });
        }

        let result = UserLibsListResult {
            user_libs_directory: user_libs_directory.to_string_lossy().to_string(),
            count: user_libs.len(),
            user_libs,
        };

        Ok(serde_json::to_value(result)?)
    }

    pub async fn count_user_libs(&self, game_dir: &str) -> Result<u32> {
        let result = self.list_user_libs(game_dir).await?;
        let count = result.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        Ok(count)
    }

    pub async fn enable_user_lib(&self, game_dir: &str, user_lib_path: &str) -> Result<()> {
        let disabled_path = self.resolve_user_lib_path(game_dir, user_lib_path)?;
        let enabled_file_name = disabled_path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(strip_disabled_suffix_case_insensitive)
            .ok_or_else(|| anyhow::anyhow!("User lib is not disabled"))?;
        let enabled_path = disabled_path.with_file_name(enabled_file_name);

        if !disabled_path.exists() {
            return Err(anyhow::anyhow!("Disabled user lib file not found"));
        }

        if enabled_path.exists() {
            return Err(anyhow::anyhow!(
                "User lib file already exists (not disabled)"
            ));
        }

        // Verify it's actually a file or directory
        let metadata = fs::metadata(&disabled_path).await?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(anyhow::anyhow!("Path is not a file or directory"));
        }

        // Rename the file/directory back
        fs::rename(&disabled_path, &enabled_path)
            .await
            .context("Failed to enable user lib")?;

        Ok(())
    }

    pub async fn disable_user_lib(&self, game_dir: &str, user_lib_path: &str) -> Result<()> {
        let enabled_path = self.resolve_user_lib_path(game_dir, user_lib_path)?;
        let file_name = enabled_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid user lib path"))?;
        if strip_disabled_suffix_case_insensitive(file_name).is_some() {
            return Err(anyhow::anyhow!("User lib is already disabled"));
        }
        let disabled_path = enabled_path.with_file_name(format!(
            "{}.disabled",
            file_name
        ));

        if !enabled_path.exists() {
            return Err(anyhow::anyhow!("User lib file not found"));
        }

        if disabled_path.exists() {
            return Err(anyhow::anyhow!("User lib is already disabled"));
        }

        // Verify it's actually a file or directory
        let metadata = fs::metadata(&enabled_path).await?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(anyhow::anyhow!("Path is not a file or directory"));
        }

        // Rename the file/directory
        fs::rename(&enabled_path, &disabled_path)
            .await
            .context("Failed to disable user lib")?;

        Ok(())
    }
}

impl Default for UserLibsService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::UserLibsService;
    use anyhow::Result;
    use tempfile::tempdir;
    use tokio::fs;

    #[tokio::test]
    async fn list_and_count_userlibs_reflect_enabled_and_disabled_entries() -> Result<()> {
        let temp = tempdir()?;
        let service = UserLibsService::new();

        let userlibs_dir = temp.path().join("UserLibs");
        fs::create_dir_all(&userlibs_dir).await?;
        fs::write(userlibs_dir.join("LibA.dll"), b"data").await?;
        fs::write(userlibs_dir.join("LibB.dll.disabled"), b"data").await?;

        let listed = service
            .list_user_libs(temp.path().to_string_lossy().as_ref())
            .await?;
        let count = service
            .count_user_libs(temp.path().to_string_lossy().as_ref())
            .await?;

        assert_eq!(count, 2);
        let entries = listed
            .get("userLibs")
            .and_then(|v| v.as_array())
            .expect("entries");
        assert_eq!(entries.len(), 2);

        Ok(())
    }

    #[tokio::test]
    async fn disable_and_enable_userlib_rename_roundtrip() -> Result<()> {
        let temp = tempdir()?;
        let service = UserLibsService::new();

        let userlibs_dir = temp.path().join("UserLibs");
        fs::create_dir_all(&userlibs_dir).await?;
        fs::write(userlibs_dir.join("LibA.dll"), b"data").await?;

        service
            .disable_user_lib(
                temp.path().to_string_lossy().as_ref(),
                userlibs_dir.join("LibA.dll").to_string_lossy().as_ref(),
            )
            .await?;
        assert!(!userlibs_dir.join("LibA.dll").exists());
        assert!(userlibs_dir.join("LibA.dll.disabled").exists());

        service
            .enable_user_lib(
                temp.path().to_string_lossy().as_ref(),
                userlibs_dir
                    .join("LibA.dll.disabled")
                    .to_string_lossy()
                    .as_ref(),
            )
            .await?;
        assert!(userlibs_dir.join("LibA.dll").exists());
        assert!(!userlibs_dir.join("LibA.dll.disabled").exists());

        Ok(())
    }

    #[tokio::test]
    async fn disabled_directories_roundtrip_and_list_as_disabled() -> Result<()> {
        let temp = tempdir()?;
        let service = UserLibsService::new();

        let userlibs_dir = temp.path().join("UserLibs");
        fs::create_dir_all(userlibs_dir.join("SharedAssets.disabled")).await?;

        let listed = service
            .list_user_libs(temp.path().to_string_lossy().as_ref())
            .await?;
        let entries = listed
            .get("userLibs")
            .and_then(|v| v.as_array())
            .expect("entries");
        let entry = entries
            .iter()
            .find(|value| value.get("name").and_then(|name| name.as_str()) == Some("SharedAssets"))
            .expect("shared assets entry");

        assert_eq!(entry.get("disabled").and_then(|value| value.as_bool()), Some(true));
        assert_eq!(entry.get("fileName").and_then(|value| value.as_str()), Some("SharedAssets"));

        service
            .enable_user_lib(
                temp.path().to_string_lossy().as_ref(),
                userlibs_dir.join("SharedAssets").to_string_lossy().as_ref(),
            )
            .await?;

        assert!(userlibs_dir.join("SharedAssets").exists());
        assert!(!userlibs_dir.join("SharedAssets.disabled").exists());

        Ok(())
    }
}
