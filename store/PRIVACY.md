# MediaGrab privacy policy

_Last updated: 2026-10-04_

**MediaGrab does not collect, transmit or sell any personal data. It has no servers, accounts or analytics.**

## What the extension reads
To list downloadable media it observes, in your browser only:
- the addresses, content types and sizes of audio/video/stream requests made by the pages you visit;
- the page title and preview image of the tab you open the popup on;
- for a download you start: the request headers the page itself used for that media (Referer, User-Agent, Origin and Cookie), so the file can be fetched the same way your browser fetched it.

## Where that information goes
- It is kept in memory (and in Firefox's per-session extension storage) for the open tab and discarded when the tab is closed or navigates away.
- When you press Download on a stream, the media address and the headers above are sent **only to the MediaGrab Companion running on your own computer** (Firefox native messaging, a local process). The companion uses them to download that one stream from the website you are already visiting, with FFmpeg. Cookies are only sent to the stream's own host.
- Nothing is sent to the developers or to any third party. The extension itself contacts no server of its own. It makes requests only to the websites you are viewing (to read a stream's playlist/manifest and the size of a file you are about to download).

## What is stored
- Your per-website choices (for example "always download audio only on this site") in Firefox's local extension storage.
- The companion keeps a local log file (`%LOCALAPPDATA%\MediaGrabCompanion\mediagrab-host.log`) for troubleshooting. It never contains cookie values. You can delete it at any time.

## Permissions
See the extension description and the reviewer notes for why each permission is needed.

## Contact
(fill in an email address or issue-tracker link before publishing)
