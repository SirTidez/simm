[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]] $Path,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedThumbprint
)

$ErrorActionPreference = 'Stop'
$normalizedThumbprint = $ExpectedThumbprint.Replace(' ', '').ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($normalizedThumbprint)) {
  throw 'An expected Authenticode certificate thumbprint is required.'
}

foreach ($candidate in $Path) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Signed Windows artifact was not found: $candidate"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $candidate
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature for '$candidate' is not valid: $($signature.Status) $($signature.StatusMessage)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signature for '$candidate' does not contain a signer certificate."
  }

  $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
  if ($actualThumbprint -cne $normalizedThumbprint) {
    throw "Authenticode signer for '$candidate' did not match the release certificate."
  }

  Write-Output "Verified Authenticode signature: $candidate"
}
