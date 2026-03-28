use anyhow::{Context, Result};
use quick_xml::de::from_str;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

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
    #[serde(default, rename = "@visible", alias = "visible")]
    pub visible: Option<String>,
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
    #[serde(default, rename = "flagDependency")]
    pub flag_dependency: Vec<FlagDependency>,
    #[serde(default, rename = "fileDependency")]
    pub file_dependency: Vec<FileDependency>,
    #[serde(default, rename = "gameDependency")]
    pub game_dependency: Vec<GameDependency>,
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

    pub fn parse_fomod_xml_path(&self, config_path: &Path) -> Result<FomodConfig> {
        let mut content = String::new();
        File::open(config_path)
            .context("Failed to open ModuleConfig.xml")?
            .read_to_string(&mut content)
            .context("Failed to read ModuleConfig.xml content")?;
        let config: FomodConfig = from_str(&content).context("Failed to parse ModuleConfig.xml")?;
        Ok(config)
    }

    /// Detect if a ZIP file is a FOMOD archive
    pub fn detect_fomod(&self, zip_path: &Path) -> Result<FomodDetectionResult> {
        let file = File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

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
            let mut content = String::new();
            file_reader
                .read_to_string(&mut content)
                .context("Failed to read ModuleConfig.xml content")?;

            // Parse XML (basic parsing for name and image)
            if let Ok(config) = from_str::<FomodConfig>(&content) {
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

        let mut config_index = None;
        for i in 0..archive.len() {
            let file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;
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
        let mut content = String::new();
        file_reader
            .read_to_string(&mut content)
            .context("Failed to read ModuleConfig.xml content")?;
        let config: FomodConfig = from_str(&content).context("Failed to parse ModuleConfig.xml")?;
        Ok(config)
    }

    pub fn build_install_entries(
        &self,
        config: &FomodConfig,
        runtime: Option<&str>,
    ) -> Vec<FomodInstallEntry> {
        let mut entries = Vec::new();
        let mut selected_flags = HashMap::<String, String>::new();

        let Some(steps) = config.install_steps.as_ref() else {
            return entries;
        };

        for step in &steps.install_step {
            if let Some(required) = step.required_install_files.as_ref() {
                self.collect_file_entries(required, None, None, &mut entries);
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
                            );
                        }
                    }
                }
            }

            if let Some(conditional) = step.conditional_file_installs.as_ref() {
                if let Some(patterns) = conditional.patterns.as_ref() {
                    for pattern in &patterns.pattern {
                        if self.pattern_dependencies_match(
                            pattern.dependencies.as_ref(),
                            &selected_flags,
                        ) {
                            if let Some(files) = pattern.files.as_ref() {
                                self.collect_file_entries(
                                    files,
                                    step.name.as_deref(),
                                    None,
                                    &mut entries,
                                );
                            }
                        }
                    }
                }
            }
        }

        entries.sort_by_key(|entry| {
            (
                entry.priority,
                entry.destination.clone(),
                entry.source.clone(),
            )
        });
        entries.dedup_by(|right, left| {
            right.source.eq_ignore_ascii_case(&left.source)
                && right.destination.eq_ignore_ascii_case(&left.destination)
                && right.is_folder == left.is_folder
        });
        entries
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

        let group_type = group
            .group_type
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if group_type.contains("selectall") || group_type.contains("selectany") {
            return plugins.plugin.iter().collect();
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
    ) {
        for folder in &files.folder {
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
            });
        }

        for file in &files.file {
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
            });
        }
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

    fn pattern_dependencies_match(
        &self,
        dependencies: Option<&Dependencies>,
        selected_flags: &HashMap<String, String>,
    ) -> bool {
        let Some(dependencies) = dependencies else {
            return true;
        };

        if !dependencies.file_dependency.is_empty() {
            return false;
        }

        dependencies.flag_dependency.iter().all(|dependency| {
            let Some(actual) = selected_flags.get(&dependency.flag) else {
                return false;
            };
            dependency
                .value
                .as_deref()
                .map(|expected| actual.eq_ignore_ascii_case(expected))
                .unwrap_or(true)
        })
    }

    fn normalize_path_value(value: &str) -> String {
        value
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
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
