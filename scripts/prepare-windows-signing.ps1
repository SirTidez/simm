[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ConfigPath,

  [Parameter(Mandatory = $true)]
  [string] $CertificateBase64,

  [Parameter(Mandatory = $true)]
  [string] $CertificatePassword,

  [Parameter(Mandatory = $true)]
  [string] $CertificatePath,

  [string] $GithubEnvPath = $env:GITHUB_ENV
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CertificateBase64) -or [string]::IsNullOrWhiteSpace($CertificatePassword)) {
  throw 'Windows release signing requires WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD.'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Tauri configuration was not found: $ConfigPath"
}
if ([string]::IsNullOrWhiteSpace($GithubEnvPath)) {
  throw 'GITHUB_ENV is required so later release steps can verify the expected certificate.'
}

try {
  $certificateBytes = [Convert]::FromBase64String($CertificateBase64)
} catch {
  throw 'WINDOWS_CERTIFICATE is not valid base64.'
}

[IO.File]::WriteAllBytes($CertificatePath, $certificateBytes)
$securePassword = ConvertTo-SecureString -String $CertificatePassword -AsPlainText -Force
$imported = @(Import-PfxCertificate `
  -FilePath $CertificatePath `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -Password $securePassword)

$signingCertificates = @($imported | Where-Object {
  $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId.Value -contains '1.3.6.1.5.5.7.3.3')
})
if ($signingCertificates.Count -ne 1) {
  throw "Expected exactly one imported code-signing certificate with a private key, found $($signingCertificates.Count)."
}

$thumbprint = $signingCertificates[0].Thumbprint.ToUpperInvariant()
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $config.ContainsKey('bundle') -or $null -eq $config.bundle) {
  $config.bundle = @{}
}
if (-not $config.bundle.ContainsKey('windows') -or $null -eq $config.bundle.windows) {
  $config.bundle.windows = @{}
}
$config.bundle.windows.certificateThumbprint = $thumbprint
$config.bundle.windows.digestAlgorithm = 'sha256'
$config.bundle.windows.timestampUrl = 'http://timestamp.digicert.com'
$config | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $ConfigPath -Encoding utf8NoBOM

"SIMM_WINDOWS_SIGNING_THUMBPRINT=$thumbprint" | Out-File -FilePath $GithubEnvPath -Append -Encoding utf8
Write-Output 'Configured fail-closed Windows Authenticode signing.'
