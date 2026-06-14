#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: simm-build-linux [build|check|shell|command ...]

Commands:
  build   Run Bun install, frontend validation, Linux Tauri bundle build,
          and Linux desktop MIME validation. This is the default.
  check   Run Bun install and frontend validation only.
  shell   Open an interactive shell in the prepared build container.

Environment toggles:
  SIMM_SKIP_INSTALL=1          Skip bun install.
  SIMM_SKIP_VALIDATE=1         Skip tsc, lint, tests, and frontend build.
  SIMM_SKIP_ARTIFACT_CHECK=1   Skip packaged desktop MIME validation.
  SIMM_BUN_INSTALL_ARGS=...    Extra arguments passed to bun install.
EOF
}

run_install() {
  if [[ "${SIMM_SKIP_INSTALL:-0}" == "1" ]]; then
    echo "Skipping bun install."
    return
  fi

  # shellcheck disable=SC2206
  local install_args=(${SIMM_BUN_INSTALL_ARGS:-})
  bun install "${install_args[@]}"
}

run_frontend_validation() {
  if [[ "${SIMM_SKIP_VALIDATE:-0}" == "1" ]]; then
    echo "Skipping frontend validation."
    return
  fi

  bunx tsc --noEmit
  bun run lint
  bun run test
  bun run build
}

run_linux_bundle_validation() {
  if [[ "${SIMM_SKIP_ARTIFACT_CHECK:-0}" == "1" ]]; then
    echo "Skipping Linux artifact validation."
    return
  fi

  shopt -s nullglob
  local artifacts=(
    src-tauri/target/release/bundle/deb/*.deb
    src-tauri/target/release/bundle/appimage/*.AppImage
  )
  shopt -u nullglob

  if [[ ${#artifacts[@]} -eq 0 ]]; then
    echo "No Linux bundle artifacts found to validate."
    return
  fi

  for artifact in "${artifacts[@]}"; do
    bash scripts/validate-linux-desktop-mime.sh "$artifact"
  done
}

run_build() {
  run_install
  run_frontend_validation
  bun run tauri:build:linux
  run_linux_bundle_validation
}

cd /workspace

case "${1:-build}" in
  build)
    shift || true
    run_build "$@"
    ;;
  check)
    shift || true
    run_install
    run_frontend_validation
    ;;
  shell)
    shift || true
    exec bash "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    exec "$@"
    ;;
esac
