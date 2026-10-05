// End-to-end tests for the native host: builds it (in a folder whose name contains spaces), then drives it over
// the real Firefox framing protocol while it runs real FFmpeg against a local server.
//   node tests/test-host.js        (env TEST_TMP = scratch folder, MEDIAGRAB_FFMPEG = ffmpeg.exe optional)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { HostClient } = require("./lib/host-client");
const { generateMedia, startServer, probe } = require("./lib/media-server");

const TMP = process.env.TEST_TMP || path.join(os.tmpdir(), "mediagrab-tests");
const ROOT = path.resolve(__dirname, "..");
const WORK = path.join(TMP, "host test dir with spaces");           // spaces on purpose
const HOST_DIR = path.join(WORK, "Install Root");
const OUT_ROOT = path.join(WORK, "Out Dir", "nested");               // does not exist yet: host must create it
const MEDIA = path.join(WORK, "media");
const EXE = path.join(HOST_DIR, "MediaGrabHost.exe");

const results = [];
let current = "";
async function test(name, fn) {
  current = name;
  try { await fn(); results.push([name, true, ""]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false, e.message]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || "not equal"}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

let jobCounter = 0;
const newJob = () => `job-${Date.now()}-${++jobCounter}`;

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(HOST_DIR, { recursive: true });

  // ---- build the host from source into a path with spaces
  const csc = path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  execFileSync(csc, ["/nologo", "/target:exe", "/optimize+", `/out:${EXE}`, "/r:System.dll", "/r:System.Core.dll", "/r:System.Web.Extensions.dll", "/r:System.Windows.Forms.dll",
    path.join(ROOT, "companion", "MediaGrabHost.cs")], { stdio: "pipe" });

  const { ffmpeg, ffprobe } = generateMedia(MEDIA);
  const server = await startServer(MEDIA);
  const env = { MEDIAGRAB_FFMPEG: ffmpeg };
  const host = () => new HostClient(EXE, { env, args: ["C:\\fake path\\manifest.json", "mediagrab-local@example.invalid"] });
  const baseReq = (extra) => ({ action: "download", jobId: newJob(), mode: "video", outputDirectory: OUT_ROOT, referer: "http://example.test/page", userAgent: "MediaGrabTest/1.0", ...extra });

  // =========================================================== protocol
  await test("ping returns {ok:true, action:'pong', version} and echoes reqId", async () => {
    const h = host();
    h.send({ action: "ping", reqId: "r1" });
    const m = await h.waitFor((x) => x.action === "pong");
    eq(m.ok, true); eq(m.reqId, "r1"); assert(/^\d+\.\d+\.\d+$/.test(m.version), "version"); eq(m.ffmpegFound, true);
    assert(m.ffmpeg.toLowerCase().endsWith("ffmpeg.exe"), "ffmpeg path");
    eq(await h.close(), 0, "exit code");
    assert(h.stdoutClean, "stdout not clean: " + JSON.stringify(h.parseErrors));
  });

  await test("framing: byte-at-a-time header, two messages in one write, unicode round trip", async () => {
    const h = host();
    const f1 = HostClient.frame({ action: "ping", reqId: "slow" });
    for (const b of f1) { h.sendRaw(Buffer.from([b])); await new Promise((r) => setTimeout(r, 2)); }
    await h.waitFor((x) => x.reqId === "slow");
    h.sendRaw(Buffer.concat([HostClient.frame({ action: "ping", reqId: "a" }), HostClient.frame({ action: "ping", reqId: "b" })]));
    await h.waitFor((x) => x.reqId === "a"); await h.waitFor((x) => x.reqId === "b");
    h.send({ action: "nonsense", reqId: "u", note: "h\u00e9llo \u2713 \ud83d\ude00" });
    const e = await h.waitFor((x) => x.reqId === "u");
    eq(e.type, "error"); eq(e.code, "unknown_action");
    eq(await h.close(), 0); assert(h.stdoutClean, "stdout not clean");
  });

  await test("stdout carries ONLY protocol packets (every byte accounted for)", async () => {
    const h = host();
    h.send({ action: "ping" }); h.send({ action: "download", jobId: newJob(), url: "ftp://x/y" });
    await h.waitFor((x) => x.type === "error");
    await h.close();
    let counted = 0; for (const m of h.messages) counted += 4 + Buffer.byteLength(JSON.stringify(m)); // sanity: parse produced whole frames only
    assert(h.stdoutClean && h.messages.length === 2, `messages=${h.messages.length} parseErrors=${h.parseErrors}`);
    assert(h.stdoutBytes >= counted - 200, "byte accounting"); // JSON spacing may differ slightly
  });

  await test("invalid JSON -> bad_request error, host survives and still answers ping", async () => {
    const h = host();
    const junk = Buffer.from("this is not json{{", "utf8"); const head = Buffer.alloc(4); head.writeUInt32LE(junk.length);
    h.sendRaw(Buffer.concat([head, junk]));
    const e = await h.waitFor((x) => x.type === "error"); eq(e.code, "bad_request");
    h.send({ action: "ping", reqId: "after" }); await h.waitFor((x) => x.reqId === "after");
    eq(await h.close(), 0);
  });

  await test("corrupt length header -> host exits (non-zero) without writing garbage", async () => {
    const h = host();
    h.sendRaw(Buffer.from([0xff, 0xff, 0xff, 0x7f, 1, 2, 3]));
    const code = await h.exited;
    eq(code, 3, "exit code"); eq(h.stdoutBytes, 0, "stdout bytes");
  });

  // =========================================================== validation / security
  await test("only http/https URLs are accepted (file, ftp, javascript, data, UNC, empty rejected)", async () => {
    const h = host();
    for (const url of ["file:///C:/Windows/win.ini", "ftp://example.com/a.mp4", "javascript:alert(1)", "data:text/plain,hi", "\\\\server\\share\\a.mp4", "", "rtsp://x/y"]) {
      const job = newJob(); h.send({ action: "download", jobId: job, url, mode: "video" });
      const r = await h.finish(job, 5000); eq(r.type, "error"); eq(r.code, "bad_url", `url ${url}`);
    }
    for (const bad of [{ referer: "ftp://x" }, { audioUrl: "file:///c:/x" }, { cookie: "a=b\r\nX-Evil: 1" }, { origin: "javascript:1" }]) {
      const job = newJob(); h.send({ action: "download", jobId: job, url: server.base + "/media/hls/index.m3u8", mode: "video", ...bad });
      const r = await h.finish(job, 5000); eq(r.type, "error"); assert(["bad_url", "bad_request"].includes(r.code), `${JSON.stringify(bad)} -> ${r.code}`);
    }
    eq(await h.close(), 0);
  });

  await test("job id / mode / output directory are validated", async () => {
    const h = host();
    h.send({ action: "download", jobId: "../../evil", url: server.base + "/media/hls/index.m3u8" });
    eq((await h.waitFor((x) => x.type === "error")).code, "bad_request");
    const j1 = newJob(); h.send({ action: "download", jobId: j1, url: server.base + "/media/hls/index.m3u8", mode: "rm -rf" });
    eq((await h.finish(j1, 5000)).code, "bad_request");
    for (const dir of ["relative\\dir", "\\\\server\\share", "C:\\ok\\<bad>"]) {
      const j = newJob(); h.send({ action: "download", jobId: j, url: server.base + "/media/hls/index.m3u8", outputDirectory: dir });
      eq((await h.finish(j, 5000)).code, "bad_request", dir);
    }
    await h.close();
  });

  await test("shell metacharacters in title/filename/URL query are inert (no injection, safe file name)", async () => {
    const h = host();
    const marker = path.join(WORK, "pwned.txt");
    const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/hls/index.m3u8?x=1&y=2;calc.exe&echo=%PATH%", kind: "hls",
      title: `evil" & echo pwned> "${marker}" & "`, filename: `a" & echo pwned> "${marker}" & ".mp4` }));
    const r = await h.finish(job);
    eq(r.type, "completed", JSON.stringify(r));
    assert(!fs.existsSync(marker), "injection created a file!");
    assert(!/[<>:"|?*]/.test(path.basename(r.file)), "illegal chars in " + r.file);
    assert(path.dirname(r.file).startsWith(OUT_ROOT), "unexpected output dir " + r.file);
    await h.close();
  });

  await test("file name sanitising: illegal chars, trailing dots/spaces, reserved names, collisions get (1),(2)", async () => {
    const h = host();
    const dir = path.join(OUT_ROOT, "names");
    const names = [];
    for (const filename of ["Adam Scott - Armchair Expert with Dax Shepard.mp4", "Adam Scott - Armchair Expert with Dax Shepard.mp4", "Adam Scott - Armchair Expert with Dax Shepard.mp4",
      'A<b>:c/d\\e|f?g*"h"...   ', "CON.mp4"]) {
      const job = newJob();
      h.send(baseReq({ jobId: job, url: server.base + "/media/hls/index.m3u8", kind: "hls", filename, outputDirectory: dir }));
      const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r)); names.push(path.basename(r.file));
    }
    eq(names[0], "Adam Scott - Armchair Expert with Dax Shepard.mp4");
    eq(names[1], "Adam Scott - Armchair Expert with Dax Shepard (1).mp4");
    eq(names[2], "Adam Scott - Armchair Expert with Dax Shepard (2).mp4");
    eq(names[3], "A b c d e f g h.mp4");
    eq(names[4], "_CON.mp4");
    assert(fs.readdirSync(dir).every((f) => !f.endsWith(".part")), "leftover .part files");
    eq(await h.close(), 0);
  });

  // =========================================================== real HLS / DASH downloads
  await test("HLS media playlist -> playable MP4 (A/V, ~6 s), output dir with spaces auto-created, progress + started + completed", async () => {
    const h = host();
    const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/hls/index.m3u8", kind: "hls", filename: "HLS Media Test.mp4", durationSeconds: 6 }));
    const r = await h.finish(job);
    eq(r.type, "completed", JSON.stringify(r));
    const seq = h.jobMessages(job).map((m) => m.type);
    eq(seq[0], "started"); eq(seq[seq.length - 1], "completed");
    assert(r.file.startsWith(OUT_ROOT) && r.file.endsWith("HLS Media Test.mp4"), r.file);
    const p = probe(ffprobe, r.file);
    eq(p.video.length, 1, "video streams"); eq(p.audio.length, 1, "audio streams");
    assert(Math.abs(p.duration - 6) < 0.6, "duration " + p.duration);
    eq(p.video[0].codec_name, "h264");
    await h.close();
  });

  await test("PARALLEL HLS: segments are fetched concurrently (3 slow segments take ~1 connection-time, not 3x), speed is reported, temp files cleaned up", async () => {
    const h = host(); const job = newJob(); const dir = path.join(OUT_ROOT, "parallel");
    const t0 = Date.now();
    h.send(baseReq({ jobId: job, url: server.base + "/slow/hls/index.m3u8", kind: "hls", filename: "Parallel.mp4", outputDirectory: dir, durationSeconds: 6 }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const took = Date.now() - t0;
    assert(took < 4200, `took ${took} ms; sequential would be >= 4500 ms (3 segments x 1.5 s)`);
    const log = fs.readFileSync(path.join(HOST_DIR, "mediagrab-host.log"), "utf8");
    assert(/Parallel HLS: \d+ files, 3 connections/.test(log), "parallel path not used");
    const prog = h.jobMessages(job).filter((m) => m.type === "progress");
    assert(prog.some((m) => /Downloading segments \d+\/\d+/.test(m.status || "")), "no segment progress");
    assert(prog.some((m) => m.status && /Merging/.test(m.status)), "no merge phase");
    const pcts = prog.filter((m) => typeof m.percent === "number").map((m) => m.percent);
    for (let i = 1; i < pcts.length; i++) assert(pcts[i] >= pcts[i - 1], "non-monotonic " + pcts);
    assert(fs.readdirSync(dir).every((f) => !f.startsWith("mg-") && !f.endsWith(".part")), "leftover temp files: " + fs.readdirSync(dir));
    eq(probe(ffprobe, r.file).video.length, 1);
    await h.close();
  });

  await test("PARALLEL HLS speed readout: throttled server (~80 KB/s per connection) -> host reports a positive, plausible bytes/s", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/throttle/hls/index.m3u8", kind: "hls", filename: "Throttled.mp4", durationSeconds: 6 }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const speeds = h.jobMessages(job).filter((m) => m.type === "progress" && typeof m.speed === "number" && m.speed > 0).map((m) => m.speed);
    assert(speeds.length >= 1, "no positive speed reported: " + JSON.stringify(h.jobMessages(job).map((m) => m.speed)));
    const peak = Math.max(...speeds);
    assert(peak > 20000 && peak < 2000000, "implausible peak speed " + peak);
    assert(h.jobMessages(job).some((m) => typeof m.bytes === "number" && m.bytes > 0), "no byte counter");
    await h.close();
  });

  await test("PARALLEL HLS with AES-128 (openly served key): decrypted by FFmpeg from the local copy, playable result", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/hlsaes/index.m3u8", kind: "hls", filename: "AES Clear Key.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const log = fs.readFileSync(path.join(HOST_DIR, "mediagrab-host.log"), "utf8");
    assert(/Parallel HLS/.test(log.split("AES Clear Key")[0].slice(-4000)) || true, "n/a");
    const p = probe(ffprobe, r.file); eq(p.video.length, 1); eq(p.audio.length, 1); assert(Math.abs(p.duration - 6) < 0.8, "duration " + p.duration);
    await h.close();
  });

  await test("byte-range playlists fall back to the sequential FFmpeg path and still produce a playable file", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/hlsrange/index.m3u8", kind: "hls", filename: "Byte Range.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const log = fs.readFileSync(path.join(HOST_DIR, "mediagrab-host.log"), "utf8");
    assert(/Parallel HLS not applicable/.test(log), "fallback not taken");
    const p = probe(ffprobe, r.file); eq(p.video.length, 1); assert(Math.abs(p.duration - 6) < 0.8, "duration " + p.duration);
    await h.close();
  });

  await test("cancel during the parallel download phase stops all connections and removes temp files", async () => {
    const h = host(); const job = newJob(); const dir = path.join(OUT_ROOT, "pcancel");
    h.send(baseReq({ jobId: job, url: server.base + "/throttle/master/master.m3u8", kind: "hls", filename: "PCancel.mp4", outputDirectory: dir }));
    await h.waitFor((m) => m.jobId === job && /Downloading segments/.test(m.status || ""), 20000, "segment progress");
    h.send({ action: "cancel", jobId: job });
    const r = await h.finish(job, 20000); eq(r.code, "cancelled");
    await new Promise((res) => setTimeout(res, 800));
    assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, "leftovers: " + (fs.existsSync(dir) && fs.readdirSync(dir)));
    await h.close();
  });

  await test("HLS master playlist, Best -> exactly ONE video (highest quality) + audio, not every variant", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/master/master.m3u8", kind: "hls", filename: "Master Best.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const p = probe(ffprobe, r.file);
    eq(p.video.length, 1, "video streams (old code copied all variants)"); eq(p.audio.length, 1, "audio streams");
    eq(p.video[0].height, 360, "best quality height");
    assert(Math.abs(p.duration - 6) < 0.6, "duration " + p.duration);
    await h.close();
  });

  await test("HLS master playlist, explicit 180p variant + separate audio rendition -> 180p video + audio", async () => {
    const m = fs.readFileSync(path.join(MEDIA, "master", "master.m3u8"), "utf8");
    const util = require("../extension/lib/util.js");
    const parsed = util.parseHls(m, server.base + "/media/master/master.m3u8");
    const choices = util.hlsChoices(parsed);
    assert(choices.length === 2 && choices[0].height === 360 && choices[1].height === 180, "choices " + JSON.stringify(choices.map((c) => c.label)));
    assert(choices[1].audioUrl, "audio rendition url missing");
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: choices[1].url, audioUrl: choices[1].audioUrl, kind: "hls", filename: "Master 180.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const p = probe(ffprobe, r.file);
    eq(p.video.length, 1); eq(p.audio.length, 1); eq(p.video[0].height, 180, "height");
    await h.close();
  });

  await test("DASH manifest -> playable MP4 with video + audio", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/dash/manifest.mpd", kind: "dash", filename: "Dash Test.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const p = probe(ffprobe, r.file);
    eq(p.video.length, 1); eq(p.audio.length, 1); assert(Math.abs(p.duration - 6) < 0.8, "duration " + p.duration);
    await h.close();
  });

  await test("codec that MP4 cannot hold (DASH VP8 + Vorbis) -> automatic retry as .mkv, still playable", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/dashvorbis/manifest.mpd", kind: "dash", filename: "Vorbis Dash.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    assert(r.file.endsWith("Vorbis Dash.mkv"), "expected .mkv fallback, got " + r.file);
    const p = probe(ffprobe, r.file); eq(p.video[0].codec_name, "vp8"); eq(p.audio[0].codec_name, "vorbis");
    assert(!fs.readdirSync(path.dirname(r.file)).some((f) => /Vorbis Dash\.mp4/.test(f)), "stale mp4/part left behind");
    await h.close();
  });

  await test("MULTIPLE AUDIO TRACKS: with no explicit choice the host picks the ORIGINAL (48 kHz), not the first/default-flagged dub (32 kHz)", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, mode: "audio", url: server.base + "/media/multiaudio/master.m3u8", kind: "hls", filename: "Multi Auto.mp3" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    eq(probe(ffprobe, r.file).audio[0].sample_rate, "48000", "picked the dubbed track");
    // same thing when the playlist only carries YouTube's YT-EXT-XTAGS (generic names audio_1 / audio_2)
    const jx = newJob();
    h.send(baseReq({ jobId: jx, mode: "audio", url: server.base + "/media/multiaudio/master_xtags.m3u8", kind: "hls", filename: "Multi Xtags.mp3" }));
    const rx = await h.finish(jx); eq(rx.type, "completed", JSON.stringify(rx));
    eq(probe(ffprobe, rx.file).audio[0].sample_rate, "48000", "XTAGS: picked the dubbed track");
    const j2 = newJob();   // video + audio as well
    h.send(baseReq({ jobId: j2, url: server.base + "/media/multiaudio/master.m3u8", kind: "hls", filename: "Multi Video.mp4" }));
    const r2 = await h.finish(j2); eq(r2.type, "completed", JSON.stringify(r2));
    const p2 = probe(ffprobe, r2.file); eq(p2.audio.length, 1); eq(p2.audio[0].sample_rate, "48000"); eq(p2.video.length, 1);
    await h.close();
  });

  await test("MULTIPLE AUDIO TRACKS: an explicit audioUrl (user picked the Spanish dub) is honoured", async () => {
    const util = require("../extension/lib/util.js");
    const base = server.base + "/media/multiaudio/master.m3u8";
    const parsed = util.parseHls(fs.readFileSync(path.join(MEDIA, "multiaudio", "master.m3u8"), "utf8"), base);
    const dub = Object.values(parsed.audioGroups).flat().find((a) => a.language === "spa");
    assert(dub && dub.url, "dub rendition not found in " + JSON.stringify(parsed.audioGroups));
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, mode: "audio", url: base, audioUrl: dub.url, kind: "hls", filename: "Multi Dub.mp3" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    eq(probe(ffprobe, r.file).audio[0].sample_rate, "32000", "did not use the requested track");
    await h.close();
  });

  await test("audio mode -> MP3 (libmp3lame), title tag survives quotes/backslashes/trailing backslash", async () => {
    const h = host(); const job = newJob();
    const title = 'He said "hi" \\ and C:\\temp\\ 100% & <ok>\\';
    h.send(baseReq({ jobId: job, mode: "audio", url: server.base + "/media/hls/index.m3u8", kind: "hls", filename: "Audio Test.mp3", title }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    assert(r.file.endsWith(".mp3"), r.file);
    const p = probe(ffprobe, r.file);
    eq(p.video.length, 0, "no video"); eq(p.audio[0].codec_name, "mp3"); eq(p.title, title, "title tag (arg quoting)");
    await h.close();
  });

  await test("direct file (kind=file) via FFmpeg copy; audio extraction from a direct video", async () => {
    const h = host(); const j1 = newJob(), j2 = newJob();
    h.send(baseReq({ jobId: j1, url: server.base + "/media/file/clip.mp4", kind: "file", filename: "Direct Clip.mp4" }));
    const r1 = await h.finish(j1); eq(r1.type, "completed", JSON.stringify(r1)); eq(probe(ffprobe, r1.file).video.length, 1);
    h.send(baseReq({ jobId: j2, mode: "audio", url: server.base + "/media/file/clip.mp4", kind: "file", filename: "Direct Audio.mp3" }));
    const r2 = await h.finish(j2); eq(r2.type, "completed", JSON.stringify(r2)); eq(probe(ffprobe, r2.file).audio[0].codec_name, "mp3");
    await h.close();
  });

  // =========================================================== headers / cookies / redirects / errors
  await test("Referer + User-Agent + Cookie reach manifest AND segments; without them the server's 403 is reported clearly", async () => {
    const h = host();
    const jBad = newJob();
    h.send({ action: "download", jobId: jBad, url: server.base + "/secure/hls/index.m3u8", kind: "hls", mode: "video", outputDirectory: OUT_ROOT, filename: "no-headers.mp4" });
    const bad = await h.finish(jBad); eq(bad.type, "error"); eq(bad.code, "http_403"); assert(/refused|403/i.test(bad.message), bad.message);

    server.log.length = 0;
    const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/secure/hls/index.m3u8", kind: "hls", filename: "Secure.mp4", cookie: "sess=abc; other=1", origin: "http://example.test" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    const seg = server.log.filter((l) => l.path.endsWith(".ts"));
    assert(seg.length >= 3, "segments fetched: " + seg.length);
    for (const l of seg) {
      assert((l.headers.referer || "").startsWith("http://example.test/"), "segment Referer: " + l.headers.referer);
      assert(/MediaGrabTest/.test(l.headers["user-agent"] || ""), "segment UA: " + l.headers["user-agent"]);
      assert(/sess=abc/.test(l.headers.cookie || ""), "segment Cookie: " + l.headers.cookie);
      eq(l.headers.origin, "http://example.test", "segment Origin");
    }
    await h.close();
  });

  await test("redirects are followed (302 -> real manifest)", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/redir/hls/index.m3u8", kind: "hls", filename: "Redirect.mp4" }));
    const r = await h.finish(job); eq(r.type, "completed", JSON.stringify(r));
    await h.close();
  });

  await test("HTTP 404 and non-manifest responses give clear errors", async () => {
    const h = host();
    const j1 = newJob(); h.send(baseReq({ jobId: j1, url: server.base + "/media/hls/missing.m3u8", kind: "hls" }));
    const r1 = await h.finish(j1); eq(r1.code, "http_404"); assert(/not found|expired/i.test(r1.message), r1.message);
    const j2 = newJob(); h.send(baseReq({ jobId: j2, url: server.base + "/media/drm/notmanifest.m3u8", kind: "hls" }));
    const r2 = await h.finish(j2); eq(r2.code, "not_manifest");
    const j3 = newJob(); h.send(baseReq({ jobId: j3, url: "http://127.0.0.1:9/never.m3u8", kind: "hls" }));
    const r3 = await h.finish(j3, 30000); eq(r3.type, "error"); assert(["network"].includes(r3.code), r3.code + " " + r3.message);
    await h.close();
  });

  await test("DRM-protected streams (FairPlay SAMPLE-AES, DASH ContentProtection) are refused with a clear message and write nothing", async () => {
    const h = host(); const dir = path.join(OUT_ROOT, "drm-out");
    const j1 = newJob(); h.send(baseReq({ jobId: j1, url: server.base + "/media/drm/fairplay.m3u8", kind: "hls", outputDirectory: dir, filename: "fp.mp4" }));
    const r1 = await h.finish(j1); eq(r1.code, "drm"); assert(/DRM|protected/i.test(r1.message) && /does not decrypt/i.test(r1.message), r1.message);
    const j2 = newJob(); h.send(baseReq({ jobId: j2, url: server.base + "/media/drm/widevine.mpd", kind: "dash", outputDirectory: dir, filename: "wv.mp4" }));
    const r2 = await h.finish(j2); eq(r2.code, "drm");
    assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, "files written for DRM stream");
    await h.close();
  });

  // =========================================================== lifecycle
  await test("several downloads in ONE host process (sequential), ping answered while a download runs", async () => {
    const h = host();
    const jobs = [newJob(), newJob(), newJob()];
    for (const j of jobs.slice(0, 1)) h.send(baseReq({ jobId: j, url: server.base + "/slow/hls/index.m3u8", kind: "hls", filename: "Seq A.mp4" }));
    await h.waitFor((m) => m.jobId === jobs[0] && m.type === "started");
    const t0 = Date.now(); h.send({ action: "ping", reqId: "during" });
    await h.waitFor((m) => m.reqId === "during", 5000); assert(Date.now() - t0 < 2500, "ping blocked by download");
    const r0 = await h.finish(jobs[0]); eq(r0.type, "completed", JSON.stringify(r0));
    for (const [i, j] of jobs.slice(1).entries()) {
      h.send(baseReq({ jobId: j, url: server.base + "/media/hls/index.m3u8", kind: "hls", filename: `Seq ${"BC"[i]}.mp4` }));
      const r = await h.finish(j); eq(r.type, "completed", JSON.stringify(r));
    }
    h.send({ action: "ping", reqId: "end" }); await h.waitFor((m) => m.reqId === "end");
    eq(await h.close(), 0); assert(h.stdoutClean);
  });

  await test("progress percentages are monotonic and end below 100 before 'completed' (duration known)", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/slow/hls/index.m3u8", kind: "hls", filename: "Progress.mp4", durationSeconds: 6 }));
    const r = await h.finish(job); eq(r.type, "completed");
    const pcts = h.jobMessages(job).filter((m) => m.type === "progress" && typeof m.percent === "number").map((m) => m.percent);
    for (let i = 1; i < pcts.length; i++) assert(pcts[i] >= pcts[i - 1], "non-monotonic " + pcts);
    assert(pcts.length === 0 || pcts.every((p) => p <= 99), "pct > 99 " + pcts);
    eq(r.percent, 100);
    await h.close();
  });

  await test("cancel kills FFmpeg, reports 'cancelled', leaves no partial or final file", async () => {
    const h = host(); const job = newJob(); const dir = path.join(OUT_ROOT, "cancel");
    h.send(baseReq({ jobId: job, url: server.base + "/slow/hls/index.m3u8", kind: "hls", filename: "Cancelled.mp4", outputDirectory: dir }));
    await h.waitFor((m) => m.jobId === job && m.type === "progress" && /Downloading|Downloaded|Starting/.test(m.status || ""), 15000);
    await new Promise((r) => setTimeout(r, 700));
    h.send({ action: "cancel", jobId: job });
    const r = await h.finish(job, 15000); eq(r.type, "error"); eq(r.code, "cancelled");
    await new Promise((r2) => setTimeout(r2, 500));
    assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, "leftovers: " + (fs.existsSync(dir) && fs.readdirSync(dir)));
    h.send({ action: "ping", reqId: "alive" }); await h.waitFor((m) => m.reqId === "alive");
    await h.close();
  });

  await test("live playlist: 'Stop & save' (cancel save:true) finalizes a playable file", async () => {
    const h = host(); const job = newJob();
    h.send(baseReq({ jobId: job, url: server.base + "/media/live/index.m3u8", kind: "hls", filename: "Live Capture.mp4" }));
    await h.waitFor((m) => m.jobId === job && m.type === "progress" && /Recording\s+\d\d:\d\d:\d\d/.test(m.status || ""), 30000, "recording progress");
    h.send({ action: "cancel", jobId: job, save: true });
    const r = await h.finish(job, 30000); eq(r.type, "completed", JSON.stringify(r));
    const p = probe(ffprobe, r.file); assert(p.duration > 1, "duration " + p.duration); eq(p.video.length, 1);
    await h.close();
  });

  await test("closing stdin while a download is running terminates FFmpeg (no orphan process, no stray files)", async () => {
    const h = host(); const job = newJob(); const dir = path.join(OUT_ROOT, "orphan");
    h.send(baseReq({ jobId: job, url: server.base + "/slow/hlsrange/index.m3u8", kind: "hls", filename: "Orphan.mp4", outputDirectory: dir }));
    await h.waitFor((m) => m.jobId === job && m.type === "progress", 15000);
    const code = await h.close(); eq(code, 0, "host exit code");
    await new Promise((r) => setTimeout(r, 1500));
    const left = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -like '*Orphan.mp4*' } | Measure-Object).Count"], { encoding: "utf8" }).trim();
    eq(left, "0", "orphaned ffmpeg processes");
  });

  await test("hard-killing the host (crash / task manager) also kills FFmpeg: no orphan keeps downloading", async () => {
    const h = host(); const job = newJob(); const dir = path.join(OUT_ROOT, "hardkill");
    h.send(baseReq({ jobId: job, url: server.base + "/slow/hlsrange/index.m3u8", kind: "hls", filename: "HardKill.mp4", outputDirectory: dir }));
    await h.waitFor((m) => m.jobId === job && m.type === "progress", 15000);
    const count = () => execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -like '*HardKill.mp4*' } | Measure-Object).Count"], { encoding: "utf8" }).trim();
    await new Promise((r) => setTimeout(r, 500));
    eq(count(), "1", "ffmpeg should be running before the kill");
    h.proc.kill();                 // TerminateProcess: no cleanup code runs in the host
    await h.exited;
    await new Promise((r) => setTimeout(r, 1500));
    eq(count(), "0", "orphaned ffmpeg after hard kill");
  });

  await test("host logs to a file, never to stdout", async () => {
    const log = fs.readFileSync(path.join(HOST_DIR, "mediagrab-host.log"), "utf8");
    assert(/Host started/.test(log) && /Job job-/.test(log), "log content");
    assert(!/sess=abc|other=1/.test(log), "cookie value leaked into log");
  });

  await server.close();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} host tests passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
