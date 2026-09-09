[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]] $Path,

  [string] $ExpectedThumbprint,

  [string] $ExpectedSubject
)

$ErrorActionPreference = 'Stop'

function ConvertTo-NormalizedCertificateSubject {
  param([Parameter(Mandatory = $true)][string] $Subject)

  $components = @($Subject -split '(?<!\\),' | ForEach-Object { $_.Trim().ToUpperInvariant() } | Sort-Object)
  return $components -join ','
}

$normalizedThumbprint = if ([string]::IsNullOrWhiteSpace($ExpectedThumbprint)) {
  ''
} else {
  $ExpectedThumbprint.Replace(' ', '').ToUpperInvariant()
}
$normalizedSubject = if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) {
  ''
} else {
  ConvertTo-NormalizedCertificateSubject -Subject $ExpectedSubject
}
if (-not $normalizedThumbprint -and -not $normalizedSubject) {
  throw 'An expected Authenticode certificate thumbprint or subject is required.'
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

  if ($normalizedThumbprint) {
    $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
    if ($actualThumbprint -cne $normalizedThumbprint) {
      throw "Authenticode signer for '$candidate' did not match the expected release certificate thumbprint."
    }
  }

  if ($normalizedSubject) {
    $actualSubject = ConvertTo-NormalizedCertificateSubject -Subject $signature.SignerCertificate.Subject
    if ($actualSubject -cne $normalizedSubject) {
      throw "Authenticode signer for '$candidate' did not match the expected release certificate subject. Expected '$ExpectedSubject', found '$($signature.SignerCertificate.Subject)'."
    }
  }

  Write-Output "Verified Authenticode signature and signer identity: $candidate"
}
