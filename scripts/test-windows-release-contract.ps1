$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installerPath = Join-Path $repoRoot 'src-tauri\windows\installer.nsi'
$installer = Get-Content -LiteralPath $installerPath -Raw

foreach ($forbidden in @('PREREQ_DOTNET', 'EnsureDotNetDesktopRuntime', 'DetectDotNetDesktopRuntime', 'windowsdesktop-runtime-6.0.19')) {
  if ($installer.Contains($forbidden, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Windows installer still contains the obsolete .NET prerequisite marker '$forbidden'."
  }
}

$downloadIndex = $installer.IndexOf('NSISdl::download "${PREREQ_VCREDIST_URL}"', [StringComparison]::Ordinal)
$verifyIndex = $installer.IndexOf('Call VerifyVCRedistSignature', [StringComparison]::Ordinal)
$executeIndex = $installer.IndexOf('ExecWait ''"$PrereqCacheDir\${PREREQ_VCREDIST_FILENAME}"', [StringComparison]::Ordinal)
if ($downloadIndex -lt 0 -or $verifyIndex -lt 0 -or $executeIndex -lt 0 -or -not ($downloadIndex -lt $verifyIndex -and $verifyIndex -lt $executeIndex)) {
  throw 'VC++ prerequisite must be downloaded, Authenticode-verified, and only then executed.'
}
if (-not $installer.Contains("SignerCertificate.Subject.Split('','').Trim() -contains ''O=Microsoft Corporation''", [StringComparison]::Ordinal)) {
  throw 'VC++ prerequisite verification must require the Microsoft Corporation signer.'
}

$signingScripts = @(
  'scripts\prepare-windows-signing.ps1',
  'scripts\verify-windows-signatures.ps1'
)
foreach ($relativePath in $signingScripts) {
  $path = Join-Path $repoRoot $relativePath
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -ne 0) {
    throw "Windows signing script '$relativePath' has PowerShell parse errors: $($errors -join '; ')"
  }
}

Write-Output 'Windows release security contract checks passed.'
