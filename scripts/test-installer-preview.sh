#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="${repo_root}/install.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output="$1"
  local expected="$2"
  case "$output" in
    *"$expected"*) ;;
    *) fail "expected preview output to contain: $expected" ;;
  esac
}

forbidden_dir="${fixture_root}/forbidden-bin"
forbidden_log="${fixture_root}/forbidden.log"
mkdir -p "$forbidden_dir"

for command_name in curl wget sudo apt apt-get dnf yum pacman zypper flatpak steam systemctl mktemp; do
  cat > "${forbidden_dir}/${command_name}" <<EOF
#!/usr/bin/env bash
printf '%s\n' '${command_name}' >> '${forbidden_log}'
exit 97
EOF
  chmod 0755 "${forbidden_dir}/${command_name}"
done

preview_home="${fixture_root}/home-must-not-exist"
preview_path="${forbidden_dir}:${PATH}"

run_preview() {
  HOME="$preview_home" PATH="$preview_path" \
    bash "$installer" --preview --plain --no-color --no-animation "$@"
}

fresh_output="$(run_preview --preview-scenario fresh)"
assert_contains "$fresh_output" "Visual simulation — no changes will be made"
assert_contains "$fresh_output" "Simulation        fresh"
assert_contains "$fresh_output" "Files written     0"
assert_contains "$fresh_output" "Network requests  0"
assert_contains "$fresh_output" "Dependency and change acknowledgement"
assert_contains "$fresh_output" "github.com/SteamRE/DepotDownloader"
assert_contains "$fresh_output" "Noninteractive preview: required change acknowledgement was simulated."

update_output="$(run_preview --preview-scenario update --preview-distro fedora)"
assert_contains "$update_output" "Distribution      Fedora Linux"
assert_contains "$update_output" "Package manager   DNF"
assert_contains "$update_output" "0.8.5 -> 0.8.6"
assert_contains "$update_output" "NuGet package MLVScan.DevCLI"

ready_output="$(run_preview --preview-scenario ready --preview-distro steamos)"
assert_contains "$ready_output" "Distribution      SteamOS 3"
assert_contains "$ready_output" "System type       Steam Deck / immutable"
assert_contains "$ready_output" "Everything is current"

failure_output="$(run_preview --preview-scenario dependency-failure --preview-distro ubuntu)"
assert_contains "$failure_output" "Steam              Blocked"
assert_contains "$failure_output" "stopped safely before the installation phase"
assert_contains "$failure_output" "Blocker acknowledgement was simulated"

interactive_output="$(
  printf '\n\na\n' | HOME="$preview_home" PATH="$preview_path" \
    SIMM_INSTALLER_FORCE_TUI=1 SIMM_INSTALLER_FORCE_PROMPTS=1 \
    bash "$installer" --preview --no-color --no-animation --preview-distro steamos
)"
assert_contains "$interactive_output" "Detected environment accepted for this preview."
assert_contains "$interactive_output" "Enter alone does not approve changes."
assert_contains "$interactive_output" "All listed sources, privileges, and destinations acknowledged."

details_output="$(
  printf '\nd\na\n' | HOME="$preview_home" PATH="$preview_path" \
    SIMM_INSTALLER_FORCE_TUI=1 SIMM_INSTALLER_FORCE_PROMPTS=1 \
    bash "$installer" --preview --no-color --no-animation --preview-scenario update
)"
ledger_count="$(printf '%s' "$details_output" | grep -c "Dependency and change acknowledgement")"
if [ "$ledger_count" -lt 2 ]; then
  fail "interactive details response did not render the change ledger again"
fi

set +e
cancel_output="$(
  printf 'q\n' | HOME="$preview_home" PATH="$preview_path" \
    SIMM_INSTALLER_FORCE_TUI=1 SIMM_INSTALLER_FORCE_PROMPTS=1 \
    bash "$installer" --preview --no-color --no-animation 2>&1
)"
cancel_status=$?
set -e
if [ "$cancel_status" -ne 2 ]; then
  fail "interactive cancellation returned $cancel_status instead of 2"
fi
assert_contains "$cancel_output" "Preview cancelled. No changes were made."

auto_output="$(run_preview --preview-auto-accept)"
assert_contains "$auto_output" "accepted automatically for this preview"

ascii_output="$(
  HOME="$preview_home" PATH="$preview_path" LC_ALL=C COLUMNS=52 \
    bash "$installer" --preview --plain --no-color --no-animation --preview-distro arch
)"
assert_contains "$ascii_output" "+--------------------------------------------------+"
assert_contains "$ascii_output" "Arch Linux"
non_ascii="$(printf '%s' "$ascii_output" | LC_ALL=C tr -d '\11\12\15\40-\176')"
if [ -n "$non_ascii" ]; then
  fail "ASCII fallback emitted non-ASCII terminal characters"
fi

if run_preview --preview-scenario not-a-scenario >"${fixture_root}/invalid.out" 2>&1; then
  fail "invalid preview scenario unexpectedly succeeded"
fi
assert_contains "$(<"${fixture_root}/invalid.out")" "--preview-scenario must be"

if run_preview --preview-speed 0 >"${fixture_root}/invalid-speed.out" 2>&1; then
  fail "invalid preview speed unexpectedly succeeded"
fi
assert_contains "$(<"${fixture_root}/invalid-speed.out")" "--preview-speed must be"

if [ -e "$preview_home" ]; then
  fail "preview created or modified its HOME fixture"
fi

if [ -s "$forbidden_log" ]; then
  fail "preview invoked a forbidden command: $(tr '\n' ' ' < "$forbidden_log")"
fi

if command -v timeout >/dev/null 2>&1; then
  set +e
  interrupt_output="$(
    HOME="$preview_home" PATH="$preview_path" SIMM_INSTALLER_FORCE_TUI=1 \
      timeout --signal=INT --kill-after=1s 0.35s \
      bash "$installer" --preview 2>&1
  )"
  set -e
  case "$interrupt_output" in
    *$'\033[?25h'*) ;;
    *) fail "interactive preview did not restore the cursor after interruption" ;;
  esac
fi

printf 'PASS: installer preview scenarios are zero-side-effect and render expected states.\n'
