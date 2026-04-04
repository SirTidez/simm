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

  [string]$PubDate = ""
)

$signature = (Get-Content -LiteralPath $SignaturePath -Raw).Trim()
if (-not $signature) {
  throw "Signature file '$SignaturePath' was empty."
}

if (-not $PubDate) {
  $PubDate = [DateTimeOffset]::UtcNow.ToString("o")
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
