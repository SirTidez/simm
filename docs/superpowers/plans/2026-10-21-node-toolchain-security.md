# Node Toolchain Security Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with one fresh-context review after validation. The user authorized tooling changes and the compatibility plan together.

**Goal:** Upgrade SIMM's Node tooling security baseline while preserving dependency resolutions and proving the existing development/build paths still work.

**Architecture:** Pin Node 22 consistently across contributors, containers, and automation. Test the patched Node 24 branch in the frontend CI matrix and locally with portable runtimes. Keep application behavior and package dependencies unchanged.

**Tech Stack:** Node 22/24, Bun, TypeScript/Vite/Vitest, Rust/Tauri, PowerShell, Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-21-node-toolchain-security-design.md`

## Global constraints

- Exact baseline: `22.23.4`; supported engine range: `^22.23.4 || ^24.22.1`.
- Retain workflow Bun `1.3.5`, installed local Bun, dependency versions, `bun.lock`, app versions, and signing/updater contracts.
- Preserve the current checkout, unrelated launch-confirmation documents, and active development processes. The initial update preserves global Node; a subsequently authorized machine-wide replacement is recorded below. Leave changes uncommitted for review.
- Configuration changes use static consistency and actual runtime validation; do not add tests that merely duplicate version literals.
- Do not publish, push, install system runtimes without subsequent explicit authorization, or start/reconfigure Docker as part of this update.

## Review focus

1. Older Node 24 versions: engine constraints must exclude them even though they exceed the Node 22 floor. Check branch boundaries with SemVer.
2. Release/manual/backend jobs: every Bun job must select Node before invoking tools. Parse all workflow jobs and check step ordering.
3. Cached Linux/Flatpak images: wrapper defaults alone cannot update existing images. Document rebuild commands and inspect Docker availability.
4. Bun/Node interaction: Node-based CLI shebangs must resolve the selected portable runtime. Log resolved Node and run the full frontend sequence on both branches.
5. Native Tauri/package behavior: frontend build success does not prove a native package or game launch. Run Rust/release checks and record remaining native/Linux acceptance gates.

## Task 1: Align tooling requirements and automation

**Files:** `.nvmrc`, `package.json`, `README.md`, `docker/linux/Dockerfile`, `scripts/build-linux-container.ps1`, `scripts/build-flatpak-container.ps1`, `.github/workflows/{ci,publish-release,publish-beta-release,windows-exe}.yml`.

**Interfaces:** Produces the pinned baseline, supported SemVer range, and explicit Node selection consumed by Task 2. Existing Bun scripts and dependency lock are unchanged.

- [x] Set `.nvmrc`, Docker ARG, wrapper defaults/help to 22.23.4 and `engines.node` to `^22.23.4 || ^24.22.1`.
- [x] Add `actions/setup-node@v7` before each Bun setup. Use `node-version-file: .nvmrc` outside the frontend matrix; disable automatic package-manager caching.
- [x] Add frontend CI matrix entries 22.23.4 and 24.22.1, preserving the full existing validation sequence and both matrix results (`fail-fast: false`).
- [x] Update contributor instructions, container rebuild guidance, and link this compatibility plan.
- [x] Parse workflow YAML, inspect every Bun job's Node setup/order, compare pins, parse PowerShell scripts/help, and exercise engine acceptance/rejection boundaries. Expected: all checks pass, no old 22.12.0 pin remains in these tooling files.

## Task 2: Validate compatibility without changing the host runtime

**Files:** Validation logs/runners in ignored `target/diagnostics/node-toolchain-upgrade/`; results in this plan.

**Interfaces:** Consumes Task 1's versions/configuration and the existing lock. Produces runtime evidence and clearly bounded release gates.

- [x] Download official Windows x64 portable distributions for 22.23.4 and 24.22.1; verify each archive against its official HTTPS `SHASUMS256.txt` before extraction/execution. Expected: exact versions and matching hashes.
- [x] For each version, prepend its directory to the child process PATH and run, in order: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`. Expected: success; advisory lint warnings recorded; lock hash unchanged.
- [x] On 22.23.4 run `bun run test:release`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: success; intentionally ignored live tests remain ignored.
- [x] Start a Vite server on an unused dedicated port under 22.23.4, check served HTML and a transformed source module over HTTP, and stop only the owned process. Expected: both requests succeed without touching the active user session.
- [x] Check Docker's Linux daemon once. If available, rebuild and run `scripts/build-linux-container.cmd -Command check`; otherwise record the gate and exact later commands. Expected: a real Linux result or an explicit unverified gate.
- [x] Request one fresh-context final review of the complete uncommitted tooling diff, spec, plan, and evidence. Fix important findings in one pass and revalidate the affected path.
- [x] Finish with `git diff --check`, scope/lock verification, and a results/gates update. Expected: only the intended tooling/docs change.

## Remaining package/release gates

After local validation, require green GitHub frontend matrix and backend jobs. On a Linux Docker host run `scripts/build-linux-container.cmd -Command check`, then `scripts/build-linux-container.cmd` and `scripts/build-flatpak-container.cmd`, all without `-SkipImageBuild`. Validate the generated Linux package handlers, install/start the packages on their target systems, and complete Windows native package/startup smoke tests before a release. These are validation gates, not authorization to publish.

Keep the security floor during rollback. If one Node branch exposes an incompatibility, validate the other supported patched branch and coordinate any baseline pin changes across CI, containers, and local tooling. For future dependency upgrades, keep the Node/security update separate, upgrade one package family at a time with the lock committed alongside it, and repeat this validation matrix before advancing. Revert a failing package-family upgrade and its lock changes independently; do not restore vulnerable Node versions as a compatibility workaround.

## Execution results

Initial Windows validation used SHA-256-checked portable Node distributions with the existing Bun 1.3.14. That stage left the machine-wide runtime and running user sessions unchanged. The separately authorized machine-wide replacement is recorded below.

| Check | Node 22.23.4 | Node 24.22.1 |
| --- | --- | --- |
| Frozen dependency install / unchanged lock | Passed | Passed |
| TypeScript `tsc --noEmit` | Passed | Passed |
| ESLint | 0 errors, 27 advisory warnings | 0 errors, 27 advisory warnings |
| Frontend tests | 489 passed (43 files) | 489 passed (43 files) |
| Production frontend build | Passed | Passed |
| Release contracts and updater sanity | Passed | Baseline check only |
| Cargo check / default tests | Passed; 634 passed, 10 ignored | Baseline check only |
| Vite HTML and source transform over HTTP | Passed; owned server stopped | Baseline check only |

All four workflow files parse; all 12 Bun jobs select Node before installing or running tools. SemVer probes accepted patched 22/24 and rejected older 22/24, odd/unsupported majors, and prereleases. Both PowerShell wrappers parse and display help. `bun.lock` SHA256 remains `B8B33CBF00FEDFB915DD63D474294EE8ABC3FE07AC9A6785954B49E2245C3084`.

Docker's Linux daemon is unavailable (`dockerDesktopLinuxEngine` pipe missing), so no Linux container or Flatpak build was run. GitHub Actions with its existing Bun 1.3.5 pin and native package installation/startup remain the acceptance gates above. No package, installer, signature, updater feed, push, or publication was produced.

Detailed local logs and verification runners are retained under ignored `target/diagnostics/node-toolchain-upgrade/`. Independent review found one important documentation issue: a blanket rollback could restore vulnerable Node tooling. The rollback paragraph now keeps patched security floors and explicit Node selection while isolating later package-family rollbacks. No code/workflow defects or minor findings were reported. Final static, scope, lock, and diff checks passed; changes remain uncommitted.

## Authorized machine-wide replacement

The user subsequently requested replacing the machine-wide version. Installed Node **22.23.4 x64** with the existing nvm 1.2.2, verified its executable matches the SHA-256-checked portable executable, and activated it with `nvm use 22.23.4 64`.

Fresh PowerShell shells resolve `node` through `C:\nvm4w\nodejs\node.exe`, whose symlink now targets `C:\Users\itide\AppData\Local\nvm\v22.23.4`. Both `node --version` and `nvm current` report `v22.23.4`.

Preserved exact global packages and their command launchers: npm 11.13.0, Codex CLI 0.150.0, Playwright CLI 0.1.14, and Corepack 0.35.0. Their package engine ranges support Node 22.23.4, no native Node ABI addons were present, and copied package files were hash-checked against their originals. The new runtime's original bundled npm/Corepack and launchers are backed up under ignored diagnostics. Each preserved CLI passed its version check on the new runtime.

Repeated the full frontend sequence in a fresh shell using the machine-wide default, without a portable Node PATH override: frozen install, TypeScript, lint (0 errors, 27 advisory warnings), 489 tests, and production build all passed. The dependency lock stayed unchanged. Existing processes were not restarted, and old nvm versions remain installed for recovery; already running Node processes pick up the new runtime when restarted.
