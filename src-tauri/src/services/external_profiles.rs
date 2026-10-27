//! Convert external mod lists into SIMM profiles without extracting archives or
//! reading any paths referenced by the source. Source managers remain untouched.
use std::{collections::HashSet, fs::File, io::Read, path::Path};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;

use crate::types::{
    ExternalModProfileFile, ModProfileInfo, ModProfileItem, ModProfileItemType, ModProfileManifest,
    ModSource, Runtime,
};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ITEMS: usize = 4096;
const MAX_ARCHIVE_ENTRIES: usize = 8192;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedProfile {
    profile_name: String,
    mods: Vec<SharedMod>,
    community: Option<String>,
}

#[derive(Deserialize)]
struct SharedMod {
    name: String,
    #[serde(alias = "versionNumber")]
    version: SharedVersion,
    enabled: bool,
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SharedVersion {
    Parts { major: u64, minor: u64, patch: u64 },
    Text(String),
}

fn bounded_read(reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!(
            "Profile data exceeds the {} MiB import limit",
            limit / 1024 / 1024
        );
    }
    Ok(bytes)
}

pub fn read_file(path: &Path, runtime: Runtime) -> Result<ExternalModProfileFile> {
    let mut file = File::open(path).context("Could not open the selected profile file")?;
    if !file.metadata()?.is_file() {
        bail!("Choose a profile file");
    }
    if file.metadata()?.len() > MAX_FILE_BYTES {
        bail!("Profile file exceeds the 128 MiB import limit");
    }
    let extension = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "r2z" | "zip" => {
            let mut archive = zip::ZipArchive::new(file).context("Invalid profile ZIP archive")?;
            if archive.len() > MAX_ARCHIVE_ENTRIES {
                bail!("Profile archive contains too many files");
            }
            let mut manifest = None;
            let mut omitted_files = Vec::new();
            for index in 0..archive.len() {
                let entry = archive.by_index(index)?;
                if entry.is_dir() {
                    continue;
                }
                if entry.name().eq_ignore_ascii_case("export.r2x") {
                    if manifest.is_some() {
                        bail!("Profile archive has duplicate export.r2x manifests");
                    }
                    manifest = Some(bounded_read(entry, MAX_MANIFEST_BYTES)?);
                } else {
                    // Names are displayed as plain text only, never used as paths.
                    if entry.name().len() > 1024 {
                        bail!("Profile archive contains an excessively long filename");
                    }
                    omitted_files.push(entry.name().to_string());
                }
            }
            let bytes = manifest.ok_or_else(|| anyhow!("No export.r2x found. Export the profile as a file from r2modman, Thunderstore Mod Manager, or Gale."))?;
            let mut preview = parse_shared(&bytes, runtime)?;
            if !omitted_files.is_empty() {
                preview.warnings.push("The archive also contains configuration or local files. Only the mod list is imported; copy any needed configuration files separately after reviewing them.".into());
            }
            preview.omitted_files = omitted_files;
            Ok(preview)
        }
        "r2x" | "yaml" | "yml" => parse_shared(&bounded_read(file, MAX_MANIFEST_BYTES)?, runtime),
        "json" => {
            let value: Value = serde_json::from_slice(&bounded_read(&mut file, MAX_FILE_BYTES)?)
                .context("Invalid profile JSON")?;
            if value.get("persistent").is_some() {
                parse_vortex(&value, runtime)
            } else {
                bail!("Choose a full Vortex state backup JSON, or use Import JSON for a SIMM profile. For r2modman, Thunderstore Mod Manager, and Gale, export a profile .r2z file.")
            }
        }
        _ => bail!("Unsupported file. Choose .r2z, export.r2x, or a Vortex state backup .json."),
    }
}

fn new_manifest(name: String, runtime: Runtime, items: Vec<ModProfileItem>) -> ModProfileManifest {
    ModProfileManifest {
        schema_version: 1,
        kind: "simm.profile".into(),
        profile_id: None,
        is_default: None,
        created_at: None,
        updated_at: None,
        collection: None,
        profile: ModProfileInfo {
            name,
            game: "schedule-i".into(),
            environment_id: None,
            runtime,
            branch: String::new(),
            game_version: None,
            exported_at: Utc::now().to_rfc3339(),
        },
        items,
    }
}

fn item(name: String, enabled: bool, runtime: &Runtime) -> ModProfileItem {
    ModProfileItem {
        item_type: ModProfileItemType::Mod,
        name,
        enabled,
        required: true,
        file_name: None,
        source: None,
        source_id: None,
        source_version: None,
        source_url: None,
        runtime: Some(runtime.clone()),
        storage_id: None,
        nexus_file_id: None,
        manual_reason: None,
    }
}

fn is_schedule_i(game: &str) -> bool {
    matches!(
        game.to_ascii_lowercase().as_str(),
        "schedule-i" | "schedule1" | "schedulei" | "schedule_i"
    )
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.len() > 256 {
        bail!("Profile and mod names must contain 1–256 characters");
    }
    Ok(())
}

fn version_string(version: SharedVersion) -> Result<String> {
    let version = match version {
        SharedVersion::Parts {
            major,
            minor,
            patch,
        } => format!("{major}.{minor}.{patch}"),
        SharedVersion::Text(v) => v,
    };
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.parse::<u64>().is_err())
    {
        bail!("Invalid pinned mod version: {version}");
    }
    Ok(version)
}

fn parse_shared(bytes: &[u8], runtime: Runtime) -> Result<ExternalModProfileFile> {
    // A shallow, bounded schema, with parser budgets and no include resolver.
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! { max_depth: 32, max_nodes: 100_000, max_aliases: 0 },
    };
    let shared: SharedProfile = serde_saphyr::from_slice_with_options(bytes, options)
        .context("Invalid export.r2x profile manifest")?;
    validate_name(&shared.profile_name)?;
    if shared.mods.len() > MAX_ITEMS {
        bail!("Profile contains more than {MAX_ITEMS} mods");
    }
    let mut warnings = Vec::new();
    match shared.community {
        Some(game) if !is_schedule_i(&game) => bail!("This profile is for {game}, not Schedule I"),
        None => warnings.push("This export does not identify its game. Confirm that it came from a Schedule I profile before importing.".into()),
        _ => {}
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for entry in shared.mods {
        validate_name(&entry.name)?;
        let (owner, package) = entry
            .name
            .split_once('-')
            .ok_or_else(|| anyhow!("Invalid Thunderstore package identity: {}", entry.name))?;
        if owner.is_empty()
            || package.is_empty()
            || !entry
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            bail!("Invalid Thunderstore package identity: {}", entry.name);
        }
        let version = version_string(entry.version)?;
        if !seen.insert(entry.name.to_ascii_lowercase()) {
            bail!("Duplicate mod in profile: {}", entry.name);
        }
        if owner.eq_ignore_ascii_case("LavaGang") && package.eq_ignore_ascii_case("MelonLoader") {
            warnings.push("MelonLoader is managed by the SIMM environment and was excluded from the mod list.".into());
            continue;
        }
        let mut converted = item(package.to_string(), entry.enabled, &runtime);
        converted.source_version = Some(version);
        if entry
            .source
            .as_deref()
            .is_none_or(|s| s.eq_ignore_ascii_case("thunderstore"))
        {
            converted.source = Some(ModSource::Thunderstore);
            converted.source_id = Some(format!("{owner}/{package}"));
            converted.source_url = Some(format!(
                "https://thunderstore.io/c/schedule-i/p/{owner}/{package}/"
            ));
        } else {
            let reason = format!(
                "{} uses an unsupported provider ({}); add this mod to the SIMM library manually.",
                entry.name,
                entry.source.unwrap_or_default()
            );
            converted.manual_reason = Some(reason.clone());
            warnings.push(reason);
        }
        items.push(converted);
    }
    Ok(ExternalModProfileFile {
        format: "r2modman / Thunderstore / Gale".into(),
        profiles: vec![new_manifest(shared.profile_name, runtime, items)],
        warnings,
        omitted_files: Vec::new(),
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn positive_id(value: &Value, key: &str) -> Option<String> {
    let v = value.get(key)?;
    let id = v.as_u64().or_else(|| v.as_str()?.parse::<u64>().ok())?;
    (id > 0 && id <= u32::MAX as u64).then(|| id.to_string())
}

fn parse_vortex(value: &Value, runtime: Runtime) -> Result<ExternalModProfileFile> {
    let persistent = &value["persistent"];
    let source_profiles = persistent["profiles"].as_object().ok_or_else(|| anyhow!("This JSON has no Vortex profiles. In Vortex, use Settings → Workarounds → Create Backup, then Save copy."))?;
    if source_profiles.len() > 256 {
        bail!("Vortex backup contains too many profiles");
    }
    let mut profiles = Vec::new();
    let mut total_items = 0;
    let mut warnings = vec!["Vortex configuration files, local mod files, installer choices, conflict rules, and load order are not included. Nexus mod/file IDs, versions, and enabled status are imported. Review each profile before applying it.".into(),
        "Use a freshly created Vortex backup so selections and versions reflect your current setup. SIMM reads only the Schedule I mod metadata and does not import account data or settings.".into()];
    for (profile_id, profile) in source_profiles {
        let Some(game) = text(profile, "gameId").filter(|g| is_schedule_i(g)) else {
            continue;
        };
        if profile["pendingRemove"].as_bool() == Some(true) {
            continue;
        }
        let name = text(profile, "name").unwrap_or_else(|| profile_id.clone());
        validate_name(&name)?;
        let mod_state = profile["modState"]
            .as_object()
            .ok_or_else(|| anyhow!("Vortex profile {name} has no modState selections"))?;
        let mods = persistent["mods"][&game]
            .as_object()
            .ok_or_else(|| anyhow!("Vortex backup is missing mod metadata for {game}"))?;
        if mods.len().max(mod_state.len()) > MAX_ITEMS {
            bail!("Vortex profile contains more than {MAX_ITEMS} mods");
        }
        let mut items = Vec::new();
        // Include installed mods absent from modState as disabled, matching Vortex.
        let ids: HashSet<_> = mods
            .iter()
            .filter(|(_, metadata)| metadata["state"].as_str() == Some("installed"))
            .map(|(id, _)| id)
            .chain(mod_state.keys())
            .collect();
        let mut ids: Vec<_> = ids.into_iter().collect();
        if ids.len() > MAX_ITEMS {
            bail!("Vortex profile contains more than {MAX_ITEMS} mods");
        }
        ids.sort();
        for id in ids {
            let metadata = mods.get(id).unwrap_or(&Value::Null);
            if metadata["type"].as_str() == Some("collection") {
                continue;
            }
            let attributes = &metadata["attributes"];
            let mod_name = text(attributes, "customFileName")
                .or_else(|| text(attributes, "name"))
                .or_else(|| text(attributes, "modName"))
                .unwrap_or_else(|| id.clone());
            validate_name(&mod_name)?;
            let enabled = match mod_state.get(id).and_then(|s| s.get("enabled")) {
                None => false,
                Some(v) => v
                    .as_bool()
                    .ok_or_else(|| anyhow!("Invalid enabled status for {mod_name}"))?,
            };
            let mut converted = item(mod_name, enabled, &runtime);
            converted.source_version =
                text(attributes, "version").or_else(|| text(attributes, "modVersion"));
            if converted
                .source_version
                .as_ref()
                .is_some_and(|v| v.len() > 128)
            {
                bail!("Version metadata is too long for {}", converted.name);
            }
            let mod_id = positive_id(attributes, "modId");
            let file_id = positive_id(attributes, "fileId");
            let correct_game = text(attributes, "downloadGame").is_none_or(|g| is_schedule_i(&g));
            if attributes["source"].as_str() == Some("nexus")
                && mod_id.is_some()
                && file_id.is_some()
                && correct_game
            {
                converted.source = Some(ModSource::Nexusmods);
                converted.source_url = Some(format!(
                    "https://www.nexusmods.com/schedule1/mods/{}",
                    mod_id.as_deref().unwrap()
                ));
                converted.source_id = mod_id;
                converted.nexus_file_id = file_id;
            } else {
                converted.manual_reason = Some("No exact Schedule I Nexus mod/file identity is available. Add the original archive or local DLL to the SIMM library manually.".into());
                warnings.push(format!(
                    "{name}: {} needs a manual library import.",
                    converted.name
                ));
            }
            if attributes.get("installerChoices").is_some()
                || !metadata["fileOverrides"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
            {
                warnings.push(format!("{name}: {} has custom installer choices or file overrides; review these in SIMM before applying.", converted.name));
            }
            items.push(converted);
        }
        total_items += items.len();
        if total_items > 16_384 {
            bail!("Vortex backup contains too many Schedule I profile items");
        }
        profiles.push(new_manifest(name, runtime.clone(), items));
    }
    if profiles.is_empty() {
        bail!("No Schedule I profiles found in this Vortex backup. Create a full backup from Settings → Workarounds → Create Backup; the small startup settings file does not contain mod profiles.");
    }
    profiles.sort_by_key(|p| p.profile.name.to_ascii_lowercase());
    Ok(ExternalModProfileFile {
        format: "Vortex state backup".into(),
        profiles,
        warnings,
        omitted_files: Vec::new(),
    })
}

#[cfg(test)]
#[path = "external_profiles.test.rs"]
mod tests;
