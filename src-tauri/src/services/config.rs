use crate::types::{
    ConfigDocument, ConfigEditOperation, ConfigEntry, ConfigFileSummary, ConfigFileType,
    ConfigGroup, ConfigSection,
};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::fs;

#[derive(Debug, Clone)]
struct ParsedSection {
    name: String,
    has_header: bool,
    entries: Vec<ConfigEntry>,
}

#[derive(Debug, Clone)]
struct ParsedDocument {
    raw_content: String,
    sections: Vec<ParsedSection>,
    parse_warnings: Vec<String>,
}

#[derive(Clone)]
pub struct ConfigService;

impl ConfigService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_config_catalog(&self, game_dir: &str) -> Result<Vec<ConfigFileSummary>> {
        let discovered = self.discover_config_files(game_dir).await?;
        let mut catalog = Vec::new();

        for (path, file_type) in discovered {
            let document = self.parse_config_document(&path, file_type).await?;
            catalog.push(document.summary);
        }

        catalog.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(catalog)
    }

    pub async fn get_config_document(
        &self,
        game_dir: &str,
        file_path: &str,
    ) -> Result<ConfigDocument> {
        let requested = Self::normalize_path(file_path)?;
        let discovered = self.discover_config_files(game_dir).await?;

        let mut matched: Option<(PathBuf, ConfigFileType)> = None;
        for (candidate, file_type) in discovered {
            let normalized_candidate = candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
            if Self::paths_equal(&candidate, &requested)
                || Self::paths_equal(&normalized_candidate, &requested)
            {
                matched = Some((candidate, file_type));
                break;
            }
        }

        let (path, file_type) =
            matched.ok_or_else(|| anyhow!("Config file not found for this environment"))?;

        self.parse_config_document(&path, file_type).await
    }

    pub async fn apply_config_edits(
        &self,
        file_path: &str,
        operations: Vec<ConfigEditOperation>,
    ) -> Result<()> {
        let path = Self::normalize_path(file_path)?;
        let file_type = self.detect_file_type(&path);
        let mut parsed = self.parse_config_file_internal(&path).await?;

        if !parsed.parse_warnings.is_empty() {
            bail!("Structured editing is unavailable for this file because unsupported lines were detected");
        }

        for operation in operations {
            self.apply_operation(&mut parsed.sections, operation)?;
        }

        let rendered = self.render_sections(&parsed.sections);
        let reparsed = self.parse_rendered_document(&rendered, file_type);
        if !reparsed.parse_warnings.is_empty() {
            bail!("Config file could not be re-parsed cleanly after applying edits");
        }

        fs::write(&path, rendered)
            .await
            .context("Failed to write config file")?;

        Ok(())
    }

    pub async fn save_raw_config(&self, file_path: &str, content: &str) -> Result<()> {
        let path = Self::normalize_path(file_path)?;
        fs::write(path, content)
            .await
            .context("Failed to write raw config file")
    }

    async fn discover_config_files(
        &self,
        game_dir: &str,
    ) -> Result<Vec<(PathBuf, ConfigFileType)>> {
        let game_path = Path::new(game_dir);
        let userdata_path = game_path.join("UserData");
        let mut config_files = Vec::new();

        if userdata_path.exists() {
            let melon_prefs_path = userdata_path.join("MelonPreferences.cfg");
            if melon_prefs_path.exists() {
                config_files.push((melon_prefs_path, ConfigFileType::MelonPreferences));
            }
        }

        let loader_cfg_path = game_path.join("MelonLoader").join("Loader.cfg");
        if loader_cfg_path.exists() {
            config_files.push((loader_cfg_path, ConfigFileType::LoaderConfig));
        }

        if userdata_path.exists() {
            self.collect_userdata_config_files(&userdata_path, &mut config_files)
                .await?;
        }

        config_files.sort_by(|(a, _), (b, _)| {
            a.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_lowercase()
                .cmp(
                    &b.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_lowercase(),
                )
        });

        Ok(config_files)
    }

    async fn parse_config_document(
        &self,
        path: &Path,
        file_type: ConfigFileType,
    ) -> Result<ConfigDocument> {
        let parsed = if file_type == ConfigFileType::Json {
            let raw_content = fs::read_to_string(path)
                .await
                .context("Failed to read config file")?;
            ParsedDocument {
                raw_content,
                sections: Vec::new(),
                parse_warnings: vec![
                    "Structured editing is not currently available for JSON configuration files."
                        .to_string(),
                ],
            }
        } else {
            self.parse_config_file_internal(path).await?
        };
        let metadata = fs::metadata(path)
            .await
            .context("Failed to read config metadata")?;
        let last_modified = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64);
        let sections = parsed
            .sections
            .iter()
            .map(|section| ConfigSection {
                name: section.name.clone(),
                entries: section.entries.clone(),
            })
            .collect::<Vec<_>>();
        let entry_count = sections.iter().map(|section| section.entries.len()).sum();
        let parse_warnings = parsed.parse_warnings.clone();
        let relative_path = Self::relative_config_path(path);
        let group_name = Self::group_name_for_path(path, &file_type);

        Ok(ConfigDocument {
            summary: ConfigFileSummary {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown")
                    .to_string(),
                path: path.to_string_lossy().to_string(),
                file_type: file_type.clone(),
                format: if file_type == ConfigFileType::Json {
                    "json".to_string()
                } else {
                    "ini".to_string()
                },
                relative_path,
                group_name,
                last_modified,
                section_count: sections.len(),
                entry_count,
                supports_structured_edit: parse_warnings.is_empty(),
                supports_raw_edit: true,
            },
            raw_content: parsed.raw_content,
            sections: sections.clone(),
            parse_warnings,
            groups: if file_type == ConfigFileType::MelonPreferences {
                self.build_groups(&sections)
            } else {
                Vec::new()
            },
        })
    }

    async fn parse_config_file_internal(&self, path: &Path) -> Result<ParsedDocument> {
        let raw_content = fs::read_to_string(path)
            .await
            .context("Failed to read config file")?;

        Ok(self.parse_ini_like_content(raw_content))
    }

    fn parse_rendered_document(
        &self,
        raw_content: &str,
        file_type: ConfigFileType,
    ) -> ParsedDocument {
        if file_type == ConfigFileType::Json {
            ParsedDocument {
                raw_content: raw_content.to_string(),
                sections: Vec::new(),
                parse_warnings: vec![
                    "Structured editing is not currently available for JSON configuration files."
                        .to_string(),
                ],
            }
        } else {
            self.parse_ini_like_content(raw_content.to_string())
        }
    }

    fn parse_ini_like_content(&self, raw_content: String) -> ParsedDocument {
        let mut sections = vec![ParsedSection {
            name: "General".to_string(),
            has_header: false,
            entries: Vec::new(),
        }];
        let mut current_section_index = 0usize;
        let mut pending_comment: Option<String> = None;
        let mut parse_warnings = Vec::new();

        for (line_index, line) in raw_content.lines().enumerate() {
            let trimmed = line.trim();

            if trimmed.is_empty() {
                continue;
            }

            if trimmed.starts_with('#') || trimmed.starts_with(';') {
                let comment_text = trimmed.trim_start_matches(['#', ';']).trim();
                pending_comment = Some(match pending_comment.take() {
                    Some(existing) if !existing.is_empty() => {
                        format!("{}\n{}", existing, comment_text)
                    }
                    _ => comment_text.to_string(),
                });
                continue;
            }

            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                let section_name = trimmed[1..trimmed.len() - 1].trim().to_string();
                if section_name.is_empty() {
                    parse_warnings.push(format!(
                        "Line {} contains an empty section header",
                        line_index + 1
                    ));
                    continue;
                }

                sections.push(ParsedSection {
                    name: section_name,
                    has_header: true,
                    entries: Vec::new(),
                });
                current_section_index = sections.len() - 1;
                pending_comment = None;
                continue;
            }

            if let Some(eq_pos) = trimmed.find('=') {
                let key = trimmed[..eq_pos].trim().to_string();
                let value = trimmed[eq_pos + 1..].trim().to_string();

                if key.is_empty() {
                    parse_warnings.push(format!("Line {} contains an empty key", line_index + 1));
                    continue;
                }

                sections[current_section_index].entries.push(ConfigEntry {
                    key,
                    value,
                    comment: pending_comment.take(),
                });
                continue;
            }

            parse_warnings.push(format!(
                "Line {} is not supported by the structured parser: {}",
                line_index + 1,
                trimmed
            ));
        }

        if sections
            .first()
            .map(|section| section.entries.is_empty())
            .unwrap_or(false)
            && sections.len() > 1
        {
            sections.remove(0);
        }

        ParsedDocument {
            raw_content,
            sections,
            parse_warnings,
        }
    }

    fn build_groups(&self, sections: &[ConfigSection]) -> Vec<ConfigGroup> {
        let mut grouped: HashMap<String, Vec<String>> = HashMap::new();

        for section in sections {
            let mod_name = if let Some(dot_pos) = section.name.find('.') {
                section.name[..dot_pos].to_string()
            } else {
                section.name.clone()
            };

            grouped
                .entry(mod_name)
                .or_default()
                .push(section.name.clone());
        }

        let mod_names = grouped.keys().cloned().collect::<Vec<_>>();
        let mut merged = Vec::new();
        let mut processed = HashSet::new();

        for mod_name in &mod_names {
            if processed.contains(mod_name) {
                continue;
            }

            let base_name = mod_name.split('_').next().unwrap_or(mod_name);
            let matching = mod_names
                .iter()
                .filter(|candidate| {
                    candidate == &mod_name || candidate.starts_with(&format!("{}_", base_name))
                })
                .cloned()
                .collect::<Vec<_>>();

            if matching.is_empty() {
                continue;
            }

            let mut section_names = Vec::new();
            for item in &matching {
                processed.insert(item.clone());
                if let Some(names) = grouped.get(item) {
                    section_names.extend(names.iter().cloned());
                }
            }
            section_names.sort();
            section_names.dedup();

            merged.push(ConfigGroup {
                id: base_name.to_lowercase().replace(' ', "-"),
                label: base_name.to_string(),
                section_names,
            });
        }

        merged.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        merged
    }

    fn apply_operation(
        &self,
        sections: &mut Vec<ParsedSection>,
        operation: ConfigEditOperation,
    ) -> Result<()> {
        match operation {
            ConfigEditOperation::SetValue {
                section,
                key,
                value,
            } => {
                let entry = Self::find_entry_mut(sections, &section, &key)?;
                entry.value = value;
            }
            ConfigEditOperation::SetComment {
                section,
                key,
                comment,
            } => {
                let entry = Self::find_entry_mut(sections, &section, &key)?;
                entry.comment = comment
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
            }
            ConfigEditOperation::AddSection { section } => {
                if sections.iter().any(|candidate| candidate.name == section) {
                    bail!("Section '{}' already exists", section);
                }

                sections.push(ParsedSection {
                    name: section,
                    has_header: true,
                    entries: Vec::new(),
                });
            }
            ConfigEditOperation::DeleteSection { section } => {
                let index = sections
                    .iter()
                    .position(|candidate| candidate.name == section)
                    .ok_or_else(|| anyhow!("Section '{}' not found", section))?;
                sections.remove(index);
            }
            ConfigEditOperation::AddEntry {
                section,
                key,
                value,
                comment,
            } => {
                let section_index = sections
                    .iter()
                    .position(|candidate| candidate.name == section)
                    .ok_or_else(|| anyhow!("Section '{}' not found", section))?;

                if sections[section_index]
                    .entries
                    .iter()
                    .any(|entry| entry.key == key)
                {
                    bail!("Key '{}' already exists in section '{}'", key, section);
                }

                sections[section_index].entries.push(ConfigEntry {
                    key,
                    value,
                    comment: comment
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty()),
                });
            }
            ConfigEditOperation::DeleteEntry { section, key } => {
                let section_index = sections
                    .iter()
                    .position(|candidate| candidate.name == section)
                    .ok_or_else(|| anyhow!("Section '{}' not found", section))?;
                let entry_index = sections[section_index]
                    .entries
                    .iter()
                    .position(|entry| entry.key == key)
                    .ok_or_else(|| anyhow!("Key '{}' not found in section '{}'", key, section))?;
                sections[section_index].entries.remove(entry_index);
            }
        }

        Ok(())
    }

    fn render_sections(&self, sections: &[ParsedSection]) -> String {
        let mut output = String::new();

        for (section_index, section) in sections.iter().enumerate() {
            let should_write_header =
                section.has_header || section.name != "General" || section_index > 0;

            if !output.is_empty() && !output.ends_with("\n\n") {
                output.push('\n');
            }

            if should_write_header {
                output.push_str(&format!("[{}]\n", section.name));
            }

            for entry in &section.entries {
                if let Some(comment) = &entry.comment {
                    for line in comment.lines() {
                        output.push_str("# ");
                        output.push_str(line);
                        output.push('\n');
                    }
                }
                output.push_str(&format!("{} = {}\n", entry.key, entry.value));
            }
        }

        output
    }

    fn find_entry_mut<'a>(
        sections: &'a mut [ParsedSection],
        section_name: &str,
        key: &str,
    ) -> Result<&'a mut ConfigEntry> {
        let section = sections
            .iter_mut()
            .find(|candidate| candidate.name == section_name)
            .ok_or_else(|| anyhow!("Section '{}' not found", section_name))?;
        section
            .entries
            .iter_mut()
            .find(|entry| entry.key == key)
            .ok_or_else(|| anyhow!("Key '{}' not found in section '{}'", key, section_name))
    }

    fn detect_file_type(&self, path: &Path) -> ConfigFileType {
        match path.file_name().and_then(|name| name.to_str()) {
            Some("MelonPreferences.cfg") => ConfigFileType::MelonPreferences,
            Some("Loader.cfg") => ConfigFileType::LoaderConfig,
            _ if path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("json"))
                .unwrap_or(false) =>
            {
                ConfigFileType::Json
            }
            _ => ConfigFileType::Other,
        }
    }

    async fn collect_userdata_config_files(
        &self,
        directory: &Path,
        config_files: &mut Vec<(PathBuf, ConfigFileType)>,
    ) -> Result<()> {
        let mut pending = vec![directory.to_path_buf()];

        while let Some(current_dir) = pending.pop() {
            let mut entries = match fs::read_dir(&current_dir).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let metadata = match entry.metadata().await {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };

                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }

                if !metadata.is_file() {
                    continue;
                }

                let is_cfg = path
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("cfg"))
                    .unwrap_or(false);
                let is_json = path
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("json"))
                    .unwrap_or(false);

                if !is_cfg && !is_json {
                    continue;
                }

                if path.file_name().and_then(|name| name.to_str()) == Some("MelonPreferences.cfg") {
                    continue;
                }

                let file_type = self.detect_file_type(&path);
                config_files.push((path, file_type));
            }
        }

        Ok(())
    }

    fn relative_config_path(path: &Path) -> String {
        let path_str = path.to_string_lossy();
        if let Some(index) = path_str.find("UserData") {
            return path_str[index..].replace('\\', "/");
        }
        if let Some(index) = path_str.find("MelonLoader") {
            return path_str[index..].replace('\\', "/");
        }
        path_str.replace('\\', "/")
    }

    fn group_name_for_path(path: &Path, file_type: &ConfigFileType) -> String {
        match file_type {
            ConfigFileType::LoaderConfig => "Loader".to_string(),
            ConfigFileType::MelonPreferences => "MelonPreferences".to_string(),
            ConfigFileType::Json | ConfigFileType::Other => {
                let path_str = path.to_string_lossy();
                if let Some(index) = path_str.find("UserData") {
                    let relative =
                        path_str[index + "UserData".len()..].trim_start_matches(['\\', '/']);
                    let mut parts = relative.split(['\\', '/']).filter(|part| !part.is_empty());
                    let first = parts.next();
                    let second = parts.next();

                    return match (first, second) {
                        (Some(folder), Some(_)) => folder.to_string(),
                        (Some(_file), None) => "UserData Root".to_string(),
                        _ => "Other Config Files".to_string(),
                    };
                }

                "Other Config Files".to_string()
            }
        }
    }

    fn normalize_path(path: &str) -> Result<PathBuf> {
        let path_buf = PathBuf::from(path);
        if !path_buf.exists() {
            bail!("Config file does not exist");
        }
        path_buf
            .canonicalize()
            .context("Failed to resolve config file path")
    }

    fn paths_equal(a: &Path, b: &Path) -> bool {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;
    use tempfile::tempdir;
    use tokio::fs;

    fn section_map(sections: &[ConfigSection]) -> HashMap<String, Vec<ConfigEntry>> {
        let mut map = HashMap::new();
        for section in sections {
            map.insert(section.name.clone(), section.entries.clone());
        }
        map
    }

    #[tokio::test]
    #[serial]
    async fn parse_config_document_collects_sections_and_comments() -> Result<()> {
        let temp = tempdir()?;
        let file_path = temp.path().join("test.cfg");
        let content = "# comment for foo\nfoo=bar\n\n[Section One]\nkey = value\n";
        fs::write(&file_path, content).await?;

        let service = ConfigService::new();
        let config = service
            .parse_config_document(&file_path, ConfigFileType::Other)
            .await?;

        let sections = section_map(&config.sections);
        let general = sections.get("General").expect("expected General section");
        let foo_entry = general.iter().find(|entry| entry.key == "foo").unwrap();
        assert_eq!(foo_entry.value, "bar");
        assert_eq!(foo_entry.comment.as_deref(), Some("comment for foo"));

        let section_one = sections
            .get("Section One")
            .expect("expected Section One section");
        let key_entry = section_one.iter().find(|entry| entry.key == "key").unwrap();
        assert_eq!(key_entry.value, "value");
        assert!(config.summary.supports_structured_edit);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn catalog_discovers_known_and_other_cfg_files() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path();
        fs::create_dir_all(game_dir.join("UserData")).await?;
        fs::create_dir_all(game_dir.join("MelonLoader")).await?;
        fs::write(
            game_dir.join("UserData").join("MelonPreferences.cfg"),
            "foo=bar",
        )
        .await?;
        fs::write(
            game_dir.join("MelonLoader").join("Loader.cfg"),
            "[General]\nfoo = bar",
        )
        .await?;
        fs::write(
            game_dir.join("UserData").join("Custom.cfg"),
            "[General]\nbar = baz",
        )
        .await?;

        let service = ConfigService::new();
        let catalog = service
            .get_config_catalog(game_dir.to_string_lossy().as_ref())
            .await?;

        assert_eq!(catalog.len(), 3);
        assert!(catalog
            .iter()
            .any(|file| file.file_type == ConfigFileType::MelonPreferences));
        assert!(catalog
            .iter()
            .any(|file| file.file_type == ConfigFileType::LoaderConfig));
        assert!(catalog.iter().any(|file| file.name == "Custom.cfg"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn catalog_discovers_nested_userdata_json_and_groups_by_folder() -> Result<()> {
        let temp = tempdir()?;
        let game_dir = temp.path();
        fs::create_dir_all(game_dir.join("UserData").join("CoolMod")).await?;
        fs::create_dir_all(
            game_dir
                .join("UserData")
                .join("AnotherMod")
                .join("Profiles"),
        )
        .await?;

        fs::write(
            game_dir
                .join("UserData")
                .join("CoolMod")
                .join("settings.json"),
            "{\n  \"enabled\": true\n}",
        )
        .await?;
        fs::write(
            game_dir
                .join("UserData")
                .join("AnotherMod")
                .join("Profiles")
                .join("profile.cfg"),
            "[General]\nfoo = bar",
        )
        .await?;

        let service = ConfigService::new();
        let catalog = service
            .get_config_catalog(game_dir.to_string_lossy().as_ref())
            .await?;

        let json_file = catalog
            .iter()
            .find(|file| file.name == "settings.json")
            .expect("expected nested json config");
        assert_eq!(json_file.file_type, ConfigFileType::Json);
        assert_eq!(json_file.group_name, "CoolMod");
        assert_eq!(json_file.relative_path, "UserData/CoolMod/settings.json");
        assert!(!json_file.supports_structured_edit);

        let nested_cfg = catalog
            .iter()
            .find(|file| file.name == "profile.cfg")
            .expect("expected nested cfg config");
        assert_eq!(nested_cfg.file_type, ConfigFileType::Other);
        assert_eq!(nested_cfg.group_name, "AnotherMod");
        assert_eq!(
            nested_cfg.relative_path,
            "UserData/AnotherMod/Profiles/profile.cfg"
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn apply_config_edits_updates_structure() -> Result<()> {
        let temp = tempdir()?;
        let file_path = temp.path().join("update.cfg");
        let content = "# header\nfoo = old\n[Gameplay]\nbar = keep\n";
        fs::write(&file_path, content).await?;

        let service = ConfigService::new();
        service
            .apply_config_edits(
                file_path.to_string_lossy().as_ref(),
                vec![
                    ConfigEditOperation::SetValue {
                        section: "General".to_string(),
                        key: "foo".to_string(),
                        value: "new".to_string(),
                    },
                    ConfigEditOperation::AddSection {
                        section: "Graphics".to_string(),
                    },
                    ConfigEditOperation::AddEntry {
                        section: "Graphics".to_string(),
                        key: "quality".to_string(),
                        value: "high".to_string(),
                        comment: Some("applied by test".to_string()),
                    },
                    ConfigEditOperation::DeleteEntry {
                        section: "Gameplay".to_string(),
                        key: "bar".to_string(),
                    },
                ],
            )
            .await?;

        let updated = service
            .parse_config_document(&file_path, ConfigFileType::Other)
            .await?;
        let sections = section_map(&updated.sections);

        assert_eq!(
            sections
                .get("General")
                .and_then(|entries| entries.iter().find(|entry| entry.key == "foo"))
                .map(|entry| entry.value.clone())
                .as_deref(),
            Some("new")
        );
        assert_eq!(
            sections.get("Gameplay").map(|entries| entries.len()),
            Some(0)
        );
        assert_eq!(
            sections
                .get("Graphics")
                .and_then(|entries| entries.iter().find(|entry| entry.key == "quality"))
                .map(|entry| entry.comment.clone())
                .flatten()
                .as_deref(),
            Some("applied by test")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn save_raw_config_rewrites_content() -> Result<()> {
        let temp = tempdir()?;
        let file_path = temp.path().join("raw.cfg");
        fs::write(&file_path, "foo = bar").await?;

        let service = ConfigService::new();
        service
            .save_raw_config(
                file_path.to_string_lossy().as_ref(),
                "[General]\nfoo = baz\n",
            )
            .await?;

        let updated = fs::read_to_string(&file_path).await?;
        assert!(updated.contains("foo = baz"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn parse_warnings_disable_structured_edit() -> Result<()> {
        let temp = tempdir()?;
        let file_path = temp.path().join("unsupported.cfg");
        fs::write(&file_path, "[General]\nthis is invalid\nfoo = bar").await?;

        let service = ConfigService::new();
        let document = service
            .parse_config_document(&file_path, ConfigFileType::Other)
            .await?;

        assert!(!document.summary.supports_structured_edit);
        assert!(!document.parse_warnings.is_empty());

        Ok(())
    }

    #[test]
    fn config_file_type_serializes_with_frontend_contract_names() {
        assert_eq!(
            serde_json::to_value(ConfigFileType::MelonPreferences).unwrap(),
            json!("MelonPreferences")
        );
        assert_eq!(
            serde_json::to_value(ConfigFileType::LoaderConfig).unwrap(),
            json!("LoaderConfig")
        );
        assert_eq!(
            serde_json::to_value(ConfigFileType::Json).unwrap(),
            json!("Json")
        );
        assert_eq!(
            serde_json::to_value(ConfigFileType::Other).unwrap(),
            json!("Other")
        );
    }
}
