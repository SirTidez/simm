use anyhow::{Context, Result, anyhow};
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
    ) -> Result<Vec<FomodInstallEntry>> {
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
                        if self.dependencies_match(
                            pattern.dependencies.as_ref(),
                            &selected_flags,
                        )? {
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
                entry.destination.to_ascii_lowercase(),
                entry.source.to_ascii_lowercase(),
                entry.is_folder,
                std::cmp::Reverse(entry.priority),
            )
        });
        entries.dedup_by(|right, left| {
            right.source.eq_ignore_ascii_case(&left.source)
                && right.destination.eq_ignore_ascii_case(&left.destination)
                && right.is_folder == left.is_folder
        });
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
            other => Err(anyhow!(
                "Unsupported FOMOD dependency operator: {}",
                other
            )),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
