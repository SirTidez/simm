#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/validate-linux-parity-smoke.sh [--providers-only|--host-only]

Runs the targeted Linux parity smoke tests that prove the main cross-platform
surfaces still work against live provider and host state.

Environment:
  SIMM_NEXUS_LIVE_ACCESS_TOKEN  Optional token for the credentialed Nexus download smoke.
  SIMM_NEXUS_LIVE_MOD_ID        Required with SIMM_NEXUS_LIVE_ACCESS_TOKEN.
  SIMM_NEXUS_LIVE_FILE_ID       Required with SIMM_NEXUS_LIVE_ACCESS_TOKEN.
  SIMM_LIVE_LAUNCH_GAME         Optional. Set to 1 to let the host smoke start Schedule I.
  SIMM_LIVE_LAUNCH_ENV_DIR      Optional Schedule I folder for custom/DepotDownloader launch proof.
  SIMM_LIVE_LAUNCH_TIMEOUT_MS   Optional MelonLoader log confirmation timeout in milliseconds.
  SIMM_MLVSCAN_LIVE_SCAN        Optional. Set to 1 to run MLVScan against a real .NET assembly.
  SIMM_MLVSCAN_LIVE_SCAN_DLL    Optional existing .NET assembly to scan instead of compiling a fixture.
  SIMM_DOTNET_ROOT              Optional .NET SDK root to prepend while running smoke tests.
  SIMM_BOOTSTRAP_LOCAL_DOTNET   Optional. Set to 1 to install .NET SDK 8 under target/simm-dotnet-sdk-8.
USAGE
}

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bootstrap_local_dotnet() {
  local install_dir=${SIMM_DOTNET_ROOT:-"$PWD/target/simm-dotnet-sdk-8"}
  local dotnet_bin="$install_dir/dotnet"

  if [[ ! -x "$dotnet_bin" ]]; then
    mkdir -p "$install_dir" "$PWD/target/simm-dotnet-install"
    local installer="$PWD/target/simm-dotnet-install/dotnet-install.sh"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$installer"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$installer" https://dot.net/v1/dotnet-install.sh
    else
      echo "SIMM_BOOTSTRAP_LOCAL_DOTNET requires curl or wget." >&2
      exit 1
    fi
    bash "$installer" --channel 8.0 --install-dir "$install_dir" --no-path
  fi

  export DOTNET_ROOT="$install_dir"
  export PATH="$install_dir:$PATH"
  echo "Using .NET SDK from $install_dir"
  dotnet --list-sdks
}

mode="all"
for arg in "$@"; do
  case "$arg" in
    --providers-only)
      mode="providers"
      ;;
    --host-only)
      mode="host"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if truthy "${SIMM_BOOTSTRAP_LOCAL_DOTNET:-}"; then
  bootstrap_local_dotnet
elif [[ -n "${SIMM_DOTNET_ROOT:-}" ]]; then
  export DOTNET_ROOT="$SIMM_DOTNET_ROOT"
  export PATH="$SIMM_DOTNET_ROOT:$PATH"
fi

run_test() {
  local test_name=$1
  echo "==> $test_name"
  cargo test --manifest-path src-tauri/Cargo.toml "$test_name" -- --ignored --nocapture
}

if [[ "$mode" == "all" || "$mode" == "providers" ]]; then
  run_test "services::thunderstore::tests::live_search_fetch_and_download_package_archive"
  run_test "services::nexus_mods::tests::live_schedule_i_metadata_query_returns_files"
  run_test "services::nexus_mods::tests::live_oauth_downloads_configured_schedule_i_file"
fi

if [[ "$mode" == "all" || "$mode" == "host" ]]; then
  run_test "services::steam::tests::live_detects_schedule_i_installation_branch_and_launch_options_status"
  run_test "services::melon_loader::tests::live_linux_requirements_status_reads_steam_and_protontricks"
  run_test "services::melon_loader::tests::live_linux_launches_schedule_i_and_confirms_melonloader_log"
  run_test "commands::depotdownloader::linux_tests::live_linux_installer_downloads_release_and_detects_temp_home_binary"
  run_test "services::security_scanner::tests::live_linux_install_latest_uses_dotnet_tool_or_private_sdk"
  run_test "services::security_scanner::tests::live_linux_scan_executes_against_real_dotnet_assembly"
fi
