use super::*;
use serde_json::json;
use std::io::Write;

const R2: &str = "profileName: My Schedule I Profile\ncommunity: schedule-i\nmods:\n  - name: Author-Example\n    version: {major: 1, minor: 2, patch: 3}\n    enabled: true\n  - name: Other-Disabled\n    versionNumber: {major: 2, minor: 0, patch: 1}\n    enabled: false\n";

fn vortex() -> Value {
    json!({"persistent": {
        "profiles": {
            "one": {"gameId": "schedule1", "name": "Primary", "modState": {"example": {"enabled": true}, "local": {"enabled": false}}},
            "two": {"gameId": "schedule1", "name": "Secondary", "modState": {"example": {"enabled": false}}},
            "skyrim": {"gameId": "skyrim", "name": "Unrelated", "modState": {}}
        },
        "mods": {"schedule1": {
            "example": {"state": "installed", "type": "", "installationPath": "../../untrusted", "attributes": {"modName": "Example", "version": "1.2.3", "source": "nexus", "modId": 42, "fileId": "123", "downloadGame": "schedule1"}},
            "local": {"state": "installed", "type": "", "attributes": {"name": "My Local Mod", "version": "4.0.0"}},
            "absent": {"state": "installed", "attributes": {"name": "Absent from profile state"}},
            "download": {"state": "downloaded", "attributes": {"name": "Not installed"}}
        }},
        "nexus": {"apiKey": "must never be imported"}
    }})
}

#[test]
fn shared_manifest_preserves_identity_version_and_state() -> Result<()> {
    let result = parse_shared(R2.as_bytes(), Runtime::Mono)?;
    let profile = &result.profiles[0];
    assert_eq!(profile.profile.name, "My Schedule I Profile");
    assert_eq!(profile.profile.runtime, Runtime::Mono);
    assert_eq!(
        profile.items[0].source_id.as_deref(),
        Some("Author/Example")
    );
    assert_eq!(profile.items[0].source_version.as_deref(), Some("1.2.3"));
    assert!(profile.items[0].enabled);
    assert!(!profile.items[1].enabled);
    assert_eq!(profile.items[1].source_version.as_deref(), Some("2.0.1"));
    assert!(result.warnings.is_empty());
    Ok(())
}

#[test]
fn shared_export_supports_gale_source_and_reports_other_provider() -> Result<()> {
    let data = R2.replace("enabled: true", "enabled: true\n    source: hexium");
    let result = parse_shared(data.as_bytes(), Runtime::Il2cpp)?;
    assert!(result.profiles[0].items[0].source_id.is_none());
    assert!(result.profiles[0].items[0].manual_reason.is_some());
    assert!(result.warnings.iter().any(|w| w.contains("hexium")));
    Ok(())
}

#[test]
fn shared_export_rejects_wrong_game_duplicates_and_invalid_versions() {
    for data in [
        R2.replace("schedule-i", "valheim"),
        R2.replace("Other-Disabled", "Author-Example"),
        R2.replace("{major: 1, minor: 2, patch: 3}", "latest"),
        R2.replace("Author-Example", "../../Example"),
        R2.replace("enabled: true", "enabled: perhaps"),
    ] {
        assert!(parse_shared(data.as_bytes(), Runtime::Il2cpp).is_err());
    }
}

#[test]
fn shared_export_warns_about_missing_game_and_excludes_loader() -> Result<()> {
    let data = R2
        .replace("community: schedule-i\n", "")
        .replace("Other-Disabled", "LavaGang-MelonLoader");
    let result = parse_shared(data.as_bytes(), Runtime::Il2cpp)?;
    assert_eq!(result.profiles[0].items.len(), 1);
    assert_eq!(result.warnings.len(), 2);
    Ok(())
}

fn write_zip(path: &Path, entries: &[(&str, &str)]) -> Result<()> {
    let mut zip = zip::ZipWriter::new(File::create(path)?);
    for (name, data) in entries {
        zip.start_file(*name, zip::write::FileOptions::default())?;
        zip.write_all(data.as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

#[test]
fn r2z_reads_manifest_without_extracting_any_other_files() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("profile.r2z");
    write_zip(
        &path,
        &[
            ("export.r2x", R2),
            ("UserData/config.cfg", "config"),
            ("../outside.dll", "not executable"),
        ],
    )?;
    let before = std::fs::read(&path)?;
    let result = read_file(&path, Runtime::Mono)?;
    assert_eq!(
        result.omitted_files,
        ["UserData/config.cfg", "../outside.dll"]
    );
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 1);
    assert_eq!(std::fs::read(&path)?, before);
    Ok(())
}

#[test]
fn r2z_rejects_missing_duplicate_or_oversized_manifest() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("profile.r2z");
    write_zip(&path, &[("other.yaml", R2)])?;
    assert!(read_file(&path, Runtime::Mono).is_err());
    write_zip(&path, &[("export.r2x", R2), ("EXPORT.R2X", R2)])?;
    assert!(read_file(&path, Runtime::Mono).is_err());
    let large = "x".repeat(MAX_MANIFEST_BYTES as usize + 1);
    write_zip(&path, &[("export.r2x", &large)])?;
    assert!(read_file(&path, Runtime::Mono).is_err());
    Ok(())
}

#[test]
fn yaml_rejects_aliases_and_deep_nesting() {
    let aliases = R2.replace(
        "profileName: My Schedule I Profile",
        "profileName: &n name\nextra: *n",
    );
    assert!(parse_shared(aliases.as_bytes(), Runtime::Mono).is_err());
    let deep = format!("{R2}extra: {}0{}", "[".repeat(100), "]".repeat(100));
    assert!(parse_shared(deep.as_bytes(), Runtime::Mono).is_err());
}

#[test]
fn vortex_imports_only_schedule_i_profiles_and_exact_file_ids() -> Result<()> {
    let result = parse_vortex(&vortex(), Runtime::Il2cpp)?;
    assert_eq!(result.profiles.len(), 2);
    let primary = &result.profiles[0];
    assert_eq!(primary.items.len(), 3);
    let example = primary.items.iter().find(|i| i.name == "Example").unwrap();
    assert!(example.enabled);
    assert_eq!(example.source_id.as_deref(), Some("42"));
    assert_eq!(example.nexus_file_id.as_deref(), Some("123"));
    assert_eq!(example.source_version.as_deref(), Some("1.2.3"));
    assert!(primary
        .items
        .iter()
        .filter(|i| i.name != "Example")
        .all(|i| !i.enabled));
    assert!(result.profiles[1].items.iter().all(|i| !i.enabled));
    let converted = serde_json::to_string(&result)?;
    assert!(!converted.contains("must never be imported"));
    assert!(!converted.contains("../../untrusted"));
    Ok(())
}

#[test]
fn vortex_retains_missing_mods_as_manual_and_excludes_collections() -> Result<()> {
    let mut data = vortex();
    data["persistent"]["profiles"]["one"]["modState"]["missing"] = json!({"enabled": true});
    data["persistent"]["mods"]["schedule1"]["collection"] =
        json!({"state": "installed", "type": "collection"});
    let result = parse_vortex(&data, Runtime::Mono)?;
    let missing = result.profiles[0]
        .items
        .iter()
        .find(|i| i.name == "missing")
        .unwrap();
    assert!(missing.enabled && missing.manual_reason.is_some());
    assert!(!result.profiles[0]
        .items
        .iter()
        .any(|i| i.name == "collection"));
    Ok(())
}

#[test]
fn vortex_does_not_relabel_other_game_or_invalid_nexus_ids() -> Result<()> {
    for field in ["downloadGame", "modId", "fileId"] {
        let mut data = vortex();
        data["persistent"]["mods"]["schedule1"]["example"]["attributes"][field] =
            json!(if field == "downloadGame" {
                "skyrim"
            } else {
                "-5"
            });
        let result = parse_vortex(&data, Runtime::Mono)?;
        let example = result.profiles[0]
            .items
            .iter()
            .find(|i| i.name == "Example")
            .unwrap();
        assert!(example.source_id.is_none() && example.manual_reason.is_some());
    }
    Ok(())
}

#[test]
fn vortex_rejects_session_settings_file_and_invalid_enabled_values() {
    assert!(parse_vortex(&json!({"settings": {}}), Runtime::Mono).is_err());
    let mut data = vortex();
    data["persistent"]["profiles"]["one"]["modState"]["example"]["enabled"] = json!("yes");
    assert!(parse_vortex(&data, Runtime::Mono).is_err());
}

#[test]
fn vortex_file_conversion_keeps_source_unchanged() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("backup.json");
    let bytes = serde_json::to_vec(&vortex())?;
    std::fs::write(&path, &bytes)?;
    let preview = read_file(&path, Runtime::Mono)?;
    assert_eq!(preview.format, "Vortex state backup");
    assert_eq!(std::fs::read(&path)?, bytes);
    Ok(())
}

#[tokio::test]
#[serial_test::serial]
async fn converted_profile_round_trips_through_library_and_apply_preview() -> Result<()> {
    struct DataDirGuard(Option<std::ffi::OsString>);
    impl Drop for DataDirGuard {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("SIMMRUST_DATA_DIR", value),
                None => std::env::remove_var("SIMMRUST_DATA_DIR"),
            }
        }
    }
    let temp = tempfile::tempdir()?;
    let _guard = DataDirGuard(std::env::var_os("SIMMRUST_DATA_DIR"));
    std::env::set_var("SIMMRUST_DATA_DIR", temp.path().join("data"));
    let pool = crate::db::initialize_pool().await?;
    crate::services::settings::SettingsService::new(pool.clone())?
        .save_settings(
            json!({"defaultDownloadDir": temp.path().join("downloads").to_string_lossy()}),
        )
        .await?;
    let service = crate::services::mod_profiles::ModProfilesService::new(pool.clone());
    let manifest = parse_shared(R2.as_bytes(), Runtime::Mono)?
        .profiles
        .remove(0);
    let saved = service.import_profile_manifest(manifest).await?;
    let loaded = service.get_profile(&saved.id).await?;
    assert!(!loaded.is_default);
    assert_eq!(
        loaded.manifest.items[0].source_version.as_deref(),
        Some("1.2.3")
    );
    assert!(!loaded.manifest.items[1].enabled);
    let plan = service.preview_import(loaded.manifest, None).await?;
    assert_eq!(plan.items.len(), 2);
    assert!(plan
        .items
        .iter()
        .all(|i| i.status == crate::types::ModProfileImportStatus::NeedsDownload));
    assert!(!temp.path().join("game").exists());
    pool.close().await;
    Ok(())
}
