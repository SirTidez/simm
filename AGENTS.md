# AGENTS

## Local CI Validation

When making frontend changes, run the same sequence GitHub Actions runs before pushing:

```powershell
npm install --no-audit --prefer-offline
npx tsc --noEmit
npm run test
npm run build
```

Important:

- `npm run test` and `npm run build` are not enough on their own.
- The GitHub `frontend` job fails first on `npx tsc --noEmit`, so local validation must include that exact command.
- If `tsc` fails, do not rely on Vitest or Vite build success as evidence that the frontend is CI-safe.

## Full Repo Validation

If a change also touches backend or shared frontend/backend contracts, mirror the GitHub workflow more completely:

```powershell
npm install --no-audit --prefer-offline
npx tsc --noEmit
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
