# Local mod metadata throughout SIMM

## Behavior

Installed Mods and Plugins now inspect installed DLL metadata using the same static MelonInfo reader as Environment Status. Local entries display the declared name, author, and version, including disabled files and nested mod paths. Replacing a DLL is reflected by the next inventory snapshot. Both lists support searching by author; list rows show the author beside the version.

The reader uses MelonInfo, legacy MelonModInfo, and MelonPluginInfo attributes, with CLR AssemblyVersion as the version fallback. It reads headers and metadata on a blocking worker without loading the assembly, executing attribute constructors, resolving dependencies, or reading embedded asset bundles. Unreadable DLLs retain available install metadata and remain in the list.

Mod Library enriches existing local storage entries at read time. New local DLL and archive imports also persist extracted storage metadata. Direct DLL installs persist the extracted identity in environment metadata. Extraction does not adopt unmanaged files, change storage IDs, or attach remote source identities.

Remote source versions and authors remain authoritative for managed package displays; DLL metadata fills missing installed-list details. Local package inference requires agreeing MelonInfo declarations, so dependencies do not supply the package identity. Bundles with conflicting declarations keep their existing package metadata. Plain AssemblyVersion is used at package level only for a single DLL payload; UserLibs and UserData do not supply a mod identity.

## Validation

Completed the repository's full validation sequence:

- `bun install`
- `bunx tsc --noEmit`
- `bun run lint`: zero errors, 27 existing advisory warnings.
- `bun run test`: 516 tests passed.
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml --offline`
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`: 666 passed, 10 intentionally ignored.
- IPC contract checker: no missing frontend command registrations.

Added regressions for local name/author/version projection, DLL replacement, disabled files, assembly fallback, unreadable files, remote metadata precedence, ownership preservation, persisted DLL/archive imports, legacy library enrichment, ambiguous packages, and author search in installed/plugin/library views. These are noninteractive metadata and component tests; no synthetic console was launched.

The first sandboxed test attempts could not read Bun's working directory and denied temporary-file renames/local HTTP requests. The checks passed when rerun with normal local access. The IPC checker is under `.codex/skills/simmrust-ipc-contracts/scripts/`, rather than the repository's top-level scripts directory.

## Desktop evidence

Built the custom-protocol Tauri binary and opened it with isolated app data containing only the real Steam environment. The game remained closed. Installed Mods and its inspector showed:

| Mod | Author | Version |
| --- | --- | --- |
| PackRat | SirTidez | 3.1.0 |
| Save Expansion | SirTidez | 1.0.1 |
| SimpleHealthBar | iTidez | 1.5.2 |

The service returned all three entries as unmanaged local files. The first measured refresh took 9.4 ms in this run, including the 231 MB PackRat assembly; this is a smoke measurement, not a performance benchmark.

An isolated library copy of the real SimpleHealthBar DLL, with no storage metadata, displayed `iTidez` and `v1.5.2`. Author filtering worked in Installed Mods. The actual Tauri WebView was checked at 1920x1080, 2560x1440, and 3840x2160: rows had no horizontal overflow and the root font stayed at 16 px. The isolated app was closed after review. Game files were not changed.

Evidence is retained under `target/diagnostics/local-metadata-ui/` (`api.json`, `layout.json`, desktop screenshots) and `target/diagnostics/native-console-integration/local-metadata-validation/` (full check logs).

Native Windows view rendering was verified with real mods. Plugin behavior is covered by service and component tests; no live game/plugin execution or Linux runtime acceptance is claimed.
