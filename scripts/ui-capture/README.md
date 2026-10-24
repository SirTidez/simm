# UI capture

`capture.mjs` screenshots the main SIMM screens from a real, running app
instance (Tauri + WebView2 on Windows), using your own environments, mods and
accounts. It recognises the original UI (before the redesign) and the
redesigned UI and gives both the same file names, so the two folders can be
compared side by side.

It only navigates. It never launches the game, installs, updates, downloads,
deletes, or confirms anything.

## Before / after on Windows

Prerequisites: Bun, Rust/Tauri prerequisites, and a working `bun run tauri dev`
for this repository. Close any running SIMM first; the capture starts its own
instance with a local DevTools port (`src-tauri/tauri.playwright.conf.json`).

```powershell
# After: the redesign branch
git checkout feature/redesign
bun install
node scripts/ui-capture/capture.mjs --label after

# Before: the original UI in a second checkout of beta
git worktree add ..\simm-before upstream/beta   # or: origin/beta of the upstream repo
cd ..\simm-before
bun install
node ..\simm\scripts\ui-capture\capture.mjs --label before --app-dir . --out ..\simm\ui-captures
cd ..\simm
```

Both runs write to `ui-captures/<label>/<width>x<height>/NN-screen.png`
(1600x1000 and 1280x800 by default). The first start of each checkout compiles
the Rust side and can take several minutes.

Options: `--viewports 1920x1080,1600x1000`, `--only home,environment-mods`,
`--no-launch` (attach to an instance you started with `bun run tauri:playwright`),
`--keep-open`, `--cdp <url>`.

The screenshots show your real environment names, install paths and account
names. Look through them before sharing them. `ui-captures/` is git-ignored.
