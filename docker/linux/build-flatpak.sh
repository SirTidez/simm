#!/usr/bin/env bash
set -euo pipefail

APP_ID="dev.lockwirelabs.simm"
RUNTIME="org.gnome.Platform//50"
SDK="org.gnome.Sdk//50"
RUNTIME_REPO="https://dl.flathub.org/repo/flathub.flatpakrepo"
REPO_ROOT="/workspace"
OUTPUT_DIR="${REPO_ROOT}/target/flatpak"
BUILD_DIR="${OUTPUT_DIR}/build"
REPO_DIR="${OUTPUT_DIR}/repo"

cd "${REPO_ROOT}"

echo "==> Installing frontend dependencies"
bun install

echo "==> Validating frontend"
bunx tsc --noEmit
bun run lint
bun run test
bun run build

echo "==> Building the Linux Tauri binary"
bunx tauri build --no-bundle

echo "==> Installing Flatpak build dependencies"
flatpak remote-add --if-not-exists --system flathub "${RUNTIME_REPO}"
flatpak install --system --noninteractive flathub "${RUNTIME}" "${SDK}"

echo "==> Building Flatpak repository"
rm -rf "${BUILD_DIR}" "${REPO_DIR}"
pushd "${OUTPUT_DIR}" >/dev/null
flatpak-builder \
  --force-clean \
  --disable-rofiles-fuse \
  --repo="${REPO_DIR}" \
  "${BUILD_DIR}" \
  "${REPO_ROOT}/flatpak/${APP_ID}.yml"
popd >/dev/null

version=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -n 1)
bundle_path="${OUTPUT_DIR}/${APP_ID}-${version}.flatpak"

echo "==> Creating single-file Flatpak bundle"
flatpak build-update-repo "${REPO_DIR}"
flatpak build-bundle \
  "${REPO_DIR}" \
  "${bundle_path}" \
  "${APP_ID}" \
  --runtime-repo="${RUNTIME_REPO}"

echo "==> Installing bundle for smoke validation"
flatpak install --user --noninteractive "${bundle_path}"
flatpak info --user "${APP_ID}"

echo "==> Flatpak artifact"
ls -lh "${bundle_path}"
