use super::*;

fn fixture(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/melon-metadata")
        .join(format!("{name}.dll"))
}

#[test]
fn package_identity_ignores_dependencies_and_rejects_ambiguous_bundles() {
    let modern = read(&fixture("Modern")).unwrap();
    let dependency = read(&fixture("Fallback")).unwrap();
    assert_eq!(
        package_info([dependency.clone(), modern.clone(), modern.clone()]),
        Some(modern.clone())
    );
    assert!(package_info([modern, read(&fixture("Legacy")).unwrap()]).is_none());
    assert!(package_info([dependency.clone(), dependency.clone()]).is_none());
    assert_eq!(package_info([dependency.clone()]), Some(dependency));
}

#[tokio::test]
async fn batch_scan_keeps_readable_entries_when_another_file_is_missing() {
    let infos = read_files(vec![fixture("Modern"), fixture("Missing")])
        .await
        .unwrap();
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[&fixture("Modern")].version, "2.7.1-beta.4+local");
}

#[test]
fn reads_declared_version_and_unicode_without_loading_dependencies() {
    let info = read(&fixture("Modern")).unwrap();
    assert_eq!(info.name.as_deref(), Some("Fixture Ω"));
    assert_eq!(info.version, "2.7.1-beta.4+local");
    assert_eq!(info.author.as_deref(), Some("Author Ω"));
    assert_eq!(info.source, "melonInfo");
}

#[test]
fn supports_numeric_constructors_defined_locally_and_in_dependencies() {
    assert_eq!(read(&fixture("Numeric")).unwrap().version, "2.3.4-rc.2");
    assert_eq!(read(&fixture("NumericStable")).unwrap().version, "3.4.5");
}

#[test]
fn reads_legacy_plugin_declarations_and_disabled_files() {
    let directory = tempfile::tempdir().unwrap();
    let disabled = directory.path().join("Plugin.dll.disabled");
    std::fs::copy(fixture("Legacy"), &disabled).unwrap();
    let info = read(&disabled).unwrap();
    assert_eq!(info.version, "1.8.2");
    assert_eq!(info.name.as_deref(), Some("Legacy plugin"));
    assert_eq!(info.source, "melonInfo");
}

#[test]
fn assembly_fallback_ignores_unrelated_attributes_and_decoy_versions() {
    let info = read(&fixture("Fallback")).unwrap();
    assert_eq!(info.version, "3.4.5.6");
    assert_eq!(info.source, "assembly");
    assert!(info.name.is_none());
}

#[test]
fn rejects_non_assemblies_and_truncated_files_without_a_version_guess() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("broken.dll");
    std::fs::write(&path, b"dependency 98.76.54.32").unwrap();
    assert!(read(&path).is_err());
    let bytes = std::fs::read(fixture("Modern")).unwrap();
    std::fs::write(&path, &bytes[..128]).unwrap();
    assert!(read(&path).is_err());
}

#[test]
fn rejects_invalid_stream_bounds_and_huge_table_counts_before_parsing() {
    let reader = FileReader::open(fixture("Modern")).unwrap();
    let headers = PeHeaders::read_from(&reader, 0).unwrap();
    let cli = headers.optional_header.data_directories()[14];
    let cli = CliHeader::parse(
        &read_rva(&reader, &headers, cli.virtual_address, CliHeader::SIZE).unwrap(),
    )
    .unwrap();
    let bytes = read_rva(
        &reader,
        &headers,
        cli.metadata_rva,
        cli.metadata_size as usize,
    )
    .unwrap();
    let mut root = clrmeta::MetadataRoot::parse(&bytes).unwrap();
    root.streams[0].size = u32::MAX;
    let mut invalid = bytes.clone();
    let modified_root = root.write();
    invalid[..modified_root.len()].copy_from_slice(&modified_root);
    assert!(parse_metadata(&invalid).is_err());
    let root = clrmeta::MetadataRoot::parse(&bytes).unwrap();
    let tables = root.tables_stream().unwrap();
    let mut invalid = bytes;
    invalid[tables.offset as usize + 24..tables.offset as usize + 28]
        .copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_metadata(&invalid).is_err());
}
