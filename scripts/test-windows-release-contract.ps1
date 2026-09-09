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

$workflowPath = Join-Path $repoRoot '.github\workflows\windows-exe.yml'
$workflow = Get-Content -LiteralPath $workflowPath -Raw
$workflowRequirements = [ordered]@{
  'id-token: write' = 'grant the Windows signing job OIDC token permission'
  'azure/login@v3' = 'authenticate to Azure with OIDC'
  'azure/artifact-signing-action@v2' = 'use the official Azure Artifact Signing action'
  'AZURE_ARTIFACT_SIGNING_ENDPOINT' = 'use the region-specific Artifact Signing endpoint'
  'WINDOWS_SIGNING_SUBJECT' = 'pin the expected public certificate subject'
  'Build Windows application' = 'build the application before bundling'
  'Sign Windows application with Azure Artifact Signing' = 'sign the application executable before NSIS packaging'
  'Bundle signed Windows application' = 'bundle the signed application into NSIS'
  'Sign Windows installer with Azure Artifact Signing' = 'sign the completed NSIS installer'
  'Regenerate Tauri updater signature' = 'regenerate updater signing after Authenticode changes the installer'
  'TAURI_SIGNING_PRIVATE_KEY' = 'retain mandatory Tauri updater signing'
  '-ExpectedSubject' = 'verify the Artifact Signing publisher identity'
}
foreach ($entry in $workflowRequirements.GetEnumerator()) {
  if (-not $workflow.Contains($entry.Key, [StringComparison]::Ordinal)) {
    throw "Windows signing-test workflow does not $($entry.Value)."
  }
}

$buildIndex = $workflow.IndexOf('Build Windows application', [StringComparison]::Ordinal)
$signAppIndex = $workflow.IndexOf('Sign Windows application with Azure Artifact Signing', [StringComparison]::Ordinal)
$bundleIndex = $workflow.IndexOf('Bundle signed Windows application', [StringComparison]::Ordinal)
$signInstallerIndex = $workflow.IndexOf('Sign Windows installer with Azure Artifact Signing', [StringComparison]::Ordinal)
$resignUpdaterIndex = $workflow.IndexOf('Regenerate Tauri updater signature', [StringComparison]::Ordinal)
$prepareIndex = $workflow.IndexOf('Prepare setup wizard artifact', [StringComparison]::Ordinal)
if (-not ($buildIndex -lt $signAppIndex -and $signAppIndex -lt $bundleIndex -and $bundleIndex -lt $signInstallerIndex -and $signInstallerIndex -lt $resignUpdaterIndex -and $resignUpdaterIndex -lt $prepareIndex)) {
  throw 'Windows signing-test workflow must sign the app before bundling, then sign the installer before regenerating its Tauri updater signature.'
}

Write-Output 'Windows release security contract checks passed.'
