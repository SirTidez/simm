#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="SirTidez"
REPO_NAME="simm"
APP_NAME="SIMM"
APP_DESCRIPTION="Schedule I Mod Manager"
APPIMAGE_DIR="${HOME}/.local/opt/simm"
APPIMAGE_PATH="${APPIMAGE_DIR}/SIMM.AppImage"
LAUNCHER_PATH="${APPIMAGE_DIR}/simm-launch"
BIN_DIR="${HOME}/.local/bin"
BIN_LINK="${BIN_DIR}/simm"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${DESKTOP_DIR}/simm.desktop"
ICON_DIR="${HOME}/.local/share/icons/hicolor/128x128/apps"
ICON_PATH="${ICON_DIR}/simm.png"
STEAM_SHORTCUT_NAME="Schedule I Mod Manager"

CHANNEL="stable"
VERSION=""
FORCE_FORMAT=""
DRY_RUN=0
UNINSTALL=0
LOCAL_APPIMAGE=""
SKIP_STEAM_SHORTCUT=0
REPAIR_STEAM_SHORTCUT=0
INSTALL_DEPENDENCIES=1
ASSUME_YES=0
PREVIEW=0
PREVIEW_SCENARIO="fresh"
PREVIEW_DISTRO=""
PREVIEW_SPEED=1
PREVIEW_AUTO_ACCEPT=0
NO_ANIMATION=0
NO_COLOR_MODE=0
PLAIN_OUTPUT=0

TUI_ACTIVE=0
TUI_UNICODE=0
TUI_WIDTH=78
TUI_CURSOR_HIDDEN=0
TUI_RESET=""
TUI_BOLD=""
TUI_DIM=""
TUI_CYAN=""
TUI_BLUE=""
TUI_GREEN=""
TUI_YELLOW=""
TUI_RED=""
TUI_MAGENTA=""
TUI_BORDER=""
TUI_H="-"
TUI_V="|"
TUI_TL="+"
TUI_TR="+"
TUI_BL="+"
TUI_BR="+"
TUI_LJ="+"
TUI_RJ="+"
TUI_SEPARATOR="-"

PREVIEW_DISTRO_NAME="Linux"
PREVIEW_DISTRO_FAMILY="unknown"
PREVIEW_PACKAGE_MANAGER="Not detected"
PREVIEW_SYSTEM_TYPE="Standard Linux"
PREVIEW_ARCH="unknown"
PREVIEW_PACKAGE_FORMAT="AppImage"
PREVIEW_PACKAGE_SOURCE="No supported package repository detected"

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

repeat_character() {
  local character="$1"
  local count="$2"
  local output=""
  local index
  for ((index = 0; index < count; index++)); do
    output+="$character"
  done
  printf '%s' "$output"
}

fit_text() {
  local text="$1"
  local width="$2"
  if [ "${#text}" -le "$width" ]; then
    printf '%s' "$text"
  elif [ "$width" -gt 3 ]; then
    printf '%s...' "${text:0:$((width - 3))}"
  else
    printf '%s' "${text:0:$width}"
  fi
}

preview_delay() {
  local milliseconds="$1"
  if [ "$NO_ANIMATION" -eq 1 ]; then
    return
  fi

  local adjusted=$((milliseconds / PREVIEW_SPEED))
  if [ "$adjusted" -lt 1 ]; then
    adjusted=1
  fi

  local duration
  printf -v duration '%d.%03d' "$((adjusted / 1000))" "$((adjusted % 1000))"
  sleep "$duration"
}

tui_restore_terminal() {
  if [ "$TUI_CURSOR_HIDDEN" -eq 1 ]; then
    printf '\033[?25h'
    TUI_CURSOR_HIDDEN=0
  fi
  printf '%b' "$TUI_RESET"
}

tui_hide_cursor() {
  if [ "$TUI_ACTIVE" -eq 1 ] && [ "$TUI_CURSOR_HIDDEN" -eq 0 ]; then
    printf '\033[?25l'
    TUI_CURSOR_HIDDEN=1
  fi
}

tui_show_cursor() {
  if [ "$TUI_CURSOR_HIDDEN" -eq 1 ]; then
    printf '\033[?25h'
    TUI_CURSOR_HIDDEN=0
  fi
}

tui_initialize() {
  if [ "$PLAIN_OUTPUT" -eq 0 ] \
      && { [ -t 1 ] || [ "${SIMM_INSTALLER_FORCE_TUI:-0}" = "1" ]; }; then
    TUI_ACTIVE=1
  fi

  local locale_name="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  case "$locale_name" in
    *UTF-8*|*utf8*|*UTF8*) TUI_UNICODE=1 ;;
  esac

  local columns="${COLUMNS:-80}"
  if [ "$TUI_ACTIVE" -eq 1 ] && command -v tput >/dev/null 2>&1; then
    columns="$(tput cols 2>/dev/null || printf '80')"
  fi
  case "$columns" in
    ''|*[!0-9]*) columns=80 ;;
  esac
  if [ "$columns" -lt 68 ]; then
    TUI_WIDTH="$columns"
  elif [ "$columns" -gt 90 ]; then
    TUI_WIDTH=88
  else
    TUI_WIDTH=$((columns - 2))
  fi
  if [ "$TUI_WIDTH" -lt 48 ]; then
    TUI_WIDTH=48
  fi

  if [ "$TUI_UNICODE" -eq 1 ]; then
    TUI_H="─"
    TUI_V="│"
    TUI_TL="╭"
    TUI_TR="╮"
    TUI_BL="╰"
    TUI_BR="╯"
    TUI_LJ="├"
    TUI_RJ="┤"
    TUI_SEPARATOR="—"
  fi

  if [ "$NO_COLOR_MODE" -eq 0 ] && [ -z "${NO_COLOR:-}" ] && [ "$TUI_ACTIVE" -eq 1 ]; then
    TUI_RESET=$'\033[0m'
    TUI_BOLD=$'\033[1m'
    TUI_DIM=$'\033[2m'
    TUI_CYAN=$'\033[38;5;51m'
    TUI_BLUE=$'\033[38;5;75m'
    TUI_GREEN=$'\033[38;5;84m'
    TUI_YELLOW=$'\033[38;5;220m'
    TUI_RED=$'\033[38;5;203m'
    TUI_MAGENTA=$'\033[38;5;213m'
    TUI_BORDER=$'\033[38;5;67m'
  fi
}

tui_border_line() {
  local left="$1"
  local right="$2"
  printf '%b%s' "$TUI_BORDER" "$left"
  repeat_character "$TUI_H" $((TUI_WIDTH - 2))
  printf '%s%b\n' "$right" "$TUI_RESET"
}

tui_card_start() {
  local title="$1"
  tui_border_line "$TUI_TL" "$TUI_TR"
  local title_text="  $title"
  printf '%b%s%b%-*s%b%s%b\n' \
    "$TUI_BORDER" "$TUI_V" "$TUI_BOLD$TUI_CYAN" \
    $((TUI_WIDTH - 2)) "$(fit_text "$title_text" $((TUI_WIDTH - 2)))" \
    "$TUI_BORDER" "$TUI_V" "$TUI_RESET"
  tui_border_line "$TUI_LJ" "$TUI_RJ"
}

tui_card_end() {
  tui_border_line "$TUI_BL" "$TUI_BR"
}

tui_card_text() {
  local text="$1"
  local content="  $(fit_text "$text" $((TUI_WIDTH - 6)))"
  printf '%b%s%b %-*s %b%s%b\n' \
    "$TUI_BORDER" "$TUI_V" "$TUI_RESET" \
    $((TUI_WIDTH - 4)) "$content" \
    "$TUI_BORDER" "$TUI_V" "$TUI_RESET"
}

tui_key_value() {
  local key="$1"
  local value="$2"
  local available=$((TUI_WIDTH - 25))
  if [ "$available" -lt 16 ]; then
    available=16
  fi
  value="$(fit_text "$value" "$available")"
  printf '%b%s%b  %b%-17s%b %-*s %b%s%b\n' \
    "$TUI_BORDER" "$TUI_V" "$TUI_DIM" "$TUI_BLUE" "$key" "$TUI_RESET" \
    $((TUI_WIDTH - 23)) "$value" \
    "$TUI_BORDER" "$TUI_V" "$TUI_RESET"
}

tui_heading() {
  local title="$1"
  printf '\n%b%s%b\n' "$TUI_BOLD$TUI_CYAN" "$title" "$TUI_RESET"
  printf '%b' "$TUI_BORDER"
  repeat_character "$TUI_H" "$TUI_WIDTH"
  printf '%b\n' "$TUI_RESET"
}

tui_status_color() {
  case "$1" in
    Ready|Complete|Current) printf '%s' "$TUI_GREEN" ;;
    Install|Update|Configure|Repair|Prepare) printf '%s' "$TUI_YELLOW" ;;
    Blocked|Failed) printf '%s' "$TUI_RED" ;;
    *) printf '%s' "$TUI_BLUE" ;;
  esac
}

tui_status_row() {
  local component="$1"
  local status="$2"
  local detail="$3"
  local detail_width=$((TUI_WIDTH - 34))
  if [ "$detail_width" -lt 12 ]; then
    detail_width=12
  fi
  local color
  color="$(tui_status_color "$status")"
  printf '  %-18s %b%-10s%b %s\n' \
    "$(fit_text "$component" 18)" "$color" "$status" "$TUI_RESET" \
    "$(fit_text "$detail" "$detail_width")"
}

tui_notice() {
  local tone="$1"
  local text="$2"
  local color="$TUI_BLUE"
  local marker="i"
  case "$tone" in
    success) color="$TUI_GREEN"; marker="✓" ;;
    warning) color="$TUI_YELLOW"; marker="!" ;;
    error) color="$TUI_RED"; marker="x" ;;
  esac
  if [ "$TUI_UNICODE" -eq 0 ] && [ "$marker" = "✓" ]; then
    marker="OK"
  fi
  printf '  %b[%s]%b %s\n' "$color$TUI_BOLD" "$marker" "$TUI_RESET" "$text"
}

tui_spinner() {
  local label="$1"
  local frame_count="${2:-8}"
  if [ "$TUI_ACTIVE" -eq 0 ] || [ "$NO_ANIMATION" -eq 1 ]; then
    printf '  [..] %s\n' "$label"
    return
  fi

  local frames_ascii=('|' '/' '-' '\\')
  local frames_unicode=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local index frame
  tui_hide_cursor
  for ((index = 0; index < frame_count; index++)); do
    if [ "$TUI_UNICODE" -eq 1 ]; then
      frame="${frames_unicode[$((index % ${#frames_unicode[@]}))]}"
    else
      frame="${frames_ascii[$((index % ${#frames_ascii[@]}))]}"
    fi
    printf '\r\033[2K  %b%s%b %s' "$TUI_CYAN" "$frame" "$TUI_RESET" "$label"
    preview_delay 160
  done
  printf '\r\033[2K'
  tui_notice success "$label"
}

tui_progress() {
  local label="$1"
  local width=28
  local percent filled empty
  local empty_character="."
  if [ "$TUI_UNICODE" -eq 1 ]; then
    empty_character="·"
  fi
  if [ "$TUI_ACTIVE" -eq 0 ] || [ "$NO_ANIMATION" -eq 1 ]; then
    printf '  [##] %s %s 100%%\n' "$label" "$TUI_SEPARATOR"
    return
  fi

  tui_hide_cursor
  for percent in 0 12 28 47 68 84 100; do
    filled=$((percent * width / 100))
    empty=$((width - filled))
    printf '\r\033[2K  %b%-28s%b [' "$TUI_BLUE" "$(fit_text "$label" 28)" "$TUI_RESET"
    printf '%b' "$TUI_CYAN"
    repeat_character "#" "$filled"
    printf '%b' "$TUI_DIM"
    repeat_character "$empty_character" "$empty"
    printf '%b] %3d%%' "$TUI_RESET" "$percent"
    preview_delay 220
  done
  printf '\r\033[2K'
  tui_notice success "$label"
}

preview_read_os_release() {
  local detected_id=""
  local detected_like=""
  local detected_pretty=""
  local key value
  if [ -r /etc/os-release ]; then
    while IFS='=' read -r key value; do
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      case "$key" in
        ID) detected_id="$value" ;;
        ID_LIKE) detected_like="$value" ;;
        PRETTY_NAME) detected_pretty="$value" ;;
      esac
    done < /etc/os-release
  fi

  PREVIEW_DISTRO_NAME="${detected_pretty:-Linux}"
  local identities=" $detected_id $detected_like "
  case "$identities" in
    *" ubuntu "*|*" debian "*) PREVIEW_DISTRO_FAMILY="debian" ;;
    *" fedora "*|*" rhel "*|*" centos "*) PREVIEW_DISTRO_FAMILY="fedora" ;;
    *" arch "*) PREVIEW_DISTRO_FAMILY="arch" ;;
    *" suse "*|*" opensuse "*) PREVIEW_DISTRO_FAMILY="suse" ;;
    *) PREVIEW_DISTRO_FAMILY="unknown" ;;
  esac
}

preview_apply_distro_profile() {
  case "$1" in
    ubuntu)
      PREVIEW_DISTRO_NAME="Ubuntu 24.04 LTS"
      PREVIEW_DISTRO_FAMILY="debian"
      PREVIEW_PACKAGE_MANAGER="APT"
      PREVIEW_PACKAGE_FORMAT="DEB"
      PREVIEW_PACKAGE_SOURCE="Ubuntu official repositories"
      ;;
    debian)
      PREVIEW_DISTRO_NAME="Debian 12"
      PREVIEW_DISTRO_FAMILY="debian"
      PREVIEW_PACKAGE_MANAGER="APT"
      PREVIEW_PACKAGE_FORMAT="DEB"
      PREVIEW_PACKAGE_SOURCE="Debian official repositories"
      ;;
    fedora)
      PREVIEW_DISTRO_NAME="Fedora Linux"
      PREVIEW_DISTRO_FAMILY="fedora"
      PREVIEW_PACKAGE_MANAGER="DNF"
      PREVIEW_PACKAGE_FORMAT="AppImage"
      PREVIEW_PACKAGE_SOURCE="Fedora enabled repositories"
      ;;
    arch)
      PREVIEW_DISTRO_NAME="Arch Linux"
      PREVIEW_DISTRO_FAMILY="arch"
      PREVIEW_PACKAGE_MANAGER="Pacman"
      PREVIEW_PACKAGE_FORMAT="AppImage"
      PREVIEW_PACKAGE_SOURCE="Arch enabled repositories"
      ;;
    opensuse)
      PREVIEW_DISTRO_NAME="openSUSE"
      PREVIEW_DISTRO_FAMILY="suse"
      PREVIEW_PACKAGE_MANAGER="Zypper"
      PREVIEW_PACKAGE_FORMAT="AppImage"
      PREVIEW_PACKAGE_SOURCE="openSUSE enabled repositories"
      ;;
    steamos)
      PREVIEW_DISTRO_NAME="SteamOS 3"
      PREVIEW_DISTRO_FAMILY="arch"
      PREVIEW_PACKAGE_MANAGER="Flatpak + user-local"
      PREVIEW_SYSTEM_TYPE="Steam Deck / immutable"
      PREVIEW_PACKAGE_FORMAT="AppImage"
      PREVIEW_PACKAGE_SOURCE="Flathub and approved upstream releases"
      ;;
    bazzite)
      PREVIEW_DISTRO_NAME="Bazzite"
      PREVIEW_DISTRO_FAMILY="fedora"
      PREVIEW_PACKAGE_MANAGER="Flatpak + user-local"
      PREVIEW_SYSTEM_TYPE="OSTree immutable"
      PREVIEW_PACKAGE_FORMAT="AppImage"
      PREVIEW_PACKAGE_SOURCE="Flathub and approved upstream releases"
      ;;
    *) die "--preview-distro must be ubuntu, debian, fedora, arch, opensuse, steamos, or bazzite" ;;
  esac
}

preview_detect_host() {
  PREVIEW_ARCH="$(uname -m 2>/dev/null || printf 'unknown')"
  preview_read_os_release

  if [ -n "$PREVIEW_DISTRO" ]; then
    preview_apply_distro_profile "$PREVIEW_DISTRO"
  else
    case "$PREVIEW_DISTRO_FAMILY" in
      debian)
        PREVIEW_PACKAGE_MANAGER="APT"
        PREVIEW_PACKAGE_FORMAT="DEB"
        PREVIEW_PACKAGE_SOURCE="Enabled Debian-family repositories"
        ;;
      fedora)
        PREVIEW_PACKAGE_MANAGER="DNF"
        PREVIEW_PACKAGE_SOURCE="Enabled Fedora-family repositories"
        ;;
      arch)
        PREVIEW_PACKAGE_MANAGER="Pacman"
        PREVIEW_PACKAGE_SOURCE="Enabled Arch-family repositories"
        ;;
      suse)
        PREVIEW_PACKAGE_MANAGER="Zypper"
        PREVIEW_PACKAGE_SOURCE="Enabled openSUSE repositories"
        ;;
    esac
  fi

  if [ -z "$PREVIEW_DISTRO" ]; then
    local kernel_release
    kernel_release="$(uname -r 2>/dev/null || true)"
    case "$kernel_release" in
      *[Mm]icrosoft*|*[Ww][Ss][Ll]*) PREVIEW_SYSTEM_TYPE="WSL2 preview host" ;;
    esac
  fi

  if [ -n "$FORCE_FORMAT" ]; then
    case "$FORCE_FORMAT" in
      deb) PREVIEW_PACKAGE_FORMAT="DEB" ;;
      appimage) PREVIEW_PACKAGE_FORMAT="AppImage" ;;
    esac
  fi
}

preview_render_banner() {
  printf '\n%b' "$TUI_MAGENTA$TUI_BOLD"
  if [ "$TUI_UNICODE" -eq 1 ]; then
    printf '   ███████╗██╗███╗   ███╗███╗   ███╗\n'
    printf '   ██╔════╝██║████╗ ████║████╗ ████║\n'
    printf '   ███████╗██║██╔████╔██║██╔████╔██║\n'
    printf '   ╚════██║██║██║╚██╔╝██║██║╚██╔╝██║\n'
    printf '   ███████║██║██║ ╚═╝ ██║██║ ╚═╝ ██║\n'
    printf '   ╚══════╝╚═╝╚═╝     ╚═╝╚═╝     ╚═╝\n'
  else
    printf '    _____  _____ __  __ __  __\n'
    printf '   / ____||_   _|  \/  |  \/  |\n'
    printf '   | (___   | | | \  / | \  / |\n'
    printf '    \___ \  | | | |\/| | |\/| |\n'
    printf '    ____) |_| |_| |  | | |  | |\n'
    printf '   |_____/|_____|_|  |_|_|  |_|\n'
  fi
  printf '%b' "$TUI_RESET"
  printf '   %bSchedule I Mod Manager%b  %bInstaller preview%b\n' \
    "$TUI_BOLD$TUI_CYAN" "$TUI_RESET" "$TUI_DIM" "$TUI_RESET"
  printf '   %bVisual simulation %s no changes will be made%b\n\n' \
    "$TUI_YELLOW" "$TUI_SEPARATOR" "$TUI_RESET"
}

preview_render_system_cards() {
  tui_card_start "Detected environment"
  tui_key_value "Distribution" "$PREVIEW_DISTRO_NAME"
  tui_key_value "Distro family" "$PREVIEW_DISTRO_FAMILY"
  tui_key_value "Package manager" "$PREVIEW_PACKAGE_MANAGER"
  tui_key_value "System type" "$PREVIEW_SYSTEM_TYPE"
  tui_key_value "Architecture" "$PREVIEW_ARCH"
  tui_key_value "SIMM format" "$PREVIEW_PACKAGE_FORMAT"
  tui_card_end

  printf '\n'
  tui_card_start "Approved sources"
  tui_key_value "Distro packages" "$PREVIEW_PACKAGE_SOURCE"
  tui_key_value "SIMM releases" "github.com/${REPO_OWNER}/${REPO_NAME}"
  tui_key_value "Release channel" "${VERSION:-$CHANNEL}"
  tui_key_value "Managed tools" "Flathub, dot.net, NuGet, allowlisted GitHub"
  tui_card_end
}

preview_prompts_active() {
  [ "$PLAIN_OUTPUT" -eq 0 ] \
    && { { [ -t 0 ] && [ -t 1 ]; } || [ "${SIMM_INSTALLER_FORCE_PROMPTS:-0}" = "1" ]; }
}

preview_prompt_environment() {
  tui_show_cursor
  if [ "$PREVIEW_AUTO_ACCEPT" -eq 1 ]; then
    tui_notice success "Environment review accepted automatically for this preview."
    return
  fi
  if ! preview_prompts_active; then
    tui_notice warning "Noninteractive preview: environment review was simulated."
    return
  fi

  local response
  while true; do
    printf '\n  %b[Enter]%b Continue with this strategy   %b[q]%b Cancel preview\n  > ' \
      "$TUI_BOLD$TUI_CYAN" "$TUI_RESET" "$TUI_BOLD$TUI_YELLOW" "$TUI_RESET"
    if ! IFS= read -r response; then
      printf '\n'
      tui_notice warning "Preview cancelled because no response was received."
      exit 2
    fi
    case "$response" in
      ""|c|C) tui_notice success "Detected environment accepted for this preview."; return ;;
      q|Q) tui_notice warning "Preview cancelled. No changes were made."; exit 2 ;;
      *) tui_notice warning "Press Enter to continue or q to cancel." ;;
    esac
  done
}

preview_action_card() {
  local component="$1"
  local action="$2"
  local source="$3"
  local privilege="$4"
  local destination="$5"
  tui_card_start "$component - $action"
  tui_key_value "Approved source" "$source"
  tui_key_value "Privilege scope" "$privilege"
  tui_key_value "Install location" "$destination"
  tui_card_end
  printf '\n'
}

preview_render_change_ledger() {
  local proton_source proton_privilege proton_destination
  local simm_privilege simm_destination
  case "$PREVIEW_SYSTEM_TYPE" in
    *immutable*)
      proton_source="Flathub: com.github.Matoking.protontricks"
      proton_privilege="Current user only (flatpak --user)"
      proton_destination="~/.local/share/flatpak"
      ;;
    *)
      proton_source="${PREVIEW_PACKAGE_SOURCE} (${PREVIEW_PACKAGE_MANAGER})"
      proton_privilege="Package-manager sudo"
      proton_destination="Distro-managed system package paths"
      ;;
  esac
  if [ "$PREVIEW_PACKAGE_FORMAT" = "DEB" ]; then
    simm_privilege="Package-manager sudo (DEB)"
    simm_destination="Distro-managed system package paths"
  else
    simm_privilege="Current user only (AppImage)"
    simm_destination="~/.local/opt/simm and ~/.local/bin/simm"
  fi

  tui_heading "Dependency and change acknowledgement"
  tui_notice warning "Review every source, privilege boundary, and destination below."
  printf '\n'
  case "$PREVIEW_SCENARIO" in
    fresh)
      preview_action_card "Protontricks" "Install" "$proton_source" "$proton_privilege" "$proton_destination"
      preview_action_card "DepotDownloader" "Install" "github.com/SteamRE/DepotDownloader" "Current user only" "~/.local/bin/DepotDownloader"
      preview_action_card ".NET SDK 8" "Install" "https://dot.net/v1/dotnet-install.sh" "Current user only" "~/SIMM/tools/mlvscan-security-scanner/dotnet-sdk-8"
      preview_action_card "MLVScan" "Install" "NuGet package MLVScan.DevCLI" "Current user only" "~/SIMM/tools/mlvscan-security-scanner/dotnet-tool"
      preview_action_card "SIMM" "Install" "github.com/${REPO_OWNER}/${REPO_NAME}" "$simm_privilege" "$simm_destination"
      preview_action_card "Desktop handlers" "Configure" "Generated locally by SIMM installer" "Current user only" "~/.local/share/applications/simm.desktop"
      preview_action_card "Schedule I verbs" "Prepare" "Protontricks upstream verbs" "Current user / Proton prefix" "Steam compatdata prefix for AppID 3164500"
      ;;
    update)
      preview_action_card "DepotDownloader" "Update" "github.com/SteamRE/DepotDownloader" "Current user only" "~/.local/bin/DepotDownloader"
      preview_action_card "MLVScan" "Update" "NuGet package MLVScan.DevCLI" "Current user only" "~/SIMM/tools/mlvscan-security-scanner/dotnet-tool"
      preview_action_card "SIMM" "Update" "github.com/${REPO_OWNER}/${REPO_NAME}" "$simm_privilege" "$simm_destination"
      preview_action_card "Desktop handlers" "Repair" "Generated locally by SIMM installer" "Current user only" "~/.local/share/applications/simm.desktop"
      ;;
  esac
  tui_notice warning "The real installer would request sudo only for the disclosed package-manager actions."
}

preview_prompt_change_acknowledgement() {
  case "$PREVIEW_SCENARIO" in
    fresh|update) ;;
    *) return ;;
  esac

  tui_show_cursor
  if [ "$PREVIEW_AUTO_ACCEPT" -eq 1 ]; then
    tui_notice success "Required change acknowledgement accepted automatically for this preview."
    return
  fi
  if ! preview_prompts_active; then
    tui_notice warning "Noninteractive preview: required change acknowledgement was simulated."
    return
  fi

  local response
  while true; do
    printf '\n  Type %ba%b to acknowledge all listed changes and continue.\n' "$TUI_BOLD$TUI_CYAN" "$TUI_RESET"
    printf '  %b[d]%b Show the full ledger again   %b[q]%b Cancel preview\n  > ' \
      "$TUI_BOLD$TUI_BLUE" "$TUI_RESET" "$TUI_BOLD$TUI_YELLOW" "$TUI_RESET"
    if ! IFS= read -r response; then
      printf '\n'
      tui_notice warning "Preview cancelled because acknowledgement was not received."
      exit 2
    fi
    case "$response" in
      a|A) tui_notice success "All listed sources, privileges, and destinations acknowledged."; return ;;
      d|D) printf '\n'; preview_render_change_ledger ;;
      q|Q) tui_notice warning "Preview cancelled before simulated execution. No changes were made."; exit 2 ;;
      "") tui_notice warning "Acknowledgement is required; Enter alone does not approve changes." ;;
      *) tui_notice warning "Type a to acknowledge, d for details, or q to cancel." ;;
    esac
  done
}

preview_render_blocker_response() {
  if [ "$PREVIEW_SCENARIO" != "dependency-failure" ]; then
    return 0
  fi
  tui_show_cursor
  tui_heading "Dependency blocker"
  preview_action_card "Steam" "Blocked" "$PREVIEW_PACKAGE_SOURCE" "Not requested" "No installation destination selected"
  tui_notice error "Nothing can be approved until Steam has an approved package candidate."
  if [ "$PREVIEW_AUTO_ACCEPT" -eq 1 ] || ! preview_prompts_active; then
    tui_notice warning "Blocker acknowledgement was simulated; execution will remain stopped."
    return
  fi

  local response
  while true; do
    printf '\n  %b[Enter]%b Acknowledge blocker and show safe stop   %b[q]%b Cancel preview\n  > ' \
      "$TUI_BOLD$TUI_CYAN" "$TUI_RESET" "$TUI_BOLD$TUI_YELLOW" "$TUI_RESET"
    if ! IFS= read -r response; then
      printf '\n'
      tui_notice warning "Preview cancelled because no response was received."
      exit 2
    fi
    case "$response" in
      "") tui_notice success "Dependency blocker acknowledged."; return ;;
      q|Q) tui_notice warning "Preview cancelled. No changes were made."; exit 2 ;;
      *) tui_notice warning "Press Enter to acknowledge the blocker or q to cancel." ;;
    esac
  done
}

preview_render_dependency_table() {
  tui_heading "Readiness scan"
  case "$PREVIEW_SCENARIO" in
    fresh)
      tui_status_row "System tools" "Ready" "curl, Python, xdg-utils"
      tui_status_row "Steam" "Ready" "Native installation detected"
      tui_status_row "Protontricks" "Install" "Approved platform source"
      tui_status_row "DepotDownloader" "Install" "SteamRE GitHub release"
      tui_status_row ".NET SDK" "Install" "Private SDK 8"
      tui_status_row "MLVScan" "Install" "Managed NuGet tool"
      tui_status_row "SIMM" "Install" "Latest $CHANNEL release"
      tui_status_row "Desktop links" "Configure" "simm:// and nxm://"
      tui_status_row "Schedule I" "Prepare" "Proton prefix detected"
      ;;
    update)
      tui_status_row "System tools" "Current" "No package changes"
      tui_status_row "Steam" "Ready" "Native installation detected"
      tui_status_row "Protontricks" "Current" "Already supported"
      tui_status_row "DepotDownloader" "Update" "New upstream release"
      tui_status_row ".NET SDK" "Ready" "SDK 8 detected"
      tui_status_row "MLVScan" "Update" "New NuGet tool version"
      tui_status_row "SIMM" "Update" "0.8.5 -> 0.8.6"
      tui_status_row "Desktop links" "Repair" "nxm:// handler is stale"
      tui_status_row "Schedule I" "Ready" "Proton verbs installed"
      ;;
    ready)
      tui_status_row "System tools" "Ready" "All prerequisites available"
      tui_status_row "Steam" "Ready" "Native installation detected"
      tui_status_row "Protontricks" "Ready" "Supported version"
      tui_status_row "DepotDownloader" "Ready" "Latest release"
      tui_status_row ".NET SDK" "Ready" "SDK 8 detected"
      tui_status_row "MLVScan" "Ready" "Latest managed tool"
      tui_status_row "SIMM" "Current" "Latest $CHANNEL release"
      tui_status_row "Desktop links" "Ready" "Both handlers registered"
      tui_status_row "Schedule I" "Ready" "Proton prefix prepared"
      ;;
    dependency-failure)
      tui_status_row "System tools" "Ready" "Core tools detected"
      tui_status_row "Steam" "Blocked" "No approved package candidate"
      tui_status_row "Protontricks" "Blocked" "Steam is required first"
      tui_status_row "DepotDownloader" "Install" "SteamRE GitHub release"
      tui_status_row ".NET SDK" "Install" "Private SDK 8"
      tui_status_row "MLVScan" "Install" "Managed NuGet tool"
      tui_status_row "SIMM" "Install" "Latest $CHANNEL release"
      tui_status_row "Desktop links" "Configure" "simm:// and nxm://"
      tui_status_row "Schedule I" "Blocked" "Steam installation unavailable"
      ;;
  esac
}

preview_render_plan() {
  tui_heading "Installation plan"
  if [ "$PREVIEW_SCENARIO" = "ready" ]; then
    tui_notice success "Everything is current. The real installer would make no changes."
  elif [ "$PREVIEW_SCENARIO" = "dependency-failure" ]; then
    tui_notice error "The real installer would stop before changing the system."
    tui_notice warning "Steam needs an explicitly approved distro source."
  else
    tui_notice warning "System package operations would be shown before sudo approval."
    tui_notice success "User-local tools and SIMM would remain owned by the current user."
    tui_notice success "Existing files would be verified before any update is replaced."
  fi
  printf '\n'
  tui_card_start "Safety boundary"
  tui_key_value "Network" "Disabled in preview"
  tui_key_value "Filesystem writes" "None"
  tui_key_value "sudo" "Not invoked"
  tui_key_value "Steam processes" "Not touched"
  tui_key_value "Simulation" "$PREVIEW_SCENARIO"
  tui_card_end
}

preview_render_execution() {
  tui_heading "Simulated execution"
  case "$PREVIEW_SCENARIO" in
    ready)
      tui_spinner "Verifying installed versions" 7
      tui_spinner "Checking desktop and Steam integration" 7
      tui_notice success "No installation or update actions are needed."
      ;;
    dependency-failure)
      tui_spinner "Resolving approved package candidates" 8
      tui_notice error "Steam has no approved candidate in the enabled repositories."
      tui_notice warning "Simulation stopped safely before the installation phase."
      ;;
    fresh)
      tui_spinner "Preparing scoped package-manager transaction" 8
      tui_progress "Installing Protontricks"
      tui_progress "Installing DepotDownloader"
      tui_progress "Installing private .NET SDK 8"
      tui_progress "Installing MLVScan"
      tui_progress "Downloading and verifying SIMM"
      tui_spinner "Configuring desktop and Steam integration" 9
      tui_spinner "Preparing the Schedule I Proton prefix" 9
      ;;
    update)
      tui_spinner "Comparing installed and available versions" 8
      tui_progress "Updating DepotDownloader"
      tui_progress "Updating MLVScan"
      tui_progress "Downloading and verifying SIMM 0.8.6"
      tui_spinner "Replacing SIMM atomically with rollback ready" 9
      tui_spinner "Repairing desktop and Steam integration" 9
      ;;
  esac
}

preview_render_summary() {
  tui_heading "Preview summary"
  if [ "$PREVIEW_SCENARIO" = "dependency-failure" ]; then
    tui_notice warning "Flow preview completed with a simulated dependency block."
  else
    tui_notice success "Flow preview completed successfully."
  fi
  printf '\n'
  tui_card_start "Zero-side-effect guarantee"
  tui_key_value "Commands executed" "0 installation commands"
  tui_key_value "Files written" "0"
  tui_key_value "Network requests" "0"
  tui_key_value "Privilege prompts" "0"
  tui_key_value "Next step" "Review the visual flow before wiring real actions"
  tui_card_end
  printf '\n%bPreview only. Re-run without --preview only when real installer work is approved.%b\n' \
    "$TUI_DIM" "$TUI_RESET"
}

run_preview() {
  case "$PREVIEW_SCENARIO" in
    fresh|update|ready|dependency-failure) ;;
    *) die "--preview-scenario must be fresh, update, ready, or dependency-failure" ;;
  esac
  case "$PREVIEW_SPEED" in
    ''|*[!0-9]*) die "--preview-speed must be a whole number from 1 to 20" ;;
  esac
  if [ "$PREVIEW_SPEED" -lt 1 ] || [ "$PREVIEW_SPEED" -gt 20 ]; then
    die "--preview-speed must be a whole number from 1 to 20"
  fi

  tui_initialize
  trap tui_restore_terminal EXIT
  trap 'tui_restore_terminal; exit 130' INT TERM
  preview_detect_host
  preview_render_banner
  tui_spinner "Detecting distribution and installer strategy" 8
  preview_render_system_cards
  preview_prompt_environment
  tui_spinner "Building a dependency readiness plan" 8
  preview_render_dependency_table
  preview_render_plan
  if [ "$PREVIEW_SCENARIO" = "fresh" ] || [ "$PREVIEW_SCENARIO" = "update" ]; then
    preview_render_change_ledger
    preview_prompt_change_acknowledgement
  else
    preview_render_blocker_response
  fi
  preview_render_execution
  preview_render_summary
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
  --appimage-file <path> Install a local AppImage instead of downloading a release.
  --skip-steam-shortcut  Do not add SIMM to Steam when running on a Steam Deck.
  --repair-steam-shortcut
                         Repair the installed SIMM Steam shortcut without reinstalling SIMM.
  --skip-dependencies    Install SIMM without checking or installing runtime tools.
  -y, --yes              Accept the displayed dependency plan non-interactively.
  --preview              Show the animated installer flow without making changes.
  --preview-scenario <s> Preview fresh, update, ready, or dependency-failure.
  --preview-distro <d>   Preview ubuntu, debian, fedora, arch, opensuse, steamos, or bazzite.
  --preview-speed <1-20> Increase the preview animation speed. Defaults to 1.
  --preview-auto-accept  Auto-accept preview prompts for scripted demonstrations.
  --no-animation         Render the preview without animation delays.
  --no-color             Disable ANSI colors.
  --plain                Use log-friendly output instead of the interactive renderer.
  --dry-run              Print what would happen without installing.
  --uninstall            Remove a user-local AppImage install and desktop handlers.
  -h, --help             Show this help.

The installer verifies SHA256SUMS from the GitHub release before installing.
It detects required Linux tools, shows their approved sources and destinations,
asks for acknowledgement, then installs and verifies anything missing.
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
    --appimage-file)
      [ "$#" -ge 2 ] || die "--appimage-file requires a path"
      LOCAL_APPIMAGE="$2"
      FORCE_FORMAT="appimage"
      shift 2
      ;;
    --skip-steam-shortcut)
      SKIP_STEAM_SHORTCUT=1
      shift
      ;;
    --repair-steam-shortcut)
      REPAIR_STEAM_SHORTCUT=1
      shift
      ;;
    --skip-dependencies)
      INSTALL_DEPENDENCIES=0
      shift
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    --preview)
      PREVIEW=1
      shift
      ;;
    --preview-scenario)
      [ "$#" -ge 2 ] || die "--preview-scenario requires a value"
      PREVIEW=1
      PREVIEW_SCENARIO="$2"
      shift 2
      ;;
    --preview-distro)
      [ "$#" -ge 2 ] || die "--preview-distro requires a value"
      PREVIEW=1
      PREVIEW_DISTRO="$2"
      shift 2
      ;;
    --preview-speed)
      [ "$#" -ge 2 ] || die "--preview-speed requires a value"
      PREVIEW=1
      PREVIEW_SPEED="$2"
      shift 2
      ;;
    --preview-auto-accept)
      PREVIEW=1
      PREVIEW_AUTO_ACCEPT=1
      shift
      ;;
    --no-animation)
      NO_ANIMATION=1
      shift
      ;;
    --no-color)
      NO_COLOR_MODE=1
      shift
      ;;
    --plain)
      PLAIN_OUTPUT=1
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

if [ "$PREVIEW" -eq 1 ]; then
  run_preview
  exit 0
fi

if [ "$REPAIR_STEAM_SHORTCUT" -eq 1 ] && [ "$SKIP_STEAM_SHORTCUT" -eq 1 ]; then
  die "--repair-steam-shortcut cannot be combined with --skip-steam-shortcut"
fi

if [ "$REPAIR_STEAM_SHORTCUT" -eq 1 ] && [ "$UNINSTALL" -eq 1 ]; then
  die "--repair-steam-shortcut cannot be combined with --uninstall"
fi

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
  remove_appimage_mime_defaults
  run rm -f "$BIN_LINK"
  run rm -f "$DESKTOP_FILE"
  run rm -f "$ICON_PATH"
  run rm -f "$LAUNCHER_PATH"
  run rm -f "$APPIMAGE_PATH"

  if command -v update-desktop-database >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi

  log "User-local AppImage files removed. Native package installs should be removed with your package manager."
}

remove_appimage_mime_defaults() {
  # xdg-mime has no supported "clear default" operation: passing an empty
  # desktop ID is rejected and leaves a deleted handler selected. Remove only
  # our own desktop ID from user-scoped mimeapps files, preserving any other
  # handlers and never touching system-wide associations.
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] remove SIMM desktop MIME associations"
    return
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    log "warning: python3 is unavailable; skipped cleanup of SIMM MIME defaults. Remove simm.desktop from your user mimeapps.list manually."
    return
  fi

  python3 - "$(basename "$DESKTOP_FILE")" <<'PY'
import os
import sys
from pathlib import Path

desktop_id = sys.argv[1]
home = Path.home()
config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
data_home = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
candidates = [
    config_home / "mimeapps.list",
    config_home / "applications" / "mimeapps.list",
    data_home / "applications" / "mimeapps.list",
]

for path in candidates:
    if not path.is_file():
        continue

    original = path.read_text(encoding="utf-8")
    section = ""
    changed = False
    output = []
    for line in original.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1]
        if section in {"Default Applications", "Added Associations"} and "=" in line:
            key, value = line.split("=", 1)
            if key.strip() in {"x-scheme-handler/simm", "x-scheme-handler/nxm"}:
                entries = [entry for entry in value.strip().split(";") if entry and entry != desktop_id]
                replacement = f"{key}={';'.join(entries)};\n" if entries else ""
                if replacement != line:
                    changed = True
                    line = replacement
        output.append(line)

    if changed:
        temporary = path.with_name(f".{path.name}.simm-uninstall.tmp")
        temporary.write_text("".join(output), encoding="utf-8")
        os.replace(temporary, path)
PY
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall_appimage
  exit 0
fi

require_command python3
if [ "$REPAIR_STEAM_SHORTCUT" -eq 0 ]; then
  require_command sha256sum
  require_command mktemp

  if [ -z "$LOCAL_APPIMAGE" ]; then
    require_command curl
  fi

  detect_arch >/dev/null
  DISTRO_FAMILY="$(detect_distro_family)"
else
  DISTRO_FAMILY="unknown"
fi

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

if [ "$REPAIR_STEAM_SHORTCUT" -eq 0 ]; then
  FORMAT="$(choose_format)"
  TMP_DIR="$(mktemp -d)"
else
  FORMAT="appimage"
  TMP_DIR=""
fi
cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
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

if [ "$REPAIR_STEAM_SHORTCUT" -eq 0 ] && [ -n "$LOCAL_APPIMAGE" ]; then
  [ -f "$LOCAL_APPIMAGE" ] || die "local AppImage was not found: ${LOCAL_APPIMAGE}"
  [ "$FORMAT" = "appimage" ] || die "--appimage-file can only be used with the AppImage installer"
  ASSET_PATH="$(cd "$(dirname "$LOCAL_APPIMAGE")" && pwd)/$(basename "$LOCAL_APPIMAGE")"
  ASSET_NAME="$(basename "$ASSET_PATH")"
  RELEASE_TAG="local package"
  CHECKSUM_PATH="$(dirname "$ASSET_PATH")/SHA256SUMS"

  if [ -f "$CHECKSUM_PATH" ]; then
    if ! grep -F "  ${ASSET_NAME}" "$CHECKSUM_PATH" >/dev/null 2>&1; then
      die "SHA256SUMS does not contain ${ASSET_NAME}"
    fi
    (
      cd "$(dirname "$CHECKSUM_PATH")"
      grep -F "  ${ASSET_NAME}" SHA256SUMS | sha256sum -c -
    )
  else
    die "local AppImage installs require SHA256SUMS next to the AppImage"
  fi
elif [ "$REPAIR_STEAM_SHORTCUT" -eq 0 ]; then
  RELEASE_JSON="${TMP_DIR}/release.json"
  API_URL="$(api_url_for_release)"
  log "Resolving SIMM release metadata from ${API_URL}"
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$API_URL" \
    -o "$RELEASE_JSON"
fi

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

if [ "$REPAIR_STEAM_SHORTCUT" -eq 0 ] && [ -z "$LOCAL_APPIMAGE" ]; then
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
fi

DEPENDENCY_PROTONTRICKS_NEEDED=0
DEPENDENCY_DEPOT_NEEDED=0
DEPENDENCY_DOTNET_NEEDED=0
DEPENDENCY_MLVSCAN_NEEDED=0
PROTONTRICKS_INSTALL_STRATEGY=""
MANAGED_DOTNET_DIR="${HOME}/SIMM/tools/mlvscan-security-scanner/dotnet-sdk-8"
MLVSCAN_TOOL_DIR="${HOME}/SIMM/tools/mlvscan-security-scanner/dotnet-tool"
DEPOTDOWNLOADER_PATH="${HOME}/.local/bin/DepotDownloader"

dotnet_has_sdk_8() {
  local dotnet_program="$1"
  [ -x "$dotnet_program" ] || command -v "$dotnet_program" >/dev/null 2>&1 || return 1

  local version major
  while read -r version _; do
    major="${version%%.*}"
    case "$major" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$major" -ge 8 ]; then
      return 0
    fi
  done < <("$dotnet_program" --list-sdks 2>/dev/null || true)
  return 1
}

protontricks_available() {
  if command -v protontricks >/dev/null 2>&1 && protontricks --version >/dev/null 2>&1; then
    return 0
  fi
  command -v flatpak >/dev/null 2>&1 \
    && flatpak info com.github.Matoking.protontricks >/dev/null 2>&1
}

depot_downloader_available() {
  command -v DepotDownloader >/dev/null 2>&1 \
    || command -v depotdownloader >/dev/null 2>&1 \
    || [ -x "$DEPOTDOWNLOADER_PATH" ]
}

mlvscan_available() {
  local scanner="${MLVSCAN_TOOL_DIR}/mlvscan"
  [ -x "$scanner" ] || return 1

  if [ -x "${MANAGED_DOTNET_DIR}/dotnet" ]; then
    DOTNET_ROOT="$MANAGED_DOTNET_DIR" \
      PATH="${MANAGED_DOTNET_DIR}:${PATH}" \
      DOTNET_CLI_TELEMETRY_OPTOUT=1 \
      "$scanner" info --format json >/dev/null 2>&1
  else
    "$scanner" info --format json >/dev/null 2>&1
  fi
}

select_protontricks_strategy() {
  if command -v flatpak >/dev/null 2>&1; then
    PROTONTRICKS_INSTALL_STRATEGY="flatpak"
    return 0
  fi

  if is_steam_deck; then
    return 1
  fi

  case "$DISTRO_FAMILY" in
    debian)
      if command -v apt-get >/dev/null 2>&1 \
          && command -v apt-cache >/dev/null 2>&1 \
          && apt-cache show protontricks >/dev/null 2>&1; then
        PROTONTRICKS_INSTALL_STRATEGY="apt"
        return 0
      fi
      ;;
    rpm)
      if command -v dnf >/dev/null 2>&1; then
        PROTONTRICKS_INSTALL_STRATEGY="dnf"
        return 0
      fi
      ;;
    arch)
      if command -v pacman >/dev/null 2>&1; then
        PROTONTRICKS_INSTALL_STRATEGY="pacman"
        return 0
      fi
      ;;
  esac
  return 1
}

protontricks_source_description() {
  case "$PROTONTRICKS_INSTALL_STRATEGY" in
    flatpak) printf 'Flathub app com.github.Matoking.protontricks (user-local)' ;;
    apt) printf 'enabled Debian/Ubuntu APT repositories (sudo)' ;;
    dnf) printf 'enabled Fedora/RPM DNF repositories (sudo)' ;;
    pacman) printf 'enabled Arch repositories via pacman (sudo)' ;;
    *) printf 'no supported approved source detected' ;;
  esac
}

scan_required_dependencies() {
  DEPENDENCY_PROTONTRICKS_NEEDED=0
  DEPENDENCY_DEPOT_NEEDED=0
  DEPENDENCY_DOTNET_NEEDED=0
  DEPENDENCY_MLVSCAN_NEEDED=0

  if ! command -v steam >/dev/null 2>&1 && ! find_steam_root >/dev/null 2>&1; then
    die "Steam was not detected. Install and sign in to Steam before installing SIMM's Schedule I tooling"
  fi

  if ! protontricks_available; then
    DEPENDENCY_PROTONTRICKS_NEEDED=1
    select_protontricks_strategy \
      || die "Protontricks is missing, but no supported package source was detected. On SteamOS, ensure Flatpak is installed and Flathub is available"
  fi

  if ! depot_downloader_available; then
    DEPENDENCY_DEPOT_NEEDED=1
  fi

  if command -v dotnet >/dev/null 2>&1 && dotnet_has_sdk_8 dotnet; then
    :
  elif dotnet_has_sdk_8 "${MANAGED_DOTNET_DIR}/dotnet"; then
    :
  else
    DEPENDENCY_DOTNET_NEEDED=1
  fi

  if ! mlvscan_available; then
    DEPENDENCY_MLVSCAN_NEEDED=1
  fi
}

dependency_changes_needed() {
  [ "$DEPENDENCY_PROTONTRICKS_NEEDED" -eq 1 ] \
    || [ "$DEPENDENCY_DEPOT_NEEDED" -eq 1 ] \
    || [ "$DEPENDENCY_DOTNET_NEEDED" -eq 1 ] \
    || [ "$DEPENDENCY_MLVSCAN_NEEDED" -eq 1 ]
}

show_dependency_plan() {
  log ""
  log "SIMM dependency readiness"
  log "-------------------------"
  log "  Steam             Ready (existing signed-in installation)"

  if [ "$DEPENDENCY_PROTONTRICKS_NEEDED" -eq 1 ]; then
    log "  Protontricks      Install"
    log "    Source:      $(protontricks_source_description)"
    log "    Destination: managed by the selected package source"
    log "    Purpose:     installs Schedule I Proton prerequisites when SIMM needs them"
  else
    log "  Protontricks      Ready"
  fi

  if [ "$DEPENDENCY_DEPOT_NEEDED" -eq 1 ]; then
    log "  DepotDownloader   Install"
    log "    Source:      SteamRE/DepotDownloader official GitHub release"
    log "    Destination: ${DEPOTDOWNLOADER_PATH}"
    log "    Purpose:     managed Schedule I branch and depot downloads"
  else
    log "  DepotDownloader   Ready"
  fi

  if [ "$DEPENDENCY_DOTNET_NEEDED" -eq 1 ]; then
    log "  .NET SDK 8        Install"
    log "    Source:      Microsoft dotnet-install.sh from https://dot.net"
    log "    Destination: ${MANAGED_DOTNET_DIR}"
    log "    Purpose:     private runtime for the MLVScan security scanner"
  else
    log "  .NET SDK 8        Ready"
  fi

  if [ "$DEPENDENCY_MLVSCAN_NEEDED" -eq 1 ]; then
    log "  MLVScan           Install"
    log "    Source:      MLVScan.DevCLI from the public NuGet package registry"
    log "    Destination: ${MLVSCAN_TOOL_DIR}"
    log "    Purpose:     scans downloaded mod assemblies before library import"
  else
    log "  MLVScan           Ready"
  fi
}

confirm_dependency_plan() {
  if ! dependency_changes_needed; then
    log "All required Linux dependencies are already ready."
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] dependency changes shown above would require acknowledgement"
    return 0
  fi

  if [ "$ASSUME_YES" -eq 1 ]; then
    log "Dependency plan accepted by --yes."
    return 0
  fi

  if [ ! -t 0 ]; then
    die "dependency installation requires acknowledgement. Run interactively, pass --yes, or use --skip-dependencies"
  fi

  local response
  printf '\nInstall and verify the dependencies listed above? [y/N] '
  read -r response
  case "$response" in
    y|Y|yes|YES) ;;
    *) die "dependency installation was not approved; no dependency changes were made" ;;
  esac
}

install_protontricks_dependency() {
  case "$PROTONTRICKS_INSTALL_STRATEGY" in
    flatpak)
      flatpak remote-add --user --if-not-exists flathub \
        https://flathub.org/repo/flathub.flatpakrepo
      flatpak install --user -y flathub com.github.Matoking.protontricks
      ;;
    apt)
      run_as_root apt-get install -y protontricks
      ;;
    dnf)
      run_as_root dnf install -y protontricks
      ;;
    pacman)
      run_as_root pacman -S --needed --noconfirm protontricks
      ;;
    *)
      die "internal error: unsupported Protontricks installation strategy"
      ;;
  esac
  protontricks_available || die "Protontricks installation completed but verification failed"
}

install_depot_downloader_dependency() {
  python3 - "$DEPOTDOWNLOADER_PATH" <<'PY'
import json
import os
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

target = Path(sys.argv[1])
api_url = "https://api.github.com/repos/SteamRE/DepotDownloader/releases/latest"
request = urllib.request.Request(
    api_url,
    headers={"Accept": "application/vnd.github+json", "User-Agent": "SIMM-Linux-Installer"},
)
with urllib.request.urlopen(request, timeout=60) as response:
    release = json.load(response)

asset = next(
    (item for item in release.get("assets", []) if item.get("name") == "DepotDownloader-linux-x64.zip"),
    None,
)
if asset is None:
    raise SystemExit("Latest SteamRE DepotDownloader release has no DepotDownloader-linux-x64.zip asset")

with tempfile.TemporaryDirectory(prefix="simm-depotdownloader-") as temporary:
    archive_path = Path(temporary) / asset["name"]
    download = urllib.request.Request(
        asset["browser_download_url"], headers={"User-Agent": "SIMM-Linux-Installer"}
    )
    with urllib.request.urlopen(download, timeout=300) as response, archive_path.open("wb") as output:
        shutil.copyfileobj(response, output)

    with zipfile.ZipFile(archive_path) as archive:
        member = next(
            (name for name in archive.namelist() if Path(name).name in {"DepotDownloader", "depotdownloader"}),
            None,
        )
        if member is None:
            raise SystemExit("DepotDownloader archive did not contain its Linux executable")
        target.parent.mkdir(parents=True, exist_ok=True)
        staged = target.with_suffix(".simm-tmp")
        with archive.open(member) as source, staged.open("wb") as output:
            shutil.copyfileobj(source, output)
        staged.chmod(staged.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.replace(staged, target)

marker = Path.home() / ".local/share/simm/dependencies/depotdownloader.version"
marker.parent.mkdir(parents=True, exist_ok=True)
marker.write_text(str(release.get("tag_name", "latest")) + "\n", encoding="utf-8")
print(f"Installed DepotDownloader {release.get('tag_name', 'latest')} at {target}")
PY
  depot_downloader_available \
    || die "DepotDownloader installation completed but verification failed"
}

install_managed_dotnet_dependency() {
  require_command curl
  local script_path="${TMP_DIR}/dotnet-install.sh"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$script_path"
  bash "$script_path" --channel 8.0 --install-dir "$MANAGED_DOTNET_DIR" --no-path
  dotnet_has_sdk_8 "${MANAGED_DOTNET_DIR}/dotnet" \
    || die "managed .NET SDK installation completed but SDK 8 verification failed"
}

install_mlvscan_dependency() {
  local dotnet_program="dotnet"
  local tool_action="install"
  local -a dotnet_env=(env DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1)

  if ! command -v dotnet >/dev/null 2>&1 || ! dotnet_has_sdk_8 dotnet; then
    dotnet_program="${MANAGED_DOTNET_DIR}/dotnet"
    dotnet_env+=("DOTNET_ROOT=${MANAGED_DOTNET_DIR}" "PATH=${MANAGED_DOTNET_DIR}:${PATH}")
  fi
  [ -x "${MLVSCAN_TOOL_DIR}/mlvscan" ] && tool_action="update"

  mkdir -p "$MLVSCAN_TOOL_DIR"
  "${dotnet_env[@]}" "$dotnet_program" tool "$tool_action" MLVScan.DevCLI \
    --tool-path "$MLVSCAN_TOOL_DIR"
  mlvscan_available || die "MLVScan installation completed but its info check failed"
}

install_required_dependencies() {
  if [ "$INSTALL_DEPENDENCIES" -eq 0 ]; then
    log "Dependency installation skipped by request. SIMM Settings may report missing runtime tools."
    return
  fi

  scan_required_dependencies
  show_dependency_plan
  confirm_dependency_plan

  if [ "$DRY_RUN" -eq 1 ] || ! dependency_changes_needed; then
    return
  fi

  [ "$DEPENDENCY_PROTONTRICKS_NEEDED" -eq 0 ] || install_protontricks_dependency
  [ "$DEPENDENCY_DEPOT_NEEDED" -eq 0 ] || install_depot_downloader_dependency
  [ "$DEPENDENCY_DOTNET_NEEDED" -eq 0 ] || install_managed_dotnet_dependency
  [ "$DEPENDENCY_MLVSCAN_NEEDED" -eq 0 ] || install_mlvscan_dependency

  scan_required_dependencies
  dependency_changes_needed \
    && die "one or more dependencies remained unavailable after installation"
  log "All required Linux dependencies were installed and verified."
}

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
Exec="${LAUNCHER_PATH}" %u
Icon=${ICON_PATH}
Terminal=false
Categories=Game;Utility;
MimeType=x-scheme-handler/simm;x-scheme-handler/nxm;
StartupNotify=true
EOF
}

write_appimage_launcher() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] write ${LAUNCHER_PATH}"
    return
  fi

  cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -u

log_dir="\${HOME}/SIMM/logs"
launch_log="\${SIMM_LAUNCH_LOG:-\${log_dir}/simm-launch.log}"
managed_dotnet_root="\${HOME}/SIMM/tools/mlvscan-security-scanner/dotnet-sdk-8"
mkdir -p "\$log_dir"

if [ -x "\${managed_dotnet_root}/dotnet" ]; then
  export DOTNET_ROOT="\$managed_dotnet_root"
  export PATH="\${managed_dotnet_root}:\${PATH}"
fi

{
  printf '\n[%s] Starting SIMM AppImage\n' "\$(date --iso-8601=seconds 2>/dev/null || date)"
  printf 'Display: %s  Wayland: %s  X11: %s\n' \
    "\${XDG_SESSION_TYPE:-unknown}" "\${WAYLAND_DISPLAY:-unset}" "\${DISPLAY:-unset}"
  exec "${APPIMAGE_PATH}" "\$@"
} >>"\$launch_log" 2>&1
EOF
  chmod 0755 "$LAUNCHER_PATH"
}

install_appimage_icon() {
  run mkdir -p "$ICON_DIR"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] extract AppImage icon to ${ICON_PATH}"
    return
  fi

  local extract_root="${TMP_DIR}/appimage-icon"
  local extracted_icon="${extract_root}/squashfs-root/usr/share/icons/hicolor/128x128/apps/simmrust.png"
  mkdir -p "$extract_root"

  if (
    cd "$extract_root"
    "$APPIMAGE_PATH" --appimage-extract 'usr/share/icons/hicolor/128x128/apps/simmrust.png' >/dev/null 2>&1
  ) && [ -f "$extracted_icon" ]; then
    cp "$extracted_icon" "$ICON_PATH"
    chmod 0644 "$ICON_PATH"
  else
    log "warning: SIMM was installed, but its AppImage icon could not be extracted. The launcher may use a default icon."
  fi
}

is_steam_deck() {
  case "${STEAM_DECK:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
  esac

  if [ -r /etc/os-release ] && grep -Eiq '^(ID|VARIANT_ID)=.*(steamos|steamdeck)' /etc/os-release; then
    return 0
  fi

  for dmi_file in /sys/devices/virtual/dmi/id/product_name /sys/class/dmi/id/product_name; do
    if [ -r "$dmi_file" ] && grep -qiE 'steam deck|jupiter|galileo' "$dmi_file"; then
      return 0
    fi
  done

  return 1
}

find_steam_root() {
  local candidate
  for candidate in \
    "${STEAM_DIR:-}" \
    "${STEAM_PATH:-}" \
    "${HOME}/.local/share/Steam" \
    "${HOME}/.steam/steam" \
    "${HOME}/.var/app/com.valvesoftware.Steam/.local/share/Steam"; do
    if [ -n "$candidate" ] && [ -d "$candidate/userdata" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

steam_client_running() {
  command -v pgrep >/dev/null 2>&1 && pgrep -x steam >/dev/null 2>&1
}

steam_autostart_active() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user is-active app-steam@autostart.service >/dev/null 2>&1
}

stop_steam_for_shortcut() {
  if ! steam_client_running && ! steam_autostart_active; then
    return 0
  fi

  log "Stopping Steam so it can register the SIMM shortcut."
  if steam_client_running && command -v steam >/dev/null 2>&1; then
    steam -shutdown >/dev/null 2>&1 || true
  fi

  local attempt
  for attempt in $(seq 1 15); do
    if ! steam_client_running; then
      break
    fi
    sleep 1
  done

  if steam_autostart_active; then
    log "Stopping Steam's Desktop Mode autostart service before editing its shortcut registry."
    systemctl --user stop app-steam@autostart.service >/dev/null 2>&1 || true

    for attempt in $(seq 1 15); do
      if ! steam_client_running && ! steam_autostart_active; then
        return 0
      fi
      sleep 1
    done
  fi

  ! steam_client_running && ! steam_autostart_active
}

update_steam_shortcut() {
  local steam_root="$1"
  local mode="${2:-write}"

  python3 - "$steam_root" "$LAUNCHER_PATH" "$APPIMAGE_DIR" "$ICON_PATH" "$STEAM_SHORTCUT_NAME" "$mode" <<'PY'
import binascii
import os
import struct
import sys
from pathlib import Path

steam_root = Path(sys.argv[1])
launcher = Path(sys.argv[2])
start_dir = Path(sys.argv[3])
icon_path = Path(sys.argv[4])
app_name = sys.argv[5]
mode = sys.argv[6]

TYPE_OBJECT = 0x00
TYPE_STRING = 0x01
TYPE_INT32 = 0x02
TYPE_UINT64 = 0x07
TYPE_END = 0x08

def read_c_string(data, offset):
    end = data.index(0, offset)
    return data[offset:end].decode("utf-8"), end + 1

def parse_object(data, offset=0):
    entries = []
    while True:
        if offset >= len(data):
            raise ValueError("Unexpected end of shortcuts.vdf")
        value_type = data[offset]
        offset += 1
        if value_type == TYPE_END:
            return entries, offset
        key, offset = read_c_string(data, offset)
        if value_type == TYPE_OBJECT:
            value, offset = parse_object(data, offset)
        elif value_type == TYPE_STRING:
            value, offset = read_c_string(data, offset)
        elif value_type == TYPE_INT32:
            value = struct.unpack_from("<i", data, offset)[0]
            offset += 4
        elif value_type == TYPE_UINT64:
            value = struct.unpack_from("<Q", data, offset)[0]
            offset += 8
        else:
            raise ValueError(f"Unsupported shortcuts.vdf value type {value_type} for {key}")
        entries.append([key, value_type, value])

def write_c_string(value):
    return value.encode("utf-8").replace(b"\x00", b"") + b"\x00"

def write_object(entries):
    output = bytearray()
    for key, value_type, value in entries:
        output.append(value_type)
        output.extend(write_c_string(key))
        if value_type == TYPE_OBJECT:
            output.extend(write_object(value))
        elif value_type == TYPE_STRING:
            output.extend(write_c_string(value))
        elif value_type == TYPE_INT32:
            output.extend(struct.pack("<i", value))
        elif value_type == TYPE_UINT64:
            output.extend(struct.pack("<Q", value))
        else:
            raise ValueError(f"Unsupported shortcuts.vdf value type {value_type} for {key}")
    output.append(TYPE_END)
    return bytes(output)

def find_object(entries, key):
    for entry in entries:
        if entry[0].lower() == key.lower() and entry[1] == TYPE_OBJECT:
            return entry[2]
    entries.append([key, TYPE_OBJECT, []])
    return entries[-1][2]

def get_string(entries, key):
    for entry in entries:
        if entry[0].lower() == key.lower() and entry[1] == TYPE_STRING:
            return entry[2]
    return None

def set_entry(entries, key, value_type, value):
    for entry in entries:
        if entry[0].lower() == key.lower():
            entry[0], entry[1], entry[2] = key, value_type, value
            return
    entries.append([key, value_type, value])

def quote(path):
    return f'"{path}"'

exe = quote(launcher)
app_id = binascii.crc32((exe + app_name).encode("utf-8")) | 0x80000000
app_id_signed = app_id if app_id < 0x80000000 else app_id - 0x100000000
expected = [
    ("appid", TYPE_INT32, app_id_signed),
    ("appname", TYPE_STRING, app_name),
    ("exe", TYPE_STRING, exe),
    ("StartDir", TYPE_STRING, quote(start_dir)),
    ("icon", TYPE_STRING, str(icon_path)),
    ("ShortcutPath", TYPE_STRING, ""),
    ("LaunchOptions", TYPE_STRING, ""),
    ("IsHidden", TYPE_INT32, 0),
    ("AllowDesktopConfig", TYPE_INT32, 1),
    ("AllowOverlay", TYPE_INT32, 1),
    ("OpenVR", TYPE_INT32, 0),
    ("Devkit", TYPE_INT32, 0),
    ("DevkitGameID", TYPE_STRING, ""),
    ("LastPlayTime", TYPE_INT32, 0),
    ("FlatpakAppID", TYPE_STRING, ""),
    ("tags", TYPE_OBJECT, [["0", TYPE_STRING, "SIMM"]]),
]

userdata = steam_root / "userdata"
accounts = [path for path in userdata.iterdir() if path.is_dir() and path.name.isdigit()]
if not accounts:
    raise SystemExit("No Steam userdata account was found. Sign in to Steam once, then rerun this installer.")

def account_id_from_steam_id64(value):
    try:
        steam_id = int(value)
    except ValueError:
        return None
    account_id = steam_id - 76561197960265728
    return str(account_id) if account_id >= 0 else None

def most_recent_account():
    loginusers = steam_root / "config" / "loginusers.vdf"
    if not loginusers.is_file():
        return None
    current = None
    for line in loginusers.read_text(encoding="utf-8", errors="ignore").splitlines():
        values = [part for part in line.split('"') if part.strip()]
        if len(values) == 1 and values[0].strip().isdigit():
            current = account_id_from_steam_id64(values[0].strip())
        elif len(values) >= 2 and values[0].strip().lower() == "mostrecent" and values[1].strip() == "1":
            return current
    return None

preferred_id = most_recent_account()
account = next((path for path in accounts if path.name == preferred_id), None)
if account is None:
    account = max(accounts, key=lambda path: path.stat().st_mtime)

shortcut_file = account / "config" / "shortcuts.vdf"
shortcut_file.parent.mkdir(parents=True, exist_ok=True)
root = []
if shortcut_file.exists():
    root, offset = parse_object(shortcut_file.read_bytes())
    if offset != shortcut_file.stat().st_size:
        raise SystemExit("shortcuts.vdf has trailing data and was not changed")

shortcuts = find_object(root, "shortcuts")
target = next((entry[2] for entry in shortcuts if entry[1] == TYPE_OBJECT and (
    get_string(entry[2], "appname") == app_name or get_string(entry[2], "exe") == exe
)), None)
is_new = target is None
if target is None:
    indexes = [int(entry[0]) for entry in shortcuts if entry[0].isdigit()]
    target = []
    shortcuts.append([str(max(indexes, default=-1) + 1), TYPE_OBJECT, target])

managed_keys = {key.lower() for key, _, _ in expected if key != "LastPlayTime"}
is_current = not is_new and all(
    any(existing[0].lower() == key.lower() and existing[1] == value_type and existing[2] == value
        for existing in target)
    for key, value_type, value in expected
    if key.lower() in managed_keys
)

if mode == "check":
    if is_current:
        print(f"verified: {shortcut_file}")
        raise SystemExit(0)
    raise SystemExit(1)
if mode != "write":
    raise SystemExit(f"Unsupported Steam shortcut mode: {mode}")

for key, value_type, value in expected:
    if key == "LastPlayTime" and not is_new:
        continue
    set_entry(target, key, value_type, value)

temporary = shortcut_file.with_suffix(".vdf.simm-tmp")
temporary.write_bytes(write_object(root))
os.replace(temporary, shortcut_file)
print(f"{'added' if is_new else 'updated'}: {shortcut_file}")
PY
}

install_steam_deck_shortcut() {
  if [ "$SKIP_STEAM_SHORTCUT" -eq 1 ] || ! is_steam_deck; then
    return
  fi

  local steam_root
  if ! steam_root="$(find_steam_root)"; then
    log "warning: Steam Deck detected, but no Steam userdata folder was found. SIMM was installed without a Steam shortcut."
    return
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] add '${STEAM_SHORTCUT_NAME}' to ${steam_root}/userdata/*/config/shortcuts.vdf"
    return
  fi

  if ! stop_steam_for_shortcut; then
    log "warning: Steam is still running, so SIMM did not modify shortcuts.vdf. Fully exit Steam in Desktop Mode and rerun the installer to add SIMM to Gaming Mode."
    return
  fi

  if update_steam_shortcut "$steam_root" write \
      && update_steam_shortcut "$steam_root" check; then
    log "Registered and verified '${STEAM_SHORTCUT_NAME}' in Steam. Return to Gaming Mode; Steam will show it in the Non-Steam library."
  else
    log "warning: SIMM was installed, but the Steam shortcut could not be created. See the error above and rerun the installer after signing in to Steam."
  fi
}

repair_steam_deck_shortcut() {
  [ -x "$LAUNCHER_PATH" ] || die "SIMM's compatibility launcher was not found at ${LAUNCHER_PATH}. Install SIMM before repairing its Steam shortcut."
  [ -x "$APPIMAGE_PATH" ] || die "SIMM's installed AppImage was not found at ${APPIMAGE_PATH}. Install SIMM before repairing its Steam shortcut."

  local steam_root
  if ! steam_root="$(find_steam_root)"; then
    die "no Steam userdata folder was found. Sign in to Steam in Desktop Mode, then rerun this repair"
  fi

  log "Repairing '${STEAM_SHORTCUT_NAME}' for the active Steam account under ${steam_root}."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] stop Steam, rewrite the SIMM entry, and verify ${steam_root}/userdata/*/config/shortcuts.vdf"
    return
  fi

  if ! stop_steam_for_shortcut; then
    die "Steam is still running. Fully exit Steam in Desktop Mode, then rerun this repair"
  fi

  update_steam_shortcut "$steam_root" write \
    || die "the SIMM Steam shortcut could not be written"
  update_steam_shortcut "$steam_root" check \
    || die "the SIMM Steam shortcut was written but did not pass verification"
  log "Steam shortcut repair completed. Return to Gaming Mode and open the Non-Steam library."
}

install_appimage() {
  log "Installing AppImage user-local package."
  run mkdir -p "$APPIMAGE_DIR" "$BIN_DIR"
  install_appimage_atomically
  write_appimage_launcher
  run ln -sfn "$LAUNCHER_PATH" "$BIN_LINK"
  install_appimage_icon
  write_appimage_desktop_entry

  if command -v update-desktop-database >/dev/null 2>&1; then
    run update-desktop-database "$DESKTOP_DIR"
  fi

  if command -v xdg-mime >/dev/null 2>&1; then
    run xdg-mime default "$(basename "$DESKTOP_FILE")" x-scheme-handler/simm
    run xdg-mime default "$(basename "$DESKTOP_FILE")" x-scheme-handler/nxm
  fi

  install_steam_deck_shortcut
}

install_appimage_atomically() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] stage ${ASSET_PATH} next to ${APPIMAGE_PATH}, fsync it, then atomically replace the installed AppImage"
    return
  fi

  local staged_path
  staged_path="$(mktemp "${APPIMAGE_DIR}/.SIMM.AppImage.XXXXXX")" || die "failed to allocate an AppImage staging file"

  if ! cp "$ASSET_PATH" "$staged_path"; then
    rm -f "$staged_path"
    die "failed to stage the new AppImage; the existing installation was left unchanged"
  fi
  if ! chmod 0755 "$staged_path"; then
    rm -f "$staged_path"
    die "failed to set permissions on the staged AppImage; the existing installation was left unchanged"
  fi
  if ! python3 - "$staged_path" "$APPIMAGE_DIR" <<'PY'
import os
import sys

with open(sys.argv[1], "rb") as staged:
    os.fsync(staged.fileno())
directory_fd = os.open(sys.argv[2], os.O_RDONLY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
  then
    rm -f "$staged_path"
    die "failed to flush the staged AppImage; the existing installation was left unchanged"
  fi
  if ! mv -f "$staged_path" "$APPIMAGE_PATH"; then
    rm -f "$staged_path"
    die "failed to atomically replace the AppImage; the existing installation was left unchanged"
  fi
  if ! python3 - "$APPIMAGE_DIR" <<'PY'
import os
import sys

directory_fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
  then
    die "the AppImage was replaced but the directory metadata could not be flushed"
  fi
}

if [ "$REPAIR_STEAM_SHORTCUT" -eq 1 ]; then
  repair_steam_deck_shortcut
  exit 0
fi

install_required_dependencies

case "$FORMAT" in
  deb) install_deb ;;
  appimage) install_appimage ;;
  *) die "unsupported format: $FORMAT" ;;
esac

log ""
log "SIMM ${RELEASE_TAG} install step completed."
if [ "$FORMAT" = "appimage" ]; then
  log "Installed AppImage: ${APPIMAGE_PATH}"
  log "Compatibility launcher: ${LAUNCHER_PATH}"
  log "Command link: ${BIN_LINK}"
  log "Desktop entry: ${DESKTOP_FILE}"
fi

log ""
log "Runtime dependency status:"
if [ "$DRY_RUN" -eq 1 ] && [ "$INSTALL_DEPENDENCIES" -eq 1 ]; then
  log "  Dry run only: required Linux tool changes were planned but not performed."
elif [ "$INSTALL_DEPENDENCIES" -eq 1 ]; then
  log "  Required Linux tools were detected or installed and verified before SIMM was installed."
else
  log "  Dependency setup was skipped; open SIMM Settings to review Linux readiness."
fi
log "  SIMM installs Schedule I-specific Proton verbs later, when you start MelonLoader setup."
