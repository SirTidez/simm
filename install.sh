#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="SirTidez"
REPO_NAME="simm"
APP_NAME="SIMM"
APP_DESCRIPTION="Schedule I Mod Manager"
APPIMAGE_DIR="${HOME}/.local/opt/simm"
APPIMAGE_PATH="${APPIMAGE_DIR}/SIMM.AppImage"
BIN_DIR="${HOME}/.local/bin"
BIN_LINK="${BIN_DIR}/simm"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${DESKTOP_DIR}/simm.desktop"

CHANNEL="stable"
VERSION=""
FORCE_FORMAT=""
DRY_RUN=0
UNINSTALL=0

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

usage() {
  cat <<'USAGE'
Install SIMM on Linux.

Usage:
  ./install.sh [options]

Options:
  --channel stable|beta  Release channel to install from when --version is not set.
  --version <tag>        Install a specific GitHub release tag, for example v0.8.6.
  --deb                  Prefer the Debian package. Fails on non-Debian systems.
  --appimage             Install the AppImage user-local package.
  --dry-run              Print what would happen without installing.
  --uninstall            Remove a user-local AppImage install and desktop handlers.
  -h, --help             Show this help.

The installer verifies SHA256SUMS from the GitHub release before installing.
It does not install Steam, Protontricks, DepotDownloader, or .NET runtime tools.
SIMM checks and guides those runtime dependencies inside the app.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      [ "$#" -ge 2 ] || die "--channel requires a value"
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || die "--version requires a release tag"
      VERSION="$2"
      shift 2
      ;;
    --deb)
      FORCE_FORMAT="deb"
      shift
      ;;
    --appimage)
      FORCE_FORMAT="appimage"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$CHANNEL" in
  stable|beta) ;;
  *) die "--channel must be 'stable' or 'beta'" ;;
esac

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

detect_distro_family() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    local ids="${ID:-} ${ID_LIKE:-}"
    case " $ids " in
      *" debian "*|*" ubuntu "*) printf 'debian'; return ;;
      *" fedora "*|*" rhel "*|*" centos "*|*" suse "*|*" opensuse "*) printf 'rpm'; return ;;
      *" arch "*) printf 'arch'; return ;;
    esac
  fi

  printf 'unknown'
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x86_64' ;;
    *) die "unsupported architecture: $(uname -m). SIMM Linux releases currently support x86_64." ;;
  esac
}

uninstall_appimage() {
  log "Removing user-local SIMM AppImage install."
  run rm -f "$BIN_LINK"
  run rm -f "$DESKTOP_FILE"
  run rm -f "$APPIMAGE_PATH"

  if command -v xdg-mime >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    xdg-mime default "" x-scheme-handler/simm >/dev/null 2>&1 || true
    xdg-mime default "" x-scheme-handler/nxm >/dev/null 2>&1 || true
  fi

  if command -v update-desktop-database >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi

  log "User-local AppImage files removed. Native package installs should be removed with your package manager."
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall_appimage
  exit 0
fi

require_command curl
require_command python3
require_command sha256sum
require_command mktemp

detect_arch >/dev/null
DISTRO_FAMILY="$(detect_distro_family)"

choose_format() {
  if [ -n "$FORCE_FORMAT" ]; then
    if [ "$FORCE_FORMAT" = "deb" ] && [ "$DISTRO_FAMILY" != "debian" ]; then
      die "--deb was requested, but this does not look like a Debian-family distro"
    fi
    printf '%s' "$FORCE_FORMAT"
    return
  fi

  case "$DISTRO_FAMILY" in
    debian) printf 'deb' ;;
    *) printf 'appimage' ;;
  esac
}

FORMAT="$(choose_format)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

api_url_for_release() {
  if [ -n "$VERSION" ]; then
    printf 'https://api.github.com/repos/%s/%s/releases/tags/%s' "$REPO_OWNER" "$REPO_NAME" "$VERSION"
  elif [ "$CHANNEL" = "beta" ]; then
    printf 'https://api.github.com/repos/%s/%s/releases' "$REPO_OWNER" "$REPO_NAME"
  else
    printf 'https://api.github.com/repos/%s/%s/releases/latest' "$REPO_OWNER" "$REPO_NAME"
  fi
}

RELEASE_JSON="${TMP_DIR}/release.json"
API_URL="$(api_url_for_release)"
log "Resolving SIMM release metadata from ${API_URL}"
curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "$API_URL" \
  -o "$RELEASE_JSON"

read_release_field() {
  python3 - "$RELEASE_JSON" "$1" <<'PY'
import json
import sys

path, field = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

if isinstance(data, list):
    data = next((item for item in data if item.get("prerelease") and not item.get("draft")), None)
    if data is None:
        raise SystemExit("no beta release found")

value = data.get(field)
if value is None:
    raise SystemExit(f"missing field: {field}")
print(value)
PY
}

find_asset() {
  python3 - "$RELEASE_JSON" "$1" <<'PY'
import json
import re
import sys

path, kind = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

if isinstance(data, list):
    data = next((item for item in data if item.get("prerelease") and not item.get("draft")), None)
    if data is None:
        raise SystemExit("no beta release found")

assets = data.get("assets") or []
patterns = {
    "deb": re.compile(r"^SIMM_.+_amd64\.deb$"),
    "appimage": re.compile(r"^SIMM_.+_x86_64\.AppImage$"),
    "checksums": re.compile(r"^SHA256SUMS$"),
}
pattern = patterns[kind]

for asset in assets:
    name = asset.get("name") or ""
    if pattern.match(name):
        print(name)
        print(asset.get("browser_download_url") or "")
        raise SystemExit(0)

raise SystemExit(f"release does not contain required asset kind: {kind}")
PY
}

RELEASE_TAG="$(read_release_field tag_name)"
ASSET_INFO="$(find_asset "$FORMAT")"
ASSET_NAME="$(printf '%s\n' "$ASSET_INFO" | sed -n '1p')"
ASSET_URL="$(printf '%s\n' "$ASSET_INFO" | sed -n '2p')"
CHECKSUM_INFO="$(find_asset checksums)"
CHECKSUM_URL="$(printf '%s\n' "$CHECKSUM_INFO" | sed -n '2p')"

[ -n "$ASSET_URL" ] || die "release asset URL was empty"
[ -n "$CHECKSUM_URL" ] || die "checksum asset URL was empty"

ASSET_PATH="${TMP_DIR}/${ASSET_NAME}"
CHECKSUM_PATH="${TMP_DIR}/SHA256SUMS"

log "Selected ${ASSET_NAME} from ${RELEASE_TAG}"
curl -fL "$ASSET_URL" -o "$ASSET_PATH"
curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_PATH"

if ! grep -F "  ${ASSET_NAME}" "$CHECKSUM_PATH" >/dev/null 2>&1; then
  die "SHA256SUMS does not contain ${ASSET_NAME}"
fi

(
  cd "$TMP_DIR"
  grep -F "  ${ASSET_NAME}" SHA256SUMS | sha256sum -c -
)

install_deb() {
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing Debian package with apt."
    run_as_root apt-get install -y "$ASSET_PATH"
  elif command -v apt >/dev/null 2>&1; then
    log "Installing Debian package with apt."
    run_as_root apt install -y "$ASSET_PATH"
  elif command -v dpkg >/dev/null 2>&1; then
    log "Installing Debian package with dpkg."
    run_as_root dpkg -i "$ASSET_PATH"
  else
    die "no supported Debian package installer found"
  fi
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    run "$@"
  else
    require_command sudo
    run sudo "$@"
  fi
}

write_appimage_desktop_entry() {
  run mkdir -p "$DESKTOP_DIR"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] write ${DESKTOP_FILE}"
    return
  fi

  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME} - ${APP_DESCRIPTION}
Comment=${APP_DESCRIPTION}
Exec=${APPIMAGE_PATH} %u
Icon=simm
Terminal=false
Categories=Game;Utility;
MimeType=x-scheme-handler/simm;x-scheme-handler/nxm;
StartupNotify=true
EOF
}

install_appimage() {
  log "Installing AppImage user-local package."
  run mkdir -p "$APPIMAGE_DIR" "$BIN_DIR"
  run cp "$ASSET_PATH" "$APPIMAGE_PATH"
  run chmod 0755 "$APPIMAGE_PATH"
  run ln -sfn "$APPIMAGE_PATH" "$BIN_LINK"
  write_appimage_desktop_entry

  if command -v update-desktop-database >/dev/null 2>&1; then
    run update-desktop-database "$DESKTOP_DIR"
  fi

  if command -v xdg-mime >/dev/null 2>&1; then
    run xdg-mime default "$(basename "$DESKTOP_FILE")" x-scheme-handler/simm
    run xdg-mime default "$(basename "$DESKTOP_FILE")" x-scheme-handler/nxm
  fi
}

case "$FORMAT" in
  deb) install_deb ;;
  appimage) install_appimage ;;
  *) die "unsupported format: $FORMAT" ;;
esac

log ""
log "SIMM ${RELEASE_TAG} install step completed."
if [ "$FORMAT" = "appimage" ]; then
  log "Installed AppImage: ${APPIMAGE_PATH}"
  log "Command link: ${BIN_LINK}"
  log "Desktop entry: ${DESKTOP_FILE}"
fi

log ""
log "Runtime dependency note:"
log "  SIMM does not install Steam, Protontricks, DepotDownloader, or .NET runtime tools from this script."
log "  Open SIMM Settings on Linux to check readiness and repair desktop/protocol handlers."
