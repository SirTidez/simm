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

$workflowPaths = @(
  '.github\workflows\windows-exe.yml',
  '.github\workflows\publish-release.yml',
  '.github\workflows\publish-beta-release.yml'
)
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

foreach ($relativeWorkflowPath in $workflowPaths) {
  $workflowPath = Join-Path $repoRoot $relativeWorkflowPath
  $workflow = Get-Content -LiteralPath $workflowPath -Raw
  foreach ($entry in $workflowRequirements.GetEnumerator()) {
    if (-not $workflow.Contains($entry.Key, [StringComparison]::Ordinal)) {
      throw "Workflow '$relativeWorkflowPath' does not $($entry.Value)."
    }
  }

  foreach ($forbidden in @('WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'prepare-windows-signing.ps1', 'SIMM_WINDOWS_SIGNING_THUMBPRINT')) {
    if ($workflow.Contains($forbidden, [StringComparison]::Ordinal)) {
      throw "Workflow '$relativeWorkflowPath' still references legacy PFX signing value '$forbidden'."
    }
  }

  $buildIndex = $workflow.IndexOf('Build Windows application', [StringComparison]::Ordinal)
  $signAppIndex = $workflow.IndexOf('Sign Windows application with Azure Artifact Signing', [StringComparison]::Ordinal)
  $bundleIndex = $workflow.IndexOf('Bundle signed Windows application', [StringComparison]::Ordinal)
  $signInstallerIndex = $workflow.IndexOf('Sign Windows installer with Azure Artifact Signing', [StringComparison]::Ordinal)
  $resignUpdaterIndex = $workflow.IndexOf('Regenerate Tauri updater signature', [StringComparison]::Ordinal)
  $prepareName = if ($relativeWorkflowPath.EndsWith('windows-exe.yml')) { 'Prepare Windows build assets' } else { 'Prepare Windows release assets' }
  $prepareIndex = $workflow.IndexOf($prepareName, [StringComparison]::Ordinal)
  if (-not ($buildIndex -ge 0 -and $buildIndex -lt $signAppIndex -and $signAppIndex -lt $bundleIndex -and $bundleIndex -lt $signInstallerIndex -and $signInstallerIndex -lt $resignUpdaterIndex -and $resignUpdaterIndex -lt $prepareIndex)) {
    throw "Workflow '$relativeWorkflowPath' must sign the app before bundling, then sign the installer before regenerating its Tauri updater signature."
  }
}

$manualWorkflowPath = Join-Path $repoRoot '.github\workflows\windows-exe.yml'
$manualWorkflow = (Get-Content -LiteralPath $manualWorkflowPath -Raw) -replace "`r`n", "`n"
$manualRequirements = [ordered]@{
  'name: Build Release Artifacts' = 'describe both target builds'
  '  build-windows:' = 'define a Windows artifact build'
  '  build-linux:' = 'define a Linux artifact build'
  '  validate-artifacts:' = 'define a combined artifact validation job'
  'bun run tauri:build:linux' = 'build Linux deb and AppImage packages'
  'validate-linux-desktop-mime.sh' = 'validate Linux desktop handlers'
  '--artifacts-only' = 'validate the complete updater artifact set'
  'SHA256SUMS' = 'generate cross-platform checksums'
  'SIMM_${{ needs.build-windows.outputs.version }}_Release_Artifacts' = 'upload one complete Windows and Linux artifact set'
}
foreach ($entry in $manualRequirements.GetEnumerator()) {
  if (-not $manualWorkflow.Contains($entry.Key, [StringComparison]::Ordinal)) {
    throw "Manual release workflow does not $($entry.Value)."
  }
}
if (-not $manualWorkflow.Contains("      - build-windows`n      - build-linux", [StringComparison]::Ordinal)) {
  throw 'Manual release workflow must wait for both platform builds before combined artifact validation.'
}

Write-Output 'Windows release security contract checks passed.'
