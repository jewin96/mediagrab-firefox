<#
  MediaGrab Companion installer.
  Builds the native messaging host, locates/installs FFmpeg, registers the host with Firefox (HKCU, both registry
  views) using absolute paths, then verifies everything and prints PASS/FAIL.

  Normally started through Install-Companion.cmd. Parameters exist mainly for testing:
    -InstallRoot   where the host is installed       (default %LOCALAPPDATA%\MediaGrabCompanion)
    -HostName      native messaging host name        (default com.mediagrab.host)
    -ExtensionId   override the ID read from ..\extension\manifest.json
    -AlsoAllow     extra extension IDs allowed to use the host (e.g. a development build's temporary ID)
    -FfmpegPath    use this ffmpeg.exe
    -SkipFfmpegInstall   never call winget
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$HostName = 'com.mediagrab.host',
    [string]$ExtensionId = '',
    [string[]]$AlsoAllow = @(),
    [string]$FfmpegPath = '',
    [switch]$SkipFfmpegInstall
)

$ErrorActionPreference = 'Stop'
$CompanionDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $CompanionDir 'MediaGrab-Common.ps1')
if (-not $InstallRoot) { $InstallRoot = Get-DefaultInstallRoot }

$results = [ordered]@{}
function Step([string]$Text) { Write-Host ''; Write-Host "[$Text]" -ForegroundColor Cyan }
function Pass([string]$Text) { Write-Host "  PASS  $Text" -ForegroundColor Green }
function Info([string]$Text) { Write-Host "        $Text" }
function Warn([string]$Text) { Write-Host "  WARN  $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  FAIL  $Text" -ForegroundColor Red }
function Stop-Install([string]$Text) { Fail $Text; throw "INSTALL_ABORTED: $Text" }

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$logFile = Join-Path $InstallRoot 'install.log'
try { Start-Transcript -Path $logFile -Force | Out-Null } catch { }

try {
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host 'MediaGrab Companion Installation' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan

    # ---- 1/2. own directory + required files -------------------------------------------------------
    Step '1/9  Checking installer files'
    Info "Installer folder : $CompanionDir"
    Info "Install folder   : $InstallRoot"
    $source = Join-Path $CompanionDir 'MediaGrabHost.cs'
    foreach ($f in 'MediaGrabHost.cs', 'MediaGrab-Common.ps1') {
        if (-not (Test-Path -LiteralPath (Join-Path $CompanionDir $f))) { Stop-Install "required file missing: $f" }
    }
    Pass 'required files present'

    # ---- 3. build host ---------------------------------------------------------------------------
    Step '2/9  Building the native host'
    $csc = Get-CscPath
    if (-not $csc) { Stop-Install '.NET Framework 4 compiler (csc.exe) not found under %WINDIR%\Microsoft.NET. Enable ".NET Framework 4.8 Advanced Services" in Windows Features.' }
    Info "Compiler         : $csc"
    $hostExe = Join-Path $InstallRoot 'MediaGrabHost.exe'
    $newExe = Join-Path $InstallRoot 'MediaGrabHost.new.exe'
    if (Test-Path -LiteralPath $newExe) { Remove-Item -LiteralPath $newExe -Force }
    $cscArgs = @('/nologo', '/target:exe', '/optimize+', "/out:$newExe",
        '/r:System.dll', '/r:System.Core.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', $source)
    $buildOut = & $csc @cscArgs 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $newExe)) {
        $buildOut | ForEach-Object { Write-Host "        $_" }
        Stop-Install 'host compilation failed'
    }
    try {
        Move-Item -LiteralPath $newExe -Destination $hostExe -Force
    } catch {
        Remove-Item -LiteralPath $newExe -Force -ErrorAction SilentlyContinue
        Stop-Install "could not replace $hostExe (Firefox is probably running it). Close ALL Firefox windows and run the installer again."
    }
    Pass "built $hostExe"
    $results['Host build'] = 'PASS'

    # ---- 4. FFmpeg -------------------------------------------------------------------------------
    Step '3/9  Locating FFmpeg'
    $bundled = @($CompanionDir, $InstallRoot)
    $ff = Find-Ffmpeg -Hint $FfmpegPath -BundledDirs $bundled
    if (-not $ff -and -not $SkipFfmpegInstall) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Warn 'FFmpeg not found. Installing Gyan.FFmpeg with winget (this downloads about 100 MB)...'
            & $winget.Source install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements
            Info "winget exit code: $LASTEXITCODE"
            Update-SessionPath
            $ff = Find-Ffmpeg -Hint $FfmpegPath -BundledDirs $bundled   # never assume the install worked: re-verify
            if (-not $ff) {
                # winget can keep a stale "already installed" record after the files were deleted; force a reinstall.
                Warn 'FFmpeg still not found (winget may hold a stale record). Retrying with --force...'
                & $winget.Source install --id Gyan.FFmpeg -e --force --silent --accept-source-agreements --accept-package-agreements
                Info "winget exit code: $LASTEXITCODE"
                Update-SessionPath
                $ff = Find-Ffmpeg -Hint $FfmpegPath -BundledDirs $bundled
            }
        } else {
            Warn 'winget is not available on this PC.'
        }
    }
    if (-not $ff) {
        Stop-Install 'FFmpeg could not be found or installed. Install it manually (https://www.gyan.dev/ffmpeg/builds/ or "winget install Gyan.FFmpeg"), or copy ffmpeg.exe to companion\bin\, then run this installer again.'
    }
    Pass "ffmpeg -version works: $($ff.Version)"
    Info "FFmpeg path      : $($ff.Path)"
    $results['FFmpeg self-test'] = 'PASS'

    # Store the resolved path so the host never has to search the disk.
    $config = [ordered]@{ ffmpegPath = $ff.Path; ffmpegVersion = $ff.Version; installedAt = (Get-Date).ToString('o') }
    [System.IO.File]::WriteAllText((Join-Path $InstallRoot 'config.json'), ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

    # ---- 5. extension ID -------------------------------------------------------------------------
    Step '4/9  Determining the Firefox extension ID'
    if ($ExtensionId) { $extId = $ExtensionId; $extSrc = '-ExtensionId parameter' }
    else { $e = Get-ExtensionIdFromProject $CompanionDir; $extId = $e.Id; $extSrc = $e.Source }
    Pass "extension ID: $extId"
    Info "source: $extSrc"

    # ---- 6/7. native host manifest (absolute paths, UTF-8 without BOM) ---------------------------------
    Step '5/9  Writing the native host manifest'
    $manifestPath = Join-Path $InstallRoot "$HostName.json"
    $manifest = [ordered]@{
        name               = $HostName
        description        = 'MediaGrab Companion (FFmpeg bridge)'
        path               = $hostExe
        type               = 'stdio'
        allowed_extensions = @(@($extId) + @($AlsoAllow | Where-Object { $_ }) | Select-Object -Unique)
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $bytes = [System.IO.File]::ReadAllBytes($manifestPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { Stop-Install 'manifest was written with a BOM' }
    $back = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($back.name -ne $HostName -or $back.path -ne $hostExe -or $back.allowed_extensions -notcontains $extId -or -not [System.IO.Path]::IsPathRooted($back.path)) {
        Stop-Install 'manifest failed read-back validation'
    }
    Pass "wrote $manifestPath"

    # ---- 8/9. registry ------------------------------------------------------------------------------
    Step '6/9  Registering with Firefox (HKCU\Software\Mozilla\NativeMessagingHosts)'
    Set-HostRegistry -HostName $HostName -ManifestPath $manifestPath
    $regRows = Get-HostRegistry -HostName $HostName | Where-Object { $_.Hive -eq 'HKCU' }
    $regOk = $true
    foreach ($row in $regRows) {
        if ($row.Value -eq $manifestPath) { Pass "$($row.Key)  [$($row.View)]" } else { Fail "$($row.Key) [$($row.View)] = '$($row.Value)'"; $regOk = $false }
    }
    if (-not $regOk) { Stop-Install 'registry verification failed' }
    $results['Registry'] = 'PASS'

    Step '7/9  Verifying files'
    if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-Install 'host manifest missing' }
    if (-not (Test-Path -LiteralPath $hostExe)) { Stop-Install 'host executable missing' }
    Pass 'host manifest and executable exist'

    # ---- 12. self-test ------------------------------------------------------------------------------
    Step '8/9  Running the native host self-test (real framed ping/pong over stdin/stdout)'
    $t = Test-NativeHost -HostExe $hostExe -ManifestPath $manifestPath -ExtensionId $extId
    if (-not $t.Pass) { Fail $t.Reason; Stop-Install "native host self-test failed: $($t.Reason)" }
    Pass "ping -> pong (host $($t.Pong.version)); bad scheme rejected; stdout clean; clean exit"
    Info "host reports FFmpeg: $($t.Pong.ffmpeg)"
    if (-not $t.Pong.ffmpegFound) { Stop-Install 'host started but cannot run FFmpeg' }
    $results['Native host self-test'] = 'PASS'

    Step '9/9  Firefox'
    $fx = Get-FirefoxInfo
    if ($fx) { Pass "Firefox $($fx.Version) at $($fx.Path)" } else { Warn 'Firefox installation not found in the usual places (not a problem if you use a portable/other build).' }
    $running = @(Get-Process firefox -ErrorAction SilentlyContinue).Count
    if ($running) { Warn "Firefox is running ($running processes)." }

    # ---- summary ------------------------------------------------------------------------------------
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host 'MediaGrab Companion Installation' -ForegroundColor Green
    Write-Host '========================================' -ForegroundColor Green
    Write-Host "Extension ID: $extId"
    Write-Host "Host name: $HostName"
    Write-Host "Manifest: $manifestPath"
    Write-Host "Host executable: $hostExe"
    Write-Host "FFmpeg: $($ff.Path)"
    Write-Host "Registry: $($results['Registry'])"
    Write-Host "Native host self-test: $($results['Native host self-test'])"
    Write-Host "FFmpeg self-test: $($results['FFmpeg self-test'])"
    Write-Host ''
    Write-Host 'INSTALLATION SUCCESSFUL' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Close ALL Firefox windows and reopen Firefox.' -ForegroundColor Yellow
    Write-Host 'Then open about:debugging#/runtime/this-firefox, click Load Temporary Add-on... and pick extension\manifest.json'
    Write-Host '(or click Reload beside MediaGrab if it is already loaded).'
    Write-Host "Install log: $logFile"
    $exitCode = 0
} catch {
    $msg = $_.Exception.Message
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Red
    Write-Host 'MediaGrab Companion Installation' -ForegroundColor Red
    Write-Host '========================================' -ForegroundColor Red
    foreach ($k in $results.Keys) { Write-Host "$k`: $($results[$k])" }
    Write-Host "INSTALLATION FAILED: $($msg -replace '^INSTALL_ABORTED: ', '')" -ForegroundColor Red
    Write-Host "Run Diagnose-Companion.cmd for details. Install log: $logFile"
    $exitCode = 1
} finally {
    try { Stop-Transcript | Out-Null } catch { }
}
exit $exitCode
