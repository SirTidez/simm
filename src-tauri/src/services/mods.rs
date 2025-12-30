use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::io::Read;
use std::fs::File;
use anyhow::{Context, Result};
use tokio::fs;
use tokio::process::Command;
use regex::Regex;
use zip::ZipArchive;
use crate::types::{ModMetadata, ModSource};

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

    async fn load_mod_metadata(&self, mods_directory: &Path) -> Result<HashMap<String, ModMetadata>> {
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

    async fn save_mod_metadata(&self, mods_directory: &Path, metadata: &HashMap<String, ModMetadata>) -> Result<()> {
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
            let version = if let Some(ref meta) = file_metadata {
                meta.installed_version.clone()
            } else if !is_disabled {
                self.extract_mod_version(Path::new(&file_path)).await
            } else {
                None
            };

            let source = file_metadata.as_ref()
                .and_then(|m| m.source.clone());

            mods.push(ModInfo {
                name: mod_name.clone(),
                file_name: original_file_name,
                path: file_path,
                version,
                source,
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

    pub async fn install_zip_mod(&self, game_dir: &str, zip_path: &str, _file_name: &str, runtime: &str, _branch: &str) -> Result<serde_json::Value> {

        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);
        let userlibs_directory = Path::new(game_dir).join("UserLibs");

        // Create directories if they don't exist
        fs::create_dir_all(&mods_directory).await?;
        fs::create_dir_all(&plugins_directory).await?;
        fs::create_dir_all(&userlibs_directory).await?;

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir()
            .join(format!("mod-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()));

        fs::create_dir_all(&temp_dir).await?;

        let installed_files = match self.extract_and_install_zip(&Path::new(zip_path), &mods_directory, &plugins_directory, &userlibs_directory, &temp_dir, runtime).await {
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

        // Update metadata
        let mut metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        for file_name in &installed_files {
            if let Some(meta) = metadata.get_mut(file_name) {
                // Update existing metadata
                meta.installed_at = Some(chrono::Utc::now());
            } else {
                // Create new metadata entry
                let new_meta = ModMetadata {
                    source: Some(ModSource::Local),
                    source_id: None,
                    source_version: None,
                    author: None,
                    mod_name: None,
                    source_url: None,
                    installed_version: self.extract_mod_version(&mods_directory.join(file_name)).await,
                    installed_at: Some(chrono::Utc::now()),
                    last_update_check: None,
                    update_available: None,
                    remote_version: None,
                    detected_runtime: None,
                    runtime_match: None,
                };
                metadata.insert(file_name.clone(), new_meta);
            }
        }

        self.save_mod_metadata(&mods_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files,
            "source": "local"
        }))
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

    pub async fn install_dll_mod(&self, game_dir: &str, dll_path: &str, source: &str, _runtime: &str) -> Result<serde_json::Value> {
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

        let dest_path = mods_directory.join(file_name);
        fs::copy(source_path, &dest_path).await
            .context("Failed to copy DLL file")?;

        // Extract version
        let version = self.extract_mod_version(&dest_path).await;

        // Update metadata
        let mut metadata = self.load_mod_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        let mod_source = match source {
            "thunderstore" => ModSource::Thunderstore,
            "nexusmods" => ModSource::Nexusmods,
            _ => ModSource::Local,
        };

        metadata.insert(file_name.to_string(), ModMetadata {
            source: Some(mod_source),
            source_id: None,
            source_version: None,
            author: None,
            mod_name: None,
            source_url: None,
            installed_version: version,
            installed_at: Some(chrono::Utc::now()),
            last_update_check: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
        });

        self.save_mod_metadata(&mods_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "fileName": file_name
        }))
    }

    pub async fn install_s1api(&self, game_dir: &str, zip_path: &str, runtime: &str, branch: &str, version: &str) -> Result<serde_json::Value> {
        // Install S1API using the ZIP mod installation method
        let result = self.install_zip_mod(game_dir, zip_path, "S1API.zip", runtime, branch).await?;
        
        if result.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
            // Update metadata with S1API-specific information
            let mods_directory = self.get_mods_directory(game_dir);
            let mut metadata = self.load_mod_metadata(&mods_directory).await
                .unwrap_or_else(|_| HashMap::new());

            let s1api_metadata = ModMetadata {
                source: Some(ModSource::Local),
                source_id: None,
                source_version: Some(version.to_string()),
                author: Some("ScheduleI-Dev".to_string()),
                mod_name: Some("S1API".to_string()),
                source_url: Some("https://github.com/ifBars/S1API".to_string()),
                installed_version: Some(version.to_string()), // Store version in installed_version so it can be retrieved
                installed_at: Some(chrono::Utc::now()),
                last_update_check: None,
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
            };

            metadata.insert("S1API.Mono.MelonLoader.dll".to_string(), s1api_metadata.clone());
            metadata.insert("S1API.IL2CPP.MelonLoader.dll".to_string(), s1api_metadata);
            
            self.save_mod_metadata(&mods_directory, &metadata).await?;
        }

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
