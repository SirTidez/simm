# SIMM Command-Line Interface

SIMM accepts command-line requests for querying and launching configured Schedule I environments. Running the executable without arguments continues to open the normal desktop application. `simm://` and `nxm://` arguments also remain desktop/deep-link requests rather than CLI commands.

The examples below use `simm` as the installed command name. During development, use the platform's built `simmrust` executable.

## Commands

```text
simm game list
simm game list --json

simm game info schedule1 --profile "Beta"
simm game info schedule1 --profile "Beta" --json

simm game path schedule1 --profile "Beta"
simm game path schedule1 --profile "Beta" --json

simm launch schedule1 --profile "Beta"
simm launch schedule1 --profile "Beta" --launch-method steam_restart
```

An environment ID or exact environment name can be used in place of `schedule1`. Branch names are accepted only when they resolve to one environment. When a selector is ambiguous, SIMM returns an error containing the matching environment names and IDs instead of choosing an installation implicitly.

Supported launch methods are:

- `steam`: launch the normal Steam installation or a SIMM-managed Steam shortcut.
- `steam_restart`: prepare a custom-install shortcut and restart Steam when required.
- `direct`: launch the environment executable directly. This is unavailable on Linux because Schedule I runs through Steam Proton there.

Omitting the launch method uses the same platform-aware default as the desktop application: Steam for Steam environments and Linux, direct launch for other Windows environments.

## Structured output and exit codes

`--json` returns stable JSON field names for automation. JSON data is written to standard output. Errors are written to standard error and use this shape when `--json` is active:

```json
{
  "ok": false,
  "error": {
    "code": "command-failed",
    "message": "..."
  }
}
```

Exit codes:

- `0`: command completed successfully.
- `1`: SIMM could not complete the requested operation.
- `2`: the command or its arguments were invalid.

The `game info` response includes the environment identity, installation and Mods paths, validity, persisted status, branch, runtime, recorded game and MelonLoader versions, environment type, and current running state.

## Safety and architecture

CLI queries read SIMM's existing SQLite environment records through `EnvironmentService`. Launch requests use the existing environment reconciliation, settings, and `FileSystemService` launch behavior. The CLI does not maintain a separate environment configuration and does not expose stored provider credentials.

On Windows, the packaged desktop executable uses the GUI subsystem to avoid opening a console during normal use. Explicit CLI requests attach to the calling console for output. Linux uses its ordinary process streams. Installer-level command aliases and packaged-terminal behavior still require release artifact validation before the feature is considered fully shipped.
