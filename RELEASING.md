# Releasing MediaGrab on addons.mozilla.org

Everything below is prepared in this repository. The only things only you can do are the account steps (marked **YOU**).

## One-time
1. **YOU** Create a Mozilla developer account: https://addons.mozilla.org/developers/ (a Firefox Account; turn on 2FA).
2. **YOU** Decide where the companion download lives (e.g. a GitHub repository's Releases page). The listing must link to it.
3. **YOU** Fill the placeholders in `store/LISTING.md` and `store/PRIVACY.md` (support link / email). If you do not want "MediaGrab contributors" in `LICENSE`, change it.
4. The permanent extension ID is already set in `extension/manifest.json`: `{f9a06230-a51a-48bd-adc7-0c9eba38962d}`. **Never change it after the first upload.**

## Every release
1. Bump `"version"` in `extension/manifest.json` (must be higher than the last upload). If the native protocol changed, also bump `Version` in `companion/MediaGrabHost.cs` and `MIN_HOST_VERSION` in `extension/background.js`; the popup then tells users to update their companion.
2. Run the tests (see README "Testing"), then build:
   ```
   powershell -ExecutionPolicy Bypass -File tools\Build-Release.ps1
   ```
   This produces `dist\mediagrab-<version>.zip` (the add-on) and `dist\MediaGrab-Companion-<version>.zip` (the companion).
3. Optional but recommended - Mozilla's own validator (needs Node.js):
   ```
   npx addons-linter dist\mediagrab-<version>.zip
   ```
   The last run reported 0 errors, 0 warnings, 0 notices.
4. **YOU** Upload `dist\mediagrab-<version>.zip` at *Developer Hub → Submit a New Add-on → On this site* (listed). Choose Firefox. When asked about source code answer **No** (no build step, nothing minified). 
5. **YOU** In the listing form:
   - Name, summary, description, category: copy from `store/LISTING.md`.
   - Privacy policy: paste `store/PRIVACY.md`.
   - Notes to reviewer: paste `store/REVIEWER-NOTES.md`.
   - Screenshots: `store/screenshots/*.png` (1280x800).
   - Compatibility: **untick Firefox for Android** (native messaging does not exist there).
   - License: MIT (matches `LICENSE`) or your choice.
6. **YOU** Upload `dist\MediaGrab-Companion-<version>.zip` to the place you chose in step 2 and put its link in the listing's Homepage/Support field.
7. Wait for review. Mozilla may ask questions about the permissions or the companion; `store/REVIEWER-NOTES.md` has the answers.

## After it is approved
- Users install from the store link (permanent, auto-updating), then run `Install-Companion.cmd` from the companion zip once.
- The installer needs no extension folder: it defaults to the release extension ID. For a development build with a temporary ID, run `Install-Companion.cmd -AlsoAllow <temporary-id>`.
