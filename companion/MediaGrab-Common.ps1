# Shared helpers for Install-/Diagnose-/Uninstall-Companion. Dot-source this file; it has no side effects.
# Written for Windows PowerShell 5.1 (powershell.exe) and PowerShell 7.

$Script:DefaultHostName    = 'com.mediagrab.host'
$Script:DefaultExtensionId = '{f9a06230-a51a-48bd-adc7-0c9eba38962d}'

function Get-DefaultInstallRoot { Join-Path $env:LOCALAPPDATA 'MediaGrabCompanion' }

# The extension ID is read from the extension's own manifest.json so the two can never drift apart.
function Get-ExtensionIdFromProject {
    param([string]$CompanionDir)
    $manifest = Join-Path (Split-Path -Parent $CompanionDir) 'extension\manifest.json'
    if (Test-Path -LiteralPath $manifest) {
        try {
            $m = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
            $id = $m.browser_specific_settings.gecko.id
            if ($id) { return [pscustomobject]@{ Id = [string]$id; Source = $manifest } }
        } catch { }
    }
    [pscustomobject]@{ Id = $Script:DefaultExtensionId; Source = '(built-in default; extension\manifest.json not found)' }
}

function Get-FirefoxInfo {
    $candidates = @()
    foreach ($root in 'HKLM:\SOFTWARE\Mozilla\Mozilla Firefox', 'HKLM:\SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox') {
        if (Test-Path $root) {
            $ver = (Get-ItemProperty $root -ErrorAction SilentlyContinue).CurrentVersion
            if ($ver) {
                $main = Join-Path $root "$ver\Main"
                $exe = (Get-ItemProperty $main -ErrorAction SilentlyContinue).'PathToExe'
                if ($exe) { $candidates += $exe }
            }
        }
    }
    $candidates += "$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe", "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe"
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            return [pscustomobject]@{ Path = $c; Version = (Get-Item -LiteralPath $c).VersionInfo.ProductVersion }
        }
    }
    $null
}

# ---------------------------------------------------------------- FFmpeg

function Test-FfmpegExe {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        # Capture everything first: cutting the pipeline short (Select-Object -First 1) leaves $LASTEXITCODE unset.
        $lines = @(& $Path -hide_banner -version 2>&1)
        $code = $LASTEXITCODE
        $first = "$($lines | Select-Object -First 1)".Trim()
        if ($code -eq 0 -and $first -match 'ffmpeg version') { return $first }
    } catch { }
    $null
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($machine, $user) | Where-Object { $_ }) -join ';'
}

# Order: explicit hint -> bundled -> PATH -> WinGet -> common manual locations. Returns the first that really runs.
function Find-Ffmpeg {
    param([string]$Hint, [string[]]$BundledDirs = @())
    $cands = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $cands.Add($Hint) }
    foreach ($d in $BundledDirs) { $cands.Add((Join-Path $d 'bin\ffmpeg.exe')) }
    foreach ($c in @(Get-Command ffmpeg.exe -All -ErrorAction SilentlyContinue)) { if ($c.Source) { $cands.Add($c.Source) } }
    $wg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet'
    $cands.Add((Join-Path $wg 'Links\ffmpeg.exe'))
    $pk = Join-Path $wg 'Packages'
    if (Test-Path $pk) {
        foreach ($d in @(Get-ChildItem $pk -Directory -Filter '*FFmpeg*' -ErrorAction SilentlyContinue)) {
            foreach ($f in @(Get-ChildItem $d.FullName -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue)) { $cands.Add($f.FullName) }
        }
    }
    foreach ($p in 'C:\ffmpeg\bin\ffmpeg.exe', "$env:ProgramFiles\ffmpeg\bin\ffmpeg.exe", 'C:\ProgramData\chocolatey\bin\ffmpeg.exe', "$env:USERPROFILE\scoop\shims\ffmpeg.exe") { $cands.Add($p) }
    foreach ($c in $cands) {
        $v = Test-FfmpegExe $c
        if ($v) { return [pscustomobject]@{ Path = (Resolve-Path -LiteralPath $c).Path; Version = $v } }
    }
    $null
}

# ---------------------------------------------------------------- registry

$Script:RegViews = @('Registry64', 'Registry32')

function Get-RegSubPath { param([string]$HostName) "Software\Mozilla\NativeMessagingHosts\$HostName" }

function Set-HostRegistry {
    param([string]$HostName, [string]$ManifestPath)
    foreach ($view in $Script:RegViews) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]$view)
        try {
            $key = $base.CreateSubKey((Get-RegSubPath $HostName))
            $key.SetValue('', $ManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
            $key.Close()
        } finally { $base.Close() }
    }
}

function Get-HostRegistry {
    param([string]$HostName)
    $out = @()
    foreach ($hive in 'CurrentUser', 'LocalMachine') {
        foreach ($view in $Script:RegViews) {
            $sub = if ($hive -eq 'LocalMachine') { 'SOFTWARE\Mozilla\NativeMessagingHosts\' + $HostName } else { Get-RegSubPath $HostName }
            $val = $null
            try {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]$view)
                $k = $base.OpenSubKey($sub)
                if ($k) { $val = $k.GetValue(''); $k.Close() }
                $base.Close()
            } catch { }
            $short = if ($hive -eq 'CurrentUser') { 'HKCU' } else { 'HKLM' }
            $out += [pscustomobject]@{ Hive = $short; View = $view; Key = "$short\$sub"; Value = $val }
        }
    }
    $out
}

function Remove-HostRegistry {
    param([string]$HostName)
    foreach ($view in $Script:RegViews) {
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]$view)
            $base.DeleteSubKeyTree((Get-RegSubPath $HostName), $false)
            $base.Close()
        } catch { }
    }
}

# ---------------------------------------------------------------- native host protocol test

function Read-Exact {
    param([System.IO.Stream]$Stream, [int]$Count, [int]$TimeoutMs)
    $buf = New-Object byte[] $Count
    $off = 0
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($off -lt $Count) {
        $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($left -le 0) { throw "timed out after $TimeoutMs ms waiting for $Count bytes (got $off)" }
        $task = $Stream.ReadAsync($buf, $off, $Count - $off)
        if (-not $task.Wait($left)) { throw "timed out after $TimeoutMs ms waiting for $Count bytes (got $off)" }
        if ($task.Result -le 0) { throw "host closed stdout after $off of $Count bytes" }
        $off += $task.Result
    }
    , $buf
}

# Talks to the host exactly like Firefox does: 4-byte little-endian length + UTF-8 JSON, over stdin/stdout.
# Returns replies, whether stdout carried ONLY well-formed packets, and the process exit code.
function Invoke-HostConversation {
    param([string]$HostExe, [object[]]$Messages, [int]$TimeoutMs = 10000, [string]$ManifestPath = '', [string]$ExtensionId = '', [hashtable]$Env = @{})
    $result = [ordered]@{ Ok = $false; Replies = @(); StdoutClean = $false; ExitCode = $null; Error = ''; StderrText = '' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $HostExe
    # Firefox starts native hosts as:  host.exe <manifest path> <extension id>
    $psi.Arguments = ('"{0}" "{1}"' -f $ManifestPath, $ExtensionId).Trim()
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    # .NET's redirected stdin writer emits the console encoding's preamble (a UTF-8 BOM) when the process starts; that
    # would corrupt the binary length header. Firefox does not do this, so use a preamble-free encoding while starting.
    $savedInputEncoding = $null
    try { $savedInputEncoding = [Console]::InputEncoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[$k] = [string]$Env[$k] }
    $p = $null
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        if ($savedInputEncoding) { try { [Console]::InputEncoding = $savedInputEncoding } catch { } }
        $in = $p.StandardInput.BaseStream
        $out = $p.StandardOutput.BaseStream
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $replies = @()
        foreach ($m in $Messages) {
            $body = $utf8.GetBytes(($m | ConvertTo-Json -Compress -Depth 6))
            $len = [BitConverter]::GetBytes([int]$body.Length)         # little-endian on Windows
            $in.Write($len, 0, 4); $in.Write($body, 0, $body.Length); $in.Flush()
            $hdr = Read-Exact $out 4 $TimeoutMs
            $n = [BitConverter]::ToUInt32($hdr, 0)
            if ($n -eq 0 -or $n -gt 1048576) { throw "implausible reply length $n (stdout is not clean protocol data)" }
            $payload = Read-Exact $out ([int]$n) $TimeoutMs
            $replies += ($utf8.GetString($payload) | ConvertFrom-Json)
        }
        $result.Replies = $replies
        $p.StandardInput.Close()
        if (-not $p.WaitForExit(8000)) { try { $p.Kill() } catch { }; throw 'host did not exit after stdin was closed' }
        $result.ExitCode = $p.ExitCode
        # Anything left on stdout after the expected packets would corrupt Firefox's stream.
        $leftover = $out.ReadAsync((New-Object byte[] 64), 0, 64)
        $result.StdoutClean = ($leftover.Wait(2000) -and $leftover.Result -eq 0)
        $result.StderrText = $p.StandardError.ReadToEnd()
        $result.Ok = $true
    } catch {
        $result.Error = $_.Exception.Message
        if ($p -and -not $p.HasExited) { try { $p.Kill() } catch { } }
    } finally {
        if ($savedInputEncoding) { try { [Console]::InputEncoding = $savedInputEncoding } catch { } }
    }
    [pscustomobject]$result
}

# ping -> pong, plus an invalid (file://) download which must be rejected with a protocol error.
function Test-NativeHost {
    param([string]$HostExe, [string]$ManifestPath = '', [string]$ExtensionId = '', [hashtable]$Env = @{})
    $r = [ordered]@{ Pass = $false; Reason = ''; Pong = $null; RejectsBadScheme = $false; StdoutClean = $false; Conversation = $null }
    if (-not (Test-Path -LiteralPath $HostExe)) { $r.Reason = "host executable missing: $HostExe"; return [pscustomobject]$r }
    $msgs = @(
        @{ action = 'ping'; reqId = 'selftest-1' },
        @{ action = 'download'; jobId = 'selftest-job-0001'; url = 'file:///C:/Windows/win.ini'; mode = 'video' }
    )
    $c = Invoke-HostConversation -HostExe $HostExe -Messages $msgs -ManifestPath $ManifestPath -ExtensionId $ExtensionId -Env $Env
    $r.Conversation = $c
    if (-not $c.Ok) { $r.Reason = $c.Error; return [pscustomobject]$r }
    $pong = $c.Replies[0]
    $r.Pong = $pong
    $r.StdoutClean = $c.StdoutClean
    if ($pong.action -ne 'pong' -or $pong.ok -ne $true) { $r.Reason = "ping did not return {ok:true, action:'pong'}"; return [pscustomobject]$r }
    if ($pong.reqId -ne 'selftest-1') { $r.Reason = 'pong did not echo reqId'; return [pscustomobject]$r }
    $rej = $c.Replies[1]
    $r.RejectsBadScheme = ($rej.type -eq 'error' -and $rej.code -eq 'bad_url' -and $rej.jobId -eq 'selftest-job-0001')
    if (-not $r.RejectsBadScheme) { $r.Reason = 'host accepted a file:// URL'; return [pscustomobject]$r }
    if (-not $c.StdoutClean) { $r.Reason = 'stdout contained extra bytes besides protocol packets'; return [pscustomobject]$r }
    if ($c.ExitCode -ne 0) { $r.Reason = "host exit code $($c.ExitCode)"; return [pscustomobject]$r }
    $r.Pass = $true
    [pscustomobject]$r
}

function Get-CscPath {
    foreach ($p in "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe", "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe") {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $null
}
