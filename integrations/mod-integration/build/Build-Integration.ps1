[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $MonoMelonLoaderAssembly,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $Il2CppMelonLoaderAssembly,

    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts')
)

$ErrorActionPreference = 'Stop'
$integrationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$solution = Join-Path $integrationRoot 'Simm.ModIntegration.sln'
$abstractionsProject = Join-Path $integrationRoot 'src\Simm.ModIntegration.Abstractions\Simm.ModIntegration.Abstractions.csproj'
$pluginProject = Join-Path $integrationRoot 'src\Simm.ModIntegration.Bridge.MelonLoader\Simm.ModIntegration.Bridge.MelonLoader.csproj'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)

dotnet test $solution -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'Portable bridge tests failed.' }

dotnet pack $abstractionsProject -c Release --nologo -o (Join-Path $resolvedOutput 'packages')
if ($LASTEXITCODE -ne 0) { throw 'Developer package creation failed.' }

$variants = @(
    @{
        Name = 'Mono'
        Framework = 'netstandard2.1'
        MelonLoader = [System.IO.Path]::GetFullPath($MonoMelonLoaderAssembly)
    },
    @{
        Name = 'IL2CPP'
        Framework = 'net6.0'
        MelonLoader = [System.IO.Path]::GetFullPath($Il2CppMelonLoaderAssembly)
    }
)

foreach ($variant in $variants) {
    dotnet build $pluginProject -c Release --nologo `
        "-p:RuntimeBackend=$($variant.Name)" `
        "-p:MelonLoaderAssembly=$($variant.MelonLoader)"
    if ($LASTEXITCODE -ne 0) { throw "$($variant.Name) bridge build failed." }

    $buildOutput = Join-Path $integrationRoot "src\Simm.ModIntegration.Bridge.MelonLoader\bin\$($variant.Name)\Release\$($variant.Framework)"
    $variantOutput = Join-Path $resolvedOutput $variant.Name
    $pluginsOutput = Join-Path $variantOutput 'Plugins'
    $userLibsOutput = Join-Path $variantOutput 'UserLibs'
    New-Item -ItemType Directory -Force -Path $pluginsOutput, $userLibsOutput | Out-Null

    Copy-Item -LiteralPath (Join-Path $buildOutput 'Simm.ModIntegration.Bridge.MelonLoader.dll') -Destination $pluginsOutput -Force
    Copy-Item -LiteralPath (Join-Path $buildOutput 'Simm.ModIntegration.Bridge.Core.dll') -Destination $userLibsOutput -Force
    Copy-Item -LiteralPath (Join-Path $buildOutput 'Simm.ModIntegration.Abstractions.dll') -Destination $userLibsOutput -Force
}

Write-Host "SIMM mod integration artifacts staged at $resolvedOutput"
