# SIMM Package Manifest v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SIMM’s namespaced, declarative package manifest to archive imports so compatible Schedule I packages can be previewed, installed safely, and uninstalled with reversible base-game changes.

**Architecture:** A focused Rust package service parses only `manifest.json.simm`, validates archive-relative mappings, resolves the current environment runtime and game version, and produces an immutable preview. A ledger stored beside each environment records ownership, hashes, conflict precedence, and base-game backups; the existing library service remains responsible for archive storage and legacy installation. Thin Tauri commands expose preview and apply operations, while the existing mod workspace renders the plan and collects the required user confirmations.

**Tech Stack:** Rust 2021, Tauri 2 commands, `serde`/`serde_json`, `zip`, Tokio filesystem APIs, existing `GameVersionService`, React 18, TypeScript, Vitest, and the existing SIMM primitives/dialog system.

## Global Constraints

- Every SIMM-owned key is a descendant of the single root `simm` object; do not add another custom top-level manifest key.
- Retain Thunderstore’s native root fields unchanged, including its native `dependencies`; do not add a SIMM dependency declaration.
- Support only ZIP archives with a valid `simm.package` v1 extension in this release. Existing ZIP, RAR, 7z, tar.gz, DLL, Nexus, Thunderstore, and FOMOD fallback paths must keep their current behavior when no valid SIMM extension exists.
- Apply `cross` mappings plus exactly one automatically resolved runtime section (`mono` or `il2cpp`). Runtime ambiguity must return a preview state requiring a user selection, never guess.
- Only resolve normalized destinations below the selected game directory. Reject absolute paths, `..`, prefixes, drive-qualified paths, malformed archive entries, and paths escaping the game root.
- Treat a manifest as untrusted data: no command execution, script hooks, registry changes, external writes, or dynamic download instructions.
- A known incompatible Schedule I version requires an explicit UI override. An unknown or unparsable installed game version is reported as unverified, not as compatible.
- A base-game overwrite requires a separate confirmation that names every affected file and the backup path before any filesystem mutation.
- A file conflict always requires a user decision. Recommend one enabled package; permit an explicit per-path precedence choice without silently using last-installed-wins.
- Preserve unrelated dirty workspace changes. Run the full frontend and Rust validation sequence from `AGENTS.md` after shared-contract work.

---

### Task 1: Parse and validate the SIMM manifest extension

**Files:**
- Create: `src-tauri/src/services/simm_package.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Test: `src-tauri/src/services/simm_package.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Consumes: a ZIP archive path and the existing `Runtime` enum from `src-tauri/src/types.rs`.
- Produces: `SimmPackageManifest`, `SimmPackageIdentity`, `SimmRuntimeSections`, `SimmPackageMapping`, `ScheduleIVersionSelector`, and `SimmManifestError`.
- Required functions: `read_simm_manifest_archive(&Path) -> Result<Option<SimmPackageManifest>, SimmManifestError>`, `selected_runtime_mappings(&SimmPackageManifest, Runtime) -> Result<Vec<SimmPackageMapping>, SimmManifestError>`, and `ScheduleIVersionSelector::matches(&self, &ScheduleIVersion) -> bool`.

- [ ] **Step 1: Write failing parser and selector tests**

```rust
#[test]
fn parses_a_namespaced_manifest_and_combines_cross_with_il2cpp() {
    let manifest = parse_fixture_manifest(r#"{
      "name": "Example", "version_number": "1.0.0",
      "simm": {"format": "simm.package", "schema_version": 1,
        "package": {"id": "author.example", "version": "1.0.0"},
        "runtimes": {
          "cross": {"mappings": [{"kind": "file", "source": "a", "destination": "UserData/a"}]},
          "mono": {"mappings": []},
          "il2cpp": {"mappings": [{"kind": "file", "source": "b", "destination": "Plugins/b.dll"}]}
        }
      }
    }"#);
    assert_eq!(selected_runtime_mappings(&manifest, Runtime::Il2cpp).unwrap().len(), 2);
}

#[test]
fn version_selectors_cover_exact_family_and_inclusive_ranges() {
    assert!(parse_selector("0.4.6f6").unwrap().matches(&parse_game_version("0.4.6f6").unwrap()));
    assert!(parse_selector("0.4.6").unwrap().matches(&parse_game_version("0.4.6f12").unwrap()));
    assert!(parse_selector("0.4.3-0.4.6").unwrap().matches(&parse_game_version("0.4.5f1").unwrap()));
    assert!(!parse_selector("0.4.3f2-0.4.6").unwrap().matches(&parse_game_version("0.4.3f1").unwrap()));
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests -- --nocapture`

Expected: FAIL because `simm_package` and its parser/types do not exist.

- [ ] **Step 3: Add the serializable manifest domain model and parser**

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct SimmPackageManifest {
    pub format: String,
    pub schema_version: u32,
    pub package: SimmPackageIdentity,
    #[serde(default)]
    pub compatibility: SimmCompatibility,
    pub runtimes: SimmRuntimeSections,
}

pub fn read_simm_manifest_archive(path: &Path) -> Result<Option<SimmPackageManifest>, SimmManifestError> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    let mut manifest = String::new();
    archive.by_name("manifest.json")?.read_to_string(&mut manifest)?;
    let root: serde_json::Value = serde_json::from_str(&manifest)?;
    let Some(simm) = root.get("simm") else { return Ok(None); };
    let parsed: SimmPackageManifest = serde_json::from_value(simm.clone())?;
    parsed.validate()?;
    Ok(Some(parsed))
}
```

Validate the exact `format`, schema version `1`, canonical `publisher.package-name` package ID, matching `package.version` and root `version_number` when present, valid mapping kinds, and the selector grammar. Implement numeric `major.minor.patch` plus optional numeric `f` build comparison; never use a lexical string comparison.

- [ ] **Step 4: Add archive-entry and mapping validation tests**

```rust
#[test]
fn rejects_unsafe_or_missing_mapping_sources() {
    let error = validate_mapping(&mapping("../payload.dll", "Plugins/payload.dll"), &archive_index()).unwrap_err();
    assert!(error.to_string().contains("unsafe"));

    let error = validate_mapping(&mapping("payload.dll", "../../outside.dll"), &archive_index()).unwrap_err();
    assert!(error.to_string().contains("destination"));
}
```

Cover missing sources, duplicate effective destinations, absolute destinations, archive paths containing a Windows drive prefix, and a directory mapping that expands to zero files.

- [ ] **Step 5: Run parser tests and format the Rust code**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Commit the parser boundary**

```powershell
git add src-tauri/src/services/simm_package.rs src-tauri/src/services/mod.rs
git commit -m "feat: parse SIMM package manifests"
```

### Task 2: Produce an environment-specific, non-mutating installation preview

**Files:**
- Modify: `src-tauri/src/services/simm_package.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/services/game_version.rs`
- Test: `src-tauri/src/services/simm_package.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Consumes: `SimmPackageManifest`, ZIP archive entries, an `Environment`, and `GameVersionService::extract_game_version`.
- Produces: `SimmPackageInstallPreview`, `SimmPackagePlannedFile`, `SimmGameCompatibility`, `SimmBaseGameOverwrite`, and `SimmFileConflict` serialized with camelCase.
- Required function: `preview_install(&self, archive_path: &Path, environment: &Environment, installed_ledger: &SimmPackageInstallLedger) -> Result<SimmPackageInstallPreview, SimmManifestError>`.

- [ ] **Step 1: Write failing preview tests with a temporary game root and ZIP fixture**

```rust
#[tokio::test]
async fn preview_marks_existing_game_file_as_a_confirmed_base_overwrite() {
    let fixture = create_manifest_zip(&[("payload/GameAssembly.dll", b"new bytes")]);
    let game = tempfile::tempdir().unwrap();
    std::fs::write(game.path().join("GameAssembly.dll"), b"original bytes").unwrap();

    let preview = service.preview_install(&fixture, &environment_for(game.path(), Runtime::Il2cpp), &empty_ledger()).await.unwrap();
    assert_eq!(preview.base_game_overwrites.len(), 1);
    assert!(preview.requires_base_game_confirmation);
}
```

- [ ] **Step 2: Run the focused preview test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests::preview_marks_existing_game_file_as_a_confirmed_base_overwrite -- --nocapture`

Expected: FAIL because no preview model or environment plan exists.

- [ ] **Step 3: Implement plan construction without writes**

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageInstallPreview {
    pub package_id: String,
    pub package_version: String,
    pub selected_runtime: Runtime,
    pub detected_game_version: Option<String>,
    pub game_compatibility: SimmGameCompatibility,
    pub files: Vec<SimmPackagePlannedFile>,
    pub base_game_overwrites: Vec<SimmBaseGameOverwrite>,
    pub conflicts: Vec<SimmFileConflict>,
    pub requires_base_game_confirmation: bool,
    pub requires_conflict_resolution: bool,
}
```

Canonicalize each destination relative to `environment.output_dir`, expand directory mappings into sorted individual files, classify an existing file outside `Mods`, `Plugins`, `UserLibs`, and `UserData` as a base-game overwrite, and include the planned backup location. Reuse `GameVersionService` for extraction and return `Compatible`, `Incompatible`, `Unverified`, or `NotDeclared` without mutating the environment.

- [ ] **Step 4: Record conflict discovery from the installation ledger**

```rust
assert_eq!(preview.conflicts[0].destination, "Plugins/shared.dll");
assert_eq!(preview.conflicts[0].installed_package_id, "author.installed-mod");
assert!(preview.requires_conflict_resolution);
```

Detect same-destination ownership from enabled SIMM package records. Do not infer a conflict solely from an untracked ordinary game file; that is a base-game overwrite and follows its separate confirmation path.

- [ ] **Step 5: Run preview tests and format**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Commit preview support**

```powershell
git add src-tauri/src/services/simm_package.rs src-tauri/src/types.rs src-tauri/src/services/game_version.rs
git commit -m "feat: preview SIMM package installs"
```

### Task 3: Apply and reverse mapped changes transactionally

**Files:**
- Modify: `src-tauri/src/services/simm_package.rs`
- Modify: `src-tauri/src/services/mods.rs`
- Test: `src-tauri/src/services/simm_package.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Consumes: a validated `SimmPackageInstallPreview`, `SimmPackageInstallApproval`, and the source archive snapshot under the existing storage item’s `Archive` directory.
- Produces: `SimmPackageApplyResult`, `SimmPackageInstallLedger`, and `SimmPackageUninstallResult`.
- Required methods: `apply_preview`, `uninstall_package`, `load_ledger`, and `save_ledger`.

- [ ] **Step 1: Write failing transaction tests**

```rust
#[tokio::test]
async fn apply_backs_up_a_base_file_and_uninstall_restores_it() {
    let applied = service.apply_preview(&preview, approval_with_base_confirmation()).await.unwrap();
    assert!(Path::new(&applied.base_game_backups[0]).exists());
    assert_eq!(std::fs::read(game.path().join("GameAssembly.dll")).unwrap(), b"new bytes");

    service.uninstall_package(game.path(), "author.example").await.unwrap();
    assert_eq!(std::fs::read(game.path().join("GameAssembly.dll")).unwrap(), b"original bytes");
}
```

Add tests that reject missing base-overwrite confirmation, reject an incompatible game version without explicit override, reject unresolved conflicts, and preserve a user-modified destination rather than deleting it automatically on uninstall.

- [ ] **Step 2: Run transaction tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests::apply_backs_up_a_base_file_and_uninstall_restores_it -- --nocapture`

Expected: FAIL because no ledger or apply operation exists.

- [ ] **Step 3: Implement the per-environment ledger and backups**

```rust
const SIMM_INSTALL_LEDGER_FILE: &str = ".simm-package-installs.json";
const SIMM_BACKUP_DIR: &str = ".simm-package-backups";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageInstallLedger {
    pub schema_version: u32,
    pub packages: Vec<SimmInstalledPackage>,
}
```

Write the original content to `<game-root>/.simm-package-backups/<package-id>/<install-id>/<relative-destination>` before replacing a base-game target. Write copied payloads to a temporary sibling, hash them with the existing `sha2` dependency, atomically rename them into place, then persist the ledger. On a failure, remove newly written files and restore all backups created by that transaction before returning an error.

- [ ] **Step 4: Implement explicit precedence behavior**

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimmPackageInstallApproval {
    pub allow_incompatible_game_version: bool,
    pub confirm_base_game_overwrites: bool,
    pub conflict_precedence: Vec<SimmConflictPrecedenceChoice>,
}
```

Require one `SimmConflictPrecedenceChoice` for every conflicting destination when the user elects to keep both packages enabled. The choice records the winning package ID and destination path. An install with no choice returns the preview’s conflict details; it does not write a file. Uninstall restores the next enabled owner’s recorded payload when one exists, otherwise restores the original backup.

- [ ] **Step 5: Bridge SIMM storage into the existing library flow**

Persist valid manifest data as `.simm-package.json` inside the existing storage item and keep the original archive snapshot as the source of mapped files. In `store_mod_archive`, detect and store the extension before legacy bucket extraction. In `install_storage_mod_to_envs`, route storage containing `.simm-package.json` through `SimmPackageService`; retain the current bucket-copy logic for every other storage item. In `uninstall_storage_mod_from_envs` and `delete_downloaded_mod`, call the SIMM ledger uninstall path before deleting storage.

- [ ] **Step 6: Run service tests and the existing library tests**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo test --manifest-path src-tauri/Cargo.toml services::simm_package::tests services::mods::tests -- --nocapture`

Expected: PASS, including existing library/FOMOD tests.

- [ ] **Step 7: Commit transactional package installation**

```powershell
git add src-tauri/src/services/simm_package.rs src-tauri/src/services/mods.rs
git commit -m "feat: install SIMM package mappings safely"
```

### Task 4: Expose preview and apply operations through typed Tauri contracts

**Files:**
- Create: `src-tauri/src/commands/simm_packages.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/types.rs`
- Modify: `src/types/index.ts`
- Modify: `src/services/api.ts`
- Modify: `src/services/api.test.ts`

**Interfaces:**
- Consumes: archive path or storage ID, environment ID, and `SimmPackageInstallApproval`.
- Produces: `preview_simm_package_install`, `apply_simm_package_install`, and `uninstall_simm_package_install` commands plus camelCase TypeScript mirrors.

- [ ] **Step 1: Write failing API wrapper tests**

```ts
it('previewSimmPackageInstall preserves the archive and environment arguments', async () => {
  invokeMock.mockResolvedValueOnce({ packageId: 'author.example', files: [] });
  await ApiService.previewSimmPackageInstall('env-1', { archivePath: 'C:/mods/example.zip' });
  expect(invokeMock).toHaveBeenCalledWith('preview_simm_package_install', {
    environmentId: 'env-1',
    source: { archivePath: 'C:/mods/example.zip' },
  });
});
```

- [ ] **Step 2: Run the wrapper test to verify it fails**

Run: `bun run test -- src/services/api.test.ts`

Expected: FAIL because the API method and command name do not exist.

- [ ] **Step 3: Implement thin commands and contract mirrors**

```rust
#[tauri::command]
pub async fn preview_simm_package_install(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    source: SimmPackageSource,
) -> Result<SimmPackageInstallPreview, String> {
    let environment_service = EnvironmentService::new(db.inner().clone()).map_err(|error| error.to_string())?;
    let environment = environment_service
        .get_environment(&environment_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;
    let archive_path = resolve_simm_package_source(db.inner().clone(), &source).await?;
    SimmPackageService::new()
        .preview_install(&archive_path, &environment, &SimmPackageService::load_ledger(Path::new(&environment.output_dir)).await?)
        .await
        .map_err(|error| error.to_string())
}
```

Commands must resolve the environment from `EnvironmentService`, use the stored archive when `source.storage_id` is supplied, and emit the existing mods/plugins/userlibs changed events only after a successful apply or uninstall. Register all commands in `main.rs`, mirror every DTO in `src/types/index.ts`, and route frontend calls exclusively through `ApiService`.

- [ ] **Step 4: Run frontend contract tests and Rust command tests**

Run: `bun run test -- src/services/api.test.ts; cargo test --manifest-path src-tauri/Cargo.toml commands::simm_packages::tests -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit the IPC boundary**

```powershell
git add src-tauri/src/commands/simm_packages.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs src-tauri/src/types.rs src/types/index.ts src/services/api.ts src/services/api.test.ts
git commit -m "feat: expose SIMM package install preview"
```

### Task 5: Add the installation-preview and confirmation UI

**Files:**
- Create: `src/components/SimmPackageInstallDialog.tsx`
- Create: `src/components/SimmPackageInstallDialog.test.tsx`
- Modify: `src/components/ModsOverlay.tsx`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `SimmPackageInstallPreview`, `SimmPackageInstallApproval`, and `ApiService` methods from Task 4.
- Produces: a completed or cancelled preview flow for local uploads, library installs, Thunderstore downloads, and Nexus downloads routed through `ModsOverlay`.

- [ ] **Step 1: Write failing dialog tests**

```tsx
it('requires base-game confirmation before enabling Apply', () => {
  render(<SimmPackageInstallDialog preview={baseOverwritePreview} onApply={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: /install package/i })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I understand SIMM will back up/i));
  expect(screen.getByRole('button', { name: /install package/i })).toBeEnabled();
});
```

Add tests for incompatible-version override, an unverified-version warning, selecting a conflict winner, and a normal non-conflicting mapping preview.

- [ ] **Step 2: Run the component test to verify it fails**

Run: `bun run test -- src/components/SimmPackageInstallDialog.test.tsx`

Expected: FAIL because the dialog component does not exist.

- [ ] **Step 3: Build the dialog with a compact, readable mapping table**

Render package identity/version, selected runtime, detected and declared game versions, author notes, and a table with source, destination, operation, and status. Place base-game files in a dedicated warning section showing each backup path. Place conflicts in a dedicated section with the recommended one-enabled option and an explicit precedence picker. Keep the table horizontally constrained and let long paths wrap rather than overflow.

- [ ] **Step 4: Route every archive-origin install through preview before mutation**

In `ModsOverlay.tsx`, request a preview after the existing security gate passes and before calling a mutating local upload, library install, Thunderstore installation, or Nexus installation command. If the archive has no valid SIMM extension, immediately continue through the existing workflow. If the dialog applies, pass the returned approval object to the apply operation; if the user cancels, leave the library and environment unchanged.

- [ ] **Step 5: Add scoped styles and accessibility behavior**

Use the existing `SimmDialogContent`, `SimmButton`, and badge primitives. Add focusable labels for each checkbox and precedence select, visible warning/error states, and responsive table rules that preserve the desktop layout at 1080p, 1440p, and 4k without root-font breakpoint scaling.

- [ ] **Step 6: Run component and type validation**

Run: `bunx tsc --noEmit; bun run test -- src/components/SimmPackageInstallDialog.test.tsx src/services/api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the user confirmation flow**

```powershell
git add src/components/SimmPackageInstallDialog.tsx src/components/SimmPackageInstallDialog.test.tsx src/components/ModsOverlay.tsx src/style.css
git commit -m "feat: preview SIMM package file changes"
```

### Task 6: Validate fallback behavior and end-to-end package scenarios

**Files:**
- Modify: `src-tauri/src/services/mods.rs`
- Modify: `src-tauri/src/services/simm_package.rs`
- Modify: `src/components/ModsOverlay.test.tsx`
- Modify: `src/services/api.test.ts`
- Modify: `docs/superpowers/specs/2026-07-28-simm-package-manifest-design.md`

**Interfaces:**
- Consumes: the completed parser, plan, transaction, IPC, and dialog boundaries.
- Produces: fixture-backed evidence that SIMM packages work without breaking legacy package formats.

- [ ] **Step 1: Add end-to-end Rust fixtures**

```rust
#[tokio::test]
async fn legacy_archive_without_simm_extension_uses_existing_storage_buckets() {
    let archive = create_zip_fixture(&[("Plugins/Legacy.dll", b"legacy")], None);
    let stored = service.store_mod_archive(archive.to_str().unwrap(), "legacy.zip", None, None, None).await.unwrap();
    let storage_id = stored["storageId"].as_str().unwrap();
    assert!(service.get_mods_storage_dir().await.unwrap().join(storage_id).join("Plugins/Legacy.dll").exists());
}

#[tokio::test]
async fn simm_manifest_with_cross_and_mono_payload_installs_only_the_selected_payload() {
    let archive = create_runtime_manifest_zip();
    let preview = service.preview_install(&archive, &environment_for(game.path(), Runtime::Mono), &empty_ledger()).await.unwrap();
    assert!(preview.files.iter().any(|file| file.destination == "UserData/Shared/config.json"));
    assert!(preview.files.iter().any(|file| file.destination == "Plugins/MonoOnly.dll"));
    assert!(!preview.files.iter().any(|file| file.destination == "Plugins/Il2CppOnly.dll"));
}

#[tokio::test]
async fn uninstall_reinstates_the_selected_conflict_owner_before_original_backup() {
    let result = service.uninstall_package(game.path(), "author.overriding-mod").await.unwrap();
    assert!(result.restored_files.iter().any(|path| path.ends_with("Plugins/shared.dll")));
    assert_eq!(std::fs::read(game.path().join("Plugins/shared.dll")).unwrap(), b"first package payload");
}
```

Create fixtures in temporary directories from ZIP writer helpers already used by the `mods.rs` tests. Do not add binary fixtures to the repository.

- [ ] **Step 2: Add frontend route tests**

Assert that a SIMM preview opens before a mutating call, cancellation does not invoke apply, a valid approval invokes apply exactly once, and an archive without the extension still invokes the existing install method.

- [ ] **Step 3: Update the design specification’s acceptance evidence**

Append a `Validation Evidence` table to the design specification with these rows: `parser and selector validation` → `services::simm_package::tests`; `base-file backup and restore` → `apply_backs_up_a_base_file_and_uninstall_restores_it`; `legacy fallback` → `legacy_archive_without_simm_extension_uses_existing_storage_buckets`; `UI confirmation` → `SimmPackageInstallDialog.test.tsx`. Keep the published manifest shape unchanged.

- [ ] **Step 4: Run the full repository validation sequence**

Run:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: every command exits with code 0. Treat new `react-hooks/rules-of-hooks` warnings as failures; review other lint warnings only when they are in touched code and behavior-preserving to fix.

- [ ] **Step 5: Commit verification and specification evidence**

```powershell
git add src-tauri/src/services/mods.rs src-tauri/src/services/simm_package.rs src/components/ModsOverlay.test.tsx src/services/api.test.ts docs/superpowers/specs/2026-07-28-simm-package-manifest-design.md
git commit -m "test: verify SIMM package manifest installation"
```

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover namespacing, runtime sections, version selectors, secure mappings, and non-mutating previews. Task 3 covers backups, restoration, and explicit conflict precedence. Task 4 preserves the Tauri/API contract boundary. Task 5 covers the required user confirmations and readable UI. Task 6 verifies fallback behavior and the full CI sequence.
- Placeholder scan: the plan contains concrete file paths, interfaces, tests, commands, and commit scopes; no deferred implementation marker is present.
- Type consistency: `SimmPackageInstallPreview` is returned by the parser/service, serialized by Tauri commands, mirrored by TypeScript, and consumed by the dialog. `SimmPackageInstallApproval` is created only by the dialog and consumed only by the apply command.
