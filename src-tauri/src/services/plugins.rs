use std::path::{Path, PathBuf};
use std::collections::HashMap;
use anyhow::{Context, Result};
use tokio::fs;
use regex::Regex;
use chrono;
use crate::types::{ModMetadata, ModSource};

#[derive(Clone)]
pub struct PluginsService;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginInfo {
    name: String,
    file_name: String,
    path: String,
    version: Option<String>,
    source: Option<ModSource>,
    related_mod: Option<String>,
    disabled: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginsListResult {
    plugins: Vec<PluginInfo>,
    plugins_directory: String,
    count: usize,
}

impl PluginsService {
    pub fn new() -> Self {
        Self
    }

    fn get_plugins_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Plugins")
    }

    fn get_mods_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Mods")
    }

    pub async fn load_plugin_metadata(&self, plugins_directory: &Path) -> Result<HashMap<String, ModMetadata>> {
        let metadata_file = plugins_directory.join(".plugins-metadata.json");
        
        if !metadata_file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&metadata_file).await
            .context("Failed to read plugin metadata file")?;
        
        let metadata: HashMap<String, ModMetadata> = serde_json::from_str(&content)
            .context("Failed to parse plugin metadata file")?;
        
        Ok(metadata)
    }

    async fn load_mods_metadata(&self, mods_directory: &Path) -> Result<HashMap<String, ModMetadata>> {
        let metadata_file = mods_directory.join(".mods-metadata.json");
        
        if !metadata_file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&metadata_file).await
            .context("Failed to read mods metadata file")?;
        
        let metadata: HashMap<String, ModMetadata> = serde_json::from_str(&content)
            .context("Failed to parse mods metadata file")?;
        
        Ok(metadata)
    }

    pub async fn save_plugin_metadata(&self, plugins_directory: &Path, metadata: &HashMap<String, ModMetadata>) -> Result<()> {
        let metadata_file = plugins_directory.join(".plugins-metadata.json");
        let content = serde_json::to_string_pretty(metadata)
            .context("Failed to serialize plugin metadata")?;
        fs::write(&metadata_file, content).await
            .context("Failed to write plugin metadata file")?;
        Ok(())
    }

    pub async fn list_plugins(&self, game_dir: &str) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        
        if !plugins_directory.exists() {
            return Ok(serde_json::json!({
                "plugins": [],
                "pluginsDirectory": plugins_directory.to_string_lossy().to_string(),
                "count": 0
            }));
        }

        let mut entries = fs::read_dir(&plugins_directory).await
            .context("Failed to read Plugins directory")?;

        let mut dll_files = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                let file_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    let path_string = path.to_string_lossy().to_string();
                    dll_files.push((path_string, file_name.to_string()));
                }
            }
        }

        // Load metadata
        let plugin_metadata = self.load_plugin_metadata(&plugins_directory).await
            .unwrap_or_else(|_| HashMap::new());

        // Also check mods metadata to find related mods
        let mods_directory = self.get_mods_directory(game_dir);
        let mods_metadata = self.load_mods_metadata(&mods_directory).await
            .unwrap_or_else(|_| HashMap::new());

        let mut plugins = Vec::new();
        for (file_path, file_name) in dll_files {
            let is_disabled = file_name.to_lowercase().ends_with(".disabled");
            let original_file_name = if is_disabled {
                file_name.replace(".disabled", "")
            } else {
                file_name.clone()
            };

            let plugin_name = original_file_name
                .replace(".dll", "")
                .replace(".DLL", "");

            // Get metadata for the original filename (without .disabled)
            let file_metadata = plugin_metadata.get(&original_file_name)
                .or_else(|| plugin_metadata.get(&file_name))
                .cloned();

            // Check for related mod in mods metadata
            let related_mod = mods_metadata.values()
                .find(|meta| {
                    meta.mod_name.as_ref()
                        .map(|n| n.to_lowercase() == plugin_name.to_lowercase())
                        .unwrap_or(false)
                })
                .and_then(|meta| meta.mod_name.clone());

            let version = file_metadata.as_ref()
                .and_then(|m| m.installed_version.clone());

            let source = file_metadata.as_ref()
                .and_then(|m| m.source.clone());

            plugins.push(PluginInfo {
                name: plugin_name.clone(),
                file_name: original_file_name,
                path: file_path,
                version,
                source,
                related_mod,
                disabled: Some(is_disabled),
            });
        }

        let result = PluginsListResult {
            plugins_directory: plugins_directory.to_string_lossy().to_string(),
            count: plugins.len(),
            plugins,
        };

        Ok(serde_json::to_value(result)?)
    }

    pub async fn count_plugins(&self, game_dir: &str) -> Result<u32> {
        let result = self.list_plugins(game_dir).await?;
        let count = result.get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        Ok(count)
    }

    pub async fn delete_plugin(&self, game_dir: &str, plugin_file_name: &str) -> Result<()> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        let plugin_path = plugins_directory.join(plugin_file_name);
        let disabled_path = plugins_directory.join(format!("{}.disabled", plugin_file_name));

        // Security: Ensure the file is within the plugins directory and ends with .dll
        if !plugin_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid plugin file"));
        }

        let file_to_delete = if plugin_path.exists() {
            plugin_path
        } else if disabled_path.exists() {
            disabled_path
        } else {
            return Err(anyhow::anyhow!("Plugin file not found"));
        };

        // Verify it's actually a file
        let metadata = fs::metadata(&file_to_delete).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        fs::remove_file(&file_to_delete).await
            .context("Failed to delete plugin file")?;

        // Remove from metadata
        let mut metadata_map = self.load_plugin_metadata(&plugins_directory).await
            .unwrap_or_else(|_| HashMap::new());
        metadata_map.remove(plugin_file_name);
        self.save_plugin_metadata(&plugins_directory, &metadata_map).await?;

        Ok(())
    }

    pub async fn disable_plugin(&self, game_dir: &str, plugin_file_name: &str) -> Result<()> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        let plugin_path = plugins_directory.join(plugin_file_name);
        let disabled_path = plugins_directory.join(format!("{}.disabled", plugin_file_name));

        // Security: Ensure the file is within the plugins directory and ends with .dll
        if !plugin_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid plugin file"));
        }

        if !plugin_path.exists() {
            return Err(anyhow::anyhow!("Plugin file not found"));
        }

        if disabled_path.exists() {
            return Err(anyhow::anyhow!("Plugin is already disabled"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&plugin_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file
        fs::rename(&plugin_path, &disabled_path).await
            .context("Failed to disable plugin")?;

        Ok(())
    }

    pub async fn enable_plugin(&self, game_dir: &str, plugin_file_name: &str) -> Result<()> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        let disabled_path = plugins_directory.join(format!("{}.disabled", plugin_file_name));
        let plugin_path = plugins_directory.join(plugin_file_name);

        // Security: Ensure the file is within the plugins directory and ends with .dll
        if !plugin_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid plugin file"));
        }

        if !disabled_path.exists() {
            return Err(anyhow::anyhow!("Disabled plugin file not found"));
        }

        if plugin_path.exists() {
            return Err(anyhow::anyhow!("Plugin file already exists (not disabled)"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&disabled_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file back
        fs::rename(&disabled_path, &plugin_path).await
            .context("Failed to enable plugin")?;

        Ok(())
    }

    pub async fn install_dll_plugin(&self, _game_dir: &str, _dll_path: &str, _source: &str, _runtime: &str) -> Result<serde_json::Value> {
        // TODO: Implement DLL plugin installation
        Ok(serde_json::json!({ "success": false, "error": "Not implemented" }))
    }

    pub async fn install_mlvscan(&self, game_dir: &str, dll_path: &str, version: &str) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        fs::create_dir_all(&plugins_directory).await
            .context("Failed to create plugins directory")?;

        let source_path = Path::new(dll_path);
        // The source file might be named MLVScan.MelonLoader.dll or similar
        // but we always install it as MLVScan.dll in the Plugins folder
        let dest_path = plugins_directory.join("MLVScan.dll");
        
        // Copy the DLL file
        fs::copy(source_path, &dest_path).await
            .context("Failed to copy MLVScan.dll")?;

        // Update plugin metadata
        let mut metadata = self.load_plugin_metadata(&plugins_directory).await
            .unwrap_or_else(|_| HashMap::new());

        let mlvscan_metadata = ModMetadata {
            source: Some(ModSource::Local),
            source_id: None,
            source_version: Some(version.to_string()),
            author: Some("ifBars".to_string()),
            mod_name: Some("MLVScan".to_string()),
            source_url: Some("https://github.com/ifBars/MLVScan".to_string()),
            installed_version: Some(version.to_string()),
            installed_at: Some(chrono::Utc::now()),
            last_update_check: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
        };

        metadata.insert("MLVScan.dll".to_string(), mlvscan_metadata);
        self.save_plugin_metadata(&plugins_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "message": "MLVScan installed successfully",
            "version": version
        }))
    }

    pub async fn uninstall_mlvscan(&self, game_dir: &str) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        let plugin_path = plugins_directory.join("MLVScan.dll");
        let disabled_path = plugins_directory.join("MLVScan.dll.disabled");

        // Try to delete both enabled and disabled versions
        let mut deleted = false;
        if plugin_path.exists() {
            fs::remove_file(&plugin_path).await
                .context("Failed to remove MLVScan.dll")?;
            deleted = true;
        }
        if disabled_path.exists() {
            fs::remove_file(&disabled_path).await
                .context("Failed to remove MLVScan.dll.disabled")?;
            deleted = true;
        }

        if !deleted {
            return Ok(serde_json::json!({
                "success": false,
                "error": "MLVScan.dll not found"
            }));
        }

        // Remove from metadata
        let mut metadata = self.load_plugin_metadata(&plugins_directory).await
            .unwrap_or_else(|_| HashMap::new());
        metadata.remove("MLVScan.dll");
        self.save_plugin_metadata(&plugins_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "message": "MLVScan uninstalled successfully"
        }))
    }

    pub async fn get_mlvscan_installation_status(&self, game_dir: &str) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);

        if !plugins_directory.exists() {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        let plugin_file = plugins_directory.join("MLVScan.dll");
        let disabled_file = plugins_directory.join("MLVScan.dll.disabled");

        let has_plugin = plugin_file.exists();
        let has_disabled = disabled_file.exists();
        let installed = has_plugin || has_disabled;

        if !installed {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        // Try to extract version from metadata or DLL
        let mut version: Option<String> = None;
        let metadata = self.load_plugin_metadata(&plugins_directory).await
            .unwrap_or_else(|_| HashMap::new());

        if let Some(meta) = metadata.get("MLVScan.dll") {
            // Check installed_version first, then fall back to source_version
            version = meta.installed_version.clone()
                .or_else(|| meta.source_version.clone());
        }

        // If no version in metadata, try to extract from DLL
        if version.is_none() && has_plugin {
            // Use mods service to extract version (plugins use same DLL structure)
            use crate::services::mods::ModsService;
            let mods_service = ModsService::new();
            version = mods_service.extract_mod_version(&plugin_file).await;
        }

        Ok(serde_json::json!({
            "installed": true,
            "enabled": has_plugin && !has_disabled,
            "version": version,
            "pluginFile": if has_plugin {
                Some(plugin_file.to_string_lossy().to_string())
            } else if has_disabled {
                Some(disabled_file.to_string_lossy().to_string())
            } else {
                None
            }
        }))
    }
}

impl Default for PluginsService {
    fn default() -> Self {
        Self::new()
    }
}
