# Runtime Library Playbook

## Mental Model

SIMM uses a library-first model:

- Shared storage holds reusable mod, plugin, and UserLib assets.
- Environment folders get lightweight installs, usually through symlinks.
- Metadata exists at storage and environment projection points.
- Runtime compatibility is explicit: IL2CPP, Mono, or genuinely runtime-agnostic.

## Change Checklist

- Trace create, install, uninstall, enable, disable, delete, and refresh paths separately.
- Confirm which metadata file or DB row the UI actually reads after the action.
- Keep storage metadata authoritative for shared library views.
- Keep environment metadata accurate for installed environment views.
- Emit `mods_changed`, `plugins_changed`, or `userlibs_changed` after filesystem-visible mutations.
- Extend update summaries and compatibility badges when source or runtime metadata changes.

## Common Failure Shapes

- UI badges are fixed but persisted metadata remains stale.
- Runtime is inferred from filenames when explicit metadata should be available.
- Unknown runtime silently defaults and creates misleading compatibility state.
- Deleting shared storage leaves stale environment links or metadata.
- A watcher refresh masks a service bug until a cold app start.

## Tests To Prefer

- Runtime detection and unknown-runtime prompt behavior.
- Storage metadata persistence after import/download.
- Environment projection after install/uninstall.
- Update summary behavior for each supported source type.
- Event-driven refresh behavior when a filesystem-visible mutation occurs.
