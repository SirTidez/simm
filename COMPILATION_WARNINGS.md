# Compilation Warnings (cargo check)

Command used:
```
cd src-tauri && cargo check
```

Warnings observed:

1) unexpected `cfg` condition value: `unix` in `src-tauri/src/services/mods.rs`
- `#[cfg(target_os = "unix")]` at lines 134, 153, 178
- Expected values for `target_os` do not include `unix`. Use `#[cfg(unix)]` or remove if Windows-only.

2) unused import: `std::os::windows::process::CommandExt`
- `src-tauri/src/services/depot_downloader.rs:4`
- `src-tauri/src/services/auth.rs:62`
- `src-tauri/src/services/melon_loader.rs:70`
- `src-tauri/src/services/mods.rs:306`
- `src-tauri/src/services/game_version.rs:343`
- `src-tauri/src/services/game_version.rs:430`

3) dead code (never used)
- `src-tauri/src/commands/app_init.rs`: `mark_welcome_message_seen`
- `src-tauri/src/services/depot_downloader.rs`: `get_active_downloads`
- `src-tauri/src/services/environment.rs`: `get_environment_size`, `calculate_size`, `calculate_size_impl`
- `src-tauri/src/services/auth.rs`: `check_authentication_status`
- `src-tauri/src/services/mods.rs`: `resolve_symlink`
- `src-tauri/src/services/plugins.rs`: `install_dll_plugin`
- `src-tauri/src/services/fomod.rs`: `FomodType`, `extract_fomod_files`
- `src-tauri/src/services/nexus_mods.rs`: `get_validation_result`
- `src-tauri/src/services/filesystem_watcher.rs`: `stop_all`
- `src-tauri/src/services/logger.rs`: `log_backend`, `log_game_version`, `log_update_check`, `log_melon_loader`, `log_websocket`
- `src-tauri/src/types.rs`: `AuthState`, `AuthMethod`
- `src-tauri/src/utils/validation.rs`: `sanitize_string`, `validate_platform`
- `src-tauri/src/utils/depot_downloader_detector.rs`: `verify_depot_downloader`
- `src-tauri/src/utils/directory_init.rs`: `get_mods_storage_dir`

Notes:
- `cargo check` output also reported frontend build steps run by the build script (no errors).
