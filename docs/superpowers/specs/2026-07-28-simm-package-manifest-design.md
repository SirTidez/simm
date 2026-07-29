# SIMM Package Manifest v1 Design

## Goal

Define a declarative package manifest that lets Schedule I mod authors describe
their package identity, runtime-specific installation layout, dependencies, and
user-facing instructions. SIMM uses the manifest to produce a safe, previewable,
and reversible installation plan for archives obtained from Thunderstore, Nexus
Mods, or local files.

The format is intentionally a SIMM-focused FOMOD alternative, not a scripting
or conditional installer framework.

## Chosen Packaging Approach

The preferred distribution is one archive with the existing Thunderstore
`manifest.json` at its root and a namespaced top-level `simm` object inside that
file. Nexus and local archives use the same file unchanged.

Thunderstore owns its existing top-level fields such as `name`,
`version_number`, `description`, `website_url`, and `dependencies`. SIMM owns
only the `simm` object. The SIMM extension must be continuously checked against
Thunderstore upload validation because it is not a documented Thunderstore
extension contract.

`simm-manifest.json` is not part of v1. It remains a future compatibility
fallback if a marketplace later rejects the namespaced extension.

## Format Shape

```json
{
  "name": "ExampleMod",
  "version_number": "1.2.0",
  "website_url": "https://example.invalid",
  "description": "An example Schedule I mod",
  "dependencies": [],
  "simm": {
    "format": "simm.package",
    "schema_version": 1,
    "package": {
      "id": "example-author.example-mod",
      "version": "1.2.0"
    },
    "providers": {
      "thunderstore": {
        "namespace": "ExampleAuthor",
        "name": "ExampleMod"
      },
      "nexus": {
        "game_domain": "schedule-i",
        "mod_id": 123
      }
    },
    "notes": {
      "install": "Install into a supported Schedule I environment.",
      "after_install": "Configure the mod after launching the game once."
    },
    "runtimes": {
      "cross": { "mappings": [], "dependencies": [] },
      "mono": { "mappings": [], "dependencies": [] },
      "il2cpp": { "mappings": [], "dependencies": [] }
    }
  }
}
```

`package.id` is a source-neutral, stable package identifier in
`publisher.package-name` form. `package.version` is semantic version text and
must equal Thunderstore's `version_number` whenever the package is published on
Thunderstore. Provider identifiers are optional aliases used for source lookup
and dependency installation.

## Runtime Selection

`cross`, `mono`, and `il2cpp` are the only runtime sections in v1.

- `cross` contains files and dependencies compatible with both runtimes.
- `mono` contains only Mono-specific content.
- `il2cpp` contains only IL2CPP-specific content.
- SIMM automatically selects the environment's runtime and applies `cross`
  plus its matching runtime section.
- SIMM asks the user to select a runtime only when it cannot determine the
  target environment safely.

There are no author-defined install options, conditional pages, scripts, or
runtime-selection prompts in v1. A package has one deterministic install plan
for each supported runtime.

## Mapping Model

Each runtime section can declare file and directory mappings:

```json
{
  "kind": "file",
  "source": "release/Plugins/ExampleMod.dll",
  "destination": "Plugins/ExampleMod.dll"
}
```

```json
{
  "kind": "directory",
  "source": "release/UserData/ExampleMod",
  "destination": "UserData/ExampleMod"
}
```

Mappings are declarative copies from an archive-relative source to a normalized
path inside the selected Schedule I environment. A source directory can use
the casing authored in the archive; a destination identifies the canonical
game-relative target path. SIMM rejects absolute paths, path traversal,
symlinks that escape the install root, missing source entries, duplicate
manifest mappings, and destinations outside the game installation.

The v1 destination scope is normal game-relative paths only. It does not write
to AppData, a user's home folder, the registry, or arbitrary filesystem paths.
Standard loader paths such as `Mods`, `Plugins`, `UserLibs`, `UserData`, and
`MelonLoader` are supported through normal mappings. A mapping may also target
an existing base-game file or directory beneath the game root.

## Base-Game Files and Uninstall

Base-game overwrites are permitted, but never silently applied.

Before an installation changes a pre-existing base-game file, SIMM displays a
separate confirmation that lists each destination and its backup location. On
confirmation, SIMM stores an immutable original-file backup and an install
ledger entry before copying package content.

The ledger records the canonical package ID and version, selected runtime,
archive identity, applied mappings, destination content hashes, original-file
backup paths, and conflict choices. On uninstall, SIMM removes package-owned
files and restores original files only when no active, higher-precedence package
owns the same destination. If a destination has changed outside SIMM since
installation, SIMM shows the difference and asks the user before deleting or
restoring it.

## Conflicts

SIMM detects conflicts whenever enabled packages target the same destination.
The manifest declares the intended file mapping only; it never authorizes or
suppresses a conflict.

The default and recommended resolution is to keep one conflicting package
enabled at a time. The user may instead keep both enabled and explicitly choose
which package has overwrite precedence for each conflict set. SIMM persists the
choice in the install ledger and surfaces it on later update, reinstall, and
uninstall operations. SIMM must never silently use last-installed-wins
semantics.

## Dependencies

Dependencies are declared within the applicable runtime section so packages can
depend on different libraries for Mono and IL2CPP:

```json
{
  "package_id": "example-author.shared-library",
  "requirement": ">=2.0.0 <3.0.0",
  "kind": "required",
  "sources": [
    {
      "provider": "thunderstore",
      "namespace": "ExampleAuthor",
      "name": "SharedLibrary"
    },
    {
      "provider": "nexus",
      "game_domain": "schedule-i",
      "mod_id": 456
    }
  ]
}
```

`kind` is either `required` or `recommended`.

- Required dependencies block the normal installation flow until SIMM installs
  or resolves them, unless the user deliberately chooses a clearly labeled
  bypass.
- Recommended dependencies are shown with an optional install action.
- When a declared Thunderstore or Nexus source is valid and SIMM can access it,
  SIMM offers to install the dependency automatically.
- SIMM verifies canonical package ID, runtime compatibility, and version
  requirement before considering a dependency satisfied.
- Thunderstore's native `dependencies` list is retained for Thunderstore's own
  ecosystem. SIMM dependency declarations add source-neutral identity, runtime,
  and alternate-provider information.

## User-Facing Information

The manifest may contain plain-text installation and post-install notes plus
support URLs. SIMM displays these in the package preview and installation
confirmation. These fields are informational only: they cannot execute code,
download arbitrary files, or alter the computed installation plan.

## Validation and Failure Behavior

SIMM treats the manifest as untrusted archive content. It validates the schema
and all archive entries before any filesystem mutation.

An invalid SIMM extension does not make an otherwise valid archive unusable by
existing installation paths. SIMM reports why enhanced installation is
unavailable and falls back to its existing archive/FOMOD behavior when that
path can safely continue. A package that starts a SIMM-managed install cannot
partially apply mappings: validation, dependency resolution, conflict review,
and base-file backup completion happen before the installation transaction.

## Explicitly Deferred

The following are outside v1:

- Author-defined option groups, conditional installers, and FOMOD-style pages.
- Executable hooks, scripts, registry changes, and writes outside the game
  installation.
- A standalone `simm-manifest.json` fallback.
- Marketplace publishing automation or account management.
- Automatic conflict policy chosen by a mod author.

## Acceptance Criteria

1. A valid Thunderstore-style archive with a valid `simm` object produces a
   deterministic preview for Mono, IL2CPP, and cross-runtime mappings.
2. A dual-runtime archive selects the current environment automatically and
   combines `cross` with exactly one runtime section.
3. File and directory mappings install only beneath the game root and reject
   traversal, missing archive entries, and unsafe links.
4. SIMM offers automatic installation for valid declared Thunderstore and Nexus
   dependencies, while preserving required and recommended behavior.
5. Base-game changes require a separate confirmation, create recoverable
   backups, and can be restored through uninstall.
6. Conflicts always require a user decision; the default guidance is one
   enabled package, with explicit overwrite precedence available as an
   alternative.
7. Existing archive, Nexus, and FOMOD flows remain usable when no valid SIMM
   extension is present.
