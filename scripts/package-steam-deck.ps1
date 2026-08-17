[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $AppImage,

    [string] $OutputDirectory = (Join-Path $PSScriptRoot "..\target\steam-deck"),

    [string] $PackageLabel = "",

    [switch] $Force
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$resolvedAppImages = @(Resolve-Path -Path $AppImage)
if ($resolvedAppImages.Count -ne 1) {
    throw "Expected exactly one AppImage, found $($resolvedAppImages.Count) for '$AppImage'."
}
$sourceAppImage = $resolvedAppImages[0].Path
if (-not $sourceAppImage.EndsWith(".AppImage", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "AppImage must end with '.AppImage': $sourceAppImage"
}

$packageVersion = (Select-String -LiteralPath (Join-Path $repoRoot "package.json") -Pattern '"version"\s*:\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
if ([string]::IsNullOrWhiteSpace($packageVersion)) {
    throw "Could not read the SIMM version from package.json."
}

if (-not [string]::IsNullOrWhiteSpace($PackageLabel) -and $PackageLabel -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "PackageLabel may contain only letters, numbers, periods, underscores, and hyphens."
}

$packageName = "SIMM-Steam-Deck-$packageVersion"
if (-not [string]::IsNullOrWhiteSpace($PackageLabel)) {
    $packageName = "$packageName-$PackageLabel"
}
$packageRoot = Join-Path (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $OutputDirectory)).Path $packageName
$zipPath = Join-Path (Split-Path -Parent $packageRoot) "$packageName.zip"

if (Test-Path -LiteralPath $packageRoot) {
    if (-not $Force) {
        throw "Package directory already exists: $packageRoot. Pass -Force to recreate it."
    }
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}

if (Test-Path -LiteralPath $zipPath) {
    if (-not $Force) {
        throw "Package archive already exists: $zipPath. Pass -Force to recreate it."
    }
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $packageRoot | Out-Null

$appImageName = "SIMM_${packageVersion}_x86_64.AppImage"

$packagedAppImage = Join-Path $packageRoot $appImageName
Copy-Item -LiteralPath $sourceAppImage -Destination $packagedAppImage
Copy-Item -LiteralPath (Join-Path $repoRoot "install.sh") -Destination (Join-Path $packageRoot "install.sh")

$hash = (Get-FileHash -LiteralPath $packagedAppImage -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $packageRoot "SHA256SUMS") -Encoding ascii -NoNewline -Value "$hash  $appImageName`n"

$readme = @"
SIMM Steam Deck package

This is a self-contained SIMM installer bundle. The included AppImage is the
application payload; install.sh verifies and installs that local file and does
not download SIMM from GitHub.

This Steam Deck compatibility build uses SteamOS's own graphics/runtime
infrastructure instead of Ubuntu-bundled Wayland, GLib, and GStreamer copies.

Install from Steam Deck Desktop Mode:

  1. Extract this entire folder somewhere in your home directory.
  2. Open Konsole in the extracted folder.
  3. Run: bash install.sh --appimage-file ./$appImageName
  4. Review the dependency plan. It names each missing tool, its approved
     source, and its destination. Type y only if you approve those changes.
  5. The installer installs and verifies missing Protontricks, DepotDownloader,
     private .NET 8, and MLVScan tooling, then installs SIMM under
     ~/.local/opt/simm with its launcher and icon.
  6. Steam is stopped so the installer can safely register Schedule I Mod
     Manager as a Non-Steam game. Return to Gaming Mode after it finishes.

If SIMM is already installed but its Non-Steam shortcut is missing, return to
Desktop Mode, open Konsole in this extracted folder, and run:

  bash install.sh --repair-steam-shortcut

This repair does not reinstall SIMM. It stops Steam, rewrites the shortcut for
the most recently used Steam account, and prints the exact shortcuts.vdf path
after verifying the entry.

If SIMM cannot display correctly, send this diagnostic file to the developer:

  ~/SIMM/logs/simm-launch.log

The installer does not write to SteamOS's immutable system partition. Do not
separate the AppImage from SHA256SUMS before installation.

SteamOS already provides the base installer tools used here: bash, python3,
sha256sum, mktemp, and Flatpak. The bundled SIMM AppImage is offline, but an
internet connection is required when the approved dependency plan needs to
download Protontricks, DepotDownloader, private .NET 8, or MLVScan.

To install without changing Steam shortcuts, append --skip-steam-shortcut.
To intentionally skip runtime tool setup, append --skip-dependencies; SIMM
Settings will continue to report any missing tools.
"@
Set-Content -LiteralPath (Join-Path $packageRoot "README-STEAM-DECK.txt") -Encoding utf8 -Value $readme

Compress-Archive -Path $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Steam Deck package: $zipPath"
