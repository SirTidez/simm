[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packager = Join-Path $PSScriptRoot 'package-steam-deck.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("simm-steam-deck-package-test-" + [guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $version = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json).version
    $artifactName = "SIMM_${version}_x86_64.AppImage"
    $artifact = Join-Path $fixtureRoot $artifactName
    [System.IO.File]::WriteAllBytes($artifact, [byte[]](1, 2, 3, 4))
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $fixtureRoot 'SHA256SUMS') -NoNewline -Encoding ascii -Value "$hash  $artifactName`n"

    & $packager -AppImage $artifact -OutputDirectory $fixtureRoot

    $wrongVersionArtifact = Join-Path $fixtureRoot 'SIMM_0.0.0_x86_64.AppImage'
    [System.IO.File]::WriteAllBytes($wrongVersionArtifact, [byte[]](1, 2, 3, 4))
    $wrongVersionRejected = $false
    try { & $packager -AppImage $wrongVersionArtifact -OutputDirectory $fixtureRoot } catch { $wrongVersionRejected = $true }
    if (-not $wrongVersionRejected) { throw 'Stale AppImage filename was accepted.' }

    [System.IO.File]::WriteAllBytes($artifact, [byte[]](9, 9, 9, 9))
    $hashMismatchRejected = $false
    try { & $packager -AppImage $artifact -OutputDirectory $fixtureRoot -Force } catch { $hashMismatchRejected = $true }
    if (-not $hashMismatchRejected) { throw 'Checksum-mismatched AppImage was accepted.' }

    Write-Host 'PASS: Steam Deck packager rejects stale or checksum-mismatched AppImages.'
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
