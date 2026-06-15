#!/usr/bin/env bash
set -euo pipefail

manifest_path=${1:-src-tauri/windows/app.manifest}

if [[ ! -f "$manifest_path" ]]; then
  echo "Windows app manifest was not found: $manifest_path" >&2
  exit 1
fi

if grep -Eq 'requestedExecutionLevel[[:space:]][^>]*level="requireAdministrator"' "$manifest_path"; then
  echo "Windows app manifest still requires administrator elevation at launch: $manifest_path" >&2
  exit 1
fi

if ! grep -Eq 'requestedExecutionLevel[[:space:]][^>]*level="asInvoker"' "$manifest_path"; then
  echo "Windows app manifest must declare requestedExecutionLevel level=\"asInvoker\": $manifest_path" >&2
  exit 1
fi

echo "Validated Windows app launch manifest is unelevated: $manifest_path"
