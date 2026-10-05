<#
  Builds the two release files into .\dist :
    mediagrab-<version>.zip                 the Firefox add-on (upload this to addons.mozilla.org)
    MediaGrab-Companion-<version>.zip       the Windows companion (host source + installer) to host next to the add-on
  Entries use forward slashes (AMO rejects Windows-style paths, which Compress-Archive produces).
  Usage:  powershell -ExecutionPolicy Bypass -File tools\Build-Release.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$manifestPath = Join-Path $root 'extension\manifest.json'
$m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $m.version
$id = $m.browser_specific_settings.gecko.id
if (-not $id -or $id -match 'example\.invalid') { throw "manifest.json still has a placeholder extension ID: '$id'" }
if ($version -notmatch '^\d+(\.\d+){0,3}$') { throw "invalid version '$version'" }
foreach ($p in 'icons/icon-48.png', 'icons/icon-96.png', 'icons/icon-128.png', 'background.js', 'content.js', 'lib/util.js', 'popup/popup.html') {
    if (-not (Test-Path -LiteralPath (Join-Path $root "extension\$p"))) { throw "missing extension file: $p" }
}
$hostSrc = Get-Content -LiteralPath (Join-Path $root 'companion\MediaGrabHost.cs') -Raw
if ($hostSrc -notmatch 'Version = "([\d.]+)"') { throw 'cannot read host version' }
$hostVersion = $Matches[1]

function New-ZipFromFolder {
    param([string]$SourceDir, [string]$ZipPath, [string]$EntryPrefix = '', [string[]]$ExcludeNames = @(), [string[]]$ExcludePatterns = @())
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $base = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\')
        foreach ($f in Get-ChildItem -LiteralPath $base -Recurse -File | Sort-Object FullName) {
            if ($ExcludeNames -contains $f.Name) { continue }
            $skip = $false; foreach ($pat in $ExcludePatterns) { if ($f.Name -like $pat) { $skip = $true } }
            if ($skip) { continue }
            $rel = $f.FullName.Substring($base.Length + 1).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $EntryPrefix + $rel, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }
}

$extZip = Join-Path $dist "mediagrab-$version.zip"
New-ZipFromFolder -SourceDir (Join-Path $root 'extension') -ZipPath $extZip -ExcludeNames @('README.md', 'Thumbs.db', '.DS_Store')

$compZip = Join-Path $dist "MediaGrab-Companion-$hostVersion.zip"
New-ZipFromFolder -SourceDir (Join-Path $root 'companion') -ZipPath $compZip -EntryPrefix 'MediaGrab-Companion/' -ExcludePatterns @('*.log', '*.exe', '*.old')

foreach ($z in $extZip, $compZip) {
    $a = [System.IO.Compression.ZipFile]::OpenRead($z)
    try {
        if ($a.Entries | Where-Object { $_.FullName -match '\\' }) { throw "$z contains backslash paths" }
        Write-Host ("{0}  ({1:N0} bytes, {2} files)" -f $z, (Get-Item $z).Length, $a.Entries.Count) -ForegroundColor Green
    } finally { $a.Dispose() }
    Write-Host ("  SHA256 " + (Get-FileHash -LiteralPath $z -Algorithm SHA256).Hash)
}
$a = [System.IO.Compression.ZipFile]::OpenRead($extZip)
try { if (-not ($a.Entries | Where-Object { $_.FullName -eq 'manifest.json' })) { throw 'manifest.json is not at the root of the add-on zip' } } finally { $a.Dispose() }
Write-Host "Add-on $version  id=$id   companion host $hostVersion" -ForegroundColor Cyan
