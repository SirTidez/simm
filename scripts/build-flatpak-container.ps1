[CmdletBinding()]
param(
    [string] $Image = "simm-linux-builder:ubuntu22.04",
    [string] $UbuntuVersion = "22.04",
    [string] $BunVersion = "latest",
    [string] $NodeVersion = "22.12.0",
    [string] $RustToolchain = "stable",
    [switch] $SkipImageBuild,
    [switch] $Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    @"
Usage:
  .\scripts\build-flatpak-container.cmd [options]
  .\scripts\build-flatpak-container.ps1 [options]

Builds a testable Flatpak bundle with Docker. The resulting artifact is written to:
  target\flatpak\dev.lockwirelabs.simm-<version>.flatpak
"@ | Write-Output
    exit 0
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dockerfile = Join-Path $repoRoot "docker/linux/Dockerfile"

if (-not $SkipImageBuild) {
    docker build `
        --build-arg "UBUNTU_VERSION=$UbuntuVersion" `
        --build-arg "BUN_VERSION=$BunVersion" `
        --build-arg "NODE_VERSION=$NodeVersion" `
        --build-arg "RUST_TOOLCHAIN=$RustToolchain" `
        -f $dockerfile `
        -t $Image `
        $repoRoot
}

docker run `
    --rm `
    --privileged `
    --mount "type=bind,source=$repoRoot,target=/workspace" `
    --mount "type=volume,source=simm-flatpak-system,target=/var/lib/flatpak" `
    --mount "type=volume,source=simm-flatpak-cache,target=/root/.local/share/flatpak" `
    --mount "type=volume,source=simm-flatpak-builder-cache,target=/root/.cache/flatpak-builder" `
    --mount "type=volume,source=simm-linux-cargo-registry,target=/usr/local/cargo/registry" `
    --mount "type=volume,source=simm-linux-cargo-git,target=/usr/local/cargo/git" `
    --mount "type=volume,source=simm-linux-bun-cache,target=/root/.bun/install/cache" `
    --workdir /workspace `
    --entrypoint /usr/local/bin/simm-build-flatpak `
    $Image
