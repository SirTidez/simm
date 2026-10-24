$ErrorActionPreference='Stop'
foreach($fixtureCase in @('Modern','Numeric','NumericStable','Legacy','Fallback')) {
    & dotnet build (Join-Path $PSScriptRoot 'Fixture.csproj') --configuration Release --no-incremental '-p:RestoreSources=' "-p:Case=$fixtureCase" --verbosity quiet
    if($LASTEXITCODE -ne 0){throw "Fixture build failed: $fixtureCase"}
    $built=Join-Path $PSScriptRoot "../../../../target/diagnostics/melon-metadata-fixtures/bin/Fixture/$fixtureCase/net10.0/$fixtureCase.dll"
    Copy-Item -LiteralPath $built -Destination (Join-Path $PSScriptRoot "$fixtureCase.dll")
}
