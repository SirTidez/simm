use std::path::Path;
use std::collections::HashMap;
use std::io::Read;
use std::fs::File;
use anyhow::{Context, Result};
use zip::ZipArchive;
use quick_xml::de::from_str;
use serde::{Deserialize, Serialize};

/// FOMOD detection and parsing service
#[derive(Clone)]
pub struct FomodService;

/// FOMOD module configuration (parsed from ModuleConfig.xml)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(rename = "installStep")]
    pub install_step: Vec<InstallStep>,
    #[serde(rename = "order")]
    pub order: Option<String>,
}

/// Single installation step
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStep {
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[serde(rename = "visible")]
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
    #[serde(rename = "group")]
    pub group: Vec<Group>,
    #[serde(rename = "order")]
    pub order: Option<String>,
}

/// File group
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub group_type: Option<String>, // SelectAtLeastOne, SelectAtMostOne, SelectExactlyOne, SelectAll, SelectAny
    #[serde(rename = "plugins")]
    pub plugins: Option<PluginList>,
}

/// Plugin list container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    #[serde(rename = "plugin")]
    pub plugin: Vec<Plugin>,
    #[serde(rename = "order")]
    pub order: Option<String>,
}

/// Plugin/Option
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[serde(rename = "image")]
    pub image: Option<String>,
    #[serde(rename = "type")]
    pub plugin_type: Option<String>, // Required, Optional, Recommended, NotUsable, CouldBeUsable
    #[serde(rename = "files")]
    pub files: Option<FileList>,
    #[serde(rename = "conditionFlags")]
    pub condition_flags: Option<ConditionFlags>,
}

/// File list container
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    #[serde(rename = "folder")]
    pub folder: Vec<Folder>,
    #[serde(rename = "file")]
    pub file: Vec<FilePattern>,
}

/// Folder pattern
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(rename = "source")]
    pub source: String,
    #[serde(rename = "destination")]
    pub destination: Option<String>,
    #[serde(rename = "priority")]
    pub priority: Option<i32>,
}

/// File pattern
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePattern {
    #[serde(rename = "source")]
    pub source: String,
    #[serde(rename = "destination")]
    pub destination: Option<String>,
    #[serde(rename = "priority")]
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
    #[serde(rename = "pattern")]
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
    #[serde(rename = "flagDependency")]
    pub flag_dependency: Vec<FlagDependency>,
    #[serde(rename = "fileDependency")]
    pub file_dependency: Vec<FileDependency>,
    #[serde(rename = "gameDependency")]
    pub game_dependency: Vec<GameDependency>,
}

/// Flag dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagDependency {
    #[serde(rename = "flag")]
    pub flag: String,
    #[serde(rename = "value")]
    pub value: Option<String>,
}

/// File dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDependency {
    #[serde(rename = "file")]
    pub file: String,
}

/// Game dependency
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDependency {
    #[serde(rename = "version")]
    pub version: Option<String>,
}

/// Condition flags
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionFlags {
    #[serde(rename = "flag")]
    pub flag: Vec<Flag>,
}

/// Flag
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    #[serde(rename = "name")]
    pub name: String,
    #[serde(rename = "value")]
    pub value: Option<String>,
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

    /// Detect if a ZIP file is a FOMOD archive
    pub fn detect_fomod(&self, zip_path: &Path) -> Result<FomodDetectionResult> {
        let file = File::open(zip_path)
            .context("Failed to open zip file")?;
        
        let mut archive = ZipArchive::new(file)
            .context("Failed to read zip archive")?;

        let mut has_module_config = false;
        let mut has_script_cs = false;
        let mut module_name = None;
        let mut module_image = None;
        let mut config_index = None;

        // First pass: find FOMOD files and their indices
        for i in 0..archive.len() {
            let file = archive.by_index(i)
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
            let mut file_reader = archive.by_index(idx)
                .context("Failed to read ModuleConfig.xml")?;
            let mut content = String::new();
            file_reader.read_to_string(&mut content)
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
        let file = File::open(zip_path)
            .context("Failed to open zip file")?;
        
        let mut archive = ZipArchive::new(file)
            .context("Failed to read zip archive")?;

        // Find ModuleConfig.xml index
        let mut config_index = None;
        for i in 0..archive.len() {
            let file = archive.by_index(i)
                .context("Failed to read file from archive")?;
            
            let file_name = file.name().to_lowercase();
            
            if file_name == "fomod/moduleconfig.xml" || file_name == "fomod/script.xml" {
                config_index = Some(i);
                break;
            }
        }

        let idx = config_index
            .ok_or_else(|| anyhow::anyhow!("ModuleConfig.xml not found in FOMOD archive"))?;

        // Read the config file
        let mut file_reader = archive.by_index(idx)
            .context("Failed to read ModuleConfig.xml")?;
        let mut content = String::new();
        file_reader.read_to_string(&mut content)
            .context("Failed to read ModuleConfig.xml content")?;

        // Parse XML
        let config: FomodConfig = from_str(&content)
            .context("Failed to parse ModuleConfig.xml")?;

        Ok(config)
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
}

