#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT

home_dir="$fixture_root/home"
desktop_dir="$home_dir/.local/share/applications"
config_dir="$home_dir/.config"
mkdir -p "$desktop_dir" "$config_dir" "$home_dir/.local/opt/simm"
printf 'old appimage' > "$home_dir/.local/opt/simm/SIMM.AppImage"
printf 'desktop entry' > "$desktop_dir/simm.desktop"
cat > "$config_dir/mimeapps.list" <<'EOF'
[Default Applications]
x-scheme-handler/simm=simm.desktop;other.desktop;
x-scheme-handler/nxm=simm.desktop;
[Added Associations]
x-scheme-handler/simm=simm.desktop;other.desktop;
EOF

HOME="$home_dir" XDG_CONFIG_HOME="$config_dir" bash "$repo_root/install.sh" --uninstall

if [[ -e "$home_dir/.local/opt/simm/SIMM.AppImage" ]]; then
  echo 'FAIL: uninstall did not remove the managed AppImage' >&2
  exit 1
fi
if grep -Fq 'simm.desktop' "$config_dir/mimeapps.list"; then
  echo 'FAIL: uninstall left the deleted SIMM desktop ID in mimeapps.list' >&2
  exit 1
fi
if ! grep -Fq 'other.desktop' "$config_dir/mimeapps.list"; then
  echo 'FAIL: uninstall removed another handler while cleaning SIMM associations' >&2
  exit 1
fi

if grep -Fq 'xdg-mime default ""' "$repo_root/install.sh"; then
  echo 'FAIL: installer still passes an unsupported empty desktop ID to xdg-mime' >&2
  exit 1
fi
if ! grep -Fq 'mv -f "$staged_path" "$APPIMAGE_PATH"' "$repo_root/install.sh"; then
  echo 'FAIL: installer does not atomically rename the staged AppImage' >&2
  exit 1
fi

printf 'PASS: AppImage uninstall cleans only SIMM MIME associations and replacement is staged.\n'
