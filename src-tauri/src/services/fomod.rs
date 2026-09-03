use anyhow::{anyhow, Context, Result};
use quick_xml::{de::from_str, events::Event, Reader};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use zip::ZipArchive;

// Archive and installer metadata budgets are deliberately shared with the
// archive extractors in `mods.rs`. They bound work before any untrusted package
// is copied into managed storage while leaving ample room for real mod packs.
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub(crate) const MAX_ARCHIVE_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_PATH_DEPTH: usize = 32;
const MAX_FOMOD_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FOMOD_XML_NODES: usize = 50_000;
const MAX_FOMOD_XML_DEPTH: usize = 64;
const MAX_FOMOD_DEPENDENCY_DEPTH: usize = 16;
const MAX_FOMOD_INSTALL_ENTRIES: usize = 10_000;

#[derive(Debug, Default)]
pub(crate) struct ArchiveBudget {
    entries: usize,
    declared_expanded_bytes: u64,
    actual_expanded_bytes: u64,
    limits: ArchiveLimits,
}

#[derive(Debug, Clone, Copy)]
struct ArchiveLimits {
    max_entries: usize,
    max_entry_bytes: u64,
    max_expanded_bytes: u64,
    max_path_depth: usize,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_entry_bytes: MAX_ARCHIVE_ENTRY_BYTES,
            max_expanded_bytes: MAX_ARCHIVE_EXPANDED_BYTES,
            max_path_depth: MAX_ARCHIVE_PATH_DEPTH,
        }
    }
}

impl ArchiveBudget {
    pub(crate) fn account(&mut self, name: &str, expanded_bytes: u64) -> Result<()> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or_else(|| anyhow!("Archive entry count overflow"))?;
        if self.entries > self.limits.max_entries {
            return Err(anyhow!(
                "Archive contains more than {} entries",
                self.limits.max_entries
            ));
        }
        if expanded_bytes > self.limits.max_entry_bytes {
            return Err(anyhow!(
                "Archive entry exceeds the {} byte expanded-size limit: {name}",
                self.limits.max_entry_bytes
            ));
        }
        self.declared_expanded_bytes = self
            .declared_expanded_bytes
            .checked_add(expanded_bytes)
            .ok_or_else(|| anyhow!("Archive expanded-size overflow"))?;
        if self.declared_expanded_bytes > self.limits.max_expanded_bytes {
            return Err(anyhow!(
                "Archive exceeds the {} byte cumulative expanded-size limit",
                self.limits.max_expanded_bytes
            ));
        }
        validate_archive_path_depth_with_limit(name, self.limits.max_path_depth)
    }

    pub(crate) fn copy_entry<R, W>(
        &mut self,
        name: &str,
        reader: &mut R,
        writer: &mut W,
    ) -> Result<u64>
    where
        R: Read + ?Sized,
        W: Write + ?Sized,
    {
        let mut entry_bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            // Read no more than one byte beyond the remaining budget. This
            // proves EOF at the exact limit without decompressing another
            // large chunk after the archive has already exceeded it.
            let remaining_entry = self.limits.max_entry_bytes.saturating_sub(entry_bytes);
            let remaining_total = self
                .limits
                .max_expanded_bytes
                .saturating_sub(self.actual_expanded_bytes);
            let read_limit = remaining_entry
                .min(remaining_total)
                .saturating_add(1)
                .min(buffer.len() as u64) as usize;
            let read = reader
                .read(&mut buffer[..read_limit])
                .with_context(|| format!("Failed to read archive entry: {name}"))?;
            if read == 0 {
                break;
            }
            let read = read as u64;
            entry_bytes = entry_bytes
                .checked_add(read)
                .ok_or_else(|| anyhow!("Archive entry expanded-size overflow: {name}"))?;
            let next_actual_total = self
                .actual_expanded_bytes
                .checked_add(read)
                .ok_or_else(|| anyhow!("Archive actual expanded-size overflow"))?;
            if entry_bytes > self.limits.max_entry_bytes {
                return Err(anyhow!(
                    "Archive entry exceeded the {} byte actual expanded-size limit: {name}",
                    self.limits.max_entry_bytes
                ));
            }
            if next_actual_total > self.limits.max_expanded_bytes {
                return Err(anyhow!(
                    "Archive exceeded the {} byte cumulative actual expanded-size limit",
                    self.limits.max_expanded_bytes
                ));
            }
            writer
                .write_all(&buffer[..read as usize])
                .with_context(|| format!("Failed to write archive entry: {name}"))?;
            self.actual_expanded_bytes = next_actual_total;
        }
        Ok(entry_bytes)
    }

    pub(crate) fn copy_entry_to_path<R>(
        &mut self,
        name: &str,
        reader: &mut R,
        output_path: &Path,
    ) -> Result<u64>
    where
        R: Read + ?Sized,
    {
        let mut output = File::create(output_path).with_context(|| {
            format!("Failed to create archive entry: {}", output_path.display())
        })?;
        match self.copy_entry(name, reader, &mut output) {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                drop(output);
                let _ = std::fs::remove_file(output_path);
                Err(error)
            }
        }
    }

    #[cfg(test)]
    fn with_test_limits(
        max_entries: usize,
        max_entry_bytes: u64,
        max_expanded_bytes: u64,
        max_path_depth: usize,
    ) -> Self {
        Self {
            limits: ArchiveLimits {
                max_entries,
                max_entry_bytes,
                max_expanded_bytes,
                max_path_depth,
            },
            ..Self::default()
        }
    }
}

pub(crate) fn validate_archive_path_depth(name: &str) -> Result<()> {
    validate_archive_path_depth_with_limit(name, MAX_ARCHIVE_PATH_DEPTH)
}

fn validate_archive_path_depth_with_limit(name: &str, max_depth: usize) -> Result<()> {
    let depth = name
        .replace('\\', "/")
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .count();
    if depth > max_depth {
        return Err(anyhow!(
            "Archive entry path exceeds the {max_depth}-component limit: {name}"
        ));
    }
    Ok(())
}

/// FOMOD detection and parsing service
#[derive(Clone)]
pub struct FomodService;

/// FOMOD module configuration (parsed from ModuleConfig.xml)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "config", rename_all = "camelCase")]
pub struct FomodConfig {
    #[serde(rename = "moduleName")]
    pub module_name: Option<String>,
    #[serde(rename = "moduleImage")]
    pub module_image: Option<String>,
    #[serde(rename = "installSteps")]
    pub install_steps: Option<InstallSteps>,
}

/// Install steps container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSteps {
    #[serde(default, rename = "installStep")]
    pub install_step: Vec<InstallStep>,
    #[serde(default, rename = "@order", alias = "order")]
    pub order: Option<String>,
}

/// Single installation step
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStep {
    #[serde(default, rename = "@name", alias = "name")]
    pub name: Option<String>,
    #[serde(rename = "visible")]
    pub visible: Option<Dependencies>,
    #[serde(rename = "optionalFileGroups")]
    pub optional_file_groups: Option<GroupList>,
    #[serde(rename = "requiredInstallFiles")]
    pub required_install_files: Option<FileList>,
    #[serde(rename = "conditionalFileInstalls")]
    pub conditional_file_installs: Option<ConditionalFileInstalls>,
}

/// Group list container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupList {
    #[serde(default, rename = "group")]
    pub group: Vec<Group>,
    #[serde(default, rename = "@order", alias = "order")]
    pub order: Option<String>,
}

/// File group
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    #[serde(default, rename = "@name", alias = "name")]
    pub name: Option<String>,
    #[serde(default, rename = "@type", alias = "type")]
    pub group_type: Option<String>, // SelectAtLeastOne, SelectAtMostOne, SelectExactlyOne, SelectAll, SelectAny
    #[serde(rename = "plugins")]
    pub plugins: Option<PluginList>,
}

/// Plugin list container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    #[serde(default, rename = "plugin")]
    pub plugin: Vec<Plugin>,
    #[serde(default, rename = "@order", alias = "order")]
    pub order: Option<String>,
}

/// Plugin/Option
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    #[serde(default, rename = "@name", alias = "name")]
    pub name: String,
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[serde(rename = "image")]
    pub image: Option<String>,
    #[serde(default, rename = "type")]
    pub plugin_type: Option<String>, // Required, Optional, Recommended, NotUsable, CouldBeUsable
    #[serde(rename = "typeDescriptor")]
    pub type_descriptor: Option<PluginTypeDescriptor>,
    #[serde(rename = "files")]
    pub files: Option<FileList>,
    #[serde(rename = "conditionFlags")]
    pub condition_flags: Option<ConditionFlags>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTypeDescriptor {
    #[serde(rename = "type")]
    pub plugin_kind: Option<NamedPluginType>,
    #[serde(rename = "dependencyType")]
    pub dependency_type: Option<DependencyPluginType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedPluginType {
    #[serde(default, rename = "@name", alias = "name")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyPluginType {
    #[serde(rename = "defaultType")]
    pub default_type: Option<NamedPluginType>,
}

/// File list container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    #[serde(default, rename = "folder")]
    pub folder: Vec<Folder>,
    #[serde(default, rename = "file")]
    pub file: Vec<FilePattern>,
}

/// Folder pattern
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(default, rename = "@source", alias = "source")]
    pub source: String,
    #[serde(default, rename = "@destination", alias = "destination")]
    pub destination: Option<String>,
    #[serde(default, rename = "@priority", alias = "priority")]
    pub priority: Option<i32>,
}

/// File pattern
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePattern {
    #[serde(default, rename = "@source", alias = "source")]
    pub source: String,
    #[serde(default, rename = "@destination", alias = "destination")]
    pub destination: Option<String>,
    #[serde(default, rename = "@priority", alias = "priority")]
    pub priority: Option<i32>,
}

/// Conditional file installs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalFileInstalls {
    #[serde(rename = "patterns")]
    pub patterns: Option<Patterns>,
}

/// Patterns container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patterns {
    #[serde(default, rename = "pattern")]
    pub pattern: Vec<Pattern>,
}

/// Pattern with dependencies
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    #[serde(rename = "dependencies")]
    pub dependencies: Option<Dependencies>,
    #[serde(rename = "files")]
    pub files: Option<FileList>,
}

/// Dependencies
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependencies {
    #[serde(default, rename = "@operator", alias = "operator")]
    pub operator: Option<String>,
    #[serde(default, rename = "flagDependency")]
    pub flag_dependency: Vec<FlagDependency>,
    #[serde(default, rename = "fileDependency")]
    pub file_dependency: Vec<FileDependency>,
    #[serde(default, rename = "gameDependency")]
    pub game_dependency: Vec<GameDependency>,
    #[serde(default, rename = "dependencies")]
    pub dependencies: Vec<Dependencies>,
}

/// Flag dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagDependency {
    #[serde(default, rename = "@flag", alias = "flag")]
    pub flag: String,
    #[serde(default, rename = "@value", alias = "value")]
    pub value: Option<String>,
}

/// File dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDependency {
    #[serde(default, rename = "@file", alias = "file")]
    pub file: String,
    #[serde(default, rename = "@state", alias = "state")]
    pub state: Option<String>,
}

/// Game dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDependency {
    #[serde(default, rename = "@version", alias = "version")]
    pub version: Option<String>,
}

/// Condition flags
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionFlags {
    #[serde(default, rename = "flag")]
    pub flag: Vec<Flag>,
}

/// Flag
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    #[serde(default, rename = "@name", alias = "name")]
    pub name: String,
    #[serde(default, rename = "@value", alias = "value")]
    pub value: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FomodInstallEntry {
    pub source: String,
    pub destination: String,
    pub is_folder: bool,
    pub priority: i32,
    pub runtime: Option<String>,
    // Captures XML declaration order so equal-priority conflicts have a
    // deterministic and explainable winner.
    pub(crate) declaration_order: usize,
}

/// FOMOD detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FomodDetectionResult {
    pub is_fomod: bool,
    pub fomod_type: String, // "xml", "csharp", or "none"
    pub module_name: Option<String>,
    pub module_image: Option<String>,
}

impl FomodService {
    pub fn new() -> Self {
        Self
    }

    fn decode_module_config_xml(bytes: &[u8]) -> Result<String> {
        if bytes.len() as u64 > MAX_FOMOD_XML_BYTES {
            return Err(anyhow!(
                "ModuleConfig.xml exceeds the {MAX_FOMOD_XML_BYTES} byte limit"
            ));
        }
        if bytes.starts_with(&[0xFF, 0xFE]) {
            let payload = &bytes[2..];
            if payload.len() % 2 != 0 {
                return Err(anyhow!("UTF-16 LE ModuleConfig.xml has an odd byte length"));
            }
            let units = payload
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>();
            return String::from_utf16(&units)
                .context("Failed to decode UTF-16 LE ModuleConfig.xml content");
        }

        if bytes.starts_with(&[0xFE, 0xFF]) {
            let payload = &bytes[2..];
            if payload.len() % 2 != 0 {
                return Err(anyhow!("UTF-16 BE ModuleConfig.xml has an odd byte length"));
            }
            let units = payload
                .chunks_exact(2)
                .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>();
            return String::from_utf16(&units)
                .context("Failed to decode UTF-16 BE ModuleConfig.xml content");
        }

        String::from_utf8(bytes.to_vec()).context("Failed to read ModuleConfig.xml content")
    }

    fn read_config_bytes(mut reader: impl Read) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        reader
            .by_ref()
            .take(MAX_FOMOD_XML_BYTES + 1)
            .read_to_end(&mut bytes)
            .context("Failed to read ModuleConfig.xml content")?;
        if bytes.len() as u64 > MAX_FOMOD_XML_BYTES {
            return Err(anyhow!(
                "ModuleConfig.xml exceeds the {MAX_FOMOD_XML_BYTES} byte limit"
            ));
        }
        Ok(bytes)
    }

    fn validate_xml_complexity(content: &str) -> Result<()> {
        let mut reader = Reader::from_str(content);
        reader.trim_text(false);
        let mut nodes = 0usize;
        let mut depth = 0usize;
        let mut buffer = Vec::new();
        loop {
            match reader.read_event_into(&mut buffer) {
                Ok(Event::Start(_)) => {
                    nodes = nodes.saturating_add(1);
                    depth = depth.saturating_add(1);
                    if nodes > MAX_FOMOD_XML_NODES || depth > MAX_FOMOD_XML_DEPTH {
                        return Err(anyhow!("ModuleConfig.xml exceeds XML complexity limits"));
                    }
                }
                Ok(Event::Empty(_)) => {
                    nodes = nodes.saturating_add(1);
                    if nodes > MAX_FOMOD_XML_NODES {
                        return Err(anyhow!("ModuleConfig.xml exceeds XML node limit"));
                    }
                }
                Ok(Event::End(_)) => depth = depth.saturating_sub(1),
                Ok(Event::Eof) => break,
                Err(error) => {
                    return Err(anyhow!(error)).context("Failed to inspect ModuleConfig.xml")
                }
                _ => {}
            }
            buffer.clear();
        }
        Ok(())
    }

    fn parse_config_bytes(bytes: &[u8]) -> Result<FomodConfig> {
        let content = Self::decode_module_config_xml(bytes)?;
        Self::validate_xml_complexity(&content)?;
        let config: FomodConfig = from_str(&content).context("Failed to parse ModuleConfig.xml")?;
        Self::validate_dependency_depth(&config)?;
        Ok(config)
    }

    fn validate_dependency_depth(config: &FomodConfig) -> Result<()> {
        fn visit(dependencies: &Dependencies, depth: usize) -> Result<()> {
            if depth > MAX_FOMOD_DEPENDENCY_DEPTH {
                return Err(anyhow!(
                    "FOMOD dependencies exceed the {MAX_FOMOD_DEPENDENCY_DEPTH}-level limit"
                ));
            }
            for nested in &dependencies.dependencies {
                visit(nested, depth + 1)?;
            }
            Ok(())
        }

        if let Some(steps) = config.install_steps.as_ref() {
            for step in &steps.install_step {
                if let Some(visible) = step.visible.as_ref() {
                    visit(visible, 1)?;
                }
                if let Some(patterns) = step
                    .conditional_file_installs
                    .as_ref()
                    .and_then(|conditional| conditional.patterns.as_ref())
                {
                    for pattern in &patterns.pattern {
                        if let Some(dependencies) = pattern.dependencies.as_ref() {
                            visit(dependencies, 1)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn parse_fomod_xml_path(&self, config_path: &Path) -> Result<FomodConfig> {
        let bytes = Self::read_config_bytes(
            File::open(config_path).context("Failed to open ModuleConfig.xml")?,
        )?;
        Self::parse_config_bytes(&bytes)
    }

    /// Detect if a ZIP file is a FOMOD archive
    pub fn detect_fomod(&self, zip_path: &Path) -> Result<FomodDetectionResult> {
        let file = File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        if archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(anyhow!(
                "Archive contains more than {MAX_ARCHIVE_ENTRIES} entries"
            ));
        }

        let mut budget = ArchiveBudget::default();
        let mut has_module_config = false;
        let mut has_script_cs = false;
        let mut module_name = None;
        let mut module_image = None;
        let mut config_index = None;

        // First pass: find FOMOD files and their indices
        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;

            budget.account(file.name(), file.size())?;
            let file_name = file.name().to_lowercase();

            if file_name == "fomod/moduleconfig.xml" || file_name == "fomod/script.xml" {
                has_module_config = true;
                config_index = Some(i);
            } else if file_name == "fomod/script.cs" {
                has_script_cs = true;
            }
        }

        // Second pass: read and parse ModuleConfig.xml if found
        if let Some(idx) = config_index {
            let mut file_reader = archive
                .by_index(idx)
                .context("Failed to read ModuleConfig.xml")?;
            if file_reader.size() > MAX_FOMOD_XML_BYTES {
                return Err(anyhow!(
                    "ModuleConfig.xml exceeds the {MAX_FOMOD_XML_BYTES} byte limit"
                ));
            }
            let bytes = Self::read_config_bytes(&mut file_reader)?;
            // Parse XML (basic parsing for name and image)
            if let Ok(config) = Self::parse_config_bytes(&bytes) {
                module_name = config.module_name;
                module_image = config.module_image;
            }
        }

        let (is_fomod, fomod_type) = if has_module_config {
            (true, "xml")
        } else if has_script_cs {
            (true, "csharp")
        } else {
            (false, "none")
        };

        Ok(FomodDetectionResult {
            is_fomod,
            fomod_type: fomod_type.to_string(),
            module_name,
            module_image,
        })
    }

    /// Parse FOMOD XML configuration
    pub fn parse_fomod_xml(&self, zip_path: &Path) -> Result<FomodConfig> {
        let file = File::open(zip_path).context("Failed to open zip file")?;
        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        if archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err(anyhow!(
                "Archive contains more than {MAX_ARCHIVE_ENTRIES} entries"
            ));
        }

        let mut budget = ArchiveBudget::default();
        let mut config_index = None;
        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;
            budget.account(file.name(), file.size())?;
            let file_name = file.name().to_lowercase();
            if file_name == "fomod/moduleconfig.xml" || file_name == "fomod/script.xml" {
                config_index = Some(i);
                break;
            }
        }

        let idx = config_index
            .ok_or_else(|| anyhow::anyhow!("ModuleConfig.xml not found in FOMOD archive"))?;
        let mut file_reader = archive
            .by_index(idx)
            .context("Failed to read ModuleConfig.xml")?;
        if file_reader.size() > MAX_FOMOD_XML_BYTES {
            return Err(anyhow!(
                "ModuleConfig.xml exceeds the {MAX_FOMOD_XML_BYTES} byte limit"
            ));
        }
        let bytes = Self::read_config_bytes(&mut file_reader)?;
        Self::parse_config_bytes(&bytes)
    }

    pub fn build_install_entries(
        &self,
        config: &FomodConfig,
        runtime: Option<&str>,
    ) -> Result<Vec<FomodInstallEntry>> {
        Self::validate_dependency_depth(config)?;
        let mut entries = Vec::new();
        let mut selected_flags = HashMap::<String, String>::new();

        let Some(steps) = config.install_steps.as_ref() else {
            return Ok(entries);
        };

        for step in &steps.install_step {
            if !self.dependencies_match(step.visible.as_ref(), &selected_flags)? {
                continue;
            }

            if let Some(required) = step.required_install_files.as_ref() {
                self.collect_file_entries(required, None, None, &mut entries)?;
            }

            if let Some(groups) = step.optional_file_groups.as_ref() {
                for group in &groups.group {
                    for plugin in self.select_plugins_for_group(group, runtime) {
                        if let Some(flags) = plugin.condition_flags.as_ref() {
                            for flag in &flags.flag {
                                selected_flags.insert(
                                    flag.name.clone(),
                                    flag.value.clone().unwrap_or_else(|| "true".to_string()),
                                );
                            }
                        }
                        if let Some(files) = plugin.files.as_ref() {
                            self.collect_file_entries(
                                files,
                                group.name.as_deref(),
                                Some(plugin),
                                &mut entries,
                            )?;
                        }
                    }
                }
            }

            if let Some(conditional) = step.conditional_file_installs.as_ref() {
                if let Some(patterns) = conditional.patterns.as_ref() {
                    for pattern in &patterns.pattern {
                        if self
                            .dependencies_match(pattern.dependencies.as_ref(), &selected_flags)?
                        {
                            if let Some(files) = pattern.files.as_ref() {
                                self.collect_file_entries(
                                    files,
                                    step.name.as_deref(),
                                    None,
                                    &mut entries,
                                )?;
                            }
                        }
                    }
                }
            }
        }

        // FOMOD priority applies to *destinations*, not merely duplicate
        // source/destination tuples. Select exactly one mapping per target;
        // declared order wins ties so the result is stable regardless of hash
        // or filesystem enumeration order.
        entries.sort_by(|left, right| {
            Self::install_target_key(left)
                .cmp(&Self::install_target_key(right))
                .then_with(|| right.priority.cmp(&left.priority))
                .then_with(|| left.declaration_order.cmp(&right.declaration_order))
                .then_with(|| {
                    left.source
                        .to_ascii_lowercase()
                        .cmp(&right.source.to_ascii_lowercase())
                })
        });
        let mut resolved_targets = HashSet::new();
        entries.retain(|entry| resolved_targets.insert(Self::install_target_key(entry)));
        Ok(entries)
    }

    /// Extract files from FOMOD archive based on selected options
    #[allow(dead_code)]
    pub fn extract_fomod_files(
        &self,
        _zip_path: &Path,
        _game_dir: &Path,
        _selected_options: &HashMap<String, Vec<String>>, // step_name -> [option_names]
        _config: &FomodConfig,
    ) -> Result<Vec<String>> {
        // This will be implemented to extract files based on selections
        // For now, return empty vector
        Ok(Vec::new())
    }

    fn select_plugins_for_group<'a>(
        &self,
        group: &'a Group,
        runtime: Option<&str>,
    ) -> Vec<&'a Plugin> {
        let Some(plugins) = group.plugins.as_ref() else {
            return Vec::new();
        };
        if plugins.plugin.is_empty() {
            return Vec::new();
        }

        let runtime_plugins: Vec<&Plugin> = plugins
            .plugin
            .iter()
            .filter(|plugin| self.plugin_runtime(group.name.as_deref(), plugin).is_some())
            .collect();

        if !runtime_plugins.is_empty() {
            if let Some(target_runtime) = runtime {
                let exact: Vec<&Plugin> = runtime_plugins
                    .into_iter()
                    .filter(|plugin| {
                        self.plugin_runtime(group.name.as_deref(), plugin)
                            .map(|value| value.eq_ignore_ascii_case(target_runtime))
                            .unwrap_or(false)
                    })
                    .collect();
                if !exact.is_empty() {
                    return exact;
                }
            } else {
                return runtime_plugins;
            }
        }

        let group_type = group
            .group_type
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if group_type.contains("selectall") || group_type.contains("selectany") {
            return plugins.plugin.iter().collect();
        }

        let preferred: Vec<&Plugin> = plugins
            .plugin
            .iter()
            .filter(|plugin| self.is_default_plugin_choice(plugin))
            .collect();
        if !preferred.is_empty() {
            return preferred;
        }

        if plugins.plugin.len() == 1 {
            return vec![&plugins.plugin[0]];
        }

        vec![&plugins.plugin[0]]
    }

    fn is_default_plugin_choice(&self, plugin: &Plugin) -> bool {
        match plugin
            .resolved_plugin_type()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "required" | "recommended" | "couldbeusable" => true,
            "notusable" => false,
            _ => false,
        }
    }

    fn collect_file_entries(
        &self,
        files: &FileList,
        group_name: Option<&str>,
        plugin: Option<&Plugin>,
        output: &mut Vec<FomodInstallEntry>,
    ) -> Result<()> {
        for folder in &files.folder {
            validate_archive_path_depth(&folder.source)?;
            if let Some(destination) = folder.destination.as_deref() {
                validate_archive_path_depth(destination)?;
            }
            let runtime = self.infer_runtime(&[
                group_name.unwrap_or_default(),
                plugin.map(|value| value.name.as_str()).unwrap_or_default(),
                plugin
                    .and_then(|value| value.description.as_deref())
                    .unwrap_or_default(),
                &folder.source,
                folder.destination.as_deref().unwrap_or_default(),
            ]);
            output.push(FomodInstallEntry {
                source: Self::normalize_path_value(&folder.source),
                destination: Self::normalize_path_value(
                    folder.destination.as_deref().unwrap_or_default(),
                ),
                is_folder: true,
                priority: folder.priority.unwrap_or(0),
                runtime: runtime.map(str::to_string),
                declaration_order: output.len(),
            });
            if output.len() > MAX_FOMOD_INSTALL_ENTRIES {
                return Err(anyhow!(
                    "FOMOD contains more than {MAX_FOMOD_INSTALL_ENTRIES} install entries"
                ));
            }
        }

        for file in &files.file {
            validate_archive_path_depth(&file.source)?;
            if let Some(destination) = file.destination.as_deref() {
                validate_archive_path_depth(destination)?;
            }
            let runtime = self.infer_runtime(&[
                group_name.unwrap_or_default(),
                plugin.map(|value| value.name.as_str()).unwrap_or_default(),
                plugin
                    .and_then(|value| value.description.as_deref())
                    .unwrap_or_default(),
                &file.source,
                file.destination.as_deref().unwrap_or_default(),
            ]);
            output.push(FomodInstallEntry {
                source: Self::normalize_path_value(&file.source),
                destination: Self::normalize_path_value(
                    file.destination.as_deref().unwrap_or_default(),
                ),
                is_folder: false,
                priority: file.priority.unwrap_or(0),
                runtime: runtime.map(str::to_string),
                declaration_order: output.len(),
            });
            if output.len() > MAX_FOMOD_INSTALL_ENTRIES {
                return Err(anyhow!(
                    "FOMOD contains more than {MAX_FOMOD_INSTALL_ENTRIES} install entries"
                ));
            }
        }
        Ok(())
    }

    fn infer_runtime<'a>(&self, values: &[&'a str]) -> Option<&'static str> {
        for value in values {
            let lower = value.to_ascii_lowercase();
            if lower.contains("il2cpp") {
                return Some("IL2CPP");
            }
            if lower.contains("mono") {
                return Some("Mono");
            }
        }
        None
    }

    fn plugin_runtime(&self, group_name: Option<&str>, plugin: &Plugin) -> Option<&'static str> {
        self.infer_runtime(&[
            group_name.unwrap_or_default(),
            plugin.name.as_str(),
            plugin.description.as_deref().unwrap_or_default(),
            plugin
                .files
                .as_ref()
                .map(|files| {
                    files
                        .file
                        .iter()
                        .map(|file| file.source.as_str())
                        .chain(files.folder.iter().map(|folder| folder.source.as_str()))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .as_deref()
                .unwrap_or_default(),
        ])
    }

    fn dependencies_match(
        &self,
        dependencies: Option<&Dependencies>,
        selected_flags: &HashMap<String, String>,
    ) -> Result<bool> {
        let Some(dependencies) = dependencies else {
            return Ok(true);
        };

        if !dependencies.file_dependency.is_empty() {
            return Err(anyhow!(
                "Unsupported FOMOD fileDependency conditions in installer metadata"
            ));
        }
        if !dependencies.game_dependency.is_empty() {
            return Err(anyhow!(
                "Unsupported FOMOD gameDependency conditions in installer metadata"
            ));
        }

        let mut evaluations = Vec::new();
        evaluations.extend(dependencies.flag_dependency.iter().map(|dependency| {
            let Some(actual) = selected_flags.get(&dependency.flag) else {
                return false;
            };
            dependency
                .value
                .as_deref()
                .map(|expected| actual.eq_ignore_ascii_case(expected))
                .unwrap_or(true)
        }));

        for nested in &dependencies.dependencies {
            evaluations.push(self.dependencies_match(Some(nested), selected_flags)?);
        }

        if evaluations.is_empty() {
            return Ok(true);
        }

        match dependencies
            .operator
            .as_deref()
            .unwrap_or("And")
            .to_ascii_lowercase()
            .as_str()
        {
            "or" => Ok(evaluations.into_iter().any(|value| value)),
            "and" => Ok(evaluations.into_iter().all(|value| value)),
            other => Err(anyhow!("Unsupported FOMOD dependency operator: {}", other)),
        }
    }

    fn normalize_path_value(value: &str) -> String {
        value
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn install_target_key(entry: &FomodInstallEntry) -> String {
        let destination = Self::normalize_path_value(&entry.destination);
        let source = Self::normalize_path_value(&entry.source);
        // File mappings to a bucket/directory have an implicit target file
        // name. Resolve that name before conflict resolution: `Mods` plus
        // `IL2CPP/A.dll` and `Mods` plus `Mono/B.dll` are distinct targets,
        // while two mappings to `Mods/A.dll` deliberately compete.
        let destination = if destination.is_empty() {
            source
        } else if entry.is_folder || Path::new(&destination).extension().is_some() {
            destination
        } else {
            let source_name = Path::new(&source)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(source.as_str());
            format!("{destination}/{source_name}")
        };
        format!(
            "{}:{}",
            if entry.is_folder { "folder" } else { "file" },
            destination.to_ascii_lowercase()
        )
    }
}

impl Plugin {
    fn resolved_plugin_type(&self) -> Option<&str> {
        self.plugin_type
            .as_deref()
            .or_else(|| {
                self.type_descriptor
                    .as_ref()
                    .and_then(|descriptor| descriptor.plugin_kind.as_ref())
                    .and_then(|kind| kind.name.as_deref())
            })
            .or_else(|| {
                self.type_descriptor
                    .as_ref()
                    .and_then(|descriptor| descriptor.dependency_type.as_ref())
                    .and_then(|dependency| dependency.default_type.as_ref())
                    .and_then(|kind| kind.name.as_deref())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_budget_rejects_oversized_entries_and_deep_paths() {
        let oversized = ArchiveBudget::default()
            .account("Mods/Huge.dll", MAX_ARCHIVE_ENTRY_BYTES + 1)
            .expect_err("oversized entry must fail closed");
        assert!(oversized.to_string().contains("expanded-size limit"));

        let deep_path = (0..=MAX_ARCHIVE_PATH_DEPTH)
            .map(|index| format!("level-{index}"))
            .collect::<Vec<_>>()
            .join("/");
        let too_deep = ArchiveBudget::default()
            .account(&deep_path, 1)
            .expect_err("deep entry path must fail closed");
        assert!(too_deep.to_string().contains("component limit"));
    }

    #[test]
    fn archive_budget_rejects_cumulative_size_and_entry_count() {
        let mut size_budget = ArchiveBudget::default();
        for index in 0..4 {
            size_budget
                .account(&format!("Mods/part-{index}.bin"), MAX_ARCHIVE_ENTRY_BYTES)
                .expect("four one-GiB entries fit the cumulative budget");
        }
        let cumulative = size_budget
            .account("Mods/overflow.bin", 1)
            .expect_err("cumulative expanded-size overflow must fail closed");
        assert!(cumulative.to_string().contains("cumulative expanded-size"));

        let mut count_budget = ArchiveBudget::default();
        for index in 0..MAX_ARCHIVE_ENTRIES {
            count_budget
                .account(&format!("entry-{index}"), 0)
                .expect("entries through the documented limit are accepted");
        }
        let count = count_budget
            .account("one-too-many", 0)
            .expect_err("entry-count overflow must fail closed");
        assert!(count.to_string().contains("more than"));
    }

    #[test]
    fn archive_budget_rejects_forged_small_metadata_using_actual_bytes() {
        let mut budget = ArchiveBudget::with_test_limits(10, 16, 8, 8);
        budget
            .account("forged.bin", 1)
            .expect("forged declared size fits the test limit");
        let mut reader = std::io::Cursor::new(vec![0x5a; 9]);
        let mut output = Vec::new();

        let error = budget
            .copy_entry("forged.bin", &mut reader, &mut output)
            .expect_err("actual cumulative size must fail closed");

        assert!(error.to_string().contains("cumulative actual"));
        assert!(
            output.is_empty(),
            "the over-limit chunk must not be written"
        );
    }

    #[test]
    fn archive_budget_removes_partial_output_after_actual_size_failure() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let output_path = temp.path().join("partial.bin");
        let mut budget = ArchiveBudget::with_test_limits(10, 100_000, 65_000, 8);
        budget.account("partial.bin", 1)?;
        let mut reader = std::io::Cursor::new(vec![0x41; 70_000]);

        budget
            .copy_entry_to_path("partial.bin", &mut reader, &output_path)
            .expect_err("actual size overflow must remove partial output");

        assert!(!output_path.exists());
        Ok(())
    }

    #[test]
    fn archive_budget_accepts_legitimate_actual_bytes_across_entries() -> Result<()> {
        let mut budget = ArchiveBudget::with_test_limits(10, 8, 12, 8);
        let mut first_output = Vec::new();
        let mut second_output = Vec::new();
        budget.account("one.bin", 1)?;
        budget.copy_entry(
            "one.bin",
            &mut std::io::Cursor::new(b"hello"),
            &mut first_output,
        )?;
        budget.account("two.bin", 1)?;
        budget.copy_entry(
            "two.bin",
            &mut std::io::Cursor::new(b"world!"),
            &mut second_output,
        )?;

        assert_eq!(first_output, b"hello");
        assert_eq!(second_output, b"world!");
        Ok(())
    }

    #[test]
    fn parse_fomod_xml_rejects_oversized_metadata_before_decoding() {
        let bytes = vec![b'x'; MAX_FOMOD_XML_BYTES as usize + 1];
        let error = FomodService::parse_config_bytes(&bytes)
            .expect_err("oversized installer metadata must fail closed");
        assert!(error.to_string().contains("byte limit"));
    }

    #[test]
    fn parse_fomod_xml_rejects_excessive_xml_depth() {
        let nested = format!(
            "{}payload{}",
            "<node>".repeat(MAX_FOMOD_XML_DEPTH + 1),
            "</node>".repeat(MAX_FOMOD_XML_DEPTH + 1)
        );
        let error = FomodService::parse_config_bytes(nested.as_bytes())
            .expect_err("excessive XML depth must fail closed");
        assert!(error.to_string().contains("XML complexity limits"));
    }

    #[test]
    fn parse_fomod_xml_rejects_excessive_dependency_depth() {
        let nested = format!(
            "{}<flagDependency flag=\"runtime\" value=\"mono\" />{}",
            "<dependencies>".repeat(MAX_FOMOD_DEPENDENCY_DEPTH + 1),
            "</dependencies>".repeat(MAX_FOMOD_DEPENDENCY_DEPTH + 1)
        );
        let xml = format!(
            "<config><installSteps><installStep><visible>{nested}</visible></installStep></installSteps></config>"
        );
        let error = FomodService::parse_config_bytes(xml.as_bytes())
            .expect_err("excessive dependency nesting must fail closed");
        assert!(error.to_string().contains("dependencies exceed"));
    }

    #[test]
    fn build_install_entries_rejects_excessive_mapping_count() {
        let files = (0..=MAX_FOMOD_INSTALL_ENTRIES)
            .map(|index| {
                format!("<file source=\"data/{index}.dll\" destination=\"Mods/{index}.dll\" />")
            })
            .collect::<String>();
        let xml = format!(
            "<config><installSteps><installStep><requiredInstallFiles>{files}</requiredInstallFiles></installStep></installSteps></config>"
        );
        let config: FomodConfig = from_str(&xml).expect("fixture should deserialize");
        let error = FomodService::new()
            .build_install_entries(&config, None)
            .expect_err("excessive install mappings must fail closed");
        assert!(error.to_string().contains("install entries"));
    }

    #[test]
    fn parse_fomod_xml_path_reads_utf16_le_module_config() {
        let service = FomodService::new();
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let config_path = temp_dir.path().join("ModuleConfig.xml");
        let xml = r#"<?xml version="1.0" encoding="utf-16"?>
<config>
  <moduleName>Encoded Installer</moduleName>
</config>"#;
        let mut bytes = vec![0xFF, 0xFE];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&config_path, bytes).expect("write utf16 config");

        let config = service
            .parse_fomod_xml_path(&config_path)
            .expect("UTF-16 ModuleConfig.xml should parse");

        assert_eq!(config.module_name.as_deref(), Some("Encoded Installer"));
    }

    #[test]
    fn build_install_entries_honors_visible_flag_dependencies() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config>
  <installSteps>
    <installStep name="Select Runtime">
      <optionalFileGroups>
        <group name="Runtime" type="SelectExactlyOne">
          <plugins>
            <plugin name="Mono">
              <conditionFlags>
                <flag name="runtime" value="mono" />
              </conditionFlags>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Mono Extras">
      <visible>
        <flagDependency flag="runtime" value="mono" />
      </visible>
      <requiredInstallFiles>
        <file source="data/Runtime/Mono/Mods/Extra.dll" destination="Mods" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let entries = service
            .build_install_entries(&config, None)
            .expect("expected visible dependency evaluation to succeed");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "data/Runtime/Mono/Mods/Extra.dll");
    }

    #[test]
    fn build_install_entries_supports_nested_or_flag_dependencies() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config>
  <installSteps>
    <installStep name="Select Channel">
      <optionalFileGroups>
        <group name="Channel" type="SelectExactlyOne">
          <plugins>
            <plugin name="Stable">
              <conditionFlags>
                <flag name="channel" value="stable" />
              </conditionFlags>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Shared Payload">
      <visible operator="Or">
        <dependencies operator="Or">
          <flagDependency flag="channel" value="beta" />
          <flagDependency flag="channel" value="stable" />
        </dependencies>
      </visible>
      <requiredInstallFiles>
        <file source="data/shared.dll" destination="Mods" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let entries = service
            .build_install_entries(&config, None)
            .expect("expected nested OR evaluation to succeed");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "data/shared.dll");
    }

    #[test]
    fn build_install_entries_errors_on_unsupported_file_dependencies() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config>
  <installSteps>
    <installStep name="File Gated">
      <visible>
        <fileDependency file="Mods/Dependency.dll" state="Active" />
      </visible>
      <requiredInstallFiles>
        <file source="data/file-gated.dll" destination="Mods" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let error = service
            .build_install_entries(&config, None)
            .expect_err("expected unsupported fileDependency usage to fail closed");

        assert!(
            error
                .to_string()
                .contains("Unsupported FOMOD fileDependency conditions"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn build_install_entries_keeps_highest_priority_duplicate_mapping() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config>
  <installSteps>
    <installStep name="Overrides">
      <requiredInstallFiles>
        <file source="data/override.dll" destination="Mods/Example.dll" priority="0" />
        <file source="data/override.dll" destination="Mods/Example.dll" priority="10" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let entries = service
            .build_install_entries(&config, None)
            .expect("expected duplicate priority resolution to succeed");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "data/override.dll");
        assert_eq!(entries[0].priority, 10);
    }

    #[test]
    fn build_install_entries_chooses_one_destination_winner_by_priority_then_order() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config><installSteps><installStep name="Overrides"><requiredInstallFiles>
  <file source="data/a-low.dll" destination="Mods/Example.dll" priority="1" />
  <file source="data/z-high.dll" destination="Mods/Example.dll" priority="10" />
  <file source="data/second-tie.dll" destination="Mods/Tie.dll" priority="5" />
  <file source="data/first-tie.dll" destination="Mods/Tie.dll" priority="5" />
</requiredInstallFiles></installStep></installSteps></config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let entries = service
            .build_install_entries(&config, None)
            .expect("expected deterministic conflict resolution");

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.destination == "Mods/Example.dll")
                .map(|entry| entry.source.as_str()),
            Some("data/z-high.dll")
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.destination == "Mods/Tie.dll")
                .map(|entry| entry.source.as_str()),
            Some("data/second-tie.dll"),
            "first XML declaration wins equal-priority ties"
        );
    }

    #[test]
    fn build_install_entries_preserves_distinct_files_in_the_same_destination_directory() {
        let service = FomodService::new();
        let config: FomodConfig = from_str(
            r#"
<config><installSteps><installStep name="Runtime variants"><requiredInstallFiles>
  <file source="IL2CPP/PackRat.IL2CPP.dll" destination="Mods" priority="0" />
  <file source="Mono/PackRat.Mono.dll" destination="Mods" priority="0" />
</requiredInstallFiles></installStep></installSteps></config>
"#,
        )
        .expect("expected FOMOD config to parse");

        let entries = service
            .build_install_entries(&config, None)
            .expect("directory mappings should remain distinct files");

        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.source == "IL2CPP/PackRat.IL2CPP.dll"));
        assert!(entries
            .iter()
            .any(|entry| entry.source == "Mono/PackRat.Mono.dll"));
    }

    #[test]
    fn select_plugins_for_group_keeps_all_plugins_for_select_all() {
        let service = FomodService::new();
        let group = Group {
            name: Some("Extras".to_string()),
            group_type: Some("SelectAll".to_string()),
            plugins: Some(PluginList {
                plugin: vec![
                    Plugin {
                        name: "Required".to_string(),
                        description: None,
                        image: None,
                        plugin_type: Some("Required".to_string()),
                        type_descriptor: None,
                        files: None,
                        condition_flags: None,
                    },
                    Plugin {
                        name: "Optional".to_string(),
                        description: None,
                        image: None,
                        plugin_type: Some("Optional".to_string()),
                        type_descriptor: None,
                        files: None,
                        condition_flags: None,
                    },
                ],
                order: None,
            }),
        };

        let selected = service.select_plugins_for_group(&group, None);

        assert_eq!(selected.len(), 2);
    }
}
