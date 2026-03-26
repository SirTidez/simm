use crate::types::{ModMetadata, ModSource};
use anyhow::{Context, Result};
use chrono;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use zip::ZipArchive;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

#[derive(Clone)]
pub struct PluginsService {
    pool: Arc<SqlitePool>,
}

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
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self { pool }
    }

    fn get_plugins_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Plugins")
    }

    fn get_mods_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Mods")
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\")
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    }

    async fn environment_id_for_dir(&self, game_dir: &str) -> Result<Option<String>> {
        if game_dir.is_empty() {
            return Ok(None);
        }

        let normalized_game_dir = Self::normalize_path(game_dir);
        let normalized_query = sqlx::query_scalar::<_, String>(
            "SELECT id FROM environments WHERE normalized_output_dir = ? OR output_dir = ? LIMIT 1",
        )
        .bind(normalized_game_dir)
        .bind(game_dir)
        .fetch_optional(&*self.pool)
        .await;

        let id = match normalized_query {
            Ok(id) => id,
            Err(err)
                if err
                    .to_string()
                    .to_lowercase()
                    .contains("no such column: normalized_output_dir") =>
            {
                let rows = sqlx::query_as::<_, (String, String)>(
                    "SELECT id, output_dir FROM environments",
                )
                .fetch_all(&*self.pool)
                .await
                .context("Failed to resolve environment id")?;

                rows.into_iter()
                    .find(|(_, output_dir)| {
                        Self::normalize_path(output_dir) == Self::normalize_path(game_dir)
                    })
                    .map(|(id, _)| id)
            }
            Err(err) => return Err(err).context("Failed to resolve environment id"),
        };

        Ok(id)
    }

    pub async fn load_plugin_metadata(
        &self,
        plugins_directory: &Path,
    ) -> Result<HashMap<String, ModMetadata>> {
        let game_dir = plugins_directory
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let env_id = self.environment_id_for_dir(game_dir).await?;
        let mut metadata = HashMap::new();

        if let Some(env_id) = env_id {
            let rows = sqlx::query_as::<_, (String, String)>(
                "SELECT file_name, data FROM mod_metadata WHERE environment_id = ? AND kind = 'plugins'",
            )
            .bind(&env_id)
            .fetch_all(&*self.pool)
            .await
            .context("Failed to load plugin metadata")?;

            for (file_name, data) in rows {
                if let Ok(entry) = serde_json::from_str::<ModMetadata>(&data) {
                    metadata.insert(file_name, entry);
                }
            }
        }

        if metadata.is_empty() {
            if let Ok(file_metadata) = self.load_plugin_metadata_from_file(plugins_directory).await
            {
                if !file_metadata.is_empty() {
                    self.save_plugin_metadata(plugins_directory, &file_metadata)
                        .await?;
                    return Ok(file_metadata);
                }
            }
        }

        Ok(metadata)
    }

    async fn load_mods_metadata(
        &self,
        mods_directory: &Path,
    ) -> Result<HashMap<String, ModMetadata>> {
        let game_dir = mods_directory
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let env_id = self.environment_id_for_dir(game_dir).await?;
        let mut metadata = HashMap::new();

        if let Some(env_id) = env_id {
            let rows = sqlx::query_as::<_, (String, String)>(
                "SELECT file_name, data FROM mod_metadata WHERE environment_id = ? AND kind = 'mods'",
            )
            .bind(&env_id)
            .fetch_all(&*self.pool)
            .await
            .context("Failed to load mods metadata")?;

            for (file_name, data) in rows {
                if let Ok(entry) = serde_json::from_str::<ModMetadata>(&data) {
                    metadata.insert(file_name, entry);
                }
            }
        }

        Ok(metadata)
    }

    async fn load_plugin_metadata_from_file(
        &self,
        plugins_directory: &Path,
    ) -> Result<HashMap<String, ModMetadata>> {
        let metadata_file = plugins_directory.join(".plugins-metadata.json");
        if !metadata_file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&metadata_file)
            .await
            .context("Failed to read plugin metadata file")?;
        let metadata: HashMap<String, ModMetadata> =
            serde_json::from_str(&content).context("Failed to parse plugin metadata file")?;
        Ok(metadata)
    }

    pub async fn save_plugin_metadata(
        &self,
        plugins_directory: &Path,
        metadata: &HashMap<String, ModMetadata>,
    ) -> Result<()> {
        let game_dir = plugins_directory
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let env_id = match self.environment_id_for_dir(game_dir).await? {
            Some(id) => id,
            None => {
                log::warn!(
                    "Skipping plugin metadata save; environment not found for {}",
                    game_dir
                );
                return Ok(());
            }
        };

        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to begin transaction for plugin metadata")?;

        sqlx::query("DELETE FROM mod_metadata WHERE environment_id = ? AND kind = 'plugins'")
            .bind(&env_id)
            .execute(&mut *tx)
            .await
            .context("Failed to clear plugin metadata")?;

        for (file_name, meta) in metadata {
            let serialized =
                serde_json::to_string(meta).context("Failed to serialize plugin metadata")?;
            sqlx::query(
                "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'plugins', ?, ?)",
            )
            .bind(&env_id)
            .bind(file_name)
            .bind(serialized)
            .execute(&mut *tx)
            .await
            .context("Failed to save plugin metadata")?;
        }

        tx.commit()
            .await
            .context("Failed to commit plugin metadata transaction")?;
        Ok(())
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

    pub async fn install_zip_plugin(
        &self,
        game_dir: &str,
        zip_path: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        fs::create_dir_all(&plugins_directory).await?;

        // Check for Thunderstore manifest.json
        let archive_path = Path::new(zip_path);
        let thunderstore_manifest = self.extract_thunderstore_manifest(archive_path);

        // If we found a Thunderstore manifest, use it
        let mut effective_metadata = metadata.clone();
        if let Some(ref manifest) = thunderstore_manifest {
            eprintln!("[DEBUG] Found Thunderstore manifest.json in plugin ZIP");
            eprintln!(
                "[DEBUG] Manifest contents: {}",
                serde_json::to_string_pretty(manifest).unwrap_or_default()
            );

            // Override metadata with Thunderstore data
            let mut ts_metadata = serde_json::Map::new();
            ts_metadata.insert(
                "source".to_string(),
                serde_json::Value::String("thunderstore".to_string()),
            );

            if let Some(name) = manifest.get("name").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "modName".to_string(),
                    serde_json::Value::String(name.to_string()),
                );
            }

            if let Some(version) = manifest.get("version_number").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "sourceVersion".to_string(),
                    serde_json::Value::String(version.to_string()),
                );
            }

            if let Some(author) = manifest.get("author").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "author".to_string(),
                    serde_json::Value::String(author.to_string()),
                );
            }

            if let Some(website) = manifest.get("website_url").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "sourceUrl".to_string(),
                    serde_json::Value::String(website.to_string()),
                );
            }

            // Create source ID from author/name
            if let (Some(author), Some(name)) = (
                manifest.get("author").and_then(|v| v.as_str()),
                manifest.get("name").and_then(|v| v.as_str()),
            ) {
                let source_id = format!("{}/{}", author, name);
                ts_metadata.insert("sourceId".to_string(), serde_json::Value::String(source_id));
            }

            effective_metadata = Some(serde_json::Value::Object(ts_metadata));
        }

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir().join(format!(
            "plugin-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ));
        fs::create_dir_all(&temp_dir)
            .await
            .context("Failed to create temp directory")?;

        // Extract ZIP to temp directory (same pattern as mods)
        let file = File::open(archive_path).context("Failed to open zip file")?;
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

        let mut installed_files = Vec::new();

        // Look for Plugins/ directory in the extracted archive (Thunderstore structure)
        let plugins_source_dir = temp_dir.join("Plugins");
        let plugins_source_dir_lower = temp_dir.join("plugins");

        // Check which plugins directory exists (case-insensitive)
        let source_plugins_dir = if plugins_source_dir.exists() {
            plugins_source_dir
        } else if plugins_source_dir_lower.exists() {
            plugins_source_dir_lower
        } else {
            // No Plugins folder, check root level for DLLs (legacy/local structure)
            temp_dir.clone()
        };

        // Copy DLL files from source to plugins directory
        if source_plugins_dir.is_dir() {
            // Copy from Plugins/ folder
            let mut entries = fs::read_dir(&source_plugins_dir)
                .await
                .context("Failed to read Plugins directory from archive")?;

            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                if entry_path.is_file() {
                    let file_name = entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");

                    if file_name.to_lowercase().ends_with(".dll") {
                        let dest_path = plugins_directory.join(file_name);
                        fs::copy(&entry_path, &dest_path)
                            .await
                            .context("Failed to copy plugin file")?;
                        installed_files.push(file_name.to_string());
                    }
                }
            }
        } else {
            // Legacy structure: DLLs at root level
            let mut entries = fs::read_dir(&source_plugins_dir)
                .await
                .context("Failed to read temp directory")?;

            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                if entry_path.is_file() {
                    let file_name = entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");

                    // Only root-level DLLs (not in subdirectories)
                    if file_name.to_lowercase().ends_with(".dll") {
                        let dest_path = plugins_directory.join(file_name);
                        fs::copy(&entry_path, &dest_path)
                            .await
                            .context("Failed to copy plugin file")?;
                        installed_files.push(file_name.to_string());
                    }
                }
            }
        }

        // Clean up temp directory
        let _ = fs::remove_dir_all(&temp_dir).await;

        if installed_files.is_empty() {
            return Ok(serde_json::json!({
                "success": false,
                "error": "No plugin DLL files found in ZIP archive. Expected files in Plugins/ folder or at root level."
            }));
        }

        // Update plugin metadata
        let mut plugin_metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        // Extract metadata from effective metadata
        let source_str = effective_metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));

        let mod_source = match source_str {
            Some("thunderstore") => Some(ModSource::Thunderstore),
            Some("nexusmods") => Some(ModSource::Nexusmods),
            Some("github") => Some(ModSource::Github),
            Some("unknown") => Some(ModSource::Unknown),
            _ => Some(ModSource::Local),
        };

        let source_id = effective_metadata.as_ref().and_then(|m| {
            m.get("sourceId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_version = effective_metadata.as_ref().and_then(|m| {
            m.get("sourceVersion")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_url = effective_metadata.as_ref().and_then(|m| {
            m.get("sourceUrl")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let mod_name = effective_metadata.as_ref().and_then(|m| {
            m.get("modName")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let author = effective_metadata.as_ref().and_then(|m| {
            m.get("author")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });

        // Update metadata for all installed files
        for file_name in &installed_files {
            plugin_metadata.insert(
                file_name.clone(),
                ModMetadata {
                    source: mod_source.clone(),
                    source_id: source_id.clone(),
                    source_version: source_version.clone(),
                    author: author.clone(),
                    mod_name: mod_name.clone(),
                    source_url: source_url.clone(),
                    summary: None,
                    icon_url: None,
                    icon_cache_path: None,
                    downloads: None,
                    likes_or_endorsements: None,
                    updated_at: None,
                    tags: None,
                    installed_version: None,
                    library_added_at: None,
                    installed_at: Some(chrono::Utc::now()),
                    last_update_check: None,
                    metadata_last_refreshed: None,
                    update_available: None,
                    remote_version: None,
                    detected_runtime: None,
                    runtime_match: None,
                    mod_storage_id: None,
                    symlink_paths: None,
                },
            );
        }

        self.save_plugin_metadata(&plugins_directory, &plugin_metadata)
            .await?;

        let response_source = match mod_source {
            Some(ModSource::Thunderstore) => "thunderstore",
            Some(ModSource::Nexusmods) => "nexusmods",
            Some(ModSource::Github) => "github",
            Some(ModSource::Unknown) => "unknown",
            Some(ModSource::Local) => "local",
            _ => "unknown",
        };

        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files,
            "source": response_source
        }))
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

        let mut entries = fs::read_dir(&plugins_directory)
            .await
            .context("Failed to read Plugins directory")?;

        let mut dll_files = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    let path_string = path.to_string_lossy().to_string();
                    dll_files.push((path_string, file_name.to_string()));
                }
            }
        }

        // Load metadata
        let plugin_metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        // Also check mods metadata to find related mods
        let mods_directory = self.get_mods_directory(game_dir);
        let mods_metadata = self
            .load_mods_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        let mut plugins = Vec::new();
        for (file_path, file_name) in dll_files {
            let is_disabled = file_name.to_lowercase().ends_with(".disabled");
            let original_file_name = if is_disabled {
                file_name.replace(".disabled", "")
            } else {
                file_name.clone()
            };

            let plugin_name = original_file_name.replace(".dll", "").replace(".DLL", "");

            // Get metadata for the original filename (without .disabled)
            let file_metadata = plugin_metadata
                .get(&original_file_name)
                .or_else(|| plugin_metadata.get(&file_name))
                .cloned();

            // Check for related mod in mods metadata
            let related_mod = mods_metadata
                .values()
                .find(|meta| {
                    meta.mod_name
                        .as_ref()
                        .map(|n| n.to_lowercase() == plugin_name.to_lowercase())
                        .unwrap_or(false)
                })
                .and_then(|meta| meta.mod_name.clone());

            let version = file_metadata
                .as_ref()
                .and_then(|m| m.installed_version.clone());

            let source = file_metadata.as_ref().and_then(|m| m.source.clone());

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
        let count = result.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
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

        fs::remove_file(&file_to_delete)
            .await
            .context("Failed to delete plugin file")?;

        // Remove from metadata
        let mut metadata_map = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());
        metadata_map.remove(plugin_file_name);
        self.save_plugin_metadata(&plugins_directory, &metadata_map)
            .await?;

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
        fs::rename(&plugin_path, &disabled_path)
            .await
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
        fs::rename(&disabled_path, &plugin_path)
            .await
            .context("Failed to enable plugin")?;

        Ok(())
    }

    pub async fn install_dll_plugin(
        &self,
        game_dir: &str,
        dll_path: &str,
        original_file_name: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        fs::create_dir_all(&plugins_directory)
            .await
            .context("Failed to create plugins directory")?;

        let source_path = Path::new(dll_path);
        if !source_path.exists() {
            return Err(anyhow::anyhow!("Plugin file not found"));
        }

        if !original_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!(
                "Only .dll files are supported for plugin installation"
            ));
        }

        let dest_path = plugins_directory.join(original_file_name);
        fs::copy(source_path, &dest_path)
            .await
            .context("Failed to copy plugin file")?;

        let source_str = metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));
        let mod_source = match source_str {
            Some("thunderstore") => Some(ModSource::Thunderstore),
            Some("nexusmods") => Some(ModSource::Nexusmods),
            Some("github") => Some(ModSource::Github),
            Some("unknown") => Some(ModSource::Unknown),
            _ => Some(ModSource::Local),
        };

        let source_id = metadata.as_ref().and_then(|m| {
            m.get("sourceId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_version = metadata.as_ref().and_then(|m| {
            m.get("sourceVersion")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_url = metadata.as_ref().and_then(|m| {
            m.get("sourceUrl")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let mod_name = metadata
            .as_ref()
            .and_then(|m| {
                m.get("modName")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                Some(
                    original_file_name
                        .trim_end_matches(".dll")
                        .trim_end_matches(".DLL")
                        .to_string(),
                )
            });
        let author = metadata.as_ref().and_then(|m| {
            m.get("author")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });

        let mut plugin_metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        plugin_metadata.insert(
            original_file_name.to_string(),
            ModMetadata {
                source: mod_source.clone(),
                source_id,
                source_version,
                author,
                mod_name,
                source_url,
                summary: None,
                icon_url: None,
                icon_cache_path: None,
                downloads: None,
                likes_or_endorsements: None,
                updated_at: None,
                tags: None,
                installed_version: None,
                library_added_at: None,
                installed_at: Some(chrono::Utc::now()),
                last_update_check: None,
                metadata_last_refreshed: None,
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
                mod_storage_id: None,
                symlink_paths: None,
            },
        );

        self.save_plugin_metadata(&plugins_directory, &plugin_metadata)
            .await?;

        let response_source = match mod_source {
            Some(ModSource::Thunderstore) => "thunderstore",
            Some(ModSource::Nexusmods) => "nexusmods",
            Some(ModSource::Github) => "github",
            Some(ModSource::Unknown) => "unknown",
            Some(ModSource::Local) => "local",
            _ => "unknown",
        };

        Ok(serde_json::json!({
            "success": true,
            "fileName": original_file_name,
            "source": response_source
        }))
    }

    pub async fn install_mlvscan(
        &self,
        game_dir: &str,
        dll_path: &str,
        version: &str,
    ) -> Result<serde_json::Value> {
        let plugins_directory = self.get_plugins_directory(game_dir);
        fs::create_dir_all(&plugins_directory)
            .await
            .context("Failed to create plugins directory")?;

        let source_path = Path::new(dll_path);
        // The source file might be named MLVScan.MelonLoader.dll or similar
        // but we always install it as MLVScan.dll in the Plugins folder
        let dest_path = plugins_directory.join("MLVScan.dll");

        // Copy the DLL file
        fs::copy(source_path, &dest_path)
            .await
            .context("Failed to copy MLVScan.dll")?;

        // Update plugin metadata
        let mut metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        let mlvscan_metadata = ModMetadata {
            source: Some(ModSource::Local),
            source_id: None,
            source_version: Some(version.to_string()),
            author: Some("ifBars".to_string()),
            mod_name: Some("MLVScan".to_string()),
            source_url: Some("https://github.com/ifBars/MLVScan".to_string()),
            summary: None,
            icon_url: None,
            icon_cache_path: None,
            downloads: None,
            likes_or_endorsements: None,
            updated_at: None,
            tags: None,
            installed_version: Some(version.to_string()),
            library_added_at: None,
            installed_at: Some(chrono::Utc::now()),
            last_update_check: None,
            metadata_last_refreshed: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
            mod_storage_id: None,
            symlink_paths: None,
        };

        metadata.insert("MLVScan.dll".to_string(), mlvscan_metadata);
        self.save_plugin_metadata(&plugins_directory, &metadata)
            .await?;

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
            fs::remove_file(&plugin_path)
                .await
                .context("Failed to remove MLVScan.dll")?;
            deleted = true;
        }
        if disabled_path.exists() {
            fs::remove_file(&disabled_path)
                .await
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
        let mut metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());
        metadata.remove("MLVScan.dll");
        self.save_plugin_metadata(&plugins_directory, &metadata)
            .await?;

        Ok(serde_json::json!({
            "success": true,
            "message": "MLVScan uninstalled successfully"
        }))
    }

    pub async fn get_mlvscan_installation_status(
        &self,
        game_dir: &str,
    ) -> Result<serde_json::Value> {
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
        let metadata = self
            .load_plugin_metadata(&plugins_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        if let Some(meta) = metadata.get("MLVScan.dll") {
            // Check installed_version first, then fall back to source_version
            version = meta
                .installed_version
                .clone()
                .or_else(|| meta.source_version.clone());
        }

        // If no version in metadata, try to extract from DLL
        if version.is_none() && has_plugin {
            // Use mods service to extract version (plugins use same DLL structure)
            use crate::services::mods::ModsService;
            let mods_service = ModsService::new(self.pool.clone());
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

#[cfg(test)]
mod tests {
    use super::PluginsService;
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::types::{schedule_i_config, ModSource};
    use anyhow::Result;
    use serial_test::serial;
    use tempfile::tempdir;
    use tokio::fs;

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

    #[tokio::test]
    #[serial]
    async fn install_and_uninstall_mlvscan_updates_status_and_listing() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = PluginsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("plugins-env");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let source_dll = temp.path().join("MLVScan.Input.dll");
        fs::write(&source_dll, b"not-a-real-dotnet-assembly").await?;

        service
            .install_mlvscan(
                output_dir.to_string_lossy().as_ref(),
                source_dll.to_string_lossy().as_ref(),
                "v1.2.3",
            )
            .await?;

        let status = service
            .get_mlvscan_installation_status(output_dir.to_string_lossy().as_ref())
            .await?;
        assert_eq!(
            status.get("installed").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(status.get("enabled").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            status.get("version").and_then(|v| v.as_str()),
            Some("v1.2.3")
        );

        let list = service
            .list_plugins(output_dir.to_string_lossy().as_ref())
            .await?;
        let count = list.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
        assert_eq!(count, 1);

        service
            .uninstall_mlvscan(output_dir.to_string_lossy().as_ref())
            .await?;
        let status_after = service
            .get_mlvscan_installation_status(output_dir.to_string_lossy().as_ref())
            .await?;
        assert_eq!(
            status_after.get("installed").and_then(|v| v.as_bool()),
            Some(false)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn disable_and_enable_plugin_renames_file() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = PluginsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("plugins-toggle");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let plugins_dir = output_dir.join("Plugins");
        fs::create_dir_all(&plugins_dir).await?;
        fs::write(plugins_dir.join("ExamplePlugin.dll"), b"data").await?;

        service
            .disable_plugin(output_dir.to_string_lossy().as_ref(), "ExamplePlugin.dll")
            .await?;
        assert!(plugins_dir.join("ExamplePlugin.dll.disabled").exists());

        service
            .enable_plugin(output_dir.to_string_lossy().as_ref(), "ExamplePlugin.dll")
            .await?;
        assert!(plugins_dir.join("ExamplePlugin.dll").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_dll_plugin_copies_file_and_persists_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = PluginsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("plugins-dll");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let source_dll = temp.path().join("Plugin.Source.dll");
        fs::write(&source_dll, b"not-a-real-dotnet-assembly").await?;

        let result = service
            .install_dll_plugin(
                output_dir.to_string_lossy().as_ref(),
                source_dll.to_string_lossy().as_ref(),
                "InstalledPlugin.dll",
                Some(serde_json::json!({
                    "source": "github",
                    "sourceId": "example/repo",
                    "sourceVersion": "1.2.3",
                    "sourceUrl": "https://github.com/example/repo",
                    "modName": "Installed Plugin",
                    "author": "example"
                })),
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result.get("source").and_then(|v| v.as_str()),
            Some("github")
        );

        let plugins_dir = output_dir.join("Plugins");
        assert!(plugins_dir.join("InstalledPlugin.dll").exists());

        let metadata = service.load_plugin_metadata(&plugins_dir).await?;
        let entry = metadata
            .get("InstalledPlugin.dll")
            .expect("metadata entry for installed plugin");

        assert!(matches!(entry.source, Some(ModSource::Github)));
        assert_eq!(entry.source_id.as_deref(), Some("example/repo"));
        assert_eq!(entry.source_version.as_deref(), Some("1.2.3"));

        Ok(())
    }
}
