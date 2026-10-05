// Runs the REAL extension/background.js (and lib/util.js) in a sandbox with a mocked `browser` API whose
// native-messaging port is wired to the REAL MediaGrabHost.exe (+ real FFmpeg), fed by a local HLS/DASH server.
// It plays the role of Firefox + the popup: it fires webRequest events, sends the same runtime messages the popup sends,
// and checks job events and the files that end up on disk.
//   node tests/test-background.js   (env TEST_TMP, HOST_EXE optional)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { HostClient } = require("./lib/host-client");
const { generateMedia, startServer, probe } = require("./lib/media-server");

const ROOT = path.resolve(__dirname, "..");
const TMP = process.env.TEST_TMP || path.join(os.tmpdir(), "mediagrab-tests");
const HOST_EXE = process.env.HOST_EXE || path.join(process.env.LOCALAPPDATA, "MediaGrabCompanion", "MediaGrabHost.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS  ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || "mismatch"}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

// ---------------------------------------------------------------- fake Firefox
function createBrowser({ registered = true, ffmpeg }) {
  const hostsSpawned = [];
  const evt = () => { const l = []; return { addListener: (f) => l.push(f), listeners: l, fire: (...a) => l.map((f) => f(...a)) }; };
  const sent = [];                   // runtime.sendMessage(...) calls from background (to the popup)
  const store = { local: {}, session: {} };
  const area = (o) => ({
    get: async (k) => { if (k == null) return { ...o }; const keys = Array.isArray(k) ? k : [k]; const out = {}; for (const key of keys) if (key in o) out[key] = JSON.parse(JSON.stringify(o[key])); return out; },
    set: async (v) => { Object.assign(o, JSON.parse(JSON.stringify(v))); },
    remove: async (k) => { for (const key of [].concat(k)) delete o[key]; }
  });
  const downloads = { calls: [], items: new Map(), nextId: 100, behaviour: "complete" };
  const browser = {
    runtime: {
      lastError: null,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")),
      onMessage: evt(),
      sendMessage: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); },   // Firefox structured-clones messages
      connectNative: (name) => {
        const port = { onMessage: evt(), onDisconnect: evt(), error: null, name, _closed: false };
        if (!registered || name !== "com.mediagrab.host") {
          setTimeout(() => { port.error = { message: `No such native application ${name}` }; port.onDisconnect.fire(port); }, 20);
          port.postMessage = () => {}; port.disconnect = () => {};
          return port;
        }
        const h = new HostClient(HOST_EXE, { env: { MEDIAGRAB_FFMPEG: ffmpeg }, args: ["manifest.json", "mediagrab-local@example.invalid"] });
        hostsSpawned.push(h);
        let cursor = 0;
        const pump = setInterval(() => { while (cursor < h.messages.length) port.onMessage.fire(JSON.parse(JSON.stringify(h.messages[cursor++]))); }, 5);
        h.exited.then(() => { clearInterval(pump); while (cursor < h.messages.length) port.onMessage.fire(h.messages[cursor++]); if (!port._closed) { port._closed = true; port.onDisconnect.fire(port); } });
        port.postMessage = (m) => h.send(JSON.parse(JSON.stringify(m)));
        port.disconnect = () => { port._closed = true; h.proc.stdin.end(); };
        return port;
      }
    },
    webRequest: { onBeforeSendHeaders: evt(), onHeadersReceived: evt() },
    storage: { local: area(store.local), session: area(store.session) },
    action: { badge: {}, setBadgeText: async ({ tabId, text }) => { browser.action.badge[tabId] = text; }, setBadgeBackgroundColor: async () => {} },
    tabs: { pages: {}, get: async (id) => browser.tabs.pages[id], sendMessage: async () => {}, onRemoved: evt(), onUpdated: evt() },
    downloads: {
      download: async (o) => { const id = downloads.nextId++; downloads.calls.push({ ...o, id }); downloads.items.set(id, { id, state: "in_progress", bytesReceived: 100, totalBytes: 1000, filename: "C:\\Users\\x\\Downloads\\" + o.filename }); setTimeout(() => {
        const it = downloads.items.get(id); if (downloads.behaviour === "complete") { it.state = "complete"; it.fileSize = 1000; } else if (downloads.behaviour === "forbidden") { it.state = "interrupted"; it.error = "SERVER_FORBIDDEN"; } }, 200); return id; },
      search: async ({ id }) => [downloads.items.get(id)].filter(Boolean),
      cancel: async (id) => { const it = downloads.items.get(id); if (it) { it.state = "interrupted"; it.error = "USER_CANCELED"; } }
    }
  };
  return { browser, sent, downloads, hostsSpawned, store };
}

function loadExtension(opts) {
  const fake = createBrowser(opts);
  const sandbox = { browser: fake.browser, console, fetch, crypto, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Promise, Map, Set, JSON, Date, Number, Math, Object, Array, String, RegExp, Error, Boolean, Symbol,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0" } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ["extension/lib/util.js", "extension/background.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  const message = async (msg, sender = {}) => {
    for (const l of fake.browser.runtime.onMessage.listeners) { const r = l(JSON.parse(JSON.stringify(msg)), sender); if (r !== undefined) return r; }
  };
  let rid = 0;
  const net = async (tabId, url, { contentType = "", status = 200, headers = {}, resHeaders = [] } = {}) => {
    const requestId = `r${++rid}`;
    const reqHeaders = Object.entries(headers).map(([name, value]) => ({ name, value }));
    fake.browser.webRequest.onBeforeSendHeaders.fire({ tabId, requestId, url, requestHeaders: reqHeaders });
    const rh = [{ name: "Content-Type", value: contentType }, ...resHeaders];
    fake.browser.webRequest.onHeadersReceived.fire({ tabId, requestId, url, statusCode: status, responseHeaders: rh });
    // responses without Content-Length get a 1-byte range probe for their size before they are listed
    const hasLength = resHeaders.some((h) => /content-length|content-range/i.test(h.name));
    await sleep(hasLength || !/video|audio/.test(contentType) ? 15 : 250);
  };
  return { ...fake, message, net };
}

const waitFor = async (pred, ms = 20000, label = "condition") => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out: " + label); await sleep(60); } };
const tabState = async (x, tabId) => x.message({ type: "get-state", tabId });
const jobUpdates = (x, jobId) => x.sent.filter((m) => m.type === "job-update" && m.job.jobId === jobId).map((m) => m.job);

(async () => {
  const media = path.join(TMP, "bgmedia");
  const { ffmpeg, ffprobe } = generateMedia(media);
  const server = await startServer(media);
  const PAGE = "http://example.test/watch?v=1";
  const leftovers = [];   // files this test created in the real default folder; removed at the end

  const x = loadExtension({ ffmpeg });
  const TAB = 7;
  x.browser.tabs.pages[TAB] = { id: TAB, url: PAGE, title: "Window title - Browser" };
  const sender = { tab: { id: TAB, url: PAGE, title: "Window title - Browser" }, frameId: 0 };
  await x.message({ type: "page-meta", title: "Adam Scott: Armchair Expert / with Dax?", url: PAGE, thumbnail: "http://example.test/thumb.jpg", duration: 6 }, sender);

  await test("detects HLS master by network observation; variant/audio playlists and 40 segments are grouped away", async () => {
    const hdrs = { Referer: PAGE, "User-Agent": "UA-from-page", Cookie: "sess=abc" };
    await x.net(TAB, server.base + "/media/master/master.m3u8", { contentType: "application/vnd.apple.mpegurl", headers: hdrs });
    await waitFor(async () => (await tabState(x, TAB)).items[0]?.manifest?.state === "ok", 10000, "manifest analysis");
    // child playlists + segments arrive afterwards (as a real player would request them)
    for (const v of ["v360", "v180", "aud"]) await x.net(TAB, `${server.base}/media/master/${v}/index.m3u8`, { contentType: "application/vnd.apple.mpegurl", headers: hdrs });
    for (let i = 0; i < 40; i++) await x.net(TAB, `${server.base}/media/master/v360/index${i}.ts`, { contentType: "video/mp2t", headers: hdrs });
    for (let i = 0; i < 5; i++) await x.net(TAB, `${server.base}/media/dash/chunk-stream0-0000${i}.m4s`, { contentType: "video/iso.segment", headers: hdrs });
    await x.net(TAB, `${server.base}/media/dash/init-stream0.m4s`, { contentType: "video/mp4", headers: hdrs });
    const s = await tabState(x, TAB);
    eq(s.items.length, 1, "visible items: " + JSON.stringify(s.items.map((i) => i.url)));
    const it = s.items[0];
    eq(it.kind, "hls"); eq(it.manifest.master, true); eq(it.manifest.choices.map((c) => c.label), ["360p", "180p"]);
    assert(Math.abs(it.manifest.duration - 6) < 0.5, "duration " + it.manifest.duration);
    eq(it.manifest.drm, null); eq(it.pageTitle, "Adam Scott: Armchair Expert / with Dax?");
    eq(x.browser.action.badge[TAB], "1", "badge count");
  });

  await test("ordinary media types are detected too: mp4, webm, mp3, wav, m4a, aac, ogg, opus, DASH", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[1] = { id: 1, url: PAGE, title: "t" };
    for (const [name, ct] of [["a.mp4", "video/mp4"], ["a.webm", "video/webm"], ["a.mp3", "audio/mpeg"], ["a.wav", "audio/wav"], ["a.m4a", "audio/mp4"], ["a.aac", "audio/aac"], ["a.ogg", "audio/ogg"], ["a.opus", "audio/opus"], ["a.mov", "video/quicktime"]])
      await y.net(1, `${server.base}/media/file/${name}`, { contentType: ct, resHeaders: [{ name: "Content-Length", value: "500000" }] });
    await y.net(1, `${server.base}/media/dash/manifest.mpd`, { contentType: "application/dash+xml" });
    await waitFor(async () => (await tabState(y, 1)).items.find((i) => i.kind === "dash")?.manifest?.state === "ok", 10000, "dash analysis");
    const kinds = (await tabState(y, 1)).items.map((i) => i.kind).sort();
    eq(kinds, ["audio", "audio", "audio", "audio", "audio", "audio", "dash", "video", "video", "video"]);
  });

  await test("duplicate requests / range requests for one file collapse into one entry; 206 total size from Content-Range", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[1] = { id: 1, url: PAGE, title: "t" };
    const u = server.base + "/media/file/clip.mp4";
    for (let i = 0; i < 6; i++) await y.net(1, `${u}?range=${i}`, { contentType: "video/mp4", status: 206, resHeaders: [{ name: "Content-Range", value: `bytes ${i * 1000}-${i * 1000 + 999}/8000000` }, { name: "Content-Length", value: "1000" }] });
    const s = await tabState(y, 1); eq(s.items.length, 1); eq(s.items[0].contentLength, 8000000);
    await y.net(1, server.base + "/media/file/probe.mp4", { contentType: "video/mp4", status: 206, resHeaders: [{ name: "Content-Length", value: "2048" }] });
    eq((await tabState(y, 1)).items.length, 1, "tiny range probe must not appear");
  });

  await test("ONLY REAL FILES: tiny UI sounds are never listed (size seen on the wire, size unknown from the page scan, remembered on rescan)", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[21] = { id: 21, url: PAGE, title: "YouTube" };
    const sender21 = { tab: { id: 21, url: PAGE }, frameId: 0 };
    // 1) size known from response headers (YouTube-style 6 KB sounds)
    for (const n of ["open", "no_input", "success", "failure"])
      await y.net(21, `https://www.youtube.com/s/search/audio/${n}.mp3`, { contentType: "audio/mpeg", resHeaders: [{ name: "Content-Length", value: "6200" }] });
    eq((await tabState(y, 21)).items.length, 0, "wire-size filter");
    // 2) found by the page scan (no size): the background asks the server with a 1-byte range request
    await y.message({ type: "content-media", items: [{ url: server.base + "/media/file/open.mp3", contentType: "audio/mpeg", source: "performance" }, { url: server.base + "/media/file/song.mp3", contentType: "audio/mpeg", source: "performance" }] }, sender21);
    const s = await waitFor(async () => { const t = await tabState(y, 21); return t.items.length === 1 && t; }, 8000, "probe result");
    eq(s.items[0].url, server.base + "/media/file/song.mp3"); assert(s.items[0].contentLength > 100 * 1024, "song size " + s.items[0].contentLength);
    // 3) rescans do not bring the rejected ones back (and do not re-probe them)
    const before = server.log.length;
    for (let i = 0; i < 3; i++) await y.message({ type: "content-media", items: [{ url: server.base + "/media/file/open.mp3", contentType: "audio/mpeg", source: "performance" }] }, sender21);
    await sleep(300);
    eq((await tabState(y, 21)).items.length, 1, "rejected item came back");
    eq(server.log.slice(before).filter((l) => l.path.endsWith("open.mp3")).length, 0, "re-probed a rejected file");
    eq(y.browser.action.badge[21], "1", "badge counts only real files");
  });

  await test("ONE ENTRY PER STREAM: master requested twice (different tokens) + renditions whose URLs differ from the master's -> a single entry", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[31] = { id: 31, url: PAGE, title: "YouTube-like" };
    const ct = "application/vnd.apple.mpegurl";
    await y.net(31, server.base + "/media/master/master.m3u8?tok=1", { contentType: ct });
    await waitFor(async () => (await tabState(y, 31)).items[0]?.manifest?.state === "ok", 8000, "first master analysed");
    // rendition playlists the player fetches (one with a different query string, one on an unrelated path of the same host)
    await y.net(31, server.base + "/media/master/v360/index.m3u8?tok=other", { contentType: ct });
    await y.net(31, server.base + "/media/hls/index.m3u8?tok=9", { contentType: ct });
    // second player instance requests the same stream again
    await y.net(31, server.base + "/media/master/master.m3u8?tok=2", { contentType: ct });
    await waitFor(async () => { const all = [...(await y.message({ type: "get-state", tabId: 31 })).items]; return all.length === 1 && all[0].manifest?.state === "ok"; }, 8000, "grouped to one entry");
    const s = await tabState(y, 31);
    eq(s.items.length, 1, JSON.stringify(s.items.map((i) => i.url)));
    eq(s.items[0].manifest.master, true); eq(s.items[0].manifest.choices.map((c) => c.label), ["360p", "180p"]);
  });

  await test("MULTIPLE AUDIO TRACKS end to end: popup default = original track; choosing another track downloads that one", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[41] = { id: 41, url: PAGE, title: "Multi Audio" };
    await y.net(41, server.base + "/media/multiaudio/master.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    const it = await waitFor(async () => { const i = (await tabState(y, 41)).items[0]; return i?.manifest?.state === "ok" && i; }, 8000, "analysis");
    const tracks = it.manifest.audioTracks;
    eq(tracks.length, 2); eq(tracks.filter((t) => t.preferred).map((t) => t.key), ["eng"], "preferred must be the original");
    const done = async (extra) => { const res = await y.message({ type: "download", tabId: 41, key: it.key, mode: "audio", ...extra }); const d = await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => ["done", "error"].includes(j.state)), 60000, "job"); eq(d.state, "done", JSON.stringify(d)); leftovers.push(d.file); return d.file; };
    eq(probe(ffprobe, await done({})).audio[0].sample_rate, "48000", "default must be the original track");
    eq(probe(ffprobe, await done({ audio: "spa" })).audio[0].sample_rate, "32000", "explicit choice must be honoured");
    eq(probe(ffprobe, await done({ audio: "eng" })).audio[0].sample_rate, "48000");
  });

  await test("a standalone media playlist (no master anywhere) is still listed", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[32] = { id: 32, url: PAGE, title: "Solo" };
    await y.net(32, server.base + "/media/hls/index.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    const it = await waitFor(async () => { const i = (await tabState(y, 32)).items[0]; return i?.manifest?.state === "ok" && i; }, 8000, "analysis");
    eq(it.manifest.master, false); assert(it.manifest.segmentCount >= 3, "segment count " + it.manifest.segmentCount);
  });

  await test("in-page navigation (same document, new video) clears the previous video's media; #hash / &t changes do not", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[33] = { id: 33, url: "https://www.example.test/watch?v=AAA", title: "A" };
    const s33 = { tab: { id: 33, url: "https://www.example.test/watch?v=AAA" }, frameId: 0 };
    await y.message({ type: "page-meta", title: "A", url: "https://www.example.test/watch?v=AAA" }, s33);
    await y.net(33, server.base + "/media/file/clip.mp4", { contentType: "video/mp4", resHeaders: [{ name: "Content-Length", value: "300000" }] });
    eq((await tabState(y, 33)).items.length, 1);
    y.browser.tabs.onUpdated.fire(33, { url: "https://www.example.test/watch?v=AAA&t=30s#x" }); await sleep(30);
    eq((await tabState(y, 33)).items.length, 1, "same video must keep its media");
    await sleep(5300);    // the old video's media is now older than the navigation grace window (5 s)
    // the NEW video's stream starts loading just before the URL change is reported: it must survive
    await y.net(33, server.base + "/media/file/song.mp3", { contentType: "audio/mpeg", resHeaders: [{ name: "Content-Length", value: "480000" }] });
    y.browser.tabs.onUpdated.fire(33, { url: "https://www.example.test/watch?v=BBB" }); await sleep(30);
    const after = await tabState(y, 33);
    eq(after.items.map((i) => i.url.split("/").pop()), ["song.mp3"], "old video cleared, new video's early request kept");
  });

  await test("ONLY REAL FILES: an HTML page behind an .m3u8 URL is not listed (decided by the page's own response)", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[22] = { id: 22, url: PAGE, title: "T" };
    await y.net(22, server.base + "/media/drm/notmanifest.m3u8", { contentType: "text/html" });
    await sleep(600);
    const s = await tabState(y, 22);
    eq(s.items.length, 0); eq(s.ignored.counts["not-a-playlist"], 1);
  });

  await test("a real stream is NEVER deleted because our own second request got a different answer (session-bound links)", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[23] = { id: 23, url: PAGE, title: "T" };
    // the page's response said it is an HLS playlist; our re-fetch of this URL returns an HTML page (as session-bound links may)
    await y.net(23, server.base + "/media/drm/notmanifest.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    await sleep(700);
    const s = await tabState(y, 23);
    eq(s.items.length, 1, "stream must stay listed"); eq(s.items[0].manifest.state, "unreadable");
  });

  await test("WHY NOTHING: the popup state reports what was seen but not listed (YouTube ump, segments, tiny files)", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[24] = { id: 24, url: "https://www.youtube.com/watch?v=x", title: "YouTube" };
    await y.net(24, "https://rr1---sn-abc.googlevideo.com/videoplayback?rn=1&n=abc&sig=xyz", { contentType: "application/vnd.yt-ump", resHeaders: [{ name: "Content-Length", value: "900000" }] });
    for (let i = 0; i < 4; i++) await y.net(24, `https://cdn.example.test/seg-${i}.m4s`, { contentType: "video/iso.segment" });
    await y.net(24, "https://www.youtube.com/s/search/audio/open.mp3", { contentType: "audio/mpeg", resHeaders: [{ name: "Content-Length", value: "6200" }] });
    await sleep(100);
    const s = await tabState(y, 24);
    eq(s.items.length, 0); eq(s.ignored.counts["yt-ump"], 1); eq(s.ignored.counts.segment, 4); eq(s.ignored.counts.tiny, 1);
    assert(s.ignored.samples.some((x) => x.reason === "yt-ump" && /videoplayback/.test(x.url)), "sample missing");
  });

  await test("companion-status sends a real ping and requires a valid pong (green path)", async () => {
    const st = await x.message({ type: "companion-status" });
    eq(st.connected, true); eq(st.ffmpegFound, true); assert(/^\d+\.\d+\.\d+$/.test(st.version), "version"); assert(/ffmpeg version/i.test(st.ffmpegVersion), st.ffmpegVersion);
  });

  await test("companion-status when host is NOT registered: red state with a useful reason (no exception)", async () => {
    const y = loadExtension({ ffmpeg, registered: false });
    const st = await y.message({ type: "companion-status" });
    eq(st.connected, false); eq(st.code, "not_registered");
    assert(/Install-Companion\.cmd/.test(st.reason) && /Firefox/.test(st.reason), st.reason);
    const again = await y.message({ type: "companion-status" });   // port was dropped; a new attempt must work the same way
    eq(again.connected, false);
  });

  await test("HLS download, quality 180p chosen: popup -> background -> native host -> FFmpeg -> finished 180p MP4 named from page title", async () => {
    const s = await tabState(x, TAB);
    const choice = s.items[0].manifest.choices.find((c) => c.label === "180p");
    server.log.length = 0;
    const res = await x.message({ type: "download", tabId: TAB, key: s.items[0].key, mode: "video", saveAs: false, quality: choice.id });
    const jobId = res.job.jobId;
    const done = await waitFor(() => jobUpdates(x, jobId).find((j) => j.state === "done" || j.state === "error"), 60000, "job end");
    eq(done.state, "done", JSON.stringify(done));
    leftovers.push(done.file);
    // Referer / User-Agent / Cookie captured from the page's own manifest request were forwarded to FFmpeg's segment requests
    const segs = server.log.filter((l) => l.path.endsWith(".ts") && l.path.includes("/v180/"));
    assert(segs.length >= 3, "segments requested: " + segs.length);
    for (const l of segs) { eq(l.headers.referer, PAGE, "segment Referer"); eq(l.headers["user-agent"], "UA-from-page", "segment UA"); assert(/sess=abc/.test(l.headers.cookie || ""), "segment cookie"); }
    assert(/Downloads\\MediaGrab\\Adam Scott Armchair Expert with Dax( \(\d+\))?\.mp4$/.test(done.file), "file name/location: " + done.file);
    const p = probe(ffprobe, done.file); eq(p.video[0].height, 180); eq(p.audio.length, 1); assert(Math.abs(p.duration - 6) < 0.6, "duration");
    const states = jobUpdates(x, jobId).map((j) => j.state);
    assert(states.includes("running") && states[states.length - 1] === "done", "states " + states);
  });

  await test("HLS download, Best quality, audio-only mode -> MP3 in Downloads\\MediaGrab", async () => {
    const s = await tabState(x, TAB);
    const res = await x.message({ type: "download", tabId: TAB, key: s.items[0].key, mode: "audio" });
    const done = await waitFor(() => jobUpdates(x, res.job.jobId).find((j) => ["done", "error"].includes(j.state)), 60000, "audio job");
    eq(done.state, "done", JSON.stringify(done)); leftovers.push(done.file);
    assert(done.file.endsWith(".mp3"), done.file); eq(probe(ffprobe, done.file).audio[0].codec_name, "mp3");
  });

  await test("job state survives the popup closing: get-state returns the finished jobs for the tab", async () => {
    const s = await tabState(x, TAB);
    assert(s.jobs.length >= 2 && s.jobs.every((j) => j.itemKey === s.items[0].key), "jobs " + JSON.stringify(s.jobs.map((j) => j.state)));
    eq(s.jobs.filter((j) => j.state === "done").length >= 2, true);
  });

  await test("multiple sequential downloads reuse ONE host process (persistent port)", async () => {
    eq(x.hostsSpawned.length, 1, "host processes spawned");
  });

  await test("DRM-protected playlist is flagged and download is refused before anything runs", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[2] = { id: 2, url: PAGE, title: "Protected" };
    await y.net(2, server.base + "/media/drm/fairplay.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    const it = await waitFor(async () => { const i = (await tabState(y, 2)).items[0]; return i?.manifest?.state === "ok" && i; }, 10000, "drm analysis");
    assert(it.manifest.drm, "drm flag missing");
    let err = null; try { await y.message({ type: "download", tabId: 2, key: it.key, mode: "video" }); } catch (e) { err = e; }
    assert(err && /protected/i.test(err.message) && /does not decrypt/i.test(err.message), "error: " + (err && err.message));
    eq(y.hostsSpawned.length, 0, "host should not even be started");
  });

  await test("direct MP4: uses Firefox Downloads API into MediaGrab\\ with a safe smart name; progress -> finished", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[3] = { id: 3, url: PAGE, title: "x" };
    await y.message({ type: "page-meta", title: 'My "Best" Video: Part 1/2?', url: PAGE, duration: 6 }, { tab: { id: 3, url: PAGE }, frameId: 0 });
    await y.net(3, server.base + "/media/file/clip.mp4", { contentType: "video/mp4", resHeaders: [{ name: "Content-Length", value: "150000" }] });
    const it = (await tabState(y, 3)).items[0];
    const res = await y.message({ type: "download", tabId: 3, key: it.key, mode: "video", saveAs: false });
    const call = y.downloads.calls[0];
    eq(call.filename, "MediaGrab/My Best Video Part 1 2.mp4"); eq(call.conflictAction, "uniquify"); eq(call.saveAs, false); eq(call.url, server.base + "/media/file/clip.mp4");
    const done = await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => j.state === "done"), 8000, "direct job done");
    assert(done.status === "Finished", "status"); eq(y.hostsSpawned.length, 0, "direct downloads must not need the companion");
    // Download As...
    await y.message({ type: "download", tabId: 3, key: it.key, mode: "video", saveAs: true });
    eq(y.downloads.calls[1].saveAs, true);
  });

  await test("Smartnaming OFF keeps the URL's file name", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[4] = { id: 4, url: "http://example.test/page", title: "x" };
    await y.message({ type: "page-meta", title: "Some Title", url: "http://example.test/page" }, { tab: { id: 4, url: "http://example.test/page" }, frameId: 0 });
    await y.browser.storage.local.set({ "pref:example.test:smartname": false });
    await y.net(4, server.base + "/media/file/clip.mp4", { contentType: "video/mp4" });
    await y.message({ type: "download", tabId: 4, key: (await tabState(y, 4)).items[0].key, mode: "video" });
    eq(y.downloads.calls[0].filename, "MediaGrab/clip.mp4");
  });

  await test("direct download refused with 403 (no Referer from Firefox's downloader) -> automatically retried through the companion with the page's headers", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[5] = { id: 5, url: PAGE, title: "Gated" };
    await y.message({ type: "page-meta", title: "Gated Clip", url: PAGE, duration: 6 }, { tab: { id: 5, url: PAGE }, frameId: 0 });
    y.downloads.behaviour = "forbidden";
    await y.net(5, server.base + "/secure/file/clip.mp4", { contentType: "video/mp4", headers: { Referer: PAGE, Cookie: "sess=abc", "User-Agent": "UA" }, resHeaders: [{ name: "Content-Length", value: "150000" }] });
    const it = (await tabState(y, 5)).items[0];
    const res = await y.message({ type: "download", tabId: 5, key: it.key, mode: "video" });
    const done = await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => j.state === "done" || j.state === "error"), 40000, "fallback job");
    eq(done.state, "done", JSON.stringify(done)); leftovers.push(done.file);
    eq(done.via, "native"); eq(probe(ffprobe, done.file).video.length, 1);
  });

  await test("cancel from the popup stops a running native job", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[6] = { id: 6, url: PAGE, title: "Slow" };
    await y.net(6, server.base + "/slow/hls/index.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    const it = await waitFor(async () => { const i = (await tabState(y, 6)).items[0]; return i?.manifest?.state === "ok" && i; }, 10000, "analysis");
    const res = await y.message({ type: "download", tabId: 6, key: it.key, mode: "video" });
    await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => j.state === "running" && /Downloading|Starting|Inspect/.test(j.status)), 20000, "running");
    await sleep(500);
    await y.message({ type: "cancel-job", jobId: res.job.jobId });
    const end = await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => ["cancelled", "error", "done"].includes(j.state)), 20000, "cancel end");
    eq(end.state, "cancelled", JSON.stringify(end));
  });

  await test("host crash/closed mid-job -> job fails with a clear message instead of hanging", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[8] = { id: 8, url: PAGE, title: "Crash" };
    await y.net(8, server.base + "/slow/hls/index.m3u8", { contentType: "application/vnd.apple.mpegurl" });
    const it = await waitFor(async () => { const i = (await tabState(y, 8)).items[0]; return i?.manifest?.state === "ok" && i; }, 10000, "analysis");
    const res = await y.message({ type: "download", tabId: 8, key: it.key, mode: "video" });
    await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => j.state === "running"), 20000, "running");
    y.hostsSpawned[0].proc.kill();
    const end = await waitFor(() => jobUpdates(y, res.job.jobId).find((j) => j.state === "error"), 15000, "error state");
    assert(/Companion/i.test(end.message), end.message);
  });

  await test("closing the tab / navigating clears its media and state", async () => {
    const y = loadExtension({ ffmpeg }); y.browser.tabs.pages[9] = { id: 9, url: PAGE, title: "T" };
    await y.message({ type: "page-meta", title: "T", url: PAGE }, { tab: { id: 9, url: PAGE }, frameId: 0 });
    await y.net(9, server.base + "/media/file/clip.mp4", { contentType: "video/mp4" });
    eq((await tabState(y, 9)).items.length, 1);
    await sleep(5300);   // media younger than the 5 s navigation grace window is kept (it may belong to the new page)
    y.browser.tabs.onUpdated.fire(9, { status: "loading", url: "http://example.test/other" });
    await sleep(50);
    eq((await tabState(y, 9)).items.length, 0, "cleared on navigation");
    await y.net(9, server.base + "/media/file/clip.mp4", { contentType: "video/mp4" });
    y.browser.tabs.onRemoved.fire(9); await sleep(20);
    eq((await tabState(y, 9)).items.length, 0, "cleared on close");
  });

  await test("subframe page-meta cannot overwrite the top page's title", async () => {
    const y = loadExtension({ ffmpeg });
    await y.message({ type: "page-meta", title: "Top Title", url: PAGE }, { tab: { id: 11, url: PAGE }, frameId: 0 });
    await y.message({ type: "page-meta", title: "Ad iframe", url: "http://ads/", thumbnail: "http://x/t.jpg", duration: 30 }, { tab: { id: 11, url: PAGE }, frameId: 5 });
    y.browser.tabs.pages[11] = { id: 11, url: PAGE, title: "Top Title" };
    await y.net(11, server.base + "/media/file/clip.mp4", { contentType: "video/mp4" });
    const s = await tabState(y, 11); eq(s.title, "Top Title"); eq(s.items[0].thumbnail, "http://x/t.jpg");
  });

  // cleanup files created in the real Downloads\MediaGrab folder by this run
  for (const f of leftovers) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
  for (const h of x.hostsSpawned) { try { h.proc.stdin.end(); } catch (_) {} }
  await server.close();
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} background-flow tests passed`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
