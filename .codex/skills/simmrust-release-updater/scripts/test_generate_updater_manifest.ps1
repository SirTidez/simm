$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$generator = Join-Path $repoRoot 'scripts\generate-updater-manifest.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("simm-updater-manifest-{0}" -f [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot

function Assert-Fails {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedMessage
  )

  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $ExpectedMessage) {
      throw "Expected failure matching '$ExpectedMessage', got '$($_.Exception.Message)'."
    }
    return
  }
  throw "Expected action to fail with '$ExpectedMessage'."
}

try {
  $signatureText = @"
untrusted comment: fixture
RWR1bW15LXNpZ25hdHVyZQ==
trusted comment: timestamp:0
RWR1bW15LXRydXN0ZWQtc2lnbmF0dXJl
"@
  $encodedSignature = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signatureText))
  $windowsSignature = Join-Path $testRoot 'windows.sig'
  $linuxSignature = Join-Path $testRoot 'linux.sig'
  Set-Content -LiteralPath $windowsSignature -Value $encodedSignature -Encoding utf8 -NoNewline
  Set-Content -LiteralPath $linuxSignature -Value $encodedSignature -Encoding utf8 -NoNewline

  $version = '0.8.7-beta.1'
  $output = Join-Path $testRoot 'latest-beta.json'
  $validParameters = @{
    Version = $version
    Channel = 'Beta'
    PackageVersion = $version
    MinimumVersion = '0.8.6'
    AssetUrl = "https://github.com/SirTidez/simm/releases/download/v${version}/SIMM_${version}_Setup.exe"
    SignaturePath = $windowsSignature
    LinuxAssetUrl = "https://github.com/SirTidez/simm/releases/download/v${version}/SIMM_${version}_x86_64.AppImage"
    LinuxSignaturePath = $linuxSignature
    OutputPath = $output
    Notes = 'fixture'
    PubDate = '2026-08-20T00:00:00Z'
  }

  & $generator @validParameters | Out-Null
  $manifest = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
  if ($manifest.version -cne $version) {
    throw "Generated version '$($manifest.version)' did not match '$version'."
  }
  if (-not $manifest.platforms.'windows-x86_64' -or -not $manifest.platforms.'linux-x86_64') {
    throw 'Generated manifest did not contain both required x86_64 platform entries.'
  }

  $sameCore = $validParameters.Clone()
  $sameCore.Version = '0.8.6-beta.1'
  $sameCore.PackageVersion = '0.8.6-beta.1'
  $sameCore.AssetUrl = 'https://github.com/SirTidez/simm/releases/download/v0.8.6-beta.1/SIMM_0.8.6-beta.1_Setup.exe'
  $sameCore.LinuxAssetUrl = 'https://github.com/SirTidez/simm/releases/download/v0.8.6-beta.1/SIMM_0.8.6-beta.1_x86_64.AppImage'
  Assert-Fails -ExpectedMessage 'not newer than current Stable' -Action { & $generator @sameCore | Out-Null }

  $staleUrl = $validParameters.Clone()
  $staleUrl.AssetUrl = 'https://github.com/SirTidez/simm/releases/download/v0.8.7-beta.1/SIMM_0.8.6_Setup.exe'
  Assert-Fails -ExpectedMessage "expected 'SIMM_0.8.7-beta.1_Setup.exe'" -Action { & $generator @staleUrl | Out-Null }

  Write-Output 'Updater manifest generator fixture checks passed.'
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove fixture directory outside the system temp directory: $resolvedTestRoot"
  }
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
