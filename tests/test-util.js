// Unit tests for extension/lib/util.js (naming, classification, segment grouping, HLS/DASH parsing). node tests/test-util.js
"use strict";
const MG = require("../extension/lib/util.js");
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || "mismatch"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }

/* ---- file names ---- */
t("sanitizeFileName strips < > : \" / \\ | ? * and control chars", () => {
  eq(MG.sanitizeFileName('A<b>:c/d\\e|f?g*"h"\u0007i'), "A b c d e f g h i");
});
t("sanitizeFileName trims whitespace and trailing periods, keeps unicode", () => {
  eq(MG.sanitizeFileName("  Title...   "), "Title");
  eq(MG.sanitizeFileName("Caf\u00e9 \u2013 \u65e5\u672c\u8a9e. "), "Caf\u00e9 \u2013 \u65e5\u672c\u8a9e");
});
t("sanitizeFileName avoids reserved Windows device names and empty names", () => {
  eq(MG.sanitizeFileName("CON"), "_CON"); eq(MG.sanitizeFileName("nul.txt"), "_nul.txt"); eq(MG.sanitizeFileName("???"), "media"); eq(MG.sanitizeFileName(""), "media");
});
t("sanitizeFileName limits length", () => { eq(Array.from(MG.sanitizeFileName("x".repeat(500))).length, 150); });
t("smart naming: page title is used, never index.m3u8.mp4", () => {
  const item = { url: "https://cdn.example.com/a/b/index.m3u8?token=1", kind: "hls", pageTitle: "Adam Scott - Armchair Expert with Dax Shepard" };
  eq(MG.buildFileName(item, { smartname: true }), "Adam Scott - Armchair Expert with Dax Shepard.mp4");
  eq(MG.buildFileName(item, { audioOnly: true }), "Adam Scott - Armchair Expert with Dax Shepard.mp3");
});
t("smart naming off / no title: falls back to a useful URL name, then to the title, never 'index'", () => {
  eq(MG.buildFileName({ url: "https://x.com/videos/my-clip.mp4", kind: "video", pageTitle: "Page" }, { smartname: false }), "my-clip.mp4");
  eq(MG.buildFileName({ url: "https://x.com/v/index.m3u8", kind: "hls", pageTitle: "Page" }, { smartname: false }), "Page.mp4");
  eq(MG.buildFileName({ url: "https://x.com/v/index.m3u8", kind: "hls", pageTitle: "" }, { smartname: true }), "index.mp4"); // nothing better exists
});
t("direct files keep their real extension (mp4/webm/mp3/wav/m4a/aac/ogg/opus)", () => {
  for (const ext of ["mp4", "webm", "mp3", "wav", "m4a", "aac", "ogg", "opus", "mov", "m4v"])
    eq(MG.buildFileName({ url: `https://x.com/f.${ext}?a=1`, kind: ext === "mp3" ? "audio" : "video", pageTitle: "T" }), `T.${ext}`, ext);
  eq(MG.buildFileName({ url: "https://x.com/stream?id=1", kind: "video", contentType: "video/webm", pageTitle: "T" }), "T.webm");
});

/* ---- classification ---- */
t("mediaKind: all supported direct types + HLS + DASH", () => {
  for (const ext of ["mp4", "webm", "m4v", "mov"]) eq(MG.mediaKind(`https://x/a.${ext}`), "video", ext);
  for (const ext of ["mp3", "m4a", "aac", "ogg", "opus", "wav"]) eq(MG.mediaKind(`https://x/a.${ext}`), "audio", ext);
  eq(MG.mediaKind("https://x/a.m3u8?t=1"), "hls"); eq(MG.mediaKind("https://x/a", "application/vnd.apple.mpegurl; charset=utf-8"), "hls");
  eq(MG.mediaKind("https://x/a.mpd"), "dash"); eq(MG.mediaKind("https://x/a", "application/dash+xml"), "dash");
  eq(MG.mediaKind("https://x/a", "audio/mpeg"), "audio"); eq(MG.mediaKind("https://x/a", "video/mp4"), "video");
});
t("isCandidate rejects MPEG-TS segments and plain pages", () => {
  eq(MG.isCandidate("https://x/seg.ts", "video/mp2t"), false); eq(MG.isCandidate("https://x/page.html", "text/html"), false);
  eq(MG.isCandidate("https://x/x", "video/mp4"), true); eq(MG.isCandidate("https://x/a.m3u8", "text/plain"), true);
});
t("isSegmentLike groups away HLS/DASH pieces (ts, m4s, numbered chunks, init, tiny range probes)", () => {
  const seg = ["https://x/v/seg-12.ts", "https://x/v/chunk-stream0-00001.m4s", "https://x/v/init-stream0.m4s", "https://x/v/segment_004.mp4",
    "https://x/v/frag_5.m4a", "https://x/v/audio_00012.aac", "https://x/v/init.mp4", "https://x/v/sub.vtt", "https://x/v/a.mp4?sq=44"];
  for (const u of seg) eq(MG.isSegmentLike(u), true, u);
  eq(MG.isSegmentLike("https://x/movie.mp4", { partial: true, length: 4096 }), true, "tiny 206 probe");
  eq(MG.isSegmentLike("https://x/movie.mp4", { partial: true, length: 5_000_000 }), false, "big 206 with known total");
  for (const u of ["https://x/movie.mp4", "https://x/podcast-episode-2023.mp3", "https://x/index.m3u8", "https://x/manifest.mpd", "https://x/video_2023.mp4"]) eq(MG.isSegmentLike(u), false, u);
});
t("normalizeKey merges duplicate requests (fragment, range/cache-bust params), keeps real params", () => {
  eq(MG.normalizeKey("https://x/a.mp4?token=1&range=0-100&_=123#t=5"), "https://x/a.mp4?token=1");
  eq(MG.normalizeKey("https://x/a.mp4?token=1"), MG.normalizeKey("https://x/a.mp4?token=1&bytestart=500"));
  if (MG.normalizeKey("https://x/a.mp4?token=1") === MG.normalizeKey("https://x/a.mp4?token=2")) throw new Error("different tokens must stay distinct");
});
t("isHttpUrl accepts only http/https", () => {
  eq(MG.isHttpUrl("https://x/y"), true); eq(MG.isHttpUrl("http://x"), true);
  for (const u of ["blob:https://x/1", "data:video/mp4;base64,AA", "file:///c:/a.mp4", "ftp://x/a", "javascript:1", "nope"]) eq(MG.isHttpUrl(u), false, u);
});
t("abbreviateUrl keeps host and file name, stays short", () => {
  const a = MG.abbreviateUrl("https://cdn123.example.com/very/long/path/segments/here/master_playlist_final.m3u8?token=abcdef&x=1", 50);
  if (a.length > 50 || !a.startsWith("cdn123.example.com")) throw new Error(a);
});

/* ---- HLS ---- */
const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"
v720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
v1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO="aud"
v720low/index.m3u8
`;
t("parseHls master: variants, audio group, resolutions resolved against base URL", () => {
  const p = MG.parseHls(MASTER, "https://cdn.example.com/hls/master.m3u8");
  eq(p.valid, true); eq(p.master, true); eq(p.variants.length, 4);
  eq(p.variants[0].url, "https://cdn.example.com/hls/v360/index.m3u8"); eq(p.variants[2].height, 1080);
  eq(p.audioGroups.aud[0].url, "https://cdn.example.com/hls/audio/index.m3u8");
});
t("hlsChoices: only REAL qualities, best first, one per height (highest bandwidth wins), with audio rendition", () => {
  const c = MG.hlsChoices(MG.parseHls(MASTER, "https://cdn.example.com/hls/master.m3u8"));
  eq(c.map((x) => x.label), ["1080p", "720p", "360p"]);
  eq(c[1].url, "https://cdn.example.com/hls/v720/index.m3u8"); eq(c[1].audioUrl, "https://cdn.example.com/hls/audio/index.m3u8");
});
t("hlsChoices: a master with a single variant offers no fake choices; media playlists none", () => {
  eq(MG.hlsChoices(MG.parseHls("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\na.m3u8\n", "https://x/m.m3u8")), []);
  eq(MG.hlsChoices(MG.parseHls("#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n", "https://x/m.m3u8")), []);
});
t("parseHls media: duration summed, VOD vs live detection", () => {
  const vod = MG.parseHls("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\na.ts\n#EXTINF:2.5,\nb.ts\n#EXT-X-ENDLIST\n", "https://x/m.m3u8");
  eq(vod.duration, 6.5); eq(vod.live, false);
  eq(MG.parseHls("#EXTM3U\n#EXTINF:4,\na.ts\n", "https://x/m.m3u8").live, true);
  eq(MG.parseHls("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\na.ts\n", "https://x/m.m3u8").live, false);
});
t("parseHls: HTML error page is not a playlist", () => { eq(MG.parseHls("<html>login</html>", "https://x/").valid, false); });
t("parseHls DRM: SAMPLE-AES / FairPlay / Widevine flagged; plain AES-128 (identity) is NOT DRM", () => {
  const key = (a) => `#EXTM3U\n#EXT-X-KEY:${a}\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`;
  eq(!!MG.parseHls(key('METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"'), "https://x/m.m3u8").drm, true);
  eq(!!MG.parseHls(key('METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AA==",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'), "https://x/m.m3u8").drm, true);
  const aes = MG.parseHls(key('METHOD=AES-128,URI="https://x/key.bin"'), "https://x/m.m3u8");
  eq(!!aes.drm, false); eq(aes.aes128, true);
  eq(!!MG.parseHls(key("METHOD=NONE"), "https://x/m.m3u8").drm, false);
});

/* ---- multiple audio tracks ---- */
const MULTI = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Spanish (Latin America) dubbed-auto",LANGUAGE="es-419",DEFAULT=YES,AUTOSELECT=YES,URI="es.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English (United States) descriptive",LANGUAGE="en-US",AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.describes-video",URI="ad.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English (United States) original",LANGUAGE="en-US",AUTOSELECT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French dubbed",LANGUAGE="fr",URI="fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="a"
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a"
v720.m3u8
`;
t("audio tracks: YouTube's YT-EXT-XTAGS (acont=original / dubbed-auto) is understood even with generic names", () => {
  const xt = (s) => Buffer.from("\n\x0e\x0a\x05acont\x12\x05" + s + "\x18\x01").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const m = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",DEFAULT=YES,LANGUAGE="de",YT-EXT-XTAGS="${xt("dubbed-auto")}",URI="de.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="en",YT-EXT-XTAGS="${xt("original")}",URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n`;
  eq(MG.pickAudio(MG.parseHls(m, "https://x/m.m3u8").audioGroups.a).url, "https://x/en.m3u8");
});
t("audio tracks: the ORIGINAL wins over a dub that is listed first and flagged default; descriptions/dubs avoided", () => {
  const p = MG.parseHls(MULTI, "https://x/master.m3u8");
  eq(MG.pickAudio(p.audioGroups.a).url, "https://x/en.m3u8");
  const c = MG.hlsChoices(p);
  eq(c[0].audioUrl, "https://x/en.m3u8"); eq(c[0].audio.map((a) => a.key), ["es-419", "en-US", "en-US", "fr"]);
  // no 'original' label anywhere: playlist default wins, but never a dub/description when a plain track exists
  const plain = MG.parseHls(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch dubbed",URI="d.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="e.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n`, "https://x/m.m3u8");
  eq(MG.pickAudio(plain.audioGroups.a).url, "https://x/e.m3u8");
  eq(MG.pickAudio([]), null);
});

/* ---- DASH ---- */
t("parseDash: duration, static/dynamic, heights; ContentProtection => protected", () => {
  const clear = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1H2M3.5S" xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation id="1" height="1080" bandwidth="1"/><Representation id="2" height="720" bandwidth="1"/></AdaptationSet></Period></MPD>';
  const p = MG.parseDash(clear);
  eq(p.valid, true); eq(p.duration, 3723.5); eq(p.live, false); eq(p.heights, [1080, 720]); eq(p.drm, null);
  eq(MG.parseDash(clear.replace("static", "dynamic")).live, true);
  eq(!!MG.parseDash(clear.replace("<Period>", '<Period><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>')).drm, true);
  eq(MG.parseDash("<html/>").valid, false);
});

t("compareVersions: companion older than the extension needs is detected", () => {
  eq(MG.compareVersions("1.0.0", "1.0.0"), 0);
  if (!(MG.compareVersions("0.3.0", "1.0.0") < 0)) throw new Error("0.3.0 must be older than 1.0.0");
  if (!(MG.compareVersions("1.10.0", "1.9.9") > 0)) throw new Error("1.10.0 must be newer than 1.9.9");
  if (!(MG.compareVersions("1.0", "1.0.1") < 0)) throw new Error("1.0 older than 1.0.1");
  eq(MG.compareVersions(undefined, "0"), 0);
});

/* ---- formatting ---- */
t("formatBytes / formatDuration", () => {
  eq(MG.formatBytes(1536), "1.5 KB"); eq(MG.formatBytes(1048576 * 20), "20 MB"); eq(MG.formatBytes(0), "");
  eq(MG.formatDuration(65), "1:05"); eq(MG.formatDuration(3723), "1:02:03"); eq(MG.formatDuration(NaN), "");
});

console.log(`\n${pass}/${pass + fail} util tests passed`);
process.exit(fail ? 1 : 0);
