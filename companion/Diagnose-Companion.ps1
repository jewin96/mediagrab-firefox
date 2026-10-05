<#
  MediaGrab Companion diagnostics. Prints everything needed to find out why Firefox shows
  "MediaGrab Companion disconnected", and ends with a list of FAILED checks.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$HostName = 'com.mediagrab.host',
    [switch]$NoPause
)
$ErrorActionPreference = 'Continue'
$CompanionDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $CompanionDir 'MediaGrab-Common.ps1')
if (-not $InstallRoot) { $InstallRoot = Get-DefaultInstallRoot }

$failures = New-Object System.Collections.Generic.List[string]
function Section([string]$t) { Write-Host ''; Write-Host "=== $t" -ForegroundColor Cyan }
function Row([string]$k, $v) { Write-Host ("{0,-26} {1}" -f $k, $v) }
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host ("  PASS  {0}" -f $name) -ForegroundColor Green }
    else { Write-Host ("  FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red; $failures.Add("$name $detail".Trim()) }
}

Write-Host '########################################' -ForegroundColor Cyan
Write-Host ' MediaGrab Companion diagnostics' -ForegroundColor Cyan
Write-Host '########################################' -ForegroundColor Cyan

Section 'System'
Row 'Windows' ([Environment]::OSVersion.VersionString + $(if ([Environment]::Is64BitOperatingSystem) { ' (64-bit)' } else { ' (32-bit)' }))
Row 'PowerShell' $PSVersionTable.PSVersion
$fx = Get-FirefoxInfo
if ($fx) { Row 'Firefox' "$($fx.Version)  $($fx.Path)" } else { Row 'Firefox' 'not found in the usual locations' }
Row 'Firefox processes running' @(Get-Process firefox -ErrorAction SilentlyContinue).Count

Section 'Expected identifiers'
$ext = Get-ExtensionIdFromProject $CompanionDir
Row 'Extension ID (expected)' $ext.Id
Row '  read from' $ext.Source
Row 'Native host name' $HostName
$regSub = Get-RegSubPath $HostName
Row 'Registry key' "HKCU\$regSub   (default value = path of the host manifest)"
Row 'Install folder' $InstallRoot

Section 'Registry (all views)'
$regRows = Get-HostRegistry -HostName $HostName
foreach ($r in $regRows) { Row "$($r.Hive) [$($r.View)]" $(if ($r.Value) { $r.Value } else { '(not present)' }) }
$hkcu = $regRows | Where-Object { $_.Hive -eq 'HKCU' -and $_.Value }
Check 'HKCU registry key exists' ([bool]$hkcu) "-> run Install-Companion.cmd (key HKCU\$regSub is missing)"
$manifestPath = ''
if ($hkcu) { $manifestPath = ($hkcu | Select-Object -First 1).Value }
$hklm = $regRows | Where-Object { $_.Hive -eq 'HKLM' -and $_.Value }
if ($hklm) { Write-Host '  NOTE  an HKLM entry also exists; HKCU wins in Firefox, but make sure the HKLM one is not stale.' -ForegroundColor Yellow }

Section 'Native host manifest'
$expectedManifest = Join-Path $InstallRoot "$HostName.json"
Row 'Registered path' $(if ($manifestPath) { $manifestPath } else { '(none)' })
Row 'Expected path' $expectedManifest
$mp = if ($manifestPath) { $manifestPath } else { $expectedManifest }
Check 'Manifest file exists' (Test-Path -LiteralPath $mp) $mp
$hostExe = ''
$allowed = @()
if (Test-Path -LiteralPath $mp) {
    Write-Host '--- manifest contents ---'
    Get-Content -LiteralPath $mp -Raw
    Write-Host '--- end ---'
    $bytes = [System.IO.File]::ReadAllBytes($mp)
    Check 'Manifest has no UTF-8 BOM' (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) '(Firefox rejects BOM-prefixed JSON)'
    try {
        $m = Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
        $hostExe = [string]$m.path
        $allowed = @($m.allowed_extensions)
        Check 'name matches host name' ($m.name -eq $HostName) "name='$($m.name)' expected '$HostName'"
        Check 'type is stdio' ($m.type -eq 'stdio') "type='$($m.type)'"
        Check 'path is absolute' ([System.IO.Path]::IsPathRooted($hostExe) -and $hostExe -match '^[A-Za-z]:\\') "path='$hostExe'"
        Check 'allowed_extensions contains the extension ID' ($allowed -contains $ext.Id) "allowed=[$($allowed -join ', ')] expected '$($ext.Id)'"
    } catch { Check 'Manifest is valid JSON' $false $_.Exception.Message }
}

Section 'Host executable'
Row 'Path' $(if ($hostExe) { $hostExe } else { '(unknown)' })
Check 'Host executable exists' ($hostExe -and (Test-Path -LiteralPath $hostExe)) $hostExe
Check 'config.json exists' (Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json')) '(installer writes the FFmpeg path here)'

Section 'FFmpeg'
$cfgFf = ''
$cfgPath = Join-Path $InstallRoot 'config.json'
if (Test-Path -LiteralPath $cfgPath) { try { $cfgFf = (Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json).ffmpegPath } catch { } }
Row 'config.json ffmpegPath' $(if ($cfgFf) { $cfgFf } else { '(none)' })
$ff = Find-Ffmpeg -Hint $cfgFf -BundledDirs @($CompanionDir, $InstallRoot)
Check 'ffmpeg.exe found and runs' ([bool]$ff) '-> run Install-Companion.cmd (it installs FFmpeg with winget)'
if ($ff) { Row 'Resolved path' $ff.Path; Row 'ffmpeg -version' $ff.Version }
if ($cfgFf) { Check 'config.json ffmpegPath is valid' ([bool](Test-FfmpegExe $cfgFf)) $cfgFf }

Section 'Host self-test (same framing Firefox uses)'
if ($hostExe -and (Test-Path -LiteralPath $hostExe)) {
    $t = Test-NativeHost -HostExe $hostExe -ManifestPath $mp -ExtensionId $ext.Id
    Check 'ping -> pong' ($t.Pong -and $t.Pong.action -eq 'pong' -and $t.Pong.ok -eq $true) $t.Reason
    if ($t.Pong) { Row '  host version' $t.Pong.version; Row '  host ffmpeg' $t.Pong.ffmpeg; Row '  ffmpeg version' $t.Pong.ffmpegVersion }
    Check 'rejects non-http(s) URLs' $t.RejectsBadScheme $t.Reason
    Check 'stdout carries only protocol packets' $t.StdoutClean $t.Reason
    Check 'host exits cleanly when stdin closes' ($t.Conversation -and $t.Conversation.ExitCode -eq 0) $t.Reason
    if ($t.Conversation -and $t.Conversation.StderrText) { Write-Host "  stderr: $($t.Conversation.StderrText.Trim())" }
} else { Check 'Host self-test' $false 'host executable missing' }

Section 'Recent companion log (last 30 lines)'
$log = Join-Path $InstallRoot 'mediagrab-host.log'
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 30 } else { Write-Host '(no log yet: the host has never been started by Firefox or the self-test)' }

Write-Host ''
Write-Host '########################################' -ForegroundColor Cyan
if ($failures.Count -eq 0) {
    Write-Host ' RESULT: ALL CHECKS PASSED' -ForegroundColor Green
    Write-Host ' If the popup still says "disconnected": close ALL Firefox windows, reopen Firefox, then Reload MediaGrab in about:debugging.' -ForegroundColor Yellow
} else {
    Write-Host " RESULT: $($failures.Count) CHECK(S) FAILED" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
}
Write-Host '########################################' -ForegroundColor Cyan
if (-not $NoPause -and [Environment]::UserInteractive -and $env:MEDIAGRAB_NOPAUSE -ne '1') { Read-Host 'Press Enter to close' | Out-Null }
exit $(if ($failures.Count -eq 0) { 0 } else { 1 })
