#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <input.AppImage> <output.AppImage>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

input=$1
output=$2

if [[ ! -f "$input" ]]; then
  echo "Input AppImage was not found: $input" >&2
  exit 1
fi

for tool in curl find readlink sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool '$tool' is not available." >&2
    exit 1
  fi
done

input=$(readlink -f "$input")
output_parent=$(dirname "$output")
mkdir -p "$output_parent"
output_parent=$(readlink -f "$output_parent")
output="$output_parent/$(basename "$output")"

work_dir=$(mktemp -d)
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

chmod +x "$input"
(
  cd "$work_dir"
  "$input" --appimage-extract >/dev/null
)

app_dir="$work_dir/squashfs-root"
lib_dir="$app_dir/usr/lib"
if [[ ! -d "$lib_dir" || ! -x "$app_dir/AppRun" ]]; then
  echo "Extracted AppImage does not contain the expected AppDir layout." >&2
  exit 1
fi

# Tauri's default AppImage dependency sweep can bundle Ubuntu 22.04 graphics
# infrastructure alongside WebKitGTK. SteamOS supplies newer Mesa/Wayland/GLib
# libraries, and mixing those stacks can terminate WebKitWebProcess before it
# paints even the static boot page. Keep application libraries bundled while
# resolving this compatibility layer from SteamOS.
mapfile -d '' incompatible_libraries < <(
  find "$lib_dir" -maxdepth 1 \( -type f -o -type l \) \( \
    -name 'libwayland-*' -o \
    -name 'libglib-2.0.so*' -o \
    -name 'libgio-2.0.so*' -o \
    -name 'libgobject-2.0.so*' -o \
    -name 'libgmodule-2.0.so*' -o \
    -name 'libgst*.so*' -o \
    -name 'libmount.so*' -o \
    -name 'libblkid.so*' -o \
    -name 'libselinux.so*' -o \
    -name 'libpcre2-8.so*' -o \
    -name 'libnghttp2.so*' -o \
    -name 'libzstd.so*' -o \
    -name 'libelf.so*' -o \
    -name 'libffi.so*' \
  \) -print0
)

if [[ ${#incompatible_libraries[@]} -eq 0 ]]; then
  echo "No bundled SteamOS-incompatible graphics libraries were found." >&2
  exit 1
fi

printf 'Removing %d bundled graphics/runtime compatibility entries:\n' "${#incompatible_libraries[@]}"
for library in "${incompatible_libraries[@]}"; do
  printf '  %s\n' "$(basename "$library")"
  rm -f -- "$library"
done

# A missing bundled plugin directory must not suppress SteamOS's normal
# GStreamer discovery. The absolute link deliberately resolves on the host.
rm -rf -- "$lib_dir/gstreamer-1.0"
ln -s /usr/lib/gstreamer-1.0 "$lib_dir/gstreamer-1.0"

cat > "$app_dir/STEAM-DECK-COMPATIBILITY.txt" <<'EOF'
This AppImage variant intentionally uses SteamOS system Wayland, GLib, and
GStreamer infrastructure to avoid mixing Ubuntu 22.04 libraries with SteamOS
Mesa/WebKit processes. Application-specific libraries remain bundled.
EOF

appimagetool="$work_dir/appimagetool-x86_64.AppImage"
appimagetool_url="${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage}"
curl -fL "$appimagetool_url" -o "$appimagetool"
chmod +x "$appimagetool"

rm -f -- "$output"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool" "$app_dir" "$output"
chmod +x "$output"
sha256sum "$output"
