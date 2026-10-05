# addons.mozilla.org listing — copy/paste texts

## Name
MediaGrab

## Summary (max 250 characters)
Detects video, audio and HLS/DASH streams on the page you are watching and saves them to your PC. Plain files use Firefox's downloader; streams use a small optional Windows companion with FFmpeg. No DRM bypass, no tracking.

## Categories
Download Management  (secondary: Photos, Music & Videos)

## Description

**MediaGrab finds the media on the page you are watching and lets you save it.**

Open the toolbar popup and every real video, audio file or stream on the page is listed with its title, thumbnail, type (VIDEO / AUDIO / HLS / DASH), format and size. Press **Download**.

**What it does**
- Detects mp4, webm, m4v, mov, mp3, m4a, aac, ogg, opus, wav, and HLS (.m3u8) and DASH (.mpd) streams.
- Shows one entry per stream, not hundreds of tiny segments. Page sound effects and other tiny files are ignored.
- Smart naming from the page or video title, safe Windows file names, saved to Downloads\MediaGrab.
- Quality list for HLS streams (only the qualities that really exist), with an estimated size for each.
- Audio-track list for streams that carry several languages; the original track is chosen automatically.
- "Download Audio" saves MP3. "Download As…", "Always Download As…", "Always audio only for this website", "Copy URL".
- Live progress, download speed, cancel, and a clear message when something fails.
- Fast: stream segments are downloaded over 16 parallel connections.

**Direct files** (mp4, mp3, …) are downloaded by Firefox itself. Nothing else is needed.

**HLS and DASH streams** need the free **MediaGrab Companion** for Windows (a small installer that sets up FFmpeg and a Firefox native-messaging host). The popup shows a green "Companion connected" light when it is ready and tells you exactly what is missing if it is not. Download it from the link in "Homepage" / "Support".

**What it will not do.** MediaGrab does not bypass DRM or encryption (Widevine, PlayReady, FairPlay, SAMPLE-AES, DASH ContentProtection), paywalls or logins. Protected streams are detected and refused. Only save media you are allowed to save.

**Privacy.** No accounts, no analytics, no remote servers. Everything stays on your computer. See the privacy policy.

## Version notes (1.0.0)
First public release.

## Homepage / Support site / Support email
(fill in: link to the page where the companion zip and instructions are hosted, and an email or issue tracker)

## License
(choose in the AMO form; the repository's LICENSE file is MIT)

## Privacy policy
Paste the contents of store/PRIVACY.md.

## Notes to the reviewer
Paste the contents of store/REVIEWER-NOTES.md.

## Screenshots
store/screenshots/*.png  (caption suggestions)
1. "Every real file on the page, one entry per stream"
2. "All the actions in one menu"
3. "Live progress and speed"
