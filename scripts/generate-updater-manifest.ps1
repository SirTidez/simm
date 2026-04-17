param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$AssetUrl,

  [Parameter(Mandatory = $true)]
  [string]$SignaturePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$Notes = "",

  [object]$PubDate = $null
)

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

$signature = (Get-Content -LiteralPath $SignaturePath -Raw).Trim()
if (-not $signature) {
  throw "Signature file '$SignaturePath' was empty."
}

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
  }
}

$outputDir = Split-Path -Parent $OutputPath
if ($outputDir) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
