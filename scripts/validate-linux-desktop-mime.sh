#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <path-to-deb|path-to-appimage|path-to-appdir> [scheme ...]" >&2
  echo "Example: $0 artifacts/linux/SIMM_0.8.5_amd64.deb simm nxm" >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

input_path=$1
shift || true

required_schemes=("$@")
if [[ ${#required_schemes[@]} -eq 0 ]]; then
  required_schemes=("simm" "nxm")
fi

if [[ ! -e "$input_path" ]]; then
  echo "Linux artifact was not found: $input_path" >&2
  exit 1
fi

for tool in ar tar find grep sed tr mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' is not available." >&2
    exit 1
  fi
done

work_dir=$(mktemp -d)
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

resolve_applications_dir() {
  local source_path=$1
  local output_dir=$2

  if [[ -d "$source_path" ]]; then
    if [[ -d "$source_path/usr/share/applications" ]]; then
      printf '%s\n' "$source_path/usr/share/applications"
      return 0
    fi
    if [[ -d "$source_path/share/applications" ]]; then
      printf '%s\n' "$source_path/share/applications"
      return 0
    fi
    echo "Directory does not contain usr/share/applications or share/applications: $source_path" >&2
    return 1
  fi

  case "$source_path" in
    *.deb)
      local deb_abs
      deb_abs=$(cd "$(dirname "$source_path")" && pwd)/$(basename "$source_path")
      local deb_dir="$output_dir/deb"
      mkdir -p "$deb_dir"
      (
        cd "$deb_dir"
        ar x "$deb_abs"
      )

      local data_archive
      data_archive=$(find "$deb_dir" -maxdepth 1 -type f -name 'data.tar.*' -print -quit)
      if [[ -z "$data_archive" ]]; then
        echo "Debian package does not contain a data.tar.* archive." >&2
        return 1
      fi

      local data_dir="$output_dir/data"
      mkdir -p "$data_dir"
      tar -xf "$data_archive" -C "$data_dir"
      if [[ ! -d "$data_dir/usr/share/applications" ]]; then
        echo "Debian package does not contain usr/share/applications." >&2
        return 1
      fi
      printf '%s\n' "$data_dir/usr/share/applications"
      ;;
    *.AppImage|*.appimage)
      local appimage_abs
      appimage_abs=$(cd "$(dirname "$source_path")" && pwd)/$(basename "$source_path")
      local appimage_dir="$output_dir/appimage"
      mkdir -p "$appimage_dir"
      (
        cd "$appimage_dir"
        "$appimage_abs" --appimage-extract >/dev/null
      )
      local extracted_applications
      extracted_applications=$(find "$appimage_dir/squashfs-root" -type d -path '*/usr/share/applications' -print -quit)
      if [[ -z "$extracted_applications" ]]; then
        extracted_applications=$(find "$appimage_dir/squashfs-root" -type d -path '*/share/applications' -print -quit)
      fi
      if [[ -z "$extracted_applications" ]]; then
        echo "AppImage does not contain a desktop entry under share/applications." >&2
        return 1
      fi
      printf '%s\n' "$extracted_applications"
      ;;
    *)
      echo "Unsupported Linux artifact type: $source_path" >&2
      return 1
      ;;
  esac
}

applications_dir=$(resolve_applications_dir "$input_path" "$work_dir")
if [[ -z "$applications_dir" || ! -d "$applications_dir" ]]; then
  echo "Could not locate Linux desktop entries in $input_path." >&2
  exit 1
fi

matched_desktop=""
while IFS= read -r -d '' desktop_file; do
  mime_values=$(grep -E '^MimeType=' "$desktop_file" | sed 's/^MimeType=//' | tr ';' '\n' || true)
  all_found=true

  for scheme in "${required_schemes[@]}"; do
    handler="x-scheme-handler/$scheme"
    if ! printf '%s\n' "$mime_values" | grep -Fxq "$handler"; then
      all_found=false
      break
    fi
  done

  if [[ "$all_found" == true ]]; then
    matched_desktop="$desktop_file"
    break
  fi
done < <(find "$applications_dir" -maxdepth 1 -type f -name '*.desktop' -print0)

if [[ -z "$matched_desktop" ]]; then
  echo "No desktop entry in $input_path declares all required scheme handlers: ${required_schemes[*]}" >&2
  echo "Found desktop entries:" >&2
  find "$applications_dir" -maxdepth 1 -type f -name '*.desktop' -print -exec grep -E '^MimeType=' {} \; >&2
  exit 1
fi

echo "Validated Linux desktop scheme handlers in $(basename "$matched_desktop"): ${required_schemes[*]}"
