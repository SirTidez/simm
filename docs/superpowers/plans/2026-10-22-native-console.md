# Native console integration plan

1. Add typed console preferences/snapshots and a backend session service. Persist preferences in app_meta and collect active profile plus installed mod/plugin details through existing services.
2. Port the proven Windows docking algorithm into independent SIMM controller/guard modes with exact process identity, restoration handshake, process/window-loss recovery and bounded shutdown. Keep unsupported platforms explicit.
3. Add thin Tauri commands, window capability, launch follow-up and application shutdown recovery. Preserve launch dispatch and Steam options.
4. Add themed Console route/sidebar, configurable sections and width, nonmodal wait/retry states, manual Open Console and confirmed Close Game.
5. Run contract/UI/recovery tests, required local CI sequence, disposable then live Steam/Tauri validation, screenshots and cleanup. Record remaining acceptance precisely.
