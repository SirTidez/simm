use std::path::Path;
use std::collections::HashMap;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub name: String,
    pub path: String,
    pub file_type: ConfigFileType,
    pub sections: Vec<ConfigSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ConfigFileType {
    MelonPreferences,
    LoaderConfig,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSection {
    pub name: String,
    pub entries: Vec<ConfigEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub value: String,
    pub comment: Option<String>,
}

#[derive(Clone)]
pub struct ConfigService;

impl ConfigService {
    pub fn new() -> Self {
        Self
    }

    /// Get all configuration files for an environment
    pub async fn get_config_files(&self, game_dir: &str) -> Result<Vec<ConfigFile>> {
        let game_path = Path::new(game_dir);
        let userdata_path = game_path.join("UserData");

        if !userdata_path.exists() {
            return Ok(Vec::new());
        }

        let mut config_files = Vec::new();

        // Parse MelonPreferences.cfg
        let melon_prefs_path = userdata_path.join("MelonPreferences.cfg");
        if melon_prefs_path.exists() {
            if let Ok(config) = self.parse_ini_file(&melon_prefs_path, ConfigFileType::MelonPreferences).await {
                config_files.push(config);
            }
        }

        // Parse Loader.cfg (MelonLoader settings)
        let loader_cfg_path = game_path.join("MelonLoader").join("Loader.cfg");
        if loader_cfg_path.exists() {
            if let Ok(config) = self.parse_ini_file(&loader_cfg_path, ConfigFileType::LoaderConfig).await {
                config_files.push(config);
            }
        }

        // Scan UserData for other .cfg files
        if let Ok(mut entries) = fs::read_dir(&userdata_path).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext == "cfg" && path.file_name().unwrap() != "MelonPreferences.cfg" {
                            if let Ok(config) = self.parse_ini_file(&path, ConfigFileType::Other).await {
                                config_files.push(config);
                            }
                        }
                    }
                }
            }
        }

        Ok(config_files)
    }

    /// Parse an INI-style configuration file
    async fn parse_ini_file(&self, path: &Path, file_type: ConfigFileType) -> Result<ConfigFile> {
        let content = fs::read_to_string(path)
            .await
            .context("Failed to read config file")?;

        let mut sections: HashMap<String, Vec<ConfigEntry>> = HashMap::new();
        let mut current_section = String::from("General");
        let mut pending_comment: Option<String> = None;

        for line in content.lines() {
            let trimmed = line.trim();

            // Skip empty lines
            if trimmed.is_empty() {
                continue;
            }

            // Handle comments
            if trimmed.starts_with('#') || trimmed.starts_with(';') {
                let comment_text = trimmed.trim_start_matches(|c| c == '#' || c == ';').trim();
                pending_comment = Some(comment_text.to_string());
                continue;
            }

            // Handle section headers [SectionName]
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
                continue;
            }

            // Handle key=value pairs
            if let Some(eq_pos) = trimmed.find('=') {
                let key = trimmed[..eq_pos].trim().to_string();
                let value = trimmed[eq_pos + 1..].trim().to_string();

                let entry = ConfigEntry {
                    key,
                    value,
                    comment: pending_comment.take(),
                };

                sections
                    .entry(current_section.clone())
                    .or_insert_with(Vec::new)
                    .push(entry);
            }
        }

        // Convert HashMap to Vec<ConfigSection>
        let section_list: Vec<ConfigSection> = sections
            .into_iter()
            .map(|(name, entries)| ConfigSection { name, entries })
            .collect();

        Ok(ConfigFile {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string(),
            path: path.to_string_lossy().to_string(),
            file_type,
            sections: section_list,
        })
    }

    /// Update a configuration file with new values
    pub async fn update_config_file(
        &self,
        file_path: &str,
        updates: HashMap<String, HashMap<String, String>>,
    ) -> Result<()> {
        let path = Path::new(file_path);
        let content = fs::read_to_string(path)
            .await
            .context("Failed to read config file")?;

        let mut new_content = String::new();
        let mut current_section = String::from("General");

        for line in content.lines() {
            let trimmed = line.trim();

            // Preserve empty lines and comments
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                new_content.push_str(line);
                new_content.push('\n');
                continue;
            }

            // Update section
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
                new_content.push_str(line);
                new_content.push('\n');
                continue;
            }

            // Update key=value pairs
            if let Some(eq_pos) = trimmed.find('=') {
                let key = trimmed[..eq_pos].trim();

                // Check if we have an update for this section/key
                if let Some(section_updates) = updates.get(&current_section) {
                    if let Some(new_value) = section_updates.get(key) {
                        // Write updated value
                        new_content.push_str(&format!("{} = {}\n", key, new_value));
                        continue;
                    }
                }

                // No update, preserve original line
                new_content.push_str(line);
                new_content.push('\n');
            } else {
                // Preserve any other lines
                new_content.push_str(line);
                new_content.push('\n');
            }
        }

        // Write the updated content back to the file
        fs::write(path, new_content)
            .await
            .context("Failed to write config file")?;

        Ok(())
    }

    /// Group MelonPreferences sections by mod name
    /// Groups sections by the part before the dot, and also groups mods by their base mod name (first segment)
    /// (e.g., "HighBaller_IL2CPP", "HighBaller_IL2CPP_Automation", "HighBaller_IL2CPP_Features" -> "HighBaller")
    pub fn group_by_mod(&self, config: &ConfigFile) -> HashMap<String, Vec<ConfigSection>> {
        if config.file_type != ConfigFileType::MelonPreferences {
            return HashMap::new();
        }

        let mut grouped: HashMap<String, Vec<ConfigSection>> = HashMap::new();

        // First pass: Group by dot separator (existing behavior)
        for section in &config.sections {
            // MelonPreferences sections are typically named like "ModName.SettingCategory"
            // or just "ModName"
            let mod_name = if let Some(dot_pos) = section.name.find('.') {
                section.name[..dot_pos].to_string()
            } else {
                section.name.clone()
            };

            grouped
                .entry(mod_name)
                .or_insert_with(Vec::new)
                .push(section.clone());
        }

        // Second pass: Group mods by their base mod name (first segment)
        // e.g., "HighBaller_IL2CPP", "HighBaller_IL2CPP_Automation", "HighBaller_IL2CPP_Features" -> "HighBaller"
        let mod_names: Vec<String> = grouped.keys().cloned().collect();
        let mut mod_name_groups: HashMap<String, Vec<String>> = HashMap::new(); // Maps base_mod_name -> list of full mod_names
        let mut processed_mods: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        // Group mods by their base mod name (first segment before underscore)
        for mod_name in &mod_names {
            // Only process mod names without dots (already grouped by dot)
            if mod_name.contains('.') || processed_mods.contains(mod_name) {
                continue;
            }
            
            // Extract the base mod name (first segment)
            let base_mod_name = if let Some(underscore_pos) = mod_name.find('_') {
                mod_name[..underscore_pos].to_string()
            } else {
                // No underscore, skip (keep as-is)
                continue;
            };
            
            // Find all mods that start with this base mod name followed by underscore
            let matching_mods: Vec<String> = mod_names
                .iter()
                .filter(|name| {
                    !name.contains('.') && 
                    !processed_mods.contains(*name) &&
                    name.starts_with(&format!("{}_", base_mod_name))
                })
                .cloned()
                .collect();
            
            // Group all mods sharing this base name (even if only one)
            if !matching_mods.is_empty() {
                for m in &matching_mods {
                    processed_mods.insert(m.clone());
                }
                mod_name_groups.insert(base_mod_name, matching_mods);
            }
        }
        
        // Merge groups by base mod name
        let mut merged_grouped: HashMap<String, Vec<ConfigSection>> = HashMap::new();
        let mut processed: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        // First, merge groups that share a common base mod name
        for (base_mod_name, mod_names_to_merge) in mod_name_groups {
            let mut merged_sections = Vec::new();
            for mod_name in &mod_names_to_merge {
                if let Some(sections) = grouped.get(mod_name) {
                    merged_sections.extend(sections.clone());
                }
                processed.insert(mod_name.clone());
            }
            merged_grouped.insert(base_mod_name, merged_sections);
        }
        
        // Then, add all mods that weren't grouped
        for (mod_name, sections) in grouped {
            if !processed.contains(&mod_name) {
                merged_grouped.insert(mod_name, sections);
            }
        }

        merged_grouped
    }
}
