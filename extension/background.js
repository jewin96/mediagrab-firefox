/* MediaGrab background script (Firefox MV3 event page).
 * Clean-room implementation for media the user is authorized to save.
 * It does not bypass DRM/EME, encrypted manifests, paywalls, or access controls: protected streams are
 * detected and refused. Pure helpers live in lib/util.js (shared with the tests).
 */

const HOST_NAME = "com.mediagrab.host";
const MIN_HOST_VERSION = "1.0.0";   // oldest companion this extension version works with
const MAX_ITEMS_PER_TAB = 60;
const PING_TIMEOUT_MS = 6000;
const IDLE_DISCONNECT_MS = 2 * 60 * 1000;

/* =====================================================================
 * Per-tab detected-media state (in memory, mirrored to storage.session)
 * ===================================================================== */

const tabStates = new Map();   // tabId -> { items: Map(key -> item), meta, children: Set(key) }
const tabLoads = new Map();
const persistTimers = new Map();
const jobs = new Map();        // jobId -> job (see makeJob)

function getTab(tabId) {
  if (tabStates.has(tabId)) return Promise.resolve(tabStates.get(tabId));
  if (!tabLoads.has(tabId)) {
    tabLoads.set(tabId, (async () => {
      let saved = null;
      try { saved = (await browser.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`]; } catch (_) {}
      const state = { items: new Map(), meta: saved?.meta || {}, children: new Set(saved?.children || []), childPaths: new Set(saved?.childPaths || []), rejected: new Set(saved?.rejected || []) };
      for (const it of saved?.items || []) state.items.set(it.key, it);
      tabStates.set(tabId, state);
      tabLoads.delete(tabId);
      return state;
    })());
  }
  return tabLoads.get(tabId);
}

function persistSoon(tabId) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(async () => {
    const st = tabStates.get(tabId);
    if (!st) return;
    try {
      await browser.storage.session.set({ [`tab:${tabId}`]: { items: [...st.items.values()], meta: st.meta, children: [...st.children], childPaths: [...st.childPaths], rejected: [...st.rejected] } });
    } catch (_) {}
  }, 400));
}

function visibleItems(st) {
  return [...st.items.values()].filter((i) => !i.hidden && !i.groupHidden && !i.probing).sort((a, b) => b.discoveredAt - a.discoveredAt);
}

async function updateBadge(tabId) {
  const st = tabStates.get(tabId);
  const count = st ? visibleItems(st).length : 0;
  try {
    await browser.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : "" });
    if (count) await browser.action.setBadgeBackgroundColor({ tabId, color: "#8f5cf2" });
  } catch (_) {}
}

/* =====================================================================
 * Request header capture (Referer / UA / Cookie that the page itself used)
 * ===================================================================== */

const requestHeaders = new Map(); // requestId -> { referer, user-agent, cookie, origin }

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !details.requestHeaders) return;
    const keep = {};
    for (const h of details.requestHeaders) {
      const name = String(h.name || "").toLowerCase();
      if (["referer", "user-agent", "cookie", "origin"].includes(name) && typeof h.value === "string" && h.value) keep[name] = h.value;
    }
    requestHeaders.set(details.requestId, keep);
    if (requestHeaders.size > 400) requestHeaders.delete(requestHeaders.keys().next().value);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders"]
);

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h && typeof h.value === "string" ? h.value : "";
}

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const captured = requestHeaders.get(details.requestId) || {};
    requestHeaders.delete(details.requestId);
    if (details.statusCode >= 400) return;
    const contentType = headerValue(details.responseHeaders, "content-type");
    if (!MG.isCandidate(details.url, contentType)) return;

    const len = Number.parseInt(headerValue(details.responseHeaders, "content-length"), 10);
    const range = /\/(\d+)\s*$/.exec(headerValue(details.responseHeaders, "content-range"));
    const partial = details.statusCode === 206;
    const total = range ? Number.parseInt(range[1], 10) : (!partial && len > 0 ? len : null);
    addMedia(details.tabId, {
      url: details.url,
      contentType,
      contentLength: total,
      sliceLength: Number.isFinite(len) ? len : null,
      partial,
      headers: captured,
      source: "network"
    }).catch((e) => console.error("addMedia", e));
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

async function addMedia(tabId, input) {
  if (!Number.isInteger(tabId) || tabId < 0 || !MG.isHttpUrl(input.url)) return;
  const kindHint = MG.mediaKind(input.url, input.contentType);
  const lengthForCheck = Number.isFinite(input.contentLength) ? input.contentLength : input.sliceLength;
  if (MG.isSegmentLike(input.url, { contentType: input.contentType, length: lengthForCheck, partial: input.partial && !input.contentLength })) return;

  const st = await getTab(tabId);
  const key = MG.normalizeKey(input.url);
  if (st.rejected.has(key)) return;
  const ct = MG.cleanType(input.contentType);
  const direct = kindHint === "video" || kindHint === "audio" || (kindHint === "unknown" && (ct.startsWith("video/") || ct.startsWith("audio/")));
  // Only real files: tiny direct audio/video (UI sounds, blips) is never offered.
  if (direct && Number.isFinite(input.contentLength) && input.contentLength > 0 && input.contentLength < MG.MIN_MEDIA_BYTES) {
    st.rejected.add(key); st.items.delete(key); persistSoon(tabId); updateBadge(tabId);
    return;
  }
  let item = st.items.get(key);
  const isNew = !item;
  if (!item) {
    item = {
      key, url: input.url, kind: kindHint === "unknown" ? (ct.startsWith("audio/") ? "audio" : "video") : kindHint,
      contentType: ct, contentLength: null, source: input.source || "page",
      headers: {}, manifest: null, hidden: st.children.has(key) || st.childPaths.has(MG.pathKey(input.url)), discoveredAt: Date.now()
    };
    st.items.set(key, item);
  }
  if (ct && !item.contentType) item.contentType = ct;
  if (Number.isFinite(input.contentLength) && input.contentLength > 0) item.contentLength = input.contentLength;
  if (input.headers && Object.keys(input.headers).length && (!item.headers.referer || input.headers.referer)) item.headers = { ...item.headers, ...input.headers };

  if (isNew && st.items.size > MAX_ITEMS_PER_TAB) {
    const oldest = [...st.items.values()].sort((a, b) => a.discoveredAt - b.discoveredAt)[0];
    if (oldest) st.items.delete(oldest.key);
  }
  if (isNew && direct && !item.contentLength) {
    // Size unknown (found in the page, not seen on the wire): ask the server with a 1-byte range request before showing it.
    item.probing = true;
    probeSize(tabId, key).catch((e) => console.warn("probeSize", e));
  }
  if ((item.kind === "hls" || item.kind === "dash") && !item.manifest) {
    item.manifest = { state: "loading" };
    analyzeManifest(tabId, key).catch((e) => console.warn("analyzeManifest", e));
  }
  persistSoon(tabId);
  updateBadge(tabId);
}

async function probeSize(tabId, key) {
  const st = await getTab(tabId);
  const item = st.items.get(key);
  if (!item) return;
  let size = null, notMedia = false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(item.url, { headers: { Range: "bytes=0-0" }, credentials: "include", cache: "no-store", signal: ctl.signal });
    const range = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
    const len = Number.parseInt(res.headers.get("content-length") || "", 10);
    if (res.status === 206 && range) size = Number.parseInt(range[1], 10);
    else if (res.status === 200 && len > 0) size = len;
    const type = MG.cleanType(res.headers.get("content-type") || "");
    if (type && !item.contentType) item.contentType = type;
    notMedia = res.ok && type.startsWith("text/");   // an HTML page is not a media file
    ctl.abort();   // headers are enough; never download the body
  } catch (_) { /* network/CORS failure: keep the item, we just don't know its size */ }
  clearTimeout(timer);
  item.probing = false;
  if (size) item.contentLength = size;
  if (notMedia || (size && size < MG.MIN_MEDIA_BYTES)) { st.items.delete(key); st.rejected.add(key); }
  persistSoon(tabId);
  updateBadge(tabId);
}

/* =====================================================================
 * Manifest analysis: classify master/media, duration, live, DRM, qualities
 * ===================================================================== */

async function fetchText(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store", signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: (await res.text()).slice(0, 4_000_000), url: res.url || url };
  } finally { clearTimeout(timer); }
}

async function analyzeManifest(tabId, key) {
  const st = await getTab(tabId);
  const item = st.items.get(key);
  if (!item) return;
  try {
    const { text, url: finalUrl } = await fetchText(item.url);
    if (item.kind === "dash") {
      const d = MG.parseDash(text);
      if (!d.valid) throw new Error("not a DASH manifest");
      item.manifest = { state: "ok", master: false, live: d.live, duration: d.duration || null, drm: d.drm, heights: d.heights };
    } else {
      const h = MG.parseHls(text, finalUrl);
      if (!h.valid) throw new Error("not an HLS playlist");
      const m = { state: "ok", master: h.master, live: h.live, duration: h.duration || null, drm: h.drm, aes128: h.aes128, choices: [], segmentCount: h.segments };
      if (h.master) {
        m.choices = MG.hlsChoices(h);
        // Group: variant and rendition playlists belong to this master and are not separate downloads.
        const child = new Set();
        for (const v of h.variants) child.add(MG.normalizeKey(v.url));
        for (const g of Object.values(h.audioGroups)) for (const a of g) if (a.url) child.add(MG.normalizeKey(a.url));
        for (const c of child) { st.children.add(c); st.childPaths.add(MG.pathKey(c)); }
        for (const other of st.items.values()) {
          if (other !== item && (st.children.has(other.key) || st.childPaths.has(MG.pathKey(other.url)))) other.hidden = true;
        }
        // Peek at the best variant for duration / live / key information.
        const best = [...h.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
        if (best) {
          try {
            const sub = MG.parseHls((await fetchText(best.url)).text, best.url);
            if (sub.valid) { m.duration = sub.duration || null; m.live = sub.live; m.drm = m.drm || sub.drm; m.aes128 = m.aes128 || sub.aes128; }
          } catch (_) {}
        }
        // Audio tracks of the best variant's group: the popup lets the user choose when there are several.
        const bestGroup = (h.audioGroups[best?.audioGroup] || []).filter((g) => g.url);
        const preferred = MG.pickAudio(bestGroup);
        m.audioTracks = bestGroup.map((g) => ({ key: g.key, label: MG.audioLabel(g), url: g.url, preferred: g === preferred }));
        m.bestVariantUrl = best?.url || "";
        m.variantCount = h.variants.length;
        m.audioCount = Object.values(h.audioGroups).reduce((n, g) => n + g.length, 0);
        m.bandwidth = best?.bandwidth || 0;
        m.heights = [...new Set(h.variants.map((v) => v.height).filter(Boolean))].sort((a, b) => b - a);
      }
      item.manifest = m;
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (/^not an? (HLS|DASH)/i.test(msg)) {
      // The URL returned something that is not a manifest (HTML error page, login wall): not a real stream.
      st.items.delete(key); st.rejected.add(key);
    } else item.manifest = { state: "unreadable", error: msg };
  }
  regroup(st);
  persistSoon(tabId);
  updateBadge(tabId);
}

/* Players often request the same stream more than once (preview + main player, reloads) and fetch each rendition playlist
 * right after the master. Show ONE entry per stream: renditions of a master and repeated masters of the same stream are hidden. */
function regroup(st) {
  const streams = [...st.items.values()].filter((i) => (i.kind === "hls" || i.kind === "dash") && i.manifest?.state === "ok");
  for (const i of streams) i.groupHidden = false;
  const hostOf = (i) => { try { return new URL(i.url).host; } catch (_) { return ""; } };
  const masters = streams.filter((i) => i.manifest.master);
  // 1) playlists fetched on the master's host shortly after it are its renditions
  for (const i of streams) {
    if (i.kind !== "hls" || i.manifest.master) continue;
    if (masters.some((m) => hostOf(m) === hostOf(i) && Math.abs(i.discoveredAt - m.discoveredAt) < 60000)) i.groupHidden = true;
  }
  // 2) the same stream seen several times (same host, same duration): keep the richest, then the newest
  const rank = (i) => (i.manifest.variantCount || 0) * 1000 + (i.manifest.choices?.length || 0) * 10 + (i.manifest.segmentCount ? 1 : 0);
  const pool = streams.filter((i) => !i.groupHidden).sort((a, b) => rank(b) - rank(a) || b.discoveredAt - a.discoveredAt);
  const kept = [];
  for (const i of pool) {
    const d = i.manifest.duration;
    const dup = d && kept.some((k) => k.kind === i.kind && hostOf(k) === hostOf(i) && k.manifest.duration && Math.abs(k.manifest.duration - d) < 3 && k.manifest.master === i.manifest.master);
    if (dup) i.groupHidden = true; else kept.push(i);
  }
}

/* =====================================================================
 * Native messaging (single persistent port, request/response correlation)
 * ===================================================================== */

let port = null;
let lastNativeError = "";
let idleTimer = null;
const pending = new Map(); // reqId -> { resolve, reject, timer }

function explainNativeError(raw) {
  const text = String(raw || "");
  if (/No such native application/i.test(text))
    return { code: "not_registered", message: `Firefox cannot find the native host "${HOST_NAME}". Run companion\\Install-Companion.cmd, then close ALL Firefox windows and reopen Firefox.` };
  if (/permission|not allowed|allowed_extensions/i.test(text))
    return { code: "not_allowed", message: `The native host manifest does not allow this extension (allowed_extensions must contain ${browser.runtime.getManifest().browser_specific_settings?.gecko?.id}). Re-run Install-Companion.cmd.` };
  if (/timed out|timeout/i.test(text))
    return { code: "timeout", message: text };
  return { code: "host_exited", message: `The companion process stopped (${text || "no details"}). Run companion\\Diagnose-Companion.cmd and check %LOCALAPPDATA%\\MediaGrabCompanion\\mediagrab-host.log.` };
}

function failPending(error) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(error); pending.delete(id); }
}

function ensurePort() {
  if (port) return port;
  let p;
  try { p = browser.runtime.connectNative(HOST_NAME); }
  catch (err) {
    const e = explainNativeError(err?.message);
    throw Object.assign(new Error(e.message), { code: e.code });
  }
  port = p;
  p.onMessage.addListener(onNativeMessage);
  p.onDisconnect.addListener((disconnected) => {
    const raw = disconnected?.error?.message || browser.runtime.lastError?.message || "";
    if (port === p) port = null;
    lastNativeError = raw;
    const e = explainNativeError(raw);
    const err = Object.assign(new Error(e.message), { code: e.code });
    failPending(err);
    for (const job of jobs.values()) {
      if (job.via === "native" && (job.state === "starting" || job.state === "running")) finishJob(job, { state: "error", message: `Companion connection lost. ${e.message}`, code: e.code });
    }
  });
  return p;
}

function armIdleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = pending.size || [...jobs.values()].some((j) => j.via === "native" && (j.state === "starting" || j.state === "running"));
    if (busy) return armIdleDisconnect();
    if (port) { try { port.disconnect(); } catch (_) {} port = null; }
  }, IDLE_DISCONNECT_MS);
}

function nativeCall(message, timeoutMs = PING_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = ensurePort(); } catch (e) { reject(e); return; }
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(Object.assign(new Error(`The companion did not answer within ${Math.round(timeoutMs / 1000)} s.`), { code: "timeout" }));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    try { p.postMessage({ ...message, reqId }); }
    catch (e) { clearTimeout(timer); pending.delete(reqId); reject(e); }
    armIdleDisconnect();
  });
}

function onNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.reqId && pending.has(msg.reqId)) {
    const p = pending.get(msg.reqId);
    clearTimeout(p.timer);
    pending.delete(msg.reqId);
    if (msg.type === "error") p.reject(Object.assign(new Error(msg.message || "Companion error"), { code: msg.code }));
    else p.resolve(msg);
    return;
  }
  const job = msg.jobId && jobs.get(msg.jobId);
  if (!job) return;
  switch (msg.type) {
    case "started": job.state = "running"; job.status = "Starting…"; publishJob(job); break;
    case "progress":
      job.state = "running";
      job.percent = Number.isFinite(msg.percent) ? msg.percent : null;
      job.status = msg.status || job.status;
      job.speed = Number.isFinite(msg.speed) ? msg.speed : (job.speed || 0);   // bytes/s measured by the host
      if (Number.isFinite(msg.bytes)) job.bytes = msg.bytes;
      publishJob(job);
      break;
    case "completed": finishJob(job, { state: "done", file: msg.file, size: msg.size, percent: 100, status: "Finished" }); break;
    case "error":
      finishJob(job, { state: msg.code === "cancelled" ? "cancelled" : "error", message: msg.message || "Download failed.", code: msg.code });
      break;
  }
}

async function companionStatus() {
  try {
    const reply = await nativeCall({ action: "ping" }, PING_TIMEOUT_MS);
    if (reply.action !== "pong" || reply.ok !== true) throw new Error(`Unexpected reply from companion: ${JSON.stringify(reply).slice(0, 200)}`);
    return {
      connected: true, version: reply.version, outdated: MG.compareVersions(reply.version, MIN_HOST_VERSION) < 0, ffmpegFound: Boolean(reply.ffmpegFound),
      ffmpeg: reply.ffmpeg || "", ffmpegVersion: reply.ffmpegVersion || "", downloadDir: reply.downloadDir || ""
    };
  } catch (err) {
    const known = ["not_registered", "not_allowed", "timeout", "host_exited"].includes(err.code) ? { code: err.code, message: err.message } : explainNativeError(err.message);
    return { connected: false, code: known.code, reason: known.message, raw: lastNativeError };
  }
}

/* =====================================================================
 * Jobs
 * ===================================================================== */

function makeJob(fields) {
  const job = {
    jobId: crypto.randomUUID(), tabId: null, itemKey: "", via: "native", mode: "video",
    state: "starting", percent: null, status: "Starting…", file: "", message: "", code: "",
    downloadId: null, startedAt: Date.now(), updatedAt: Date.now(), ...fields
  };
  jobs.set(job.jobId, job);
  for (const [id, j] of jobs) if (j.updatedAt < Date.now() - 60 * 60 * 1000 && j.state !== "running") jobs.delete(id);
  return job;
}

function publishJob(job) {
  job.updatedAt = Date.now();
  browser.runtime.sendMessage({ type: "job-update", job }).catch(() => {});
}

function finishJob(job, fields) {
  Object.assign(job, fields);
  job.speed = 0;
  if (job.state === "done" && job.size > 0) {
    const secs = (Date.now() - job.startedAt) / 1000;
    if (secs > 0.5) job.avgSpeed = job.size / secs;   // average over the whole job (includes merge time)
  }
  if ((job.state === "error" || job.state === "cancelled") && job.message) job.status = job.message;
  publishJob(job);
  armIdleDisconnect();
}

function pollFirefoxDownload(job) {
  const tick = async () => {
    if (job.state !== "running" && job.state !== "starting") return;
    try {
      const [d] = await browser.downloads.search({ id: job.downloadId });
      if (!d) return finishJob(job, { state: "error", message: "Firefox lost track of the download." });
      if (d.state === "complete") return finishJob(job, { state: "done", file: d.filename, size: d.fileSize, percent: 100, status: "Finished" });
      if (d.state === "interrupted") {
        if (d.error === "USER_CANCELED") return finishJob(job, { state: "cancelled", message: "Download cancelled." });
        return onDirectFailed(job, d.error);
      }
      job.state = "running";
      const now = Date.now();
      if (job._lastT && now > job._lastT) {
        const inst = Math.max(0, (d.bytesReceived - job._lastBytes) / ((now - job._lastT) / 1000));
        job.speed = job.speed > 0 ? job.speed * 0.6 + inst * 0.4 : inst;
      }
      job._lastT = now; job._lastBytes = d.bytesReceived;
      if (d.totalBytes > 0) { job.percent = Math.min(99, (d.bytesReceived / d.totalBytes) * 100); job.status = `Downloading… ${Math.round(job.percent)}%`; }
      else { job.percent = null; job.status = `Downloading… ${MG.formatBytes(d.bytesReceived) || ""}`; }
      publishJob(job);
    } catch (err) { return finishJob(job, { state: "error", message: String(err?.message || err) }); }
    setTimeout(tick, 600);
  };
  tick();
}

const DIRECT_ERRORS = {
  SERVER_FORBIDDEN: "The server refused the download (HTTP 403). The link may have expired or need a login or referer.",
  SERVER_UNAUTHORIZED: "The server needs a login (HTTP 401).",
  SERVER_BAD_CONTENT: "The file was not found on the server (HTTP 404). The link has probably expired.",
  SERVER_FAILED: "The server failed while sending the file.",
  NETWORK_FAILED: "Network error during the download.",
  NETWORK_TIMEOUT: "The download timed out.",
  NETWORK_DISCONNECTED: "The network connection dropped.",
  FILE_ACCESS_DENIED: "Windows denied access to the Downloads\\MediaGrab folder.",
  FILE_NO_SPACE: "The disk is full."
};

async function onDirectFailed(job, error) {
  // Firefox's downloader sends no Referer; if that is why we were refused, FFmpeg can retry with the page's own headers.
  if ((error === "SERVER_FORBIDDEN" || error === "SERVER_UNAUTHORIZED") && !job.retriedViaCompanion) {
    const status = await companionStatus();
    const st = job.tabId != null ? await getTab(job.tabId) : null;
    const item = st?.items.get(job.itemKey);
    if (status.connected && status.ffmpegFound && item) {
      job.retriedViaCompanion = true;
      job.status = "Retrying through the companion with the page's headers…";
      publishJob(job);
      try {
        await startNativeDownload(item, { tabId: job.tabId, audioOnly: job.mode === "audio", saveAs: false, existingJob: job });
        return;
      } catch (_) { /* fall through to the error below */ }
    }
  }
  finishJob(job, { state: "error", message: DIRECT_ERRORS[error] || `Firefox could not finish the download (${error}).`, code: error });
}

/* =====================================================================
 * Downloading
 * ===================================================================== */

async function tabInfo(tabId) {
  const st = await getTab(tabId);
  let tab = null;
  try { tab = await browser.tabs.get(tabId); } catch (_) {}
  const title = st.meta.title || tab?.title || "";
  return { st, tab, title, pageUrl: tab?.url || st.meta.url || "", hostname: (() => { try { return new URL(tab?.url || "").hostname; } catch (_) { return "global"; } })() };
}

async function smartnameEnabled(hostname) {
  const key = `pref:${hostname}:smartname`;
  const v = (await browser.storage.local.get(key))[key];
  return v === undefined ? true : Boolean(v);
}

function itemDuration(item, st) {
  return item.manifest?.duration || st.meta.duration || null;
}

async function startDirectDownload(item, { tabId, saveAs }) {
  const { title, hostname } = await tabInfo(tabId);
  const smart = await smartnameEnabled(hostname);
  const filename = MG.buildFileName({ ...item, pageTitle: title }, { audioOnly: false, smartname: smart });
  const job = makeJob({ tabId, itemKey: item.key, via: "firefox", mode: "video", status: "Starting…" });
  try {
    job.downloadId = await browser.downloads.download({
      url: item.url, filename: `MediaGrab/${filename}`, conflictAction: "uniquify", saveAs: Boolean(saveAs)
    });
  } catch (err) {
    const msg = /cancel/i.test(err?.message || "") ? "Download cancelled." : (err?.message || String(err));
    finishJob(job, { state: /cancel/i.test(msg) ? "cancelled" : "error", message: msg });
    return job;
  }
  publishJob(job);
  pollFirefoxDownload(job);
  return job;
}

async function startNativeDownload(item, { tabId, audioOnly, saveAs, quality, audio, existingJob }) {
  const { st, title, pageUrl, hostname } = await tabInfo(tabId);
  if (item.manifest?.drm) throw new Error(`This stream is protected (${item.manifest.drm}). MediaGrab does not decrypt DRM or protected media.`);

  const smart = await smartnameEnabled(hostname);
  const filename = MG.buildFileName({ ...item, pageTitle: title }, { audioOnly, smartname: smart });
  let url = item.url, audioUrl = "";
  const choice = quality && item.manifest?.choices?.find((c) => c.id === quality);
  if (choice) { url = choice.url; audioUrl = choice.audioUrl || ""; }
  // Several audio tracks: use the one the user picked, otherwise the preferred (original) one - never "whatever came first".
  const tracks = item.manifest?.audioTracks || [];
  if (tracks.length > 1) {
    const wanted = (audio && tracks.find((t) => t.key === audio)) || tracks.find((t) => t.preferred) || tracks[0];
    const own = choice ? choice.audio : null;     // the chosen variant's own group (per-codec URLs)
    audioUrl = (own && own.find((g) => g.key === wanted.key)?.url) || wanted.url;
    if (!choice && item.manifest.bestVariantUrl) url = item.manifest.bestVariantUrl;   // explicit video + explicit audio
  }

  const h = item.headers || {};
  const job = existingJob || makeJob({ tabId, itemKey: item.key, via: "native" });
  job.via = "native"; job.mode = audioOnly ? "audio" : "video"; job.state = "starting"; job.status = "Contacting companion…"; job.percent = null; job.message = "";
  jobs.set(job.jobId, job);
  publishJob(job);

  const request = {
    action: "download",
    jobId: job.jobId,
    url, audioUrl,
    kind: item.kind === "hls" || item.kind === "dash" ? item.kind : "file",
    mode: audioOnly ? "audio" : "video",
    title: smart ? title : "",
    filename,
    referer: h.referer || pageUrl || "",
    userAgent: h["user-agent"] || navigator.userAgent,
    cookie: h.cookie || "",
    origin: h.origin || "",
    saveAs: Boolean(saveAs),
    durationSeconds: itemDuration(item, st) || 0
  };
  try {
    ensurePort().postMessage(request);
  } catch (err) {
    finishJob(job, { state: "error", message: err.message, code: err.code });
    throw err;
  }
  armIdleDisconnect();
  return job;
}

async function handleDownload({ tabId, key, mode, saveAs, quality, audio }) {
  const st = await getTab(tabId);
  const item = st.items.get(key);
  if (!item) throw new Error("That media item is no longer available. Press refresh and try again.");
  if (item.manifest?.drm) throw new Error(`This stream is protected (${item.manifest.drm}). MediaGrab does not decrypt DRM or protected media.`);
  const isStream = item.kind === "hls" || item.kind === "dash";
  const audioOnly = mode === "audio";

  if (!isStream && (!audioOnly || item.kind === "audio")) return startDirectDownload(item, { tabId, saveAs });

  // Streams (and audio extraction from video files) need FFmpeg via the companion.
  const status = await companionStatus();
  if (!status.connected) throw new Error(`MediaGrab Companion is not connected. ${status.reason}`);
  if (status.outdated) throw new Error(`The companion (version ${status.version}) is older than this extension needs (${MIN_HOST_VERSION}). Re-run companion\\Install-Companion.cmd from the newest MediaGrab download.`);
  if (!status.ffmpegFound) throw new Error("The companion is running but FFmpeg was not found. Re-run companion\\Install-Companion.cmd.");
  return startNativeDownload(item, { tabId, audioOnly, saveAs, quality, audio });
}

function cancelJob(jobId, save) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.via === "firefox") browser.downloads.cancel(job.downloadId).catch(() => {});
  else if (port) port.postMessage({ action: "cancel", jobId, save: Boolean(save) });
  return true;
}

/* =====================================================================
 * Messages from popup / content scripts
 * ===================================================================== */

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "page-meta": {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) return;
      const st = await getTab(tabId);
      const top = sender.frameId === 0;
      if (top) {
        st.meta.title = String(message.title || sender.tab?.title || "").trim();
        st.meta.url = sender.tab?.url || message.url || "";
        st.meta.navSig = MG.pageSignature(st.meta.url);
      }
      // Thumbnail and duration may come from a player inside an iframe.
      if (message.thumbnail && (top || !st.meta.thumbnail)) st.meta.thumbnail = message.thumbnail;
      if (Number.isFinite(message.duration) && message.duration > 0 && (top || !st.meta.duration)) st.meta.duration = message.duration;
      persistSoon(tabId);
      return { ok: true };
    }

    case "content-media": {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) return;
      const list = Array.isArray(message.items) ? message.items.slice(0, 80) : [];
      await Promise.all(list.map((it) => addMedia(tabId, { url: it.url, contentType: it.contentType || "", source: it.source || "page", headers: {} })));
      return { ok: true };
    }

    case "get-state": {
      const { tabId } = message;
      const info = await tabInfo(tabId);
      const items = visibleItems(info.st).map((i) => ({
        key: i.key, url: i.url, kind: i.kind, contentType: i.contentType, contentLength: i.contentLength, source: i.source,
        manifest: i.manifest, discoveredAt: i.discoveredAt,
        duration: itemDuration(i, info.st), thumbnail: info.st.meta.thumbnail || "", pageTitle: info.title
      }));
      const tabJobs = [...jobs.values()].filter((j) => j.tabId === tabId);
      return { items, jobs: tabJobs, title: info.title, hostname: info.hostname };
    }

    case "download": return { ok: true, job: await handleDownload(message) };
    case "cancel-job": return { ok: cancelJob(message.jobId, message.save) };
    case "companion-status": return companionStatus();

    case "rescan": {
      try { await browser.tabs.sendMessage(message.tabId, { type: "rescan" }); } catch (_) {}
      return { ok: true };
    }

    case "clear-media": {
      const st = await getTab(message.tabId);
      st.items.clear(); st.children.clear(); st.childPaths.clear(); st.rejected.clear();
      persistSoon(message.tabId);
      updateBadge(message.tabId);
      return { ok: true };
    }
  }
});

/* ---- tab lifecycle ---- */

browser.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  tabLoads.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  browser.storage.session.remove(`tab:${tabId}`).catch(() => {});
  for (const [id, j] of jobs) if (j.tabId === tabId && j.state !== "running" && j.state !== "starting") jobs.delete(id);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Moving to another page - including single-page-app navigation such as clicking a video on YouTube, which changes the
  // URL without reloading - starts a new set of media: forget what was found for the previous page.
  if (!changeInfo.url) return;
  const st = await getTab(tabId);
  const sig = MG.pageSignature(changeInfo.url);
  if (st.meta.navSig && st.meta.navSig !== sig) {
    st.items.clear(); st.children.clear(); st.childPaths.clear(); st.rejected.clear(); st.meta = {};
    persistSoon(tabId);
    updateBadge(tabId);
  }
  st.meta.navSig = sig;
});
