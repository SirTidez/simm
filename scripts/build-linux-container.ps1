[CmdletBinding()]
param(
    [ValidateSet("build", "check", "shell")]
    [string] $Command = "build",

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
  .\scripts\build-linux-container.cmd [options]
  .\scripts\build-linux-container.ps1 [options]

Options:
  -Command <build|check|shell>    Container command to run. Defaults to build.
  -Image <name:tag>               Docker image tag. Defaults to simm-linux-builder:ubuntu22.04.
  -UbuntuVersion <version>        Ubuntu base image version. Defaults to 22.04.
  -BunVersion <version|latest>    Bun version to install. Defaults to latest.
  -NodeVersion <version>          Node.js version to install. Defaults to 22.12.0.
  -RustToolchain <toolchain>      Rust toolchain to install. Defaults to stable.
  -SkipImageBuild                 Reuse the existing Docker image.
  -Help                           Show this help text.

Use the .cmd wrapper on Windows if PowerShell execution policy blocks direct .ps1 execution.
"@
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

$interactiveArgs = @()
if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    $interactiveArgs = @("-it")
}

docker run `
    --rm `
    @interactiveArgs `
    --mount "type=bind,source=$repoRoot,target=/workspace" `
    --mount "type=volume,source=simm-linux-cargo-registry,target=/usr/local/cargo/registry" `
    --mount "type=volume,source=simm-linux-cargo-git,target=/usr/local/cargo/git" `
    --mount "type=volume,source=simm-linux-bun-cache,target=/root/.bun/install/cache" `
    --workdir /workspace `
    $Image `
    $Command
