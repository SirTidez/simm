use super::*;
use std::{fs, io::Write};

fn inventory() -> Vec<NativeConsoleEntry> {
    vec![
        NativeConsoleEntry {
            name: "Save Expansion".into(),
            version: Some("1.0".into()),
            version_source: None,
            author: None,
            file_name: Some("Nested/SaveExpansion.dll".into()),
            enabled: true,
            kind: "Mod".into(),
        },
        NativeConsoleEntry {
            name: "Test Plugin".into(),
            version: None,
            version_source: None,
            author: None,
            file_name: Some("Probe.dll".into()),
            enabled: false,
            kind: "Plugin".into(),
        },
    ]
}
fn append(path: &Path, bytes: &[u8]) {
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}
fn read(reader: &mut Diagnostics, path: &Path) -> NativeConsoleMessages {
    reader.update(path, Some((123, 0)), &inventory())
}

#[test]
fn counts_explicit_severity_once_per_multiline_message_and_keeps_repeat_events() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    fs::write(&path, "[12:01:02.003] [WARNING] [Save_Expansion] First warning\ncontinued λ text\n   at Example.Run()\n[12:01:03.004] [INFO] [Probe] no error, warning count is zero\n[12:01:04.005] [ERROR] [Probe] Failed\n[12:01:04.005] [ERROR] [Probe] Failed\n").unwrap();
    let mut reader = Diagnostics::default();
    let result = read(&mut reader, &path);
    assert_eq!((result.errors, result.warnings), (2, 1));
    assert_eq!(result.entries[0].origin.as_ref().unwrap().kind, "Plugin");
    assert_eq!(
        result.entries[2].origin.as_ref().unwrap().name,
        "Save Expansion"
    );
    assert_eq!(result.entries[2].timestamp.as_deref(), Some("12:01:02.003"));
    assert!(result.entries[2]
        .message
        .contains("continued λ text\n   at Example.Run()"));
    assert_eq!(read(&mut reader, &path).entries.len(), 3);
}

#[test]
fn partial_unicode_writes_and_continuations_do_not_duplicate_counts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    fs::write(&path, b"[12:01:02.003] [ERROR] [Probe] partial \xce").unwrap();
    let mut reader = Diagnostics::default();
    assert_eq!(read(&mut reader, &path).errors, 0);
    append(&path, b"\xbb\nstack frame");
    assert_eq!(read(&mut reader, &path).entries[0].message, "partial λ");
    append(&path, b"\n");
    let result = read(&mut reader, &path);
    assert_eq!(result.errors, 1);
    assert_eq!(result.entries[0].message, "partial λ\nstack frame");
}

#[test]
fn does_not_reuse_previous_launch_logs_or_counts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    fs::write(&path, "[ERROR] [Probe] old launch\n").unwrap();
    let mut reader = Diagnostics::default();
    assert_eq!(read(&mut reader, &path).errors, 1);
    let future = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 10_000;
    let waiting = reader.update(&path, Some((456, future)), &inventory());
    assert_eq!(waiting.state, "waiting");
    assert_eq!(waiting.errors, 0);
    assert_eq!(reader.update(&path, None, &inventory()).warnings, 0);
}

#[test]
fn detects_truncation_and_regrowth_between_reads_and_resets_generation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    fs::write(&path, "[ERROR] [Probe] old\n").unwrap();
    let mut reader = Diagnostics::default();
    let old = read(&mut reader, &path);
    fs::write(&path, "[WARNING] [Probe] new log longer than the old one\n").unwrap();
    let result = read(&mut reader, &path);
    assert!(result.generation > old.generation);
    assert_eq!((result.errors, result.warnings), (0, 1));
    fs::write(&path, "[ERROR] new\n").unwrap();
    let result = read(&mut reader, &path);
    assert_eq!((result.errors, result.warnings), (1, 0));
}

#[test]
fn missing_log_recovers_and_attribution_tracks_inventory_without_rereading() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    let mut reader = Diagnostics::default();
    assert_eq!(read(&mut reader, &path).state, "waiting");
    fs::write(
        &path,
        "[WARNING] [Save_Expansion] match\n[ERROR] [UnknownTag] unknown\n[ERROR] untagged\n",
    )
    .unwrap();
    let result = read(&mut reader, &path);
    assert!(result.entries[0].source.is_none());
    assert!(result.entries[0].origin.is_none());
    assert_eq!(result.entries[1].source.as_deref(), Some("UnknownTag"));
    assert!(result.entries[1].origin.is_none());
    let mut ambiguous = inventory();
    ambiguous.push(ambiguous[0].clone());
    assert!(reader.update(&path, Some((123, 0)), &ambiguous).entries[2]
        .origin
        .is_none());
    assert!(read(&mut reader, &path).entries[2].origin.is_some());
}

#[test]
fn keeps_message_brackets_and_does_not_treat_severity_words_as_events() {
    let mut reader = Diagnostics::default();
    reader.consume(b"[12:00:00.000] [INFO] [Probe] warning: error examples\n[12:00:00.000] [INFO] [Probe] [ERROR] quoted example\n[12:00:00.001] [ERROR] [Probe] [Feature] failed\n");
    assert_eq!(reader.errors, 1);
    assert_eq!(reader.warnings, 0);
    assert_eq!(reader.entries[0].message, "[Feature] failed");
}

#[test]
fn live_melonloader_info_has_no_level_tag_and_quoted_severity_is_message_text() {
    let mut reader = Diagnostics::default();
    reader.consume(b"[01:13:50.765] [WARNING] [SIMM_Status_Plugin_Probe] [VALIDATION WARNING] real warning\nWarning continuation.\n[01:13:50.765] [ERROR] [SIMM_Status_Mod_Probe] [VALIDATION ERROR] real error\nSynthetic stack text.\n[01:13:50.766] [SIMM_Status_Plugin_Probe] [ERROR] [VALIDATION INFO] ordinary info\n[01:13:50.767] [SIMM_Status_Mod_Probe] [WARNING] [VALIDATION INFO] ordinary info\n");
    assert_eq!((reader.errors, reader.warnings), (1, 1));
    assert_eq!(reader.entries.len(), 2);
    assert_eq!(
        reader.entries[1].source.as_deref(),
        Some("SIMM_Status_Mod_Probe")
    );
    assert_eq!(
        reader.entries[1].message,
        "[VALIDATION ERROR] real error\nSynthetic stack text."
    );
}

#[test]
fn omits_only_the_exact_interop_startup_warning_without_changing_the_log() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    let text = "[01:12:18.752] [WARNING] [Il2CppInterop] Class::Init signatures have been exhausted, using a substitute!\n[01:12:18.753] [WARN] [il2cppinterop] Class::Init signatures have been exhausted, using a substitute\n[01:12:18.754] [INFO] [Probe] Startup finished\n";
    fs::write(&path, text).unwrap();
    let mut reader = Diagnostics::default();
    let result = read(&mut reader, &path);
    assert_eq!((result.errors, result.warnings, result.omitted), (0, 0, 0));
    assert!(result.entries.is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
}

#[test]
fn retains_serious_interop_warnings_errors_and_other_sources_with_similar_text() {
    let mut reader = Diagnostics::default();
    reader.consume(b"[01:12:18.752] [ERROR] [Il2CppInterop] Class::Init signatures have been exhausted, using a substitute!\n[01:12:18.753] [WARNING] [Il2CppInterop] Could not initialize a custom native type\n[01:12:18.754] [WARNING] [Il2CppInterop] Class::Init signatures have been exhausted, using a substitute! Additional failure details.\n[01:12:18.755] [WARNING] [AnotherMod] Class::Init signatures have been exhausted, using a substitute!\n[01:12:18.756] [WARNING] Class::Init signatures have been exhausted, using a substitute!\n");
    assert_eq!((reader.errors, reader.warnings), (1, 4));
    assert_eq!(reader.entries.len(), 5);
    assert!(reader.entries[2]
        .message
        .ends_with("Additional failure details."));
}

#[test]
fn additional_multiline_context_promotes_a_startup_candidate_to_a_real_warning() {
    let mut reader = Diagnostics::default();
    reader.consume(b"[01:12:18.751] [ERROR] [Probe] Earlier error\n[01:12:18.752] [WARNING] [Il2CppInterop] Class::Init signatures have been exhausted, using a substitute!\n\n");
    assert_eq!((reader.errors, reader.warnings), (1, 0));
    reader.consume(b"Could not initialize a custom native type\n");
    assert_eq!((reader.errors, reader.warnings), (1, 1));
    assert_eq!(reader.entries[0].message, "Earlier error");
    assert_eq!(reader.entries[1].source.as_deref(), Some("Il2CppInterop"));
    assert_eq!(reader.entries[1].line_number, 2);
    assert!(reader.entries[1]
        .message
        .ends_with("\n\nCould not initialize a custom native type"));
}

#[test]
fn identifies_loader_sources_and_case_insensitive_plugin_file_names() {
    let entries = inventory();
    assert_eq!(origin("Il2CppInterop", &entries).unwrap().kind, "Loader");
    assert_eq!(origin("Unity", &entries).unwrap().kind, "Game");
    let mut upper = entries.clone();
    upper[1].file_name = Some("PROBE.DLL.DISABLED".into());
    assert_eq!(origin("Probe", &upper).unwrap().kind, "Plugin");
    assert!(origin("TotallyUnknown", &entries).is_none());
}

#[test]
fn bounds_work_and_retention_but_keeps_total_counts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    let line = format!("[WARNING] [Probe] {}\n", "x".repeat(1024));
    fs::write(&path, line.repeat(600)).unwrap();
    let mut reader = Diagnostics::default();
    let first = read(&mut reader, &path);
    assert_eq!(first.state, "reading");
    assert!(reader.offset <= READ_BUDGET as u64);
    let mut result = first;
    while result.state == "reading" {
        result = read(&mut reader, &path);
    }
    assert_eq!(result.warnings, 600);
    assert_eq!(result.entries.len(), 500);
    assert_eq!(result.omitted, 100);
    assert_eq!(read(&mut reader, &path).warnings, 600);
}

#[test]
fn source_totals_survive_retention_follow_attribution_and_reset_with_the_log() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Latest.log");
    fs::write(&path, format!("[ERROR] [Mystery] Unmatched error\n[ERROR] [Probe] Plugin error\n[WARNING] [Test_Plugin] Plugin alias warning\n{}", "[WARNING] [Save_Expansion] Mod warning\n".repeat(600))).unwrap();
    let mut reader = Diagnostics::default();
    let result = read(&mut reader, &path);
    assert_eq!((result.errors, result.warnings), (2, 601));
    assert_eq!(result.entries.len(), RETAINED_MESSAGES);
    assert!(result
        .entries
        .iter()
        .all(|entry| entry.source.as_deref() == Some("Save_Expansion")));
    let plugin = result
        .sources
        .iter()
        .find(|source| source.source.as_deref() == Some("Probe"))
        .unwrap();
    assert_eq!((plugin.errors, plugin.warnings), (1, 0));
    assert_eq!(plugin.origin.as_ref().unwrap().kind, "Plugin");
    let alias = result
        .sources
        .iter()
        .find(|source| source.source.as_deref() == Some("Test_Plugin"))
        .unwrap();
    assert_eq!((alias.errors, alias.warnings), (0, 1));
    assert_eq!(
        alias.origin.as_ref().unwrap().file_name,
        plugin.origin.as_ref().unwrap().file_name
    );
    assert!(result
        .sources
        .iter()
        .find(|source| source.source.as_deref() == Some("Mystery"))
        .unwrap()
        .origin
        .is_none());
    let unassigned = reader.update(&path, Some((123, 0)), &[]);
    assert_eq!(unassigned.errors, 2);
    assert!(unassigned
        .sources
        .iter()
        .all(|source| source.origin.is_none()));
    assert!(read(&mut reader, &path)
        .sources
        .iter()
        .any(|source| source.origin.is_some()));
    fs::write(&path, "[WARNING] [Probe] Fresh log\n").unwrap();
    let fresh = read(&mut reader, &path);
    assert_eq!((fresh.errors, fresh.warnings), (0, 1));
    assert_eq!(fresh.sources.len(), 1);
    assert_eq!(fresh.sources[0].warnings, 1);
}

#[test]
fn utf16_encodings_split_units_and_overlong_lines_recover_at_newline() {
    for little in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("Latest.log");
        let text = format!(
            "[WARNING] [Probe] λ{}\n[ERROR] [Probe] next\n",
            "x".repeat(MAX_TEXT * 3)
        );
        let mut bytes = if little {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        for unit in text.encode_utf16() {
            bytes.extend(if little {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        fs::write(&path, &bytes[..41]).unwrap();
        let mut reader = Diagnostics::default();
        assert_eq!(read(&mut reader, &path).warnings, 0);
        append(&path, &bytes[41..]);
        let result = read(&mut reader, &path);
        assert_eq!((result.errors, result.warnings), (1, 1));
        assert!(result.entries[1].message.starts_with('λ'));
        assert!(result.entries[1].truncated);
        assert!(result.entries[1].message.len() <= MAX_TEXT);
        assert_eq!(result.entries[0].message, "next");
    }
}
