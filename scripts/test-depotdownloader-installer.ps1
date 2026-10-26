param(
  [string]$MakeNsis,
  [string]$InstallerPath,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Installer execution tests require Windows.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $InstallerPath) { $InstallerPath = Join-Path $repoRoot 'src-tauri/windows/installer.nsi' }
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repoRoot ("target/installer tests/" + [guid]::NewGuid())
}
if (-not $MakeNsis) {
  $compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($compiler) { $MakeNsis = $compiler.Source }
  foreach ($candidate in @(
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "$env:ProgramFiles\NSIS\makensis.exe",
    "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
  )) {
    if (-not $MakeNsis -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $MakeNsis = $candidate }
  }
}
if (-not $MakeNsis) { throw 'NSIS compiler not found. Pass -MakeNsis or install NSIS.' }

$installer = Get-Content -LiteralPath $InstallerPath -Raw
function Read-InstallerFunction([string]$Name, [switch]$Optional) {
  $match = [regex]::Match($installer, '(?ms)^Function ' + [regex]::Escape($Name) + '\r?\n.*?^FunctionEnd')
  if (-not $match.Success -and -not $Optional) { throw "Installer function missing: $Name" }
  return $match.Value
}

# Exercise the production functions, not a second implementation of detection.
# Only filesystem roots, UI flushing and the external WinGet process are isolated.
$functions = @(
  (Read-InstallerFunction 'FindDepotDownloaderInWinGetRoot' -Optional),
  (Read-InstallerFunction 'DetectDepotDownloader'),
  (Read-InstallerFunction 'ShowDepotDownloaderInstallHelp' -Optional),
  (Read-InstallerFunction 'EnsureDepotDownloader'),
  (Read-InstallerFunction 'AppendPrereqLog')
) -join "`n"
$functions = $functions.Replace('$LOCALAPPDATA', '$EXEDIR\local').Replace('$PROGRAMFILES64', '$EXEDIR\program64').Replace('$PROGRAMFILES32', '$EXEDIR\program32').Replace('$PROGRAMFILES', '$EXEDIR\program')

$cases = @(
  @{ Name='missing'; Result=0; Install=$true },
  @{ Name='manual-user-tools'; File='local/SIMM/tools/DepotDownloader/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='user-link'; File='local/Microsoft/WinGet/Links/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='user-package'; File='local/Microsoft/WinGet/Packages/SteamRE.DepotDownloader_alternate-source/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='machine64-link'; File='program64/WinGet/Links/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='machine64-package'; File='program64/WinGet/Packages/SteamRE.DepotDownloader_Microsoft.Winget.Source_8wekyb3d8bbwe/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='machine32-package'; File='program32/WinGet/Packages/SteamRE.DepotDownloader_alternate-source/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='manual64'; File='program64/DepotDownloader/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='manual32'; File='program32/DepotDownloader/DepotDownloader.exe'; Result=1; Install=$false },
  @{ Name='directory-is-not-executable'; Directory='local/Microsoft/WinGet/Links/DepotDownloader.exe'; Result=0; Install=$true },
  @{ Name='unrelated-package'; File='local/Microsoft/WinGet/Packages/Other.DepotDownloader_source/DepotDownloader.exe'; Result=0; Install=$true },
  @{ Name='install-failure'; ExitCode=37; Output='WinGet source unavailable (fixture)'; Error='WinGet source unavailable (fixture)'; Result=0; Install=$true },
  @{ Name='long-install-failure'; ExitCode=42; Output=(('WinGet diagnostic output. ' * 16) + 'Fixture final failure code 42'); Error='Fixture final failure code 42'; Result=0; Install=$true },
  @{ Name='install-success-without-file'; ExitCode=0; Output='WinGet completed but no executable was written (fixture)'; Error='WinGet completed but no executable was written (fixture)'; Result=0; Install=$true },
  @{ Name='install-success'; ExitCode=0; Output='Installed (fixture)'; CreateFile=$true; Result=1; Install=$true }
)

foreach ($case in $cases) {
  $caseDirectory = Join-Path $OutputDirectory $case.Name
  New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
  $caseDirectory = (Resolve-Path -LiteralPath $caseDirectory).Path
  if ($case.Directory) { New-Item -ItemType Directory -Path (Join-Path $caseDirectory $case.Directory) -Force | Out-Null }
  if ($case.File) {
    $fixture = Join-Path $caseDirectory $case.File
    New-Item -ItemType Directory -Path (Split-Path $fixture) -Force | Out-Null
    Set-Content -LiteralPath $fixture -Value 'Presence fixture; never executed.'
  }

  $caseFunctions = $functions
  $wingetPath = '""'
  if ($case.ContainsKey('ExitCode')) {
    $wingetPath = '"fixture-winget"'
    $mockProcess = ''
    if ($case.CreateFile) {
      $mockProcess = @'
  CreateDirectory "$EXEDIR\local\Microsoft\WinGet\Links"
  FileOpen $R9 "$EXEDIR\local\Microsoft\WinGet\Links\DepotDownloader.exe" w
  FileWrite $R9 "Presence fixture; never executed."
  FileClose $R9
'@
    }
    $mockProcess += "`n  Push `"$($case.Output)`"`n  Push `"$($case.ExitCode)`""
    $processPattern = '(?m)^  nsExec::ExecToStack .*\$\{PREREQ_DEPOTDOWNLOADER_WINGET_ARGS\}.*$'
    if (-not [regex]::IsMatch($caseFunctions, $processPattern)) { throw 'WinGet invocation not found for process fixture.' }
    $caseFunctions = [regex]::Replace($caseFunctions, $processPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $mockProcess })
  }

  $header = @'
Unicode true
!include LogicLib.nsh
!include WinMessages.nsh
Name "SIMM DepotDownloader installer regression"
OutFile "probe.exe"
SilentInstall silent
RequestExecutionLevel user
SetCompress off
!define PREREQ_DEPOTDOWNLOADER_WINGET_ID "SteamRE.DepotDownloader"
!define PREREQ_DEPOTDOWNLOADER_WINGET_ARGS "fixture-only"
Var PassiveMode
Var PrereqLogBuffer
Var PrereqConsole
Var PrereqDepotDownloaderOutput
Section
  StrCpy $PassiveMode 1
  Call EnsureDepotDownloader
  Pop $0
  FileOpen $R9 "$EXEDIR\result.txt" w
  FileWrite $R9 "$0"
  FileClose $R9
  FileOpen $R9 "$EXEDIR\trace.txt" w
  FileWrite $R9 "$PrereqLogBuffer"
  FileClose $R9
SectionEnd
Function FlushInstallerWindow
FunctionEnd
Function SetDepotDownloaderText
  Pop $R9
FunctionEnd
Function GetWingetPath
  FileOpen $R9 "$EXEDIR\install-reached.txt" w
  FileWrite $R9 "Installation branch reached."
  FileClose $R9
  Push WINGET_PATH_FIXTURE
FunctionEnd
'@
  $header = $header.Replace('WINGET_PATH_FIXTURE', $wingetPath)
  $scriptPath = Join-Path $caseDirectory 'probe.nsi'
  Set-Content -LiteralPath $scriptPath -Value ($header + "`n" + $caseFunctions) -Encoding utf8
  & $MakeNsis /V2 $scriptPath *> (Join-Path $caseDirectory 'compile.log')
  if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed for $($case.Name). See $caseDirectory/compile.log" }

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $caseDirectory 'probe.exe'
  $start.WorkingDirectory = $caseDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.Environment['PATH'] = Join-Path $env:SystemRoot 'System32'
  $process = [System.Diagnostics.Process]::Start($start)
  try {
    if (-not $process.WaitForExit(15000)) { $process.Kill(); throw "Installer probe timed out: $($case.Name)" }
    if ($process.ExitCode -ne 0) { throw "Installer probe failed: $($case.Name), exit $($process.ExitCode)" }
  } finally { $process.Dispose() }
  $result = Get-Content -LiteralPath (Join-Path $caseDirectory 'result.txt') -Raw
  $reachedInstall = Test-Path -LiteralPath (Join-Path $caseDirectory 'install-reached.txt')
  if ($result -ne [string]$case.Result -or $reachedInstall -ne $case.Install) {
    throw "$($case.Name): expected installed=$($case.Result), install branch=$($case.Install); got installed=$result, install branch=$reachedInstall"
  }
  if ($case.Error) {
    $trace = Get-Content -LiteralPath (Join-Path $caseDirectory 'trace.txt') -Raw
    if (-not $trace.Contains($case.Error)) { throw "$($case.Name): original WinGet output was lost." }
  }
  if ($case.Result -eq 0) {
    $trace = Get-Content -LiteralPath (Join-Path $caseDirectory 'trace.txt') -Raw
    if (-not $trace.Contains('DepotDownloader-windows-x64.zip') -or -not $trace.Contains('SIMM\tools\DepotDownloader')) {
      throw "$($case.Name): manual recovery instructions are missing."
    }
  }
  Write-Output "Passed: $($case.Name)"
}
Write-Output "$($cases.Count) DepotDownloader installer execution tests passed. Fixtures: $OutputDirectory"
