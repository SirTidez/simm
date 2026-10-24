# Node toolchain security update

The Node security releases published on October 21, 2026 fix vulnerabilities affecting the Node versions currently allowed by SIMM's tooling configuration. Node runs build and development tools; SIMM's installed desktop application uses Rust/Tauri and the system WebView.

Use Node **22.23.4** as the exact build baseline. Allow patched Node 24 through the branch-aware engine range **`^22.23.4 || ^24.22.1`**. A single lower bound would still admit vulnerable Node 24 versions. Keep `.nvmrc`, Docker, PowerShell wrapper defaults, CI/release jobs, and contributor instructions aligned.

Every workflow job that installs Bun must first select Node explicitly. Baseline jobs read `.nvmrc`; the frontend CI job tests both 22.23.4 and 24.22.1. Use `actions/setup-node@v7` with automatic package-manager caching disabled; retain the existing Bun 1.3.5 workflow pin. The action's own runtime is managed by GitHub, separately from the selected project Node runtime.

Preserve `bun.lock`, dependency versions, app version, Rust/Tauri contracts, signing, updater behavior, and existing user work. The initial repository update leaves the machine-wide Node installation and running development session alone. Use official, SHA-256-checked portable Windows distributions to validate both Node branches with the same installed Bun.

Follow-up authorization on October 21: the user explicitly requested replacing the machine-wide Node version. Install/select the pinned 22.23.4 x64 runtime through the existing nvm installation, preserve the exact existing global CLI versions, and verify fresh-shell resolution plus the frontend sequence. Leave existing processes running and retain old installations for recovery.

Acceptance requires the full frontend sequence on both Node branches, existing release contract checks, Rust checks on the pinned baseline, a bounded Vite development-server smoke test, and static workflow/wrapper checks. Record unsupported host checks honestly: GitHub-hosted Linux CI, rebuilt Docker/Flatpak images, native packaging, and affected-user/game acceptance are separate gates. Rebuild container images without `-SkipImageBuild` to apply the new default.

If compatibility fails, stop the affected validation stage and retain logs. Correct the incompatibility or use the other patched supported branch; do not lower the security floor or change dependency resolutions as an incidental workaround.

Source: [Node October 2026 security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [setup-node documentation](https://github.com/actions/setup-node).
