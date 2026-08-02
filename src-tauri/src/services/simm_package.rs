use crate::types::Runtime;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use zip::ZipArchive;

pub const SIMM_PACKAGE_FORMAT: &str = "simm.package";
pub const SIMM_PACKAGE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum SimmManifestError {
    #[error("Failed to read package archive: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to read ZIP package: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Failed to parse manifest.json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid SIMM package manifest: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageManifest {
    pub format: String,
    pub schema_version: u32,
    pub package: SimmPackageIdentity,
    #[serde(default)]
    pub notes: SimmPackageNotes,
    #[serde(default)]
    pub compatibility: SimmCompatibility,
    pub runtimes: SimmRuntimeSections,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageIdentity {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageNotes {
    #[serde(default)]
    pub install: Option<String>,
    #[serde(default)]
    pub after_install: Option<String>,
    #[serde(default)]
    pub support_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmCompatibility {
    #[serde(default)]
    pub schedule_i_versions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmRuntimeSections {
    #[serde(default)]
    pub cross: SimmRuntimeSection,
    #[serde(default)]
    pub mono: SimmRuntimeSection,
    #[serde(default)]
    pub il2cpp: SimmRuntimeSection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmRuntimeSection {
    #[serde(default)]
    pub mappings: Vec<SimmPackageMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SimmMappingKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageMapping {
    pub kind: SimmMappingKind,
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScheduleIVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub build: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimmGameCompatibility {
    NotDeclared,
    Compatible,
    Incompatible,
    Unverified,
}

impl ScheduleIVersion {
    pub fn parse(value: &str) -> Result<Self, SimmManifestError> {
        let value = value.trim();
        let (core, build) = match value.split_once('f') {
            Some((core, build)) => (core, Some(parse_u32(build, value)?)),
            None => (value, None),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return Err(invalid_version(value));
        }
        Ok(Self {
            major: parse_u32(parts[0], value)?,
            minor: parse_u32(parts[1], value)?,
            patch: parse_u32(parts[2], value)?,
            build,
        })
    }
}

impl SimmPackageManifest {
    pub fn selected_runtime_mappings(
        &self,
        runtime: Runtime,
    ) -> Result<Vec<SimmPackageMapping>, SimmManifestError> {
        let mut mappings = self.runtimes.cross.mappings.clone();
        match runtime {
            Runtime::Mono => mappings.extend(self.runtimes.mono.mappings.clone()),
            Runtime::Il2cpp => mappings.extend(self.runtimes.il2cpp.mappings.clone()),
        }
        let mut destinations = HashSet::new();
        for mapping in &mappings {
            let destination = normalize_relative_path(&mapping.destination, "destination")?;
            if !destinations.insert(destination) {
                return Err(SimmManifestError::Invalid(format!(
                    "multiple selected mappings write to {}",
                    mapping.destination
                )));
            }
        }
        Ok(mappings)
    }

    pub fn compatible_with_game_version(&self, version: Option<&str>) -> SimmGameCompatibility {
        if self.compatibility.schedule_i_versions.is_empty() {
            return SimmGameCompatibility::NotDeclared;
        }
        let Some(version) = version.and_then(|value| ScheduleIVersion::parse(value).ok()) else {
            return SimmGameCompatibility::Unverified;
        };
        if self
            .compatibility
            .schedule_i_versions
            .iter()
            .any(|selector| selector_matches(selector, version))
        {
            SimmGameCompatibility::Compatible
        } else {
            SimmGameCompatibility::Incompatible
        }
    }

    fn validate(&self, root_version: Option<&str>) -> Result<(), SimmManifestError> {
        if self.format != SIMM_PACKAGE_FORMAT || self.schema_version != SIMM_PACKAGE_SCHEMA_VERSION
        {
            return Err(SimmManifestError::Invalid(
                "format must be simm.package with schema_version 1".to_string(),
            ));
        }
        if !valid_package_id(&self.package.id) || self.package.version.trim().is_empty() {
            return Err(SimmManifestError::Invalid(
                "package must contain a canonical publisher.package-name ID and version"
                    .to_string(),
            ));
        }
        if let Some(root_version) = root_version.filter(|value| !value.is_empty()) {
            if root_version != self.package.version {
                return Err(SimmManifestError::Invalid(
                    "package.version must match manifest.json version_number".to_string(),
                ));
            }
        }
        for selector in &self.compatibility.schedule_i_versions {
            validate_selector(selector)?;
        }
        for mapping in self
            .runtimes
            .cross
            .mappings
            .iter()
            .chain(self.runtimes.mono.mappings.iter())
            .chain(self.runtimes.il2cpp.mappings.iter())
        {
            normalize_relative_path(&mapping.source, "source")?;
            normalize_relative_path(&mapping.destination, "destination")?;
        }
        Ok(())
    }
}

pub fn read_simm_manifest_archive(
    path: &Path,
) -> Result<Option<SimmPackageManifest>, SimmManifestError> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    let mut contents = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| {
            SimmManifestError::Invalid("ZIP package has no root manifest.json".to_string())
        })?
        .read_to_string(&mut contents)?;
    let root: serde_json::Value = serde_json::from_str(&contents)?;
    let Some(simm) = root.get("simm") else {
        return Ok(None);
    };
    let manifest: SimmPackageManifest = serde_json::from_value(simm.clone())?;
    manifest.validate(
        root.get("version_number")
            .and_then(serde_json::Value::as_str),
    )?;
    validate_sources(&manifest, &mut archive)?;
    Ok(Some(manifest))
}

pub fn normalize_relative_path(value: &str, field: &str) -> Result<String, SimmManifestError> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty() || normalized.contains(':') || Path::new(&normalized).is_absolute() {
        return Err(SimmManifestError::Invalid(format!(
            "{} must be a game-relative path",
            field
        )));
    }
    let mut result = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => result.push(segment),
            Component::CurDir => {}
            _ => {
                return Err(SimmManifestError::Invalid(format!(
                    "{} must not escape the game directory",
                    field
                )))
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err(SimmManifestError::Invalid(format!(
            "{} must be a game-relative path",
            field
        )));
    }
    Ok(result.to_string_lossy().replace('\\', "/"))
}

fn validate_sources(
    manifest: &SimmPackageManifest,
    archive: &mut ZipArchive<File>,
) -> Result<(), SimmManifestError> {
    let mut entries = HashSet::new();
    for index in 0..archive.len() {
        entries.insert(normalize_relative_path(
            archive.by_index(index)?.name(),
            "archive entry",
        )?);
    }
    for mapping in manifest
        .runtimes
        .cross
        .mappings
        .iter()
        .chain(manifest.runtimes.mono.mappings.iter())
        .chain(manifest.runtimes.il2cpp.mappings.iter())
    {
        let source = normalize_relative_path(&mapping.source, "source")?;
        let found = match mapping.kind {
            SimmMappingKind::File => entries.contains(&source),
            SimmMappingKind::Directory => entries
                .iter()
                .any(|entry| entry.starts_with(&format!("{}/", source))),
        };
        if !found {
            return Err(SimmManifestError::Invalid(format!(
                "mapping source {} was not found in the archive",
                mapping.source
            )));
        }
    }
    Ok(())
}

fn selector_matches(selector: &str, version: ScheduleIVersion) -> bool {
    let Ok((start, end)) = selector_bounds(selector) else {
        return false;
    };
    version >= start && end.map(|end| version <= end).unwrap_or(true)
}

fn selector_bounds(
    selector: &str,
) -> Result<(ScheduleIVersion, Option<ScheduleIVersion>), SimmManifestError> {
    if let Some((start, end)) = selector.split_once('-') {
        let start = ScheduleIVersion::parse(start)?;
        let end = family_upper_bound(end)?;
        if end < start {
            return Err(SimmManifestError::Invalid(format!(
                "{} has an end before its start",
                selector
            )));
        }
        return Ok((start, Some(end)));
    }
    let start = ScheduleIVersion::parse(selector)?;
    let end = if start.build.is_some() {
        Some(start)
    } else {
        Some(ScheduleIVersion {
            build: Some(u32::MAX),
            ..start
        })
    };
    Ok((start, end))
}

fn family_upper_bound(value: &str) -> Result<ScheduleIVersion, SimmManifestError> {
    let parsed = ScheduleIVersion::parse(value)?;
    Ok(if parsed.build.is_some() {
        parsed
    } else {
        ScheduleIVersion {
            build: Some(u32::MAX),
            ..parsed
        }
    })
}

fn validate_selector(value: &str) -> Result<(), SimmManifestError> {
    selector_bounds(value).map(|_| ())
}
fn parse_u32(value: &str, original: &str) -> Result<u32, SimmManifestError> {
    if value.is_empty() || !value.bytes().all(|value| value.is_ascii_digit()) {
        return Err(invalid_version(original));
    }
    value.parse().map_err(|_| invalid_version(original))
}
fn invalid_version(value: &str) -> SimmManifestError {
    SimmManifestError::Invalid(format!("{} is not a valid Schedule I version", value))
}
fn valid_package_id(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(publisher), Some(package), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !publisher.is_empty()
        && !package.is_empty()
        && publisher
            .bytes()
            .chain(package.bytes())
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
}
