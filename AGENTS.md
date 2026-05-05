# AGENTS

## Local CI Validation

When making frontend changes, run the same sequence GitHub Actions runs before pushing:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
```

Important:

- `bun run test` and `bun run build` are not enough on their own.
- The GitHub `frontend` job fails first on `tsc --noEmit`, so local validation must include that command.
- `bun run lint` currently starts as an advisory check: warnings do not block the command and are not a mandate for broad React churn.
- Treat `react-hooks/rules-of-hooks` as correctness work. Treat `react-hooks/exhaustive-deps`, Fast Refresh, and IPC/event-boundary warnings as review prompts unless the fix is small, local, and behavior-preserving.
- If `tsc` fails, do not rely on Vitest or Vite build success as evidence that the frontend is CI-safe.

## Full Repo Validation

If a change also touches backend or shared frontend/backend contracts, mirror the GitHub workflow more completely:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
