# MediaGrab 1.0.1 — Firefox extension + Windows companion

## Install (for users)

1. **Add-on:** install MediaGrab from the Firefox Add-ons store (Firefox 140 or newer). Plain video/audio files work right away.
2. **Companion (needed for HLS/DASH streams and MP3 extraction), Windows only:** download
   `MediaGrab-Companion-<version>.zip` from the [latest release](../../releases/latest), extract it, and double-click
   `Install-Companion.cmd`. It installs FFmpeg if needed and ends with `INSTALLATION SUCCESSFUL`.
3. Close all Firefox windows, reopen Firefox, and open the MediaGrab popup: the bottom-left light should be green
   ("Companion connected"). If it is red, run `Diagnose-Companion.cmd` from the same folder.

MediaGrab never bypasses DRM or encryption, paywalls or logins. Only save media you are allowed to save.

---

Detects ordinary, non-DRM media that Firefox can legitimately access and saves it:

* direct files (mp4, webm, m4v, mov, mp3, m4a, aac, ogg, opus, wav) through Firefox's own Downloads API;
* **HLS (`.m3u8`) and DASH (`.mpd`)** through a small Windows companion that drives FFmpeg.

Clean-room code. It does **not** bypass DRM/EME, decrypt protected streams, or get around paywalls or logins.
Protected streams (FAIRPLAY/SAMPLE-AES, any DASH `ContentProtection`, Widevine/PlayReady key formats) are detected and
refused with a clear message.

## Layout

```
extension/            the Firefox add-on (load extension\manifest.json)
  background.js         detection, grouping, job tracking, one persistent native-messaging port
  content.js            page title / poster / duration + <video>/<audio> discovery
  lib/util.js           pure helpers shared by background, popup, content and the tests
  popup/                popup UI
companion/            Windows native-messaging host
  MediaGrabHost.cs      the host (compiled by the installer with the .NET Framework compiler that ships with Windows)
  Install-Companion.cmd / .ps1     build + FFmpeg + manifest + registry + self-test
  Diagnose-Companion.cmd / .ps1    prints everything needed to debug "disconnected"
  Uninstall-Companion.cmd / .ps1
  MediaGrab-Common.ps1  shared installer functions
tests/                automated tests (see "Testing")
```

## Install

1. **Companion** (needed for HLS/DASH and audio extraction): double-click
   `companion\Install-Companion.cmd`. It builds the host, finds or installs FFmpeg (winget `Gyan.FFmpeg`, then re-verifies
   with `ffmpeg -version`), writes the host manifest with absolute paths, registers it for Firefox, and runs a real
   framed ping/pong self-test. It must end with `INSTALLATION SUCCESSFUL`.
   Everything is installed per-user in `%LOCALAPPDATA%\MediaGrabCompanion` (no admin rights needed).
2. **Close ALL Firefox windows and reopen Firefox.**
3. In Firefox open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `extension\manifest.json`.
   (Temporary add-ons disappear when Firefox restarts; after a restart load it again, or click **Reload**.)
4. Open the MediaGrab popup. The bottom-left indicator must read **green "Companion connected · FFmpeg x.y"**.
   Click the indicator to re-test the connection; if it is red, the text and tooltip say why.

If anything is red, run `companion\Diagnose-Companion.cmd`; it checks every link of the chain and ends with a list of
failed checks.

## Using it

Play the video, open the popup. Each entry shows thumbnail, page title, a type badge (VIDEO / AUDIO / HLS / DASH),
MIME type, size (or duration-based estimate for HLS), shortened URL, a purple **Download** button and a drop-down:

| Menu entry | Effect |
|---|---|
| Download Audio & Video | normal download (direct file via Firefox, stream via FFmpeg `-c copy` into MP4) |
| Download As… | Firefox's save dialog (direct) / Windows save dialog from the companion (streams) |
| Always Download As… | make that the main button's behaviour for this website |
| Download Audio | MP3 (`libmp3lame -q:a 2`) via FFmpeg; already-audio direct files are downloaded as-is |
| Always audio only for this website | main button = audio |
| Copy URL / Always copy URL | copy the media URL |
| Smartnaming ✓ | name files after the page/video title (default on); off = name from the URL |
| Details | type, MIME, how it was found, qualities, protection status, full URL |

HLS master playlists show a **Quality** list built from the playlist itself (e.g. Best / 1080p / 720p / 360p) — only
qualities that really exist are offered. Streams with **several audio tracks** (original + dubbed / auto-translated / audio-description, common on YouTube) get an
**Audio** list. *Automatic* picks the original track (by its name, YouTube's `YT-EXT-XTAGS` tag, then the playlist default)
and avoids dubs and descriptions; choose another language there if you want it. The Details panel lists every track.
"Best" lets FFmpeg pick the highest stream (one video + one audio, never every
variant). Separate audio renditions are merged automatically.

**Only real files are listed.** Direct audio/video under 100 KB (page sound effects such as YouTube's `open.mp3`/`success.mp3`)
is ignored: the size comes from the response headers, or from a 1-byte range request when the page scan found the file
without a size. Segments of adaptive streams, and "playlists" that turn out to be HTML error pages, are never listed.
**One entry per stream.** Players often request the same stream several times and fetch every rendition playlist right
after the master. Renditions of a master (matched by host and path, ignoring query strings, or fetched on the master's
host right after it) are hidden, and repeats of the same stream (same host, same duration) collapse into the richest one.
**Single-page sites (YouTube):** when you move to another video without a page reload, the list is cleared, and the
title and thumbnail follow the page instead of the stale `og:` tags from the first page that was loaded. The Details
panel says whether an entry is a master or media playlist (variant / segment counts).

**Speed.** While a download runs, its live speed (e.g. `↓ 12.4 MB/s`, hover for Mbit/s) is shown beside the progress bar,
the combined speed of all active downloads is shown in the footer, and the average speed stays on the row when it finishes.

Files are saved to `Downloads\MediaGrab\` with Windows-safe names; collisions get ` (1)`, ` (2)`…
Progress, finished and failed states appear on the entry and survive closing/reopening the popup. A running download can
be cancelled; a **live** stream shows *Stop & save*.

## Why it said "MediaGrab Companion disconnected" (0.2.x)

`Install-Companion.cmd` launched `Install-Companion.ps1`, which did not exist in the package. The installer therefore
never ran: no host was compiled, no manifest written and no `HKCU\Software\Mozilla\NativeMessagingHosts\com.mediagrab.host`
key created, so Firefox answered `No such native application`. 0.3.0 ships the installer, verifies each step, and the
popup now sends a real ping and shows the actual reason when it fails. The old host also had real bugs that would have
bitten once connected (FFmpeg inherited Firefox's stdin, `-map 0:v?` copied *every* HLS variant, Windows-illegal characters
in titles crashed the file-name code); all fixed and covered by tests.

## Native messaging details

* Host name `com.mediagrab.host`; extension ID `{f9a06230-a51a-48bd-adc7-0c9eba38962d}` (read from `extension\manifest.json` by the
  installer and written to `allowed_extensions`).
* Registry (per-user, written in both registry views):
  `HKCU\Software\Mozilla\NativeMessagingHosts\com.mediagrab.host` → `%LOCALAPPDATA%\MediaGrabCompanion\com.mediagrab.host.json`.
  This is Firefox's location; it is *not* Chrome's `Google\Chrome\NativeMessagingHosts`.
* Framing: 4-byte little-endian length + UTF-8 JSON, both directions. stdout carries only packets; logging goes to
  `%LOCALAPPDATA%\MediaGrabCompanion\mediagrab-host.log` (cookie values are never logged).
* FFmpeg path is resolved once by the installer and stored in `config.json` (host fallback: bundled `bin\ffmpeg.exe`,
  `PATH`, WinGet).

Requests (`reqId` is echoed):

```json
{"action":"ping","reqId":"…"}
→ {"ok":true,"action":"pong","version":"1.0.0","ffmpegFound":true,"ffmpeg":"…","ffmpegVersion":"…","reqId":"…"}

{"action":"download","jobId":"<uuid>","url":"https://…","kind":"hls|dash|file","mode":"video|audio",
 "title":"…","filename":"…","referer":"…","userAgent":"…","cookie":"…","origin":"…",
 "audioUrl":"https://… (optional separate audio rendition)","outputDirectory":"C:\\…","saveAs":false,"durationSeconds":123}
→ {"type":"started","jobId":"…"}
→ {"type":"progress","jobId":"…","percent":42.5,"status":"Downloading… 43%"}      (percent is null when unknown)
→ {"type":"completed","jobId":"…","file":"C:\\…\\name.mp4","size":123456,"percent":100}
→ {"type":"error","jobId":"…","code":"drm|http_403|http_404|bad_url|cancelled|…","message":"…"}

{"action":"cancel","jobId":"…","save":false}      (save:true = stop a live recording and keep it)
```

Security: the extension sends structured JSON only; the host builds an argument **array** itself (proper Windows
quoting, no shell, no `cmd.exe`). Only `http:`/`https:` URLs are accepted (also for referer/origin/audio URL); FFmpeg
runs with `-protocol_whitelist http,https,tcp,tls,crypto`, so a malicious playlist cannot read local files. File names
are sanitized (illegal characters, trailing dots/spaces, reserved names, length) and the extension is forced, so
nothing executable can be written. The cookie is passed through FFmpeg's domain-scoped `-cookies` (not `-headers`), so
it is not replayed to other hosts in the playlist. FFmpeg children live in a kill-on-close Job Object, so they die with
the host even if Firefox force-kills it.

## HLS / DASH behaviour

* **Fast HLS:** the companion downloads the playlist's segments itself over **16 parallel connections** (retrying failed
  ones), keeps AES-128 keys and init sections locally, and then lets FFmpeg merge the local files with no network access
  (`-protocol_whitelist file,crypto`). FFmpeg alone fetches segments one at a time, which is what made big streams slow.
  Change the connection count (1-64) with `"connections": N` in `%LOCALAPPDATA%\MediaGrabCompanion\config.json`.
  Playlists that need FFmpeg's own handling (byte ranges, live, SAMPLE-AES, ...) automatically use the sequential path.
* DASH and direct files are not parallelised: DASH goes through FFmpeg's single connection, and direct files use Firefox's
  own downloader.

* Playlists are fetched first (with the page's Referer / User-Agent / Cookie / Origin) to detect DRM, live streams and
  the real duration (for percentages). HTML error pages and expired links give a clear message.
* HLS `AES-128` with an openly served key is ordinary HLS and is left to FFmpeg. `SAMPLE-AES` and DRM key formats are
  refused.
* Streams are remuxed without re-encoding (`-c copy`, `+faststart`); if a codec cannot live in MP4 (e.g. VP9/Opus DASH)
  the host automatically retries once as `.mkv`.
* Live streams are captured to MPEG-TS flushed packet by packet and remuxed to MP4 when you press *Stop & save* (or the
  stream ends).

## Testing

```
node --check extension\background.js extension\content.js extension\lib\util.js extension\popup\popup.js
node tests\test-util.js          # naming, classification, segment grouping, HLS/DASH parsing
node tests\test-host.js          # builds the host, speaks the Firefox protocol, runs real FFmpeg on a local server
node tests\test-background.js    # the real background.js + real host + FFmpeg with a mocked browser API
node tests\e2e-firefox.js        # separate headless Firefox + real popup (needs the companion installed)
```

Set `TEST_TMP` to a scratch folder. `test-host.js` and `e2e-firefox.js` need FFmpeg (found via `config.json`).

## Publishing

`RELEASING.md` is the checklist for addons.mozilla.org: `tools\Build-Release.ps1` builds the add-on zip and the companion zip,
`store\` holds the listing text, privacy policy, reviewer notes and screenshots, and `LICENSE` is MIT. Requires Firefox 140+
(needed for the "collects no data" declaration the store now asks for).

## Known limitations

* The Windows *Save As* dialog used by "Download As…" for streams is UI and was not exercised by the automated tests.
* Sites that bind a stream to short-lived tokens, per-request signatures or IP can fail even though the browser plays
  them; the error message says so (HTTP 401/403/404).
* Cookies are only sent to the manifest's own host (by design). Streams whose segments need cookies on a different host
  will fail with 403.
* Firefox temporary add-ons must be re-loaded after each Firefox restart (a signed/AMO build removes that step).
* Windows only; the host needs the .NET Framework 4.x compiler that ships with Windows 10/11.
