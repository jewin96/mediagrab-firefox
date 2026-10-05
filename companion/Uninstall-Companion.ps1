[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$HostName = 'com.mediagrab.host'
)
$ErrorActionPreference = 'Continue'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'MediaGrab-Common.ps1')
if (-not $InstallRoot) { $InstallRoot = Get-DefaultInstallRoot }

Remove-HostRegistry -HostName $HostName
Write-Host "Removed Firefox registration HKCU\$(Get-RegSubPath $HostName)" -ForegroundColor Green

if (Test-Path -LiteralPath $InstallRoot) {
    Get-Process MediaGrabHost -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallRoot*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $InstallRoot) { Write-Host "Could not delete $InstallRoot (close Firefox and retry)." -ForegroundColor Yellow }
    else { Write-Host "Removed $InstallRoot" -ForegroundColor Green }
}
Write-Host 'MediaGrab Companion removed. FFmpeg (if winget installed it) was left in place.'
