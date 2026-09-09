# SIMM Package Manifest v1

SIMM packages use a standard Thunderstore `manifest.json` at the archive root. Every SIMM-specific instruction lives within its root `simm` object, so the archive remains compatible with Thunderstore, Nexus Mods, and local installs.

Do not add SIMM fields beside `name`, `version_number`, or other Thunderstore fields. `simm` is the single parent for every SIMM extension.

## Complete manifest

```json
{
  "name": "Example_Mod",
  "version_number": "1.2.0",
  "website_url": "https://github.com/example-author/example-mod",
  "description": "An example Schedule I mod packaged for SIMM.",
  "dependencies": [],
  "simm": {
    "format": "simm.package",
    "schema_version": 1,
    "package": {
      "id": "example-author.example-mod",
      "version": "1.2.0"
    },
    "notes": {
      "install": "Install into a supported Schedule I environment.",
      "after_install": "Configure Example Mod after launching the game once.",
      "support_url": "https://github.com/example-author/example-mod/issues"
    },
    "compatibility": {
      "schedule_i_versions": ["0.4.3f2-0.4.6", "0.4.6f6"]
    },
    "runtimes": {
      "cross": {
        "mappings": [
          {
            "kind": "directory",
            "source": "payload/UserData/ExampleMod",
            "destination": "UserData/ExampleMod"
          }
        ]
      },
      "mono": {
        "mappings": [
          {
            "kind": "file",
            "source": "payload/Mono/Plugins/ExampleMod.dll",
            "destination": "Plugins/ExampleMod.dll"
          }
        ]
      },
      "il2cpp": {
        "mappings": [
          {
            "kind": "file",
            "source": "payload/Il2Cpp/Plugins/ExampleMod.dll",
            "destination": "Plugins/ExampleMod.dll"
          }
        ]
      }
    }
  }
}
```

`package.version` must match root `version_number`. `package.id` is a stable source-neutral identifier in lowercase `publisher.package-name` form. Each segment may contain lowercase letters, digits, and hyphens.

## Archive layout

Keep `manifest.json` at the root. Mapping `source` paths are relative to that archive root.

```text
Example_Mod-1.2.0.zip
|- manifest.json
|- README.md
|- icon.png
`- payload/
   |- Mono/Plugins/ExampleMod.dll
   |- Il2Cpp/Plugins/ExampleMod.dll
   `- UserData/ExampleMod/settings.json
```

`README.md` and `icon.png` are part of the normal Thunderstore package layout. SIMM does not need them to calculate its installation plan, but authors should include them for Thunderstore releases.

## Runtimes and mappings

`simm.runtimes` may contain `cross`, `mono`, and `il2cpp` sections. SIMM installs `cross` mappings for both environments, then adds exactly the matching Mono or IL2CPP mappings. A fully cross-runtime mod only needs `cross`.

Do not declare two mappings for the same destination in sections that apply together. Each mapping copies an archive entry into the selected Schedule I game directory:

```json
{
  "kind": "file",
  "source": "payload/Mono/Plugins/ExampleMod.dll",
  "destination": "Plugins/ExampleMod.dll"
}
```

`kind` must be `file` or `directory`. `source` must exist in the archive. `destination` is game-relative and should use the canonical folder required by the game or loader, for example `Plugins`, `Mods`, `UserLibs`, `UserData`, or `MelonLoader`. SIMM normalizes separators but does not guess an intended destination or correct folder casing.

Absolute paths, drive-qualified paths, `..` traversal, and destinations outside the game directory are rejected. Scripts, registry changes, and writes to AppData or arbitrary filesystem locations are not supported.

## Base-game files and conflicts

Mappings may target a base-game file when a mod genuinely needs it. SIMM displays every affected file and backup location before applying the change, then preserves originals so uninstall can restore them.

The manifest declares destinations; it cannot grant conflict priority. When enabled packages target the same destination, SIMM asks the user to keep one enabled or explicitly choose which package takes overwrite precedence. Keep mappings narrow to minimize conflicts.

## Schedule I version compatibility

`simm.compatibility.schedule_i_versions` is optional and applies to the entire package.

| Selector | Meaning |
| --- | --- |
| `0.4.6f6` | Exactly build `0.4.6f6`. |
| `0.4.6` | Any `0.4.6` build, including `f` builds. |
| `0.4.3-0.4.6` | Every build from the `0.4.3` family through the `0.4.6` family. |
| `0.4.3f2-0.4.6` | From `0.4.3f2` through any build in the `0.4.6` family. |

Ranges are inclusive. SIMM warns when the detected game version lies outside every declared selector and reports an unverified result when it cannot determine the installed version. Omit the property when the author has not declared a restriction.

## Dependencies and publication

Do not add `simm.dependencies`. Dependencies remain provider-owned: use Thunderstore's native root `dependencies` field for Thunderstore packages, and Nexus Mods' published dependency information for Nexus uploads. SIMM can read provider metadata separately when a valid source is known.

Before publishing, validate the JSON, ensure `simm` is a root child, confirm all sources exist in the archive, and ensure every destination is below the Schedule I game directory. For Thunderstore releases, also use the [Thunderstore manifest validator](https://thunderstore.io/tools/manifest-v1-validator/).

## v1 limits

SIMM Package Manifest v1 has one deterministic installation plan per runtime. It does not support author-defined option pages, conditional installers, executable hooks, or a separate `simm-manifest.json` file.
