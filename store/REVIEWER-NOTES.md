# Notes to the AMO reviewer

**Source code.** The submitted package is the source: plain JavaScript, no bundler, no minification, no transpiling, no remote or dynamically loaded code, no third-party libraries. `lib/util.js` is shared by the background script, content script and popup.

**What the add-on does.** It lists audio/video/HLS/DASH media found on the current tab and downloads it. Plain files go through `browser.downloads`. HLS/DASH streams (and MP3 extraction) go to an optional local helper over native messaging (`com.mediagrab.host`).

**The helper ("MediaGrab Companion", Windows).** Distributed separately (zip linked from the listing). Its installer compiles `MediaGrabHost.cs` on the user's PC with the .NET Framework compiler that ships with Windows, locates or installs FFmpeg with winget, writes the native-messaging manifest and registers it under `HKCU\Software\Mozilla\NativeMessagingHosts`. The host only accepts `http:`/`https:` URLs, builds FFmpeg argument arrays itself (no shell), restricts FFmpeg to `http,https,tcp,tls,crypto` (`file,crypto` for the local merge step), and refuses DRM-protected streams. The add-on works without it for plain files and shows a clear "Companion disconnected" state with instructions for streams.

**Data collection.** None. `data_collection_permissions.required = ["none"]`. Nothing leaves the user's machine except requests to the sites being viewed (see PRIVACY.md).

## Why each permission is needed
| Permission | Use |
|---|---|
| `webRequest` (+ `<all_urls>` host permission) | Observe response headers (`Content-Type`, `Content-Length`, `Content-Range`) and the request's `Referer`/`User-Agent`/`Cookie` of media requests, to detect media on any site and to repeat the request faithfully. Read-only; no blocking, no modification. |
| `<all_urls>` | The extension must work on whatever site the user is watching; it also fetches HLS/DASH manifests and probes file sizes (1-byte range request) from the site's own origin. Content script (`all_frames`) reads the page title, poster image and `<video>`/`<audio>` sources. |
| `nativeMessaging` | Talk to the local MediaGrab Companion (FFmpeg) for HLS/DASH and MP3. |
| `downloads` | Save plain media files to `Downloads/MediaGrab`, show progress and cancel. |
| `tabs` | Read the active tab's URL/title for naming files, group results per tab, clear results on navigation (`tabs.onUpdated`), rescan (`tabs.sendMessage`). |
| `storage` | Per-site preferences (local) and per-tab results (session). |
| `clipboardWrite` | "Copy URL" action in the popup. |

## How to test
1. Install the add-on. Open a page with a plain video or audio file (e.g. any page with an `<video src="….mp4">`) and click the toolbar button: the file is listed; **Download** saves it to Downloads/MediaGrab via Firefox. This path needs no companion.
2. For streams, install the companion (Install-Companion.cmd from the companion zip on the listing page), then open any page that plays an unencrypted HLS stream; the popup shows a green "Companion connected" indicator and an HLS entry.
3. Streams with DRM/`ContentProtection` are listed with a "DRM" badge and cannot be downloaded.
