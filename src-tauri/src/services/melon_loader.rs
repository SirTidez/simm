use anyhow::{Context, Result};
use std::io::Read;
use std::path::Path;
use tokio::fs;
use zip::ZipArchive;

#[derive(Clone)]
pub struct MelonLoaderService;

impl MelonLoaderService {
    pub fn new() -> Self {
        Self
    }

    pub fn is_melon_loader_installed(&self, game_dir: &str) -> bool {
        let game_path = Path::new(game_dir);

        // Check for version.dll in root (case-insensitive check)
        let version_dll_lower = game_path.join("version.dll");
        let version_dll_upper = game_path.join("Version.dll");

        // Check for MelonLoader folder
        let melon_loader_folder = game_path.join("MelonLoader");

        let has_version_dll = version_dll_lower.exists() || version_dll_upper.exists();
        let has_melon_loader_folder = melon_loader_folder.exists() && melon_loader_folder.is_dir();

        // MelonLoader is installed if both version.dll and MelonLoader folder exist
        has_version_dll && has_melon_loader_folder
    }

    pub async fn get_installed_version(&self, game_dir: &str) -> Result<Option<String>> {
        if !self.is_melon_loader_installed(game_dir) {
            return Ok(None);
        }

        let melon_loader_folder = Path::new(game_dir).join("MelonLoader");

        // Try to read version from version.txt file
        let version_file = melon_loader_folder.join("version.txt");
        if version_file.exists() {
            match fs::read_to_string(&version_file).await {
                Ok(content) => {
                    let version = content.trim().to_string();
                    if !version.is_empty() {
                        return Ok(Some(version));
                    }
                }
                Err(_) => {}
            }
        }

        // Try to extract from version.dll using PowerShell (Windows)
        #[cfg(target_os = "windows")]
        {
            let version_dll = Path::new(game_dir).join("version.dll");
            if version_dll.exists() {
                if let Ok(version) = self.extract_version_from_dll(&version_dll).await {
                    return Ok(Some(version));
                }
            }
        }

        Ok(None)
    }

    #[cfg(target_os = "windows")]
    async fn extract_version_from_dll(&self, dll_path: &Path) -> Result<String> {
        #[allow(unused_imports)] // Required for CommandExt trait methods
        use std::os::windows::process::CommandExt;
        use tokio::process::Command;

        let path_str = dll_path.to_string_lossy().replace('\'', "''");
        let output = Command::new("powershell")
            .arg("-Command")
            .arg(&format!(
                "(Get-Item '{}').VersionInfo.FileVersion",
                path_str
            ))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
            .output()
            .await
            .context("Failed to execute PowerShell command")?;

        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !version.is_empty() && version != "null" {
                return Ok(version);
            }
        }

        Err(anyhow::anyhow!("Failed to extract version from DLL"))
    }

    pub async fn install_melon_loader(
        &self,
        game_dir: &str,
        zip_path: &str,
    ) -> Result<serde_json::Value> {
        let game_path = Path::new(game_dir);
        let zip_file_path = Path::new(zip_path);

        if !zip_file_path.exists() {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("MelonLoader zip file not found: {}", zip_path)
            }));
        }

        if !game_path.exists() {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("Game directory does not exist: {}", game_dir)
            }));
        }

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir().join(format!(
            "melonloader-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ));

        fs::create_dir_all(&temp_dir)
            .await
            .context("Failed to create temp directory")?;

        let installed_files = match self
            .extract_and_install(&zip_file_path, game_path, &temp_dir)
            .await
        {
            Ok(files) => files,
            Err(e) => {
                let _ = fs::remove_dir_all(&temp_dir).await;
                return Ok(serde_json::json!({
                    "success": false,
                    "error": e.to_string()
                }));
            }
        };

        // Clean up temp directory
        let _ = fs::remove_dir_all(&temp_dir).await;

        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files
        }))
    }

    async fn extract_and_install(
        &self,
        zip_path: &Path,
        game_dir: &Path,
        temp_dir: &Path,
    ) -> Result<Vec<String>> {
        let file = std::fs::File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        // Extract all files to temp directory
        // First, collect all file data synchronously (before any await)
        let mut file_data = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;

            let file_name = file.name().to_string();
            let is_dir = file_name.ends_with('/');

            let mut buffer = Vec::new();
            if !is_dir {
                file.read_to_end(&mut buffer)
                    .context("Failed to read file data from archive")?;
            }

            file_data.push((file_name, is_dir, buffer));
        }

        // Now do async operations with the collected data
        for (file_name, is_dir, buffer) in file_data {
            let outpath = temp_dir.join(&file_name);

            if is_dir {
                fs::create_dir_all(&outpath).await?;
            } else {
                if let Some(p) = outpath.parent() {
                    fs::create_dir_all(p).await?;
                }
                let mut outfile = fs::File::create(&outpath).await?;
                tokio::io::AsyncWriteExt::write_all(&mut outfile, &buffer).await?;
            }
        }

        // Copy all items from temp_dir root to game_dir root
        let mut installed_files = Vec::new();
        let mut entries = fs::read_dir(temp_dir).await?;

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = game_dir.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_recursive(&entry_path, &dest_path)).await?;
                installed_files.push(format!("{}/", file_name));
            } else {
                fs::copy(&entry_path, &dest_path).await?;
                installed_files.push(file_name.to_string());
            }
        }

        Ok(installed_files)
    }

    async fn copy_directory_recursive(&self, source: &Path, dest: &Path) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = dest.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_recursive(&entry_path, &dest_path)).await?;
            } else {
                fs::copy(&entry_path, &dest_path).await?;
            }
        }

        Ok(())
    }

    pub async fn uninstall_melon_loader(&self, game_dir: &str) -> Result<serde_json::Value> {
        let game_path = Path::new(game_dir);

        // Remove version.dll (check both cases)
        let version_dll_lower = game_path.join("version.dll");
        let version_dll_upper = game_path.join("Version.dll");

        if version_dll_lower.exists() {
            fs::remove_file(&version_dll_lower).await?;
        }
        if version_dll_upper.exists() {
            fs::remove_file(&version_dll_upper).await?;
        }

        // Remove MelonLoader folder
        let melon_loader_folder = game_path.join("MelonLoader");
        if melon_loader_folder.exists() {
            fs::remove_dir_all(&melon_loader_folder).await?;
        }

        Ok(serde_json::json!({
            "success": true,
            "message": "MelonLoader uninstalled successfully"
        }))
    }
}

impl Default for MelonLoaderService {
    fn default() -> Self {
        Self::new()
    }
}
