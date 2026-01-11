use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::io::Read;
use std::fs::File;
use anyhow::{Context, Result};
use tokio::fs;
use tokio::process::Command;
use regex::Regex;
use zip::ZipArchive;
use unrar::Archive;
use chrono::Utc;
use uuid::Uuid;
use crate::types::{ModMetadata, ModSource};
use crate::services::settings::SettingsService;

#[derive(Clone)]
pub struct ModsService;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModInfo {
    name: String,
    file_name: String,
    path: String,
    version: Option<String>,
    source: Option<ModSource>,
    source_url: Option<String>,
    disabled: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModsListResult {
    mods: Vec<ModInfo>,
    mods_directory: String,
    count: usize,
}

impl ModsService {
    pub fn new() -> Self {
        Self
    }

    fn get_mods_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Mods")
    }

    fn get_plugins_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Plugins")
    }

    fn is_s1api_component_file(&self, file_name: &str) -> bool {
        let lower_name = file_name.to_lowercase();
        lower_name == "s1api.mono.melonloader.dll"
            || lower_name == "s1api.il2cpp.melonloader.dll"
            || (lower_name.starts_with("s1api") && lower_name.ends_with(".dll") && lower_name.contains('.'))
    }

    /// Generate a unique mod ID for mod storage
    fn generate_mod_id(&self) -> String {
        Uuid::new_v4().to_string()
    }

    /// Find existing mod installation by source_id and source_version
    /// Returns the mod_storage_id if found, None otherwise
    pub async fn find_existing_mod_installation(&self, game_dir: &str, source_id: &Option<String>, source_version: &Option<String>) -> Result<Option<String>> {
        if source_id.is_none() || source_version.is_none() {
            // Can't match without source_id and source_version
            return Ok(None);
        }

        let mods_directory = self.get_mods_directory(game_dir);
        let mod_metadata = self.load_mod_metadata(&mods_directory).await?;

        // Search through metadata to find a matching mod
        for (_, meta) in mod_metadata.iter() {
            if let (Some(existing_source_id), Some(existing_source_version), Some(existing_storage_id)) = 
                (&meta.source_id, &meta.source_version, &meta.mod_storage_id) {
                if existing_source_id == source_id.as_ref().unwrap() && 
                   existing_source_version == source_version.as_ref().unwrap() {
                    eprintln!("[DEBUG] Found existing installation of {} version {} with storage_id: {}", 
                        existing_source_id, existing_source_version, existing_storage_id);
                    return Ok(Some(existing_storage_id.clone()));
                }
            }
        }

        Ok(None)
    }

    /// Get the mods storage directory from settings
    async fn get_mods_storage_dir(&self) -> Result<PathBuf> {
        let mut settings_service = SettingsService::new()
            .context("Failed to create settings service")?;
        let settings = settings_service.load_settings().await
            .context("Failed to load settings")?;
        
        let storage_dir = PathBuf::from(settings.default_download_dir).join("Mods");
        fs::create_dir_all(&storage_dir).await
            .context("Failed to create mods storage directory")?;
        Ok(storage_dir)
    }

    /// Creates a symbolic link for a file.
    pub async fn create_symlink_file(&self, src: &Path, dst: &Path) -> Result<()> {
        let src_owned = src.to_owned();
        let dst_owned = dst.to_owned();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                std::os::windows::fs::symlink_file(&src_owned, &dst_owned)
                    .context(format!("Failed to create file symlink from {:?} to {:?}", src_owned, dst_owned))?;
            }
            #[cfg(target_os = "unix")]
            {
                std::os::unix::fs::symlink(&src_owned, &dst_owned)
                    .context(format!("Failed to create file symlink from {:?} to {:?}", src_owned, dst_owned))?;
            }
            Ok(())
        }).await?
    }

    /// Creates a symbolic link for a directory.
    pub async fn create_symlink_dir(&self, src: &Path, dst: &Path) -> Result<()> {
        let src_owned = src.to_owned();
        let dst_owned = dst.to_owned();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                std::os::windows::fs::symlink_dir(&src_owned, &dst_owned)
                    .context(format!("Failed to create directory symlink from {:?} to {:?}", src_owned, dst_owned))?;
            }
            #[cfg(target_os = "unix")]
            {
                std::os::unix::fs::symlink(&src_owned, &dst_owned)
                    .context(format!("Failed to create directory symlink from {:?} to {:?}", src_owned, dst_owned))?;
            }
            Ok(())
        }).await?
    }

    /// Removes a symbolic link.
    pub async fn remove_symlink(&self, path: &Path) -> Result<()> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            #[cfg(target_os = "windows")]
            {
                let metadata = std::fs::symlink_metadata(&path_owned)
                    .context(format!("Failed to read metadata for {:?}", path_owned))?;
                if metadata.file_type().is_dir() {
                    std::fs::remove_dir(&path_owned)
                        .context(format!("Failed to remove directory symlink: {:?}", path_owned))?;
                } else {
                    std::fs::remove_file(&path_owned)
                        .context(format!("Failed to remove file symlink: {:?}", path_owned))?;
                }
            }
            #[cfg(target_os = "unix")]
            {
                std::fs::remove_file(&path_owned)
                    .context(format!("Failed to remove symlink: {:?}", path_owned))?;
            }
            Ok(())
        }).await?
    }

    /// Checks if a path is a symbolic link.
    pub async fn is_symlink(&self, path: &Path) -> Result<bool> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let metadata = std::fs::symlink_metadata(&path_owned)
                .context(format!("Failed to read metadata for {:?}", path_owned))?;
            Ok(metadata.file_type().is_symlink())
        }).await?
    }

    /// Resolves a symbolic link to its target path.
    pub async fn resolve_symlink(&self, path: &Path) -> Result<PathBuf> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || {
            std::fs::read_link(&path_owned)
                .context(format!("Failed to resolve symlink: {:?}", path_owned))
        }).await?
    }

    pub async fn load_mod_metadata(&self, mods_directory: &Path) -> Result<HashMap<String, ModMetadata>> {
        let metadata_file = mods_directory.join(".mods-metadata.json");
        
        if !metadata_file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&metadata_file).await
            .context("Failed to read mod metadata file")?;
        
        let metadata: HashMap<String, ModMetadata> = serde_json::from_str(&content)
            .context("Failed to parse mod metadata file")?;
        
        Ok(metadata)
    }

    pub async fn save_mod_metadata(&self, mods_directory: &Path, metadata: &HashMap<String, ModMetadata>) -> Result<()> {
        let metadata_file = mods_directory.join(".mods-metadata.json");
        let content = serde_json::to_string_pretty(metadata)
            .context("Failed to serialize mod metadata")?;
        fs::write(&metadata_file, content).await
            .context("Failed to write mod metadata file")?;
        Ok(())
    }

    pub async fn extract_mod_version(&self, dll_path: &Path) -> Option<String> {
        // Method 1: Use PowerShell on Windows to get file version
        #[cfg(target_os = "windows")]
        {
            if let Ok(version) = self.extract_version_powershell(dll_path).await {
                if !version.is_empty() && version != "null" {
                    return Some(version);
                }
            }
        }

        // Method 2: Try to read version from DLL binary
        if let Ok(version) = self.extract_version_from_binary(dll_path).await {
            return Some(version);
        }

        None
    }

    #[cfg(target_os = "windows")]
    async fn extract_version_powershell(&self, dll_path: &Path) -> Result<String> {
        let path_str = dll_path.to_string_lossy().replace('\'', "''");

        let _output = Command::new("powershell")
            .arg("-Command")
            .arg(&format!("(Get-Item '{}').VersionInfo.FileVersion", path_str))
            .output()
            .await
            .context("Failed to execute PowerShell command")?;

        if _output.status.success() {
            let version = String::from_utf8_lossy(&_output.stdout).trim().to_string();
            if !version.is_empty() && version != "null" {
                return Ok(version);
            }
        }

        Err(anyhow::anyhow!("PowerShell version extraction failed"))
    }

    async fn extract_version_from_binary(&self, dll_path: &Path) -> Result<String> {
        let content = fs::read(dll_path).await
            .context("Failed to read DLL file")?;
        
        // Read first 1MB to search for version strings
        let search_len = std::cmp::min(content.len(), 1024 * 1024);
        let text = String::from_utf8_lossy(&content[..search_len]);
        
        // Look for AssemblyVersion or AssemblyFileVersion
        let assembly_version_re = Regex::new(r#"AssemblyVersion[^\x00]*?([0-9]+\.[0-9]+(?:\.[0-9]+(?:\.[0-9]+)?)?)"#)
            .context("Failed to compile regex")?;
        
        if let Some(caps) = assembly_version_re.captures(&text) {
            if let Some(version) = caps.get(1) {
                return Ok(version.as_str().to_string());
            }
        }
        
        let file_version_re = Regex::new(r#"AssemblyFileVersion[^\x00]*?([0-9]+\.[0-9]+(?:\.[0-9]+(?:\.[0-9]+)?)?)"#)
            .context("Failed to compile regex")?;
        
        if let Some(caps) = file_version_re.captures(&text) {
            if let Some(version) = caps.get(1) {
                return Ok(version.as_str().to_string());
            }
        }
        
        // Fallback: look for any version-like pattern
        let version_pattern = Regex::new(r#"\b([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)\b"#)
            .context("Failed to compile regex")?;
        
        for cap in version_pattern.captures_iter(&text) {
            if let Some(version) = cap.get(1) {
                let version_str = version.as_str();
                let parts: Vec<&str> = version_str.split('.').collect();
                // Avoid very large numbers that might be timestamps
                if parts.len() >= 2 {
                    if let Ok(major) = parts[0].parse::<u32>() {
                        if major < 1000 {
                            return Ok(version_str.to_string());
                        }
                    }
                }
            }
        }

        Err(anyhow::anyhow!("No version found in DLL binary"))
    }

    pub async fn list_mods(&self, game_dir: &str) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);
        
        if !mods_directory.exists() {
            return Ok(serde_json::json!({
                "mods": [],
                "modsDirectory": mods_directory.to_string_lossy().to_string(),
                "count": 0
            }));
        }

        let mut entries = fs::read_dir(&mods_directory).await
            .context("Failed to read Mods directory")?;

        let mut dll_files = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                // Extract file name from path before converting to string
                let file_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let path_string = path.to_string_lossy().to_string();
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    dll_files.push((path_string, file_name.to_string()));
                }
            }
        }

        // Load metadata
        let metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        let mut mods = Vec::new();
        for (file_path, file_name) in dll_files {
            let is_disabled = file_name.to_lowercase().ends_with(".disabled");
            let original_file_name = if is_disabled {
                file_name.replace(".disabled", "")
            } else {
                file_name.clone()
            };

            // Skip S1API component files
            if self.is_s1api_component_file(&original_file_name) {
                continue;
            }

            let mod_name = original_file_name
                .replace(".dll", "")
                .replace(".DLL", "");

            // Get metadata
            let file_metadata = metadata.get(&original_file_name)
                .or_else(|| metadata.get(&file_name))
                .cloned();

            // Extract version if not disabled and not in metadata
            // Prefer source_version (from Thunderstore) over installed_version (extracted from DLL)
            let version = if let Some(ref meta) = file_metadata {
                meta.source_version.clone().or(meta.installed_version.clone())
            } else if !is_disabled {
                self.extract_mod_version(Path::new(&file_path)).await
            } else {
                None
            };

            let source = file_metadata.as_ref()
                .and_then(|m| m.source.clone());
            let source_url = file_metadata.as_ref()
                .and_then(|m| m.source_url.clone());

            mods.push(ModInfo {
                name: mod_name.clone(),
                file_name: original_file_name,
                path: file_path,
                version,
                source,
                source_url,
                disabled: Some(is_disabled),
            });
        }

        let result = ModsListResult {
            mods_directory: mods_directory.to_string_lossy().to_string(),
            count: mods.len(),
            mods,
        };

        Ok(serde_json::to_value(result)?)
    }

    pub async fn count_mods(&self, game_dir: &str) -> Result<u32> {
        let result = self.list_mods(game_dir).await?;
        let mut count = result.get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        
        // Check if S1API is installed and add it to the count
        // S1API is shown separately in the UI but should be counted as a mod
        let mods_directory = self.get_mods_directory(game_dir);
        if mods_directory.exists() {
            let mono_file = mods_directory.join("S1API.Mono.MelonLoader.dll");
            let il2cpp_file = mods_directory.join("S1API.IL2CPP.MelonLoader.dll");
            let mono_disabled = mods_directory.join("S1API.Mono.MelonLoader.dll.disabled");
            let il2cpp_disabled = mods_directory.join("S1API.IL2CPP.MelonLoader.dll.disabled");
            
            if mono_file.exists() || il2cpp_file.exists() || mono_disabled.exists() || il2cpp_disabled.exists() {
                count += 1; // Count S1API as 1 mod
            }
        }
        
        Ok(count)
    }

    pub async fn delete_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let mod_path = mods_directory.join(mod_file_name);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        let file_to_delete = if mod_path.exists() {
            mod_path
        } else if disabled_path.exists() {
            disabled_path
        } else {
            return Err(anyhow::anyhow!("Mod file not found"));
        };

        // Verify it's actually a file
        let metadata = fs::metadata(&file_to_delete).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        fs::remove_file(&file_to_delete).await
            .context("Failed to delete mod file")?;

        // Remove from metadata
        let mut metadata_map = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());
        metadata_map.remove(mod_file_name);
        self.save_mod_metadata(&mods_directory, &metadata_map).await?;

        Ok(())
    }

    pub async fn disable_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let mod_path = mods_directory.join(mod_file_name);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        if !mod_path.exists() {
            return Err(anyhow::anyhow!("Mod file not found"));
        }

        if disabled_path.exists() {
            return Err(anyhow::anyhow!("Mod is already disabled"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&mod_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file
        fs::rename(&mod_path, &disabled_path).await
            .context("Failed to disable mod")?;

        Ok(())
    }

    pub async fn enable_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));
        let mod_path = mods_directory.join(mod_file_name);

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        if !disabled_path.exists() {
            return Err(anyhow::anyhow!("Disabled mod file not found"));
        }

        if mod_path.exists() {
            return Err(anyhow::anyhow!("Mod file already exists (not disabled)"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&disabled_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file back
        fs::rename(&disabled_path, &mod_path).await
            .context("Failed to enable mod")?;

        Ok(())
    }

    pub async fn install_zip_mod(&self, game_dir: &str, zip_path: &str, _file_name: &str, runtime: &str, _branch: &str, metadata: Option<serde_json::Value>) -> Result<serde_json::Value> {
        eprintln!("[DEBUG] install_zip_mod: Starting symlink-based installation");
        eprintln!("[DEBUG] install_zip_mod called with runtime: '{}'", runtime);

        // Create game directories if they don't exist (for symlinks)
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);
        let userlibs_directory = Path::new(game_dir).join("UserLibs");

        fs::create_dir_all(&mods_directory).await?;
        fs::create_dir_all(&plugins_directory).await?;
        fs::create_dir_all(&userlibs_directory).await?;

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir()
            .join(format!("mod-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));

        fs::create_dir_all(&temp_dir).await?;

        // Check for Thunderstore manifest.json
        let archive_path = Path::new(zip_path);
        let thunderstore_manifest = self.extract_thunderstore_manifest(archive_path);

        // If we found a Thunderstore manifest, log it and prepare to use it
        let mut effective_metadata = metadata.clone();
        if let Some(ref manifest) = thunderstore_manifest {
            eprintln!("[DEBUG] Found Thunderstore manifest.json");
            eprintln!("[DEBUG] Manifest contents: {}", serde_json::to_string_pretty(manifest).unwrap_or_default());

            // Override metadata with Thunderstore data
            let mut ts_metadata = serde_json::Map::new();
            ts_metadata.insert("source".to_string(), serde_json::Value::String("thunderstore".to_string()));

            if let Some(name) = manifest.get("name").and_then(|v| v.as_str()) {
                ts_metadata.insert("modName".to_string(), serde_json::Value::String(name.to_string()));
            }

            if let Some(version) = manifest.get("version_number").and_then(|v| v.as_str()) {
                ts_metadata.insert("sourceVersion".to_string(), serde_json::Value::String(version.to_string()));
            }

            if let Some(author) = manifest.get("author").and_then(|v| v.as_str()) {
                ts_metadata.insert("author".to_string(), serde_json::Value::String(author.to_string()));
            }

            if let Some(website) = manifest.get("website_url").and_then(|v| v.as_str()) {
                ts_metadata.insert("sourceUrl".to_string(), serde_json::Value::String(website.to_string()));
            }

            // Create source ID from author/name
            if let (Some(author), Some(name)) = (
                manifest.get("author").and_then(|v| v.as_str()),
                manifest.get("name").and_then(|v| v.as_str())
            ) {
                let source_id = format!("{}/{}", author, name);
                ts_metadata.insert("sourceId".to_string(), serde_json::Value::String(source_id));
            }

            effective_metadata = Some(serde_json::Value::Object(ts_metadata));
        }

        // Extract source_id and source_version for duplicate detection
        let source_id = effective_metadata
            .as_ref()
            .and_then(|m| m.get("sourceId").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let source_version = effective_metadata
            .as_ref()
            .and_then(|m| m.get("sourceVersion").and_then(|s| s.as_str()).map(|s| s.to_string()));

        // Check if we already have this mod/version installed
        let existing_mod_id = self.find_existing_mod_installation(game_dir, &source_id, &source_version).await?;
        
        // If mod is already installed, skip extraction and just ensure symlinks exist
        if let Some(existing_id) = existing_mod_id {
            eprintln!("[DEBUG] install_zip_mod: Mod/version already installed with mod_id: {}, skipping extraction", existing_id);
            
            let mod_storage_dir = self.get_mods_storage_dir().await?;
            let mod_storage_base = mod_storage_dir.join(&existing_id);
            let mod_storage_mods = mod_storage_base.join("Mods");
            let mod_storage_plugins = mod_storage_base.join("Plugins");
            let mod_storage_userlibs = mod_storage_base.join("UserLibs");
            
            // Clean up temp directory (we don't need it)
            let _ = fs::remove_dir_all(&temp_dir).await;
            
            // Create symlinks if they don't exist (skip extraction)
            let mut symlink_paths = Vec::new();
            
            // For Mods directory - create symlinks if they don't exist
            if mod_storage_mods.exists() {
                let mut entries = fs::read_dir(&mod_storage_mods).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    if metadata.is_file() {
                        let file_name = entry_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        let symlink_path = mods_directory.join(file_name);
                        
                        // Only create symlink if it doesn't exist
                        if !symlink_path.exists() {
                            eprintln!("[DEBUG] install_zip_mod: Creating symlink for already-installed file: {:?} -> {:?}", entry_path, symlink_path);
                            if let Ok(_) = self.create_symlink_file(&entry_path, &symlink_path).await {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            // Symlink already exists
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
            
            // Similar logic for Plugins and UserLibs
            if mod_storage_plugins.exists() {
                let mut entries = fs::read_dir(&mod_storage_plugins).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    if metadata.is_file() {
                        let file_name = entry_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        let symlink_path = plugins_directory.join(file_name);
                        if !symlink_path.exists() {
                            if let Ok(_) = self.create_symlink_file(&entry_path, &symlink_path).await {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
            
            if mod_storage_userlibs.exists() {
                let mut entries = fs::read_dir(&mod_storage_userlibs).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    let file_name = entry_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    let symlink_path = userlibs_directory.join(file_name);
                    if metadata.is_dir() {
                        if !symlink_path.exists() {
                            if let Ok(_) = self.create_symlink_dir(&entry_path, &symlink_path).await {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    } else if metadata.is_file() {
                        if !symlink_path.exists() {
                            if let Ok(_) = self.create_symlink_file(&entry_path, &symlink_path).await {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
            
            // Return success - mod is already installed, symlinks verified
            return Ok(serde_json::json!({
                "success": true,
                "message": "Mod already installed, symlinks verified",
                "alreadyInstalled": true
            }));
        }
        
        // New installation - generate new mod_id and proceed with normal flow
        let mod_id = self.generate_mod_id();
        eprintln!("[DEBUG] install_zip_mod: Generated new mod_id: {}", mod_id);

        // Get mod storage directory
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let mod_storage_base = mod_storage_dir.join(&mod_id);
        let mod_storage_mods = mod_storage_base.join("Mods");
        let mod_storage_plugins = mod_storage_base.join("Plugins");
        let mod_storage_userlibs = mod_storage_base.join("UserLibs");
        
        // Create mod storage directories
        fs::create_dir_all(&mod_storage_mods).await
            .context("Failed to create mod storage Mods directory")?;
        fs::create_dir_all(&mod_storage_plugins).await
            .context("Failed to create mod storage Plugins directory")?;
        fs::create_dir_all(&mod_storage_userlibs).await
            .context("Failed to create mod storage UserLibs directory")?;

        // Detect file type and call appropriate extraction function
        let file_ext = archive_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        eprintln!("[DEBUG] Archive file: {}", zip_path);
        eprintln!("[DEBUG] Detected extension: {}", file_ext);

        // Extract to storage (extraction methods now copy to mod_storage_base instead of game directories)
        let installed_files = match file_ext.as_str() {
            "rar" => {
                eprintln!("[DEBUG] Using RAR extraction");
                match self.extract_and_install_rar(archive_path, &mod_storage_mods, &mod_storage_plugins, &mod_storage_userlibs, &temp_dir, runtime).await {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("RAR extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
            "zip" | _ => {
                eprintln!("[DEBUG] Using ZIP extraction");
                // Default to ZIP extraction for .zip files and unknown extensions
                match self.extract_and_install_zip(archive_path, &mod_storage_mods, &mod_storage_plugins, &mod_storage_userlibs, &temp_dir, runtime).await {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("ZIP extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
        };

        // Clean up temp directory
        let _ = fs::remove_dir_all(&temp_dir).await;

        // Create symlinks for all installed files
        let mut symlink_paths = Vec::new();
        eprintln!("[DEBUG] install_zip_mod: Creating symlinks for {} files", installed_files.len());
        
        // Walk through mod storage and create symlinks
        // For Mods directory
        if mod_storage_mods.exists() {
            let mut entries = fs::read_dir(&mod_storage_mods).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;
                
                if metadata.is_file() {
                    let file_name = entry_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    let symlink_path = mods_directory.join(file_name);
                    
                    eprintln!("[DEBUG] install_zip_mod: Preparing symlink for {}: {:?} -> {:?}", file_name, entry_path, symlink_path);
                    
                    // Remove existing symlink/file if it exists
                    if symlink_path.exists() {
                        eprintln!("[DEBUG] install_zip_mod: Removing existing file/symlink at {:?}", symlink_path);
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }
                    
                    // Verify source file exists
                    if !entry_path.exists() {
                        eprintln!("[ERROR] install_zip_mod: Source file does not exist: {:?}", entry_path);
                        return Err(anyhow::anyhow!("Source file does not exist: {:?}", entry_path));
                    }
                    
                    // Create symlink
                    eprintln!("[DEBUG] install_zip_mod: Creating symlink: {:?} -> {:?}", entry_path, symlink_path);
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            eprintln!("[DEBUG] install_zip_mod: Successfully created symlink {:?} -> {:?}", symlink_path, entry_path);
                        }
                        Err(e) => {
                            eprintln!("[ERROR] install_zip_mod: Failed to create symlink: {}", e);
                            eprintln!("[ERROR] install_zip_mod: Source: {:?}, Destination: {:?}", entry_path, symlink_path);
                            // On Windows, symlinks require admin privileges or Developer Mode
                            // Return a more helpful error message
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error details: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }
        
        // For Plugins directory
        if mod_storage_plugins.exists() {
            let mut entries = fs::read_dir(&mod_storage_plugins).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;
                
                if metadata.is_file() {
                    let file_name = entry_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    let symlink_path = plugins_directory.join(file_name);
                    
                    // Remove existing symlink/file if it exists
                    if symlink_path.exists() {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }
                    
                    // Create symlink
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            eprintln!("[DEBUG] install_zip_mod: Created symlink {:?} -> {:?}", symlink_path, entry_path);
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }
        
        // For UserLibs directory (recursive - handle directories)
        if mod_storage_userlibs.exists() {
            // UserLibs can contain directories, so we need recursive symlink handling
            // For now, just handle files at the root level
            let mut entries = fs::read_dir(&mod_storage_userlibs).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;
                let file_name = entry_path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let symlink_path = userlibs_directory.join(file_name);
                
                if metadata.is_dir() {
                    // For directories, create directory symlink
                    if symlink_path.exists() {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_dir_all(&symlink_path).await?;
                        }
                    }
                    match self.create_symlink_dir(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create directory symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                } else {
                    // For files, create file symlink
                    if symlink_path.exists() {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }

        // Update metadata
        let mut mod_metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        // Extract metadata from effective metadata (includes Thunderstore manifest if found)
        // Note: source_id and source_version were already extracted earlier for duplicate detection
        let source_str = effective_metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));

        // Log the source we're setting for debugging
        eprintln!("[DEBUG] install_zip_mod: metadata source = {:?}", source_str);

        let mod_source = match source_str {
            Some("thunderstore") => Some(ModSource::Thunderstore),
            Some("nexusmods") => Some(ModSource::Nexusmods),
            Some("unknown") => Some(ModSource::Unknown),
            _ => Some(ModSource::Local),
        };

        eprintln!("[DEBUG] install_zip_mod: mod_source = {:?}", mod_source);
        // source_id and source_version are already extracted above for duplicate detection
        let source_url = effective_metadata
            .as_ref()
            .and_then(|m| m.get("sourceUrl").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let mod_name = effective_metadata
            .as_ref()
            .and_then(|m| m.get("modName").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let author = effective_metadata
            .as_ref()
            .and_then(|m| m.get("author").and_then(|s| s.as_str()).map(|s| s.to_string()));

        // Detect runtime from environment
        let env_runtime = match runtime {
            "IL2CPP" => crate::types::Runtime::Il2cpp,
            "Mono" => crate::types::Runtime::Mono,
            _ => crate::types::Runtime::Mono, // Default to Mono
        };

        for file_name in &installed_files {
            // Detect runtime from file name
            let detected_runtime_str = self.detect_mod_runtime_from_name(file_name);
            let detected_runtime = match detected_runtime_str {
                "IL2CPP" => Some(crate::types::Runtime::Il2cpp),
                "Mono" => Some(crate::types::Runtime::Mono),
                _ => None,
            };
            
            // Check if runtime matches
            let runtime_match = detected_runtime.as_ref().map(|dr| {
                match (dr, &env_runtime) {
                    (crate::types::Runtime::Il2cpp, crate::types::Runtime::Il2cpp) => true,
                    (crate::types::Runtime::Mono, crate::types::Runtime::Mono) => true,
                    _ => false,
                }
            });

            if let Some(meta) = mod_metadata.get_mut(file_name) {
                // Update existing metadata
                eprintln!("[DEBUG] Updating existing metadata for: {}", file_name);
                eprintln!("[DEBUG] Old source: {:?}", meta.source);
                meta.installed_at = Some(Utc::now());
                // Update source info if provided
                if let Some(src) = mod_source.clone() {
                    meta.source = Some(src.clone());
                    eprintln!("[DEBUG] New source: {:?}", src);
                }
                if source_id.is_some() {
                    meta.source_id = source_id.clone();
                }
                if source_version.is_some() {
                    meta.source_version = source_version.clone();
                }
                if source_url.is_some() {
                    meta.source_url = source_url.clone();
                }
                if mod_name.is_some() {
                    meta.mod_name = mod_name.clone();
                }
                if author.is_some() {
                    meta.author = author.clone();
                }
                // Update runtime detection
                meta.detected_runtime = detected_runtime.clone();
                meta.runtime_match = runtime_match;
                // Update storage info
                meta.mod_storage_id = Some(mod_id.clone());
                meta.symlink_paths = Some(symlink_paths.clone());
            } else {
                // Create new metadata entry
                // Extract version from storage file
                let storage_file_path = mod_storage_mods.join(file_name);
                let installed_version = self.extract_mod_version(&storage_file_path).await;
                let new_meta = ModMetadata {
                    source: mod_source.clone(),
                    source_id: source_id.clone(),
                    source_version: source_version.clone(),
                    author: author.clone(),
                    mod_name: mod_name.clone(),
                    source_url: source_url.clone(),
                    installed_version: installed_version,
                    installed_at: Some(Utc::now()),
                    last_update_check: None,
                    update_available: None,
                    remote_version: None,
                    detected_runtime: detected_runtime.clone(),
                    runtime_match,
                    mod_storage_id: Some(mod_id.clone()),
                    symlink_paths: Some(symlink_paths.clone()),
                };
                mod_metadata.insert(file_name.clone(), new_meta);
            }
        }

        self.save_mod_metadata(&mods_directory, &mod_metadata).await?;

        // Return the actual source that was installed, not hardcoded "local"
        let response_source = match mod_source {
            Some(ModSource::Thunderstore) => "thunderstore",
            Some(ModSource::Nexusmods) => "nexusmods",
            Some(ModSource::Unknown) => "unknown",
            Some(ModSource::Local) => "local",
            _ => "unknown",
        };

        eprintln!("[DEBUG] install_zip_mod complete. Returning success with installed_files: {:?}", installed_files);
        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files,
            "source": response_source
        }))
    }

    fn extract_thunderstore_manifest(&self, zip_path: &Path) -> Option<serde_json::Value> {
        // Try to extract and parse manifest.json from the ZIP
        let file = File::open(zip_path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;

        // Look for manifest.json at root level
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).ok()?;
            let file_name = file.name();

            // Check if it's manifest.json at root (no directory prefix)
            if file_name == "manifest.json" || file_name.ends_with("/manifest.json") {
                let mut contents = String::new();
                if file.read_to_string(&mut contents).is_ok() {
                    if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&contents) {
                        return Some(manifest);
                    }
                }
            }
        }

        None
    }

    async fn extract_and_install_zip(
        &self,
        zip_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        temp_dir: &Path,
        runtime: &str,
    ) -> Result<Vec<String>> {

        let file = File::open(zip_path)
            .context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file)
            .context("Failed to read zip archive")?;

        // Extract all files to temp directory
        // First, collect all file data synchronously (before any await)
        let mut file_data = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)
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

        let mut installed_files = Vec::new();

        // Detect if this archive has IL2CPP/Mono subdirectories (runtime-specific structure)
        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(temp_dir).await?;

        // Copy files from temp directory to appropriate locations
        let mut entries = fs::read_dir(temp_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                let dir_name = file_name.to_lowercase();

                // Handle runtime-specific directories (e.g., "IL2CPP", "Mono")
                if has_il2cpp_dir || has_mono_dir {
                    // This archive has runtime-specific structure, only process matching runtime
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    if dir_runtime == runtime {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");

                        if mods_path.exists() {
                            self.copy_directory_filtered(&mods_path, mods_dir, runtime, &mut installed_files).await?;
                        }
                        if plugins_path.exists() {
                            self.copy_directory_filtered(&plugins_path, plugins_dir, runtime, &mut installed_files).await?;
                        }
                        if userlibs_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userlibs_path, userlibs_dir)).await?;
                        }

                        // Also copy any DLLs directly in this runtime directory
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path.file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            if runtime_entry_path.is_file() && runtime_file_name.to_lowercase().ends_with(".dll") {
                                let dest_path = mods_dir.join(runtime_file_name);
                                fs::copy(&runtime_entry_path, &dest_path).await?;
                                installed_files.push(runtime_file_name.to_string());
                            }
                        }
                    }
                    // Skip directories that don't match the runtime
                    continue;
                }

                // Standard structure without runtime-specific folders
                if dir_name == "mods" {
                    self.copy_directory_filtered(&entry_path, mods_dir, runtime, &mut installed_files).await?;
                } else if dir_name == "plugins" {
                    self.copy_directory_filtered(&entry_path, plugins_dir, runtime, &mut installed_files).await?;
                } else if dir_name == "userlibs" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userlibs_dir)).await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
                // Check runtime match
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                eprintln!("[DEBUG] ZIP: Top-level DLL: '{}', detected runtime: '{}', target runtime: '{}', matches: {}",
                    file_name, file_runtime, runtime, file_runtime == runtime || file_runtime == "unknown");
                if file_runtime == runtime || file_runtime == "unknown" {
                    let dest_path = mods_dir.join(file_name);
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            }
        }

        eprintln!("[DEBUG] ZIP extraction complete. Installed files: {:?}", installed_files);
        Ok(installed_files)
    }

    async fn extract_and_install_rar(
        &self,
        rar_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        temp_dir: &Path,
        runtime: &str,
    ) -> Result<Vec<String>> {
        // Extract RAR archive synchronously to avoid Send issues
        // The unrar crate is not Send, so we do all extraction before any async operations
        {
            let mut archive = Archive::new(rar_path.to_str().unwrap())
                .open_for_processing()
                .context("Failed to open RAR archive")?;

            let temp_dir_str = temp_dir.to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid temp directory path"))?;

            // Process all entries in the archive synchronously
            while let Some(header) = archive.read_header().context("Failed to read RAR header")? {
                let entry = header.entry();
                let is_dir = entry.is_directory();

                if is_dir {
                    archive = header.skip().context("Failed to skip directory entry")?;
                } else {
                    // Extract file to temp directory
                    archive = header.extract_with_base(temp_dir_str)
                        .context("Failed to extract RAR file")?;
                }
            }
        } // Archive is dropped here, before any async operations

        let mut installed_files = Vec::new();

        // Detect if this archive has IL2CPP/Mono subdirectories (runtime-specific structure)
        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(temp_dir).await?;

        // Now do async operations to copy files from temp directory to appropriate locations
        let mut entries = fs::read_dir(temp_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                let dir_name = file_name.to_lowercase();

                // Handle runtime-specific directories (e.g., "IL2CPP", "Mono")
                if has_il2cpp_dir || has_mono_dir {
                    // This archive has runtime-specific structure, only process matching runtime
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    if dir_runtime == runtime {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");

                        if mods_path.exists() {
                            self.copy_directory_filtered(&mods_path, mods_dir, runtime, &mut installed_files).await?;
                        }
                        if plugins_path.exists() {
                            self.copy_directory_filtered(&plugins_path, plugins_dir, runtime, &mut installed_files).await?;
                        }
                        if userlibs_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userlibs_path, userlibs_dir)).await?;
                        }

                        // Also copy any DLLs directly in this runtime directory
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path.file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            if runtime_entry_path.is_file() && runtime_file_name.to_lowercase().ends_with(".dll") {
                                let dest_path = mods_dir.join(runtime_file_name);
                                fs::copy(&runtime_entry_path, &dest_path).await?;
                                installed_files.push(runtime_file_name.to_string());
                            }
                        }
                    }
                    // Skip directories that don't match the runtime
                    continue;
                }

                // Standard structure without runtime-specific folders
                if dir_name == "mods" {
                    self.copy_directory_filtered(&entry_path, mods_dir, runtime, &mut installed_files).await?;
                } else if dir_name == "plugins" {
                    self.copy_directory_filtered(&entry_path, plugins_dir, runtime, &mut installed_files).await?;
                } else if dir_name == "userlibs" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userlibs_dir)).await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
                // Check runtime match
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                if file_runtime == runtime || file_runtime == "unknown" {
                    let dest_path = mods_dir.join(file_name);
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            }
        }

        Ok(installed_files)
    }

    fn detect_mod_runtime_from_name(&self, name: &str) -> &str {
        let lower = name.to_lowercase();
        if lower.contains("mono") {
            "Mono"
        } else if lower.contains("il2cpp") || lower.contains("il2") || lower.contains("cpp") {
            "IL2CPP"
        } else {
            "unknown"
        }
    }

    /// Detects if the temp directory contains runtime-specific directories (IL2CPP, Mono)
    /// Returns (has_il2cpp_dir, has_mono_dir)
    async fn detect_runtime_directories(&self, temp_dir: &Path) -> Result<(bool, bool)> {
        let mut has_il2cpp = false;
        let mut has_mono = false;

        if let Ok(mut entries) = fs::read_dir(temp_dir).await {
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let runtime = self.detect_mod_runtime_from_name(name);
                        if runtime == "IL2CPP" {
                            has_il2cpp = true;
                        } else if runtime == "Mono" {
                            has_mono = true;
                        }
                    }
                }
            }
        }

        Ok((has_il2cpp, has_mono))
    }

    async fn copy_directory_filtered(&self, source: &Path, dest: &Path, runtime: &str, installed_files: &mut Vec<String>) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = dest.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_filtered(&entry_path, &dest_path, runtime, installed_files)).await?;
            } else if file_name.to_lowercase().ends_with(".dll") {
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                if file_runtime == runtime || file_runtime == "unknown" {
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            } else {
                fs::copy(&entry_path, &dest_path).await?;
            }
        }

        Ok(())
    }

    async fn copy_directory_recursive(&self, source: &Path, dest: &Path) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path.file_name()
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

    pub async fn install_dll_mod(&self, game_dir: &str, dll_path: &str, runtime: &str, metadata: Option<serde_json::Value>) -> Result<serde_json::Value> {
        eprintln!("[DEBUG] install_dll_mod: Starting symlink-based installation");

        // Extract source_id and source_version for duplicate detection
        let source_id = metadata
            .as_ref()
            .and_then(|m| m.get("sourceId").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let source_version = metadata
            .as_ref()
            .and_then(|m| m.get("sourceVersion").and_then(|s| s.as_str()).map(|s| s.to_string()));

        // Check if we already have this mod/version installed
        let existing_mod_id = self.find_existing_mod_installation(game_dir, &source_id, &source_version).await?;
        
        // Use existing mod_id or generate a new one
        let mod_id = if let Some(existing_id) = existing_mod_id {
            eprintln!("[DEBUG] install_dll_mod: Reusing existing installation with mod_id: {}", existing_id);
            existing_id
        } else {
            let new_id = self.generate_mod_id();
            eprintln!("[DEBUG] install_dll_mod: Generated new mod_id: {}", new_id);
            new_id
        };

        // Get mod storage directory
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let mod_storage_base = mod_storage_dir.join(&mod_id);
        let mod_storage_mods = mod_storage_base.join("Mods");
        fs::create_dir_all(&mod_storage_mods).await
            .context("Failed to create mod storage directory")?;

        // Create game directory if it doesn't exist (for symlink)
        let mods_directory = self.get_mods_directory(game_dir);
        fs::create_dir_all(&mods_directory).await?;

        let source_path = Path::new(dll_path);
        let file_name = source_path.file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid DLL path"))?;

        if !file_name.to_lowercase().ends_with(".dll") {
            return Ok(serde_json::json!({
                "success": false,
                "error": "Only .dll files are allowed"
            }));
        }

        // Copy DLL to mod storage
        let storage_path = mod_storage_mods.join(file_name);
        fs::copy(source_path, &storage_path).await
            .context("Failed to copy DLL file to storage")?;
        eprintln!("[DEBUG] install_dll_mod: Copied DLL to storage: {:?}", storage_path);

        // Create symlink in game directory
        let symlink_path = mods_directory.join(file_name);
        
        // Remove existing symlink/file if it exists
        if symlink_path.exists() {
            if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                self.remove_symlink(&symlink_path).await?;
            } else {
                fs::remove_file(&symlink_path).await?;
            }
        }

        // Create symlink from game directory to storage location
        self.create_symlink_file(&storage_path, &symlink_path).await
            .context("Failed to create symlink")?;
        eprintln!("[DEBUG] install_dll_mod: Created symlink: {:?} -> {:?}", symlink_path, storage_path);

        // Extract version from the storage file
        let version = self.extract_mod_version(&storage_path).await;

        // Detect runtime from file name
        let detected_runtime_str = self.detect_mod_runtime_from_name(file_name);
        let detected_runtime = match detected_runtime_str {
            "IL2CPP" => Some(crate::types::Runtime::Il2cpp),
            "Mono" => Some(crate::types::Runtime::Mono),
            _ => None,
        };
        
        // Detect runtime from environment
        let env_runtime = match runtime {
            "IL2CPP" => crate::types::Runtime::Il2cpp,
            "Mono" => crate::types::Runtime::Mono,
            _ => crate::types::Runtime::Mono, // Default to Mono
        };
        
        // Check if runtime matches
        let runtime_match = detected_runtime.as_ref().map(|dr| {
            match (dr, &env_runtime) {
                (crate::types::Runtime::Il2cpp, crate::types::Runtime::Il2cpp) => true,
                (crate::types::Runtime::Mono, crate::types::Runtime::Mono) => true,
                _ => false,
            }
        });

        // Extract metadata from provided metadata if available
        let source_str = metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));
        
        let mod_source = match source_str {
            Some("thunderstore") => ModSource::Thunderstore,
            Some("nexusmods") => ModSource::Nexusmods,
            Some("unknown") => ModSource::Unknown,
            _ => ModSource::Local,
        };
        
        // source_id and source_version are already extracted above for duplicate detection
        let source_url = metadata
            .as_ref()
            .and_then(|m| m.get("sourceUrl").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let mod_name = metadata
            .as_ref()
            .and_then(|m| m.get("modName").and_then(|s| s.as_str()).map(|s| s.to_string()));
        let author = metadata
            .as_ref()
            .and_then(|m| m.get("author").and_then(|s| s.as_str()).map(|s| s.to_string()));

        // Update metadata
        let mut mod_metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        mod_metadata.insert(file_name.to_string(), ModMetadata {
            source: Some(mod_source),
            source_id,
            source_version,
            author,
            mod_name,
            source_url,
            installed_version: version,
            installed_at: Some(Utc::now()),
            last_update_check: None,
            update_available: None,
            remote_version: None,
            detected_runtime,
            runtime_match,
            mod_storage_id: Some(mod_id),
            symlink_paths: Some(vec![symlink_path.to_string_lossy().to_string()]),
        });

        self.save_mod_metadata(&mods_directory, &mod_metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "fileName": file_name
        }))
    }

    /// Clean up duplicate/unused mod storage directories
    /// Removes directories that aren't referenced by any environment's metadata
    pub async fn cleanup_duplicate_mod_storage(&self) -> Result<serde_json::Value> {
        use crate::services::environment::EnvironmentService;
        
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        
        if !mod_storage_dir.exists() {
            return Ok(serde_json::json!({
                "success": true,
                "removed": 0,
                "message": "Mod storage directory does not exist"
            }));
        }
        
        // Get all environments
        let env_service = EnvironmentService::new()
            .context("Failed to create environment service")?;
        let environments = env_service.get_environments().await
            .context("Failed to get environments")?;
        
        // Collect all mod_storage_id values that are actually in use
        let mut used_storage_ids = std::collections::HashSet::new();
        
        for env in &environments {
            if env.output_dir.is_empty() {
                continue;
            }
            
            let mods_directory = self.get_mods_directory(&env.output_dir);
            if !mods_directory.exists() {
                continue;
            }
            
            // Load metadata for this environment
            if let Ok(metadata) = self.load_mod_metadata(&mods_directory).await {
                for (_file_name, mod_meta) in metadata.iter() {
                    if let Some(storage_id) = &mod_meta.mod_storage_id {
                        used_storage_ids.insert(storage_id.clone());
                    }
                }
            }
        }
        
        eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Found {} storage IDs in use", used_storage_ids.len());
        
        // List all directories in mod storage
        let mut removed_count = 0;
        let mut errors = Vec::new();
        
        let mut entries = fs::read_dir(&mod_storage_dir).await
            .context("Failed to read mod storage directory")?;
        
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = fs::metadata(&entry_path).await?;
            
            if metadata.is_dir() {
                if let Some(dir_name) = entry_path.file_name().and_then(|n| n.to_str()) {
                    // Check if this directory is referenced in any metadata
                    if !used_storage_ids.contains(dir_name) {
                        eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Removing unused directory: {:?}", entry_path);
                        match fs::remove_dir_all(&entry_path).await {
                            Ok(_) => {
                                removed_count += 1;
                                eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Successfully removed: {:?}", entry_path);
                            }
                            Err(e) => {
                                let error_msg = format!("Failed to remove {:?}: {}", entry_path, e);
                                eprintln!("[ERROR] cleanup_duplicate_mod_storage: {}", error_msg);
                                errors.push(error_msg);
                            }
                        }
                    }
                }
            }
        }
        
        let result = serde_json::json!({
            "success": errors.is_empty(),
            "removed": removed_count,
            "errors": errors
        });
        
        if !errors.is_empty() {
            eprintln!("[WARN] cleanup_duplicate_mod_storage: Completed with {} errors", errors.len());
        } else {
            eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Successfully removed {} unused directories", removed_count);
        }
        
        Ok(result)
    }

    pub async fn install_s1api(&self, game_dir: &str, zip_path: &str, runtime: &str, branch: &str, version: &str) -> Result<serde_json::Value> {
        // Prepare metadata for GitHub installation (for duplicate detection)
        // Note: GitHub is not a ModSource variant, so it will default to Local, but sourceId and sourceVersion
        // are what matter for duplicate detection
        let metadata = serde_json::json!({
            "source": "local", // GitHub mods use Local source type
            "sourceId": "ifBars/S1API", // GitHub owner/repo for duplicate detection
            "sourceVersion": version, // GitHub release tag/version
            "sourceUrl": "https://github.com/ifBars/S1API",
            "modName": "S1API",
            "author": "ScheduleI-Dev",
        });

        // Install S1API using the ZIP mod installation method with metadata for duplicate detection
        let result = self.install_zip_mod(game_dir, zip_path, "S1API.zip", runtime, branch, Some(metadata)).await?;

        Ok(result)
    }

    pub async fn uninstall_s1api(&self, game_dir: &str) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);

        let mut files_to_remove = Vec::new();

        // Check for S1API component files
        let mono_file = mods_directory.join("S1API.Mono.MelonLoader.dll");
        let il2cpp_file = mods_directory.join("S1API.IL2CPP.MelonLoader.dll");
        let mono_disabled = mods_directory.join("S1API.Mono.MelonLoader.dll.disabled");
        let il2cpp_disabled = mods_directory.join("S1API.IL2CPP.MelonLoader.dll.disabled");
        let plugin_file = plugins_directory.join("S1API.dll");

        if mono_file.exists() {
            files_to_remove.push(mono_file);
        }
        if il2cpp_file.exists() {
            files_to_remove.push(il2cpp_file);
        }
        if mono_disabled.exists() {
            files_to_remove.push(mono_disabled);
        }
        if il2cpp_disabled.exists() {
            files_to_remove.push(il2cpp_disabled);
        }
        if plugin_file.exists() {
            files_to_remove.push(plugin_file);
        }

        // Remove all files
        for file in &files_to_remove {
            let _ = fs::remove_file(file).await;
        }

        // Remove from metadata
        let mut metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());
        metadata.remove("S1API.Mono.MelonLoader.dll");
        metadata.remove("S1API.IL2CPP.MelonLoader.dll");
        self.save_mod_metadata(&mods_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "message": "S1API uninstalled successfully"
        }))
    }

    pub async fn get_s1api_installation_status(&self, game_dir: &str, runtime: &str) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);

        if !mods_directory.exists() {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        // Check for S1API component files
        let mono_file = mods_directory.join("S1API.Mono.MelonLoader.dll");
        let il2cpp_file = mods_directory.join("S1API.IL2CPP.MelonLoader.dll");
        let mono_disabled = mods_directory.join("S1API.Mono.MelonLoader.dll.disabled");
        let il2cpp_disabled = mods_directory.join("S1API.IL2CPP.MelonLoader.dll.disabled");

        // Check for S1API plugin
        let mut plugin_file: Option<String> = None;
        if plugins_directory.exists() {
            let plugin_path = plugins_directory.join("S1API.dll");
            if plugin_path.exists() {
                plugin_file = Some(plugin_path.to_string_lossy().to_string());
            }
        }

        let has_mono = mono_file.exists();
        let has_il2cpp = il2cpp_file.exists();
        let has_mono_disabled = mono_disabled.exists();
        let has_il2cpp_disabled = il2cpp_disabled.exists();
        let has_plugin = plugin_file.is_some();

        let installed = has_mono || has_il2cpp || has_mono_disabled || has_il2cpp_disabled || has_plugin;

        if !installed {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        // Determine if enabled based on runtime
        let enabled = match runtime {
            "Mono" => has_mono && !has_il2cpp,
            "IL2CPP" => has_il2cpp && !has_mono,
            _ => has_mono || has_il2cpp,
        };

        // Try to extract version from metadata or DLL
        let mut version: Option<String> = None;
        let metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        if let Some(meta) = metadata.get("S1API.Mono.MelonLoader.dll")
            .or_else(|| metadata.get("S1API.IL2CPP.MelonLoader.dll")) {
            // Check installed_version first, then fall back to source_version
            version = meta.installed_version.clone()
                .or_else(|| meta.source_version.clone());
        }

        if version.is_none() && enabled {
            if runtime == "Mono" && has_mono {
                version = self.extract_mod_version(&mono_file).await;
            } else if runtime == "IL2CPP" && has_il2cpp {
                version = self.extract_mod_version(&il2cpp_file).await;
            } else if has_mono {
                version = self.extract_mod_version(&mono_file).await;
            } else if has_il2cpp {
                version = self.extract_mod_version(&il2cpp_file).await;
            }
        }

        Ok(serde_json::json!({
            "installed": true,
            "enabled": enabled,
            "version": version,
            "monoFile": if has_mono || has_mono_disabled {
                Some(if has_mono { mono_file.to_string_lossy().to_string() } else { mono_disabled.to_string_lossy().to_string() })
            } else { None },
            "il2cppFile": if has_il2cpp || has_il2cpp_disabled {
                Some(if has_il2cpp { il2cpp_file.to_string_lossy().to_string() } else { il2cpp_disabled.to_string_lossy().to_string() })
            } else { None },
            "pluginFile": plugin_file
        }))
    }
}

impl Default for ModsService {
    fn default() -> Self {
        Self::new()
    }
}
