param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidateSet("Stable", "Beta")]
  [string]$Channel,

  [Parameter(Mandatory = $true)]
  [string]$PackageVersion,

  [string]$MinimumVersion = "",

  [Parameter(Mandatory = $true)]
  [string]$AssetUrl,

  [Parameter(Mandatory = $true)]
  [string]$SignaturePath,

  [Parameter(Mandatory = $true)]
  [string]$LinuxAssetUrl,

  [Parameter(Mandatory = $true)]
  [string]$LinuxSignaturePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$Notes = "",

  [object]$PubDate = $null
)

function ConvertFrom-FullSemVer {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $pattern = '^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
  $match = [regex]::Match($Value.Trim(), $pattern)
  if (-not $match.Success) {
    throw "Version '$Value' is not a full SemVer value. Expected MAJOR.MINOR.PATCH with an optional prerelease suffix."
  }

  $prerelease = @()
  if ($match.Groups['pre'].Success) {
    $prerelease = @($match.Groups['pre'].Value.Split('.'))
    foreach ($identifier in $prerelease) {
      if ($identifier -match '^\d+$' -and $identifier.Length -gt 1 -and $identifier.StartsWith('0')) {
        throw "Version '$Value' has a numeric prerelease identifier with a leading zero."
      }
    }
  }

  return [pscustomobject]@{
    Raw = $Value.Trim()
    Major = [long]$match.Groups['major'].Value
    Minor = [long]$match.Groups['minor'].Value
    Patch = [long]$match.Groups['patch'].Value
    Prerelease = $prerelease
  }
}

function Compare-SemVerPrecedence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Left,

    [Parameter(Mandatory = $true)]
    [string]$Right
  )

  $leftVersion = ConvertFrom-FullSemVer -Value $Left
  $rightVersion = ConvertFrom-FullSemVer -Value $Right
  foreach ($part in @('Major', 'Minor', 'Patch')) {
    if ($leftVersion.$part -gt $rightVersion.$part) { return 1 }
    if ($leftVersion.$part -lt $rightVersion.$part) { return -1 }
  }

  if ($leftVersion.Prerelease.Count -eq 0 -and $rightVersion.Prerelease.Count -eq 0) { return 0 }
  if ($leftVersion.Prerelease.Count -eq 0) { return 1 }
  if ($rightVersion.Prerelease.Count -eq 0) { return -1 }

  $sharedLength = [Math]::Min($leftVersion.Prerelease.Count, $rightVersion.Prerelease.Count)
  for ($index = 0; $index -lt $sharedLength; $index++) {
    $leftIdentifier = $leftVersion.Prerelease[$index]
    $rightIdentifier = $rightVersion.Prerelease[$index]
    if ($leftIdentifier -ceq $rightIdentifier) { continue }

    $leftNumber = 0L
    $rightNumber = 0L
    $leftIsNumber = [long]::TryParse($leftIdentifier, [ref]$leftNumber)
    $rightIsNumber = [long]::TryParse($rightIdentifier, [ref]$rightNumber)
    if ($leftIsNumber -and $rightIsNumber) {
      return $(if ($leftNumber -gt $rightNumber) { 1 } else { -1 })
    }
    if ($leftIsNumber -ne $rightIsNumber) {
      return $(if ($leftIsNumber) { -1 } else { 1 })
    }
    return $(if ([string]::CompareOrdinal($leftIdentifier, $rightIdentifier) -gt 0) { 1 } else { -1 })
  }

  if ($leftVersion.Prerelease.Count -eq $rightVersion.Prerelease.Count) { return 0 }
  return $(if ($leftVersion.Prerelease.Count -gt $rightVersion.Prerelease.Count) { 1 } else { -1 })
}

function Assert-ReleaseAssetUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedFileName,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedTag
  )

  $uri = [Uri]$Url
  if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'github.com') {
    throw "Updater asset URL must be an HTTPS GitHub release URL: '$Url'."
  }
  $actualFileName = [Uri]::UnescapeDataString([IO.Path]::GetFileName($uri.AbsolutePath))
  if ($actualFileName -cne $ExpectedFileName) {
    throw "Updater asset URL names '$actualFileName', expected '$ExpectedFileName'."
  }
  if (-not $uri.AbsolutePath.Contains("/releases/download/${ExpectedTag}/")) {
    throw "Updater asset URL must use release tag '$ExpectedTag': '$Url'."
  }
}

function Convert-ToIso8601UtcString {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return ""
  }

  $raw = [string]$Value
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return ""
  }

  if ($Value -is [DateTimeOffset]) {
    return $Value.ToUniversalTime().ToString("o")
  }

  if ($Value -is [DateTime]) {
    return ([DateTimeOffset]$Value).ToUniversalTime().ToString("o")
  }

  $styles = [System.Globalization.DateTimeStyles]::RoundtripKind
  $parsedOffset = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($raw, [System.Globalization.CultureInfo]::InvariantCulture, ($styles -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$parsedOffset)) {
    return $parsedOffset.ToUniversalTime().ToString("o")
  }

  $parsedDateTime = [DateTime]::MinValue
  if ([DateTime]::TryParse($raw, [System.Globalization.CultureInfo]::InvariantCulture, ([System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$parsedDateTime)) {
    return ([DateTimeOffset]$parsedDateTime).ToUniversalTime().ToString("o")
  }

  throw "PubDate '$raw' could not be converted to an ISO-8601 UTC timestamp."
}

function Read-SignatureFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $signature = (Get-Content -LiteralPath $Path -Raw).Trim()
  if (-not $signature) {
    throw "Signature file '$Path' was empty."
  }

  return $signature
}

$parsedVersion = ConvertFrom-FullSemVer -Value $Version
$parsedPackageVersion = ConvertFrom-FullSemVer -Value $PackageVersion
if ($parsedVersion.Raw -cne $parsedPackageVersion.Raw) {
  throw "Manifest version '$($parsedVersion.Raw)' does not match package version '$($parsedPackageVersion.Raw)'."
}
if ($Channel -ceq 'Stable' -and $parsedVersion.Prerelease.Count -ne 0) {
  throw "Stable manifests must not use a prerelease version: '$Version'."
}
if ($Channel -ceq 'Beta') {
  if ($parsedVersion.Prerelease.Count -eq 0) {
    throw "Beta manifests must use a full prerelease SemVer identity, such as 0.8.7-beta.1."
  }
  if ([string]::IsNullOrWhiteSpace($MinimumVersion)) {
    throw "Beta manifest generation requires MinimumVersion from the current Stable updater manifest."
  }
  if ((Compare-SemVerPrecedence -Left $Version -Right $MinimumVersion) -le 0) {
    throw "Beta version '$Version' is not newer than current Stable '$MinimumVersion'."
  }
}

$expectedTag = "v${Version}"
$expectedWindowsAsset = "SIMM_${Version}_Setup.exe"
$expectedLinuxAsset = "SIMM_${Version}_x86_64.AppImage"
Assert-ReleaseAssetUrl -Url $AssetUrl -ExpectedFileName $expectedWindowsAsset -ExpectedTag $expectedTag
Assert-ReleaseAssetUrl -Url $LinuxAssetUrl -ExpectedFileName $expectedLinuxAsset -ExpectedTag $expectedTag

$signature = Read-SignatureFile -Path $SignaturePath
$linuxSignature = Read-SignatureFile -Path $LinuxSignaturePath

if (-not $PubDate) {
  $PubDate = [DateTimeOffset]::UtcNow.ToString("o")
} else {
  $PubDate = Convert-ToIso8601UtcString -Value $PubDate
}

$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = $PubDate
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      url = $AssetUrl
      signature = $signature
    }
    "linux-x86_64" = [ordered]@{
      url = $LinuxAssetUrl
      signature = $linuxSignature
    }
  }
}

$outputDir = Split-Path -Parent $OutputPath
if ($outputDir) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
