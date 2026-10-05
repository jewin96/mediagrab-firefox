// Local test server + FFmpeg-generated sample media (HLS media/master/DASH/mp4) with access-control, redirect,
// slow-segment, DRM-flagged and live variants. Nothing here touches the internet.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".m4s": "video/iso.segment", ".mp4": "video/mp4",
  ".mpd": "application/dash+xml", ".aac": "audio/aac", ".mp3": "audio/mpeg", ".webm": "video/webm", ".html": "text/html; charset=utf-8", ".png": "image/png"
};

function findFfmpeg() {
  if (process.env.MEDIAGRAB_FFMPEG) return process.env.MEDIAGRAB_FFMPEG;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, "MediaGrabCompanion", "config.json"), "utf8").replace(/^﻿/, ""));
    if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath)) return cfg.ffmpegPath;
  } catch (_) {}
  throw new Error("ffmpeg not found: set MEDIAGRAB_FFMPEG or run Install-Companion.cmd");
}

function generateMedia(dir) {
  const ffmpeg = findFfmpeg();
  const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe.exe");
  const run = (args, cwd) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const src = ["-f", "lavfi", "-i", "testsrc=duration=6:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=6"];
  fs.mkdirSync(dir, { recursive: true });

  // 1) single media playlist (muxed A/V, MPEG-TS segments)
  fs.mkdirSync(path.join(dir, "hls"), { recursive: true });
  run([...src, "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "index.m3u8"], path.join(dir, "hls"));

  // 2) master playlist: two video qualities + a separate audio rendition group
  fs.mkdirSync(path.join(dir, "master"), { recursive: true });
  run([...src, "-map", "0:v", "-map", "0:v", "-map", "1:a", "-s:v:0", "640x360", "-s:v:1", "320x180",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-b:v:0", "800k", "-b:v:1", "200k", "-c:a", "aac",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-master_pl_name", "master.m3u8",
    "-var_stream_map", "v:0,agroup:aud,name:v360 v:1,agroup:aud,name:v180 a:0,agroup:aud,name:aud,default:yes", "%v/index.m3u8"], path.join(dir, "master"));

  // 2b) master with TWO audio tracks like a multi-language YouTube stream: a Spanish dub listed FIRST and flagged DEFAULT
  //     (32 kHz), and the English original later, not default (48 kHz). The sample rate tells the tracks apart.
  fs.mkdirSync(path.join(dir, "multiaudio"), { recursive: true });
  run([...src, "-f", "lavfi", "-i", "sine=frequency=880:duration=6", "-map", "0:v", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-ar:a:0", "32000", "-ar:a:1", "48000",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-master_pl_name", "master.m3u8",
    "-var_stream_map", "v:0,agroup:aud,name:v a:0,agroup:aud,language:spa,name:Dubbed_Spanish,default:yes a:1,agroup:aud,language:eng,name:English_original", "%v/index.m3u8"], path.join(dir, "multiaudio"));

  // Real manifests label their tracks. master.m3u8: YouTube-style names; master_xtags.m3u8: generic names + YT-EXT-XTAGS only.
  const ma = path.join(dir, "multiaudio");
  let mtext = fs.readFileSync(path.join(ma, "master.m3u8"), "utf8");
  const xt = (s) => Buffer.from("\n\x0e\x0a\x05acont\x12\x05" + s + "\x18\x01").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const xtagsText = mtext.replace('NAME="audio_1"', `NAME="audio_1",YT-EXT-XTAGS="${xt("dubbed-auto")}"`).replace('NAME="audio_2"', `NAME="audio_2",YT-EXT-XTAGS="${xt("original")}"`);
  fs.writeFileSync(path.join(ma, "master_xtags.m3u8"), xtagsText);
  mtext = mtext.replace('NAME="audio_1"', 'NAME="Spanish (Latin America) dubbed-auto"').replace('NAME="audio_2"', 'NAME="English (United States) original"');
  fs.writeFileSync(path.join(ma, "master.m3u8"), mtext);
  fs.copyFileSync(path.join(ma, "master.m3u8"), path.join(ma, "master_names.m3u8"));

  // 3) DASH
  fs.mkdirSync(path.join(dir, "dash"), { recursive: true });
  run([...src, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-f", "dash", "-seg_duration", "2", "manifest.mpd"], path.join(dir, "dash"));

  // 3b) DASH with VP8 video, which MP4 cannot store -> host must fall back to Matroska
  fs.mkdirSync(path.join(dir, "dashvorbis"), { recursive: true });
  run([...src, "-map", "0:v", "-map", "1:a", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libvorbis", "-f", "dash", "-seg_duration", "2", "manifest.mpd"], path.join(dir, "dashvorbis"));

  // 3c) AES-128 encrypted HLS (key served openly, ordinary HLS encryption) and a byte-range playlist (single_file)
  fs.mkdirSync(path.join(dir, "hlsaes"), { recursive: true });
  const crypto = require("crypto");
  fs.writeFileSync(path.join(dir, "hlsaes", "enc.key"), crypto.randomBytes(16));
  fs.writeFileSync(path.join(dir, "hlsaes", "keyinfo.txt"), `enc.key\n${path.join(dir, "hlsaes", "enc.key")}\n`);
  run([...src, "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_key_info_file", "keyinfo.txt", "index.m3u8"], path.join(dir, "hlsaes"));
  fs.mkdirSync(path.join(dir, "hlsrange"), { recursive: true });
  run([...src, "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_flags", "single_file", "index.m3u8"], path.join(dir, "hlsrange"));

  // 4) plain progressive mp4
  fs.mkdirSync(path.join(dir, "file"), { recursive: true });
  run([...src, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", path.join(dir, "file", "clip.mp4")]);

  // 4b) a tiny UI-sound style mp3 (~6 KB) and a real-sized audio file
  run(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.4", "-b:a", "96k", path.join(dir, "file", "open.mp3")]);
  run(["-f", "lavfi", "-i", "sine=frequency=330:duration=30", "-b:a", "128k", path.join(dir, "file", "song.mp3")]);

  // 5) live-style playlist: same segments, no #EXT-X-ENDLIST (ffmpeg keeps polling until stopped)
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, "hls"))) fs.copyFileSync(path.join(dir, "hls", f), path.join(dir, "live", f));
  const live = fs.readFileSync(path.join(dir, "live", "index.m3u8"), "utf8").replace(/#EXT-X-ENDLIST\r?\n?/, "").replace(/#EXT-X-PLAYLIST-TYPE:VOD\r?\n?/, "");
  fs.writeFileSync(path.join(dir, "live", "index.m3u8"), live);

  // 5b) a web page that issues the same requests an HLS player would (no playback needed for detection)
  fs.writeFileSync(path.join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8">
<title>Adam Scott - Armchair Expert with Dax Shepard</title></head><body><h1>MediaGrab test page</h1>
<video id="v" controls width="320" poster="/media/poster.png"></video>
<script>
(async () => {
  const base = "/crawl/master/";
  await (await fetch(base + "master.m3u8")).text();
  await fetch(base + "v360/index.m3u8");
  for (let i = 0; i < 3; i++) await fetch(base + "v360/index" + i + ".ts");
  await fetch("/media/file/clip.mp4", { headers: { Range: "bytes=0-1023" } });
  document.body.dataset.ready = "1";
})();
</script></body></html>`);
  fs.writeFileSync(path.join(dir, "poster.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

  // 5c) a single-page app: stale generic og: tags, and "navigation" to another video via pushState + title change
  fs.writeFileSync(path.join(dir, "spa.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Generic Site</title>
<meta property="og:site_name" content="Site"><meta property="og:title" content="Generic Site"><meta property="og:image" content="/media/poster.png"></head>
<body><h1>SPA</h1><video id="v"></video>
<script>
fetch("/media/hls/index.m3u8");                       // the "previous video" (must be forgotten after navigation)
function go() {
  history.pushState({}, "", "/media/spa.html?v=abc123456");
  document.title = "(2) Cool Video - Site";            // og: tags stay stale, like YouTube
  fetch("/media/master/master.m3u8").then(() => fetch("/media/master/v360/index.m3u8"));
}
</script></body></html>`);

  // 5d) generic sample page for store screenshots (poster + playable clip + network requests like a player would make)
  try { run(["-f", "lavfi", "-i", "gradients=s=640x360:c0=0x1b3b6f:c1=0xf2a65a:nb_colors=2:seed=7:duration=1:speed=0.0", "-frames:v", "1", path.join(dir, "sample-poster.png")]); }
  catch (_) { run(["-f", "lavfi", "-i", "color=c=0x2b5f8a:s=640x360", "-frames:v", "1", path.join(dir, "sample-poster.png")]); }
  fs.writeFileSync(path.join(dir, "store.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Mountain Timelapse - 4K Nature Film</title></head>
<body style="background:#10151c;color:#dde"><h1>Mountain Timelapse</h1>
<video id="v" controls muted width="480" poster="/media/sample-poster.png" src="/media/file/clip.mp4"></video>
<script>
(async () => {
  const base = "/crawl/master/";
  await (await fetch(base + "master.m3u8")).text();
  await fetch(base + "v360/index.m3u8");
  await fetch("/media/file/song.mp3", { headers: { Range: "bytes=0-1023" } });
})();
</script></body></html>`);

  // 6) DRM-flagged playlists (never fetched past the manifest: they must be refused)
  fs.mkdirSync(path.join(dir, "drm"), { recursive: true });
  fs.writeFileSync(path.join(dir, "drm", "fairplay.m3u8"),
    '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(dir, "drm", "widevine.mpd"),
    '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="1" bandwidth="1000" height="360"/></AdaptationSet></Period></MPD>');
  fs.writeFileSync(path.join(dir, "drm", "notmanifest.m3u8"), "<html>Please log in</html>");
  return { ffmpeg, ffprobe };
}

function probe(ffprobe, file) {
  const out = execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(out);
  return {
    duration: parseFloat(j.format.duration),
    video: j.streams.filter((s) => s.codec_type === "video"),
    audio: j.streams.filter((s) => s.codec_type === "audio"),
    title: j.format.tags && (j.format.tags.title || j.format.tags.TITLE),
    format: j.format.format_name
  };
}

function startServer(mediaDir) {
  const log = [];
  const state = { slowMs: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    log.push({ path: url.pathname, headers: req.headers });
    let rel = url.pathname;
    let secure = false;
    if (rel.startsWith("/redir/")) { res.writeHead(302, { Location: "/media/" + rel.slice(7) }); return res.end(); }
    if (rel.startsWith("/secure/")) { secure = true; rel = "/media/" + rel.slice(8); }
    let throttle = false, chunk = 8192, gap = 100;
    if (rel.startsWith("/slow/")) rel = "/media/" + rel.slice(6);
    if (rel.startsWith("/throttle/")) { rel = "/media/" + rel.slice(10); throttle = true; }
    if (rel.startsWith("/crawl/")) { rel = "/media/" + rel.slice(7); throttle = true; chunk = 2048; gap = 100; }   // ~20 KB/s per connection
    if (!rel.startsWith("/media/")) { res.writeHead(404); return res.end("nope"); }
    if (secure) {
      const okRef = (req.headers.referer || "").startsWith("http://example.test/");
      const okCookie = /(?:^|;\s*)sess=abc(?:;|$)/.test(req.headers.cookie || "");
      if (!okRef || !okCookie) { res.writeHead(403); return res.end("forbidden"); }
    }
    const file = path.join(mediaDir, rel.slice(7));
    if (!file.startsWith(mediaDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("missing"); }
    const send = () => {
      const data = fs.readFileSync(file);
      if (throttle && /\.(ts|m4s)$/.test(file)) {   // ~80 KB/s per connection
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": data.length, "Cache-Control": "no-store" });
        let off = 0;
        const tick = () => { if (res.destroyed) return; res.write(data.subarray(off, off + chunk)); off += chunk; if (off >= data.length) res.end(); else setTimeout(tick, gap); };
        return tick();
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": data.length, "Cache-Control": "no-store" });
      res.end(data);
    };
    if (url.pathname.startsWith("/slow/") && /\.(ts|m4s)$/.test(file)) setTimeout(send, 1500); else send();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, log, state, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { generateMedia, startServer, probe, findFfmpeg };
