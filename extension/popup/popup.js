/* MediaGrab popup. All download logic lives in background.js; this file renders state and sends intents. */

const $ = (id) => document.getElementById(id);
const itemsEl = $("items"), noticeEl = $("notice"), countEl = $("count"), subtitleEl = $("subtitle");
const companionBtn = $("companion"), companionText = $("companionText");
const menuTemplate = $("menu-template");

const params = new URLSearchParams(location.search);   // ?tabId=N lets the popup be opened as a normal tab (used by tests)
let tabId = null;
let hostname = "global";
let items = [];
let openMenu = null;
let noticeTimer = null;
const jobByItem = new Map();     // item key -> latest job
const rowByKey = new Map();      // item key -> row element
const qualityByItem = new Map(); // item key -> chosen quality id ("" = best)
const audioByItem = new Map();   // item key -> chosen audio track key ("" = automatic: the original track)
let companion = null;            // last companion status

const send = (msg) => browser.runtime.sendMessage(msg);

/* ---------- small helpers ---------- */

function showNotice(text, type = "", autoHideMs = 0) {
  clearTimeout(noticeTimer);
  noticeEl.textContent = text;
  noticeEl.className = `notice${type ? ` ${type}` : ""}`;
  if (autoHideMs) noticeTimer = setTimeout(hideNotice, autoHideMs);
}
function hideNotice() { clearTimeout(noticeTimer); noticeEl.className = "notice hidden"; noticeEl.textContent = ""; }
const reportError = (err) => showNotice(err?.message || String(err), "error");

const prefKey = (name) => `pref:${hostname}:${name}`;
async function getPref(name, fallback) {
  const v = (await browser.storage.local.get(prefKey(name)))[prefKey(name)];
  return v === undefined ? fallback : v;
}
const setPref = (name, value) => browser.storage.local.set({ [prefKey(name)]: value });

function kindBadge(item) {
  return { hls: "HLS", dash: "DASH", audio: "AUDIO", video: "VIDEO" }[item.kind] || "VIDEO";
}

// Estimated size of a stream: bandwidth x duration. (A stream's Content-Length is the size of its small playlist file.)
function estimateBytes(item, bandwidth) {
  const duration = item.manifest?.duration || item.duration;
  return bandwidth && duration ? (bandwidth / 8) * duration : 0;
}

function sizeText(item) {
  if (item.kind === "hls" || item.kind === "dash") {
    const m = item.manifest;
    const choice = m?.choices?.find((c) => c.id === qualityByItem.get(item.key));
    const est = estimateBytes(item, choice?.bandwidth || m?.bandwidth);
    return est ? `≈ ${MG.formatBytes(est)}` : "size unknown";
  }
  return item.contentLength ? MG.formatBytes(item.contentLength) : "size unknown";
}

function closeMenu() { if (openMenu) openMenu.remove(); openMenu = null; }

async function copyUrl(item) {
  try { await navigator.clipboard.writeText(item.url); }
  catch (_) {
    const ta = document.createElement("textarea");
    ta.value = item.url; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  showNotice("Media URL copied to clipboard.", "success", 2500);
}

/* ---------- downloads ---------- */

async function startDownload(item, { audioOnly = false, saveAs = false } = {}) {
  hideNotice();
  try {
    const res = await send({
      type: "download", tabId, key: item.key, mode: audioOnly ? "audio" : "video", saveAs,
      quality: qualityByItem.get(item.key) || undefined,
      audio: audioByItem.get(item.key) || undefined
    });
    if (res?.job) onJob(res.job);
  } catch (err) { reportError(err); }
}

async function doPrimary(item) {
  if (await getPref("always-copy", false)) return copyUrl(item);
  return startDownload(item, { audioOnly: await getPref("always-audio", false), saveAs: await getPref("always-save-as", false) });
}

async function toggle(name, onText, offText) {
  const next = !(await getPref(name, false));
  await setPref(name, next);
  showNotice(next ? onText : offText, "success", 3000);
}

async function handleAction(action, item, row) {
  closeMenu();
  switch (action) {
    case "av": return startDownload(item, { audioOnly: false });
    case "save-as": return startDownload(item, { audioOnly: false, saveAs: true });
    case "audio": return startDownload(item, { audioOnly: true });
    case "copy": return copyUrl(item);
    case "always-save-as": return toggle("always-save-as", "Download As will be used automatically on this website.", "Automatic Download As disabled for this website.");
    case "always-audio": return toggle("always-audio", "Audio-only is now the default for this website.", "Audio-only default disabled for this website.");
    case "always-copy": return toggle("always-copy", "The main button will copy the media URL on this website.", "Always copy URL disabled for this website.");
    case "smartname": {
      const next = !(await getPref("smartname", true));
      await setPref("smartname", next);
      return showNotice(next ? "Smartnaming on: files are named after the page/video title." : "Smartnaming off: files keep the name from the media URL.", "success", 3000);
    }
    case "details": return row.querySelector(".details-box").classList.toggle("hidden");
  }
}

async function openContextMenu(button, item, row) {
  closeMenu();
  const menu = menuTemplate.content.firstElementChild.cloneNode(true);
  document.body.appendChild(menu);
  openMenu = menu;
  const rect = button.getBoundingClientRect();
  const width = 244;
  menu.style.left = `${Math.max(6, Math.min(window.innerWidth - width - 6, rect.right - width))}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, Math.max(6, window.innerHeight - menu.offsetHeight - 6))}px`;

  const mark = (action, on, text) => { if (on) menu.querySelector(`[data-action="${action}"]`).textContent = `✓  ${text}`; };
  menu.querySelector('[data-action="smartname"] .menu-check').textContent = (await getPref("smartname", true)) ? "✓" : "";
  mark("always-save-as", await getPref("always-save-as", false), "Always Download As…");
  mark("always-audio", await getPref("always-audio", false), "Always audio only for this website");
  mark("always-copy", await getPref("always-copy", false), "Always copy URL");

  menu.querySelectorAll("button[data-action]").forEach((b) =>
    b.addEventListener("click", () => handleAction(b.dataset.action, item, row).catch(reportError)));
}

/* ---------- job state ---------- */

function onJob(job) {
  if (job.tabId !== tabId) return;
  jobByItem.set(job.itemKey, job);
  const row = rowByKey.get(job.itemKey);
  if (row) applyJob(row, job);
  updateTotalSpeed();
}

// Combined speed of every active download in this tab, shown in the footer.
function updateTotalSpeed() {
  let total = 0;
  for (const j of jobByItem.values()) if ((j.state === "starting" || j.state === "running") && j.speed > 0) total += j.speed;
  const el = $("totalSpeed");
  el.classList.toggle("hidden", total <= 0);
  el.textContent = total > 0 ? `↓ ${MG.formatSpeed(total)}` : "";
  el.title = total > 0 ? `Combined download speed (${MG.formatMbps(total)})` : "";
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.split(/[\\/]/);
  return parts.length > 3 ? `${parts[0]}\\…\\${parts.slice(-2).join("\\")}` : p;
}

function applyJob(row, job) {
  const wrap = row.querySelector(".progress-wrap");
  const fill = row.querySelector(".progress-fill");
  const text = row.querySelector(".progress-text");
  const cancel = row.querySelector(".cancel-job");
  const speedEl = row.querySelector(".speed");
  const btn = row.querySelector(".primary-action");
  const item = items.find((i) => i.key === row.dataset.key);
  const active = job.state === "starting" || job.state === "running";

  wrap.classList.remove("hidden", "is-error", "is-done", "is-indeterminate");
  btn.disabled = active;
  cancel.classList.toggle("hidden", !active);
  cancel.textContent = item?.manifest?.live ? "Stop & save" : "Cancel";
  cancel.dataset.save = item?.manifest?.live ? "1" : "";
  cancel.dataset.jobId = job.jobId;
  // Live speed while active; average speed once finished.
  const shown = active ? job.speed : (job.state === "done" ? job.avgSpeed : 0);
  speedEl.textContent = shown > 0 ? `${active ? "↓ " : "avg "}${MG.formatSpeed(shown)}` : "";
  speedEl.title = shown > 0 ? MG.formatMbps(shown) : "";
  speedEl.classList.toggle("hidden", !(shown > 0));

  if (active) {
    const pct = Number(job.percent);
    if (Number.isFinite(pct) && job.percent !== null) { fill.style.width = `${Math.max(2, Math.min(100, pct))}%`; }
    else { fill.style.width = "35%"; wrap.classList.add("is-indeterminate"); }
    text.textContent = job.status || "Working…";
    text.title = "";
  } else if (job.state === "done") {
    fill.style.width = "100%";
    wrap.classList.add("is-done");
    text.textContent = `✓ Finished — ${shortPath(job.file) || "saved"}`;
    text.title = job.file || "";
  } else if (job.state === "cancelled") {
    fill.style.width = "0%";
    text.textContent = "Cancelled.";
  } else {
    fill.style.width = "100%";
    wrap.classList.add("is-error");
    text.textContent = `✗ Failed — ${job.message || "Download failed."}`;
    text.title = job.message || "";
  }
}

/* ---------- rendering ---------- */

const rowTemplate = $("row-template");

function renderItem(item) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.key = item.key;
  const m = item.manifest;
  const title = item.pageTitle || MG.fileNameFromUrl(item.url) || "Detected media";
  const mime = item.contentType || { hls: "application/vnd.apple.mpegurl", dash: "application/dash+xml" }[item.kind] || item.kind;
  const duration = MG.formatDuration(item.duration);

  // Everything dynamic is set through textContent / properties - never through innerHTML.
  const thumbBox = row.querySelector(".thumb");
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.src = item.thumbnail;
    thumbBox.prepend(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "thumb-fallback"; fb.textContent = "\u25b6";
    thumbBox.prepend(fb);
  }
  const durEl = row.querySelector(".duration");
  if (duration) durEl.textContent = duration; else durEl.remove();

  const badge = row.querySelector(".format-badge");
  badge.classList.add(item.kind);
  badge.textContent = kindBadge(item);
  const titleEl = row.querySelector(".title");
  titleEl.textContent = title; titleEl.title = title;
  row.querySelector(".mime").textContent = mime;
  row.querySelector(".size").textContent = sizeText(item);
  const subline = row.querySelector(".subline");
  const addChip = (cls, text, tip) => { const c = document.createElement("span"); c.className = `chip ${cls}`; c.textContent = text; c.title = tip; subline.appendChild(c); };
  if (m?.drm) addChip("danger", "DRM", "Protected stream: MediaGrab cannot download DRM content");
  if (m?.live) addChip("warn", "LIVE", "Live stream: recording continues until you press Stop & save");
  const urlLine = row.querySelector(".url-line");
  urlLine.textContent = MG.abbreviateUrl(item.url); urlLine.title = item.url;

  // Real qualities only (parsed from the playlist); "Best" lets FFmpeg pick the top stream.
  if (m?.choices?.length) {
    const select = row.querySelector(".quality");
    select.add(new Option("Best", ""));
    for (const c of m.choices) {
      const est = estimateBytes(item, c.bandwidth);
      select.add(new Option(est ? `${c.label} · ≈ ${MG.formatBytes(est)}` : c.label, c.id));
    }
    select.value = qualityByItem.get(item.key) || "";
    select.addEventListener("change", () => {
      qualityByItem.set(item.key, select.value);
      row.querySelector(".size").textContent = sizeText(item);
    });
    row.querySelector(".quality-line").classList.remove("hidden");
  }

  // Streams with several audio tracks (original + dubs, descriptions): automatic = the original, or pick one.
  if (m?.audioTracks?.length > 1) {
    const sel = row.querySelector(".audio-track");
    const pref = m.audioTracks.find((t) => t.preferred);
    sel.add(new Option(`Automatic${pref ? ` · ${pref.label}` : ""}`, ""));
    for (const t of m.audioTracks) sel.add(new Option(t.label, t.key));
    sel.value = audioByItem.get(item.key) || "";
    sel.addEventListener("change", () => audioByItem.set(item.key, sel.value));
    row.querySelector(".audio-line").classList.remove("hidden");
  }

  const details = [
    ["Type", item.kind], ["Content-Type", item.contentType || "unknown"], ["Found via", item.source || "unknown"],
    ["Duration", duration || "unknown"], ["URL", item.url]
  ];
  if (m?.state === "ok") {
    details.push(["Playlist", m.master
      ? `master playlist (${m.variantCount || "?"} variants${m.audioCount ? `, ${m.audioCount} audio renditions` : ""})`
      : (item.kind === "hls" ? `media playlist (${m.segmentCount || "?"} segments)` : "DASH manifest")]);
    if (m.choices?.length) details.push(["Qualities", m.choices.map((c) => c.label).join(", ")]);
    else if (m.heights?.length) details.push(["Qualities", m.heights.map((h) => `${h}p`).join(", ")]);
    if (m.audioTracks?.length > 1) details.push(["Audio tracks", m.audioTracks.map((t) => t.label + (t.preferred ? " (auto)" : "")).join(", ")]);
    if (m.aes128) details.push(["Encryption", "AES-128 (standard HLS, key served openly)"]);
    if (m.drm) details.push(["Protection", m.drm]);
  } else if (m?.state === "unreadable") details.push(["Manifest", `could not be pre-read (${m.error}); the companion will try again when downloading`]);
  const box = row.querySelector(".details-box");
  details.forEach(([k, v], i) => {
    if (i) box.appendChild(document.createElement("br"));
    const b = document.createElement("b");
    b.textContent = `${k}:`;
    box.append(b, ` ${v}`);
  });

  const btn = row.querySelector(".primary-action");
  if (m?.drm) { btn.disabled = true; btn.querySelector("span").textContent = "Protected"; btn.title = "DRM-protected streams can't be downloaded"; }
  btn.addEventListener("click", () => doPrimary(item).catch(reportError));
  row.querySelector(".menu-action").addEventListener("click", (ev) => { ev.stopPropagation(); openContextMenu(ev.currentTarget, item, row).catch(reportError); });
  row.querySelector(".cancel-job").addEventListener("click", (ev) => {
    const b = ev.currentTarget;
    send({ type: "cancel-job", jobId: b.dataset.jobId, save: Boolean(b.dataset.save) }).catch(reportError);
  });
  const img = row.querySelector(".thumb img");
  if (img) img.addEventListener("error", () => img.replaceWith(Object.assign(document.createElement("div"), { className: "thumb-fallback", textContent: "▶" })));
  return row;
}

function render() {
  closeMenu();
  rowByKey.clear();
  countEl.textContent = String(items.length);
  itemsEl.textContent = "";
  if (!items.length) {
    itemsEl.innerHTML = '<div class="empty">No media detected yet.<br>Start playing the video, then press <b>↻</b>.</div>';
    return;
  }
  for (const item of items) {
    const row = renderItem(item);
    rowByKey.set(item.key, row);
    itemsEl.appendChild(row);
    const job = jobByItem.get(item.key);
    if (job) applyJob(row, job);
  }
}

/* ---------- companion indicator ---------- */

function setCompanion(status) {
  companion = status;
  companionBtn.className = "companion";
  if (!status) { companionBtn.classList.add("unknown"); companionText.textContent = "Checking companion…"; return; }
  if (status.connected && status.outdated) {
    companionBtn.classList.add("offline");
    companionText.textContent = "Companion outdated · update needed";
    companionBtn.title = `The installed companion is version ${status.version}, which is older than this extension needs. Re-run companion\\Install-Companion.cmd from the newest MediaGrab download.`;
  } else if (status.connected && status.ffmpegFound) {
    companionBtn.classList.add("online");
    const v = (status.ffmpegVersion.match(/version\s+(\S+)/i) || [])[1];
    companionText.textContent = `Companion connected${v ? ` · FFmpeg ${v.split("-")[0]}` : ""}`;
    companionBtn.title = `MediaGrab Companion ${status.version} is running.\nFFmpeg: ${status.ffmpeg}\nSaves to: ${status.downloadDir}`;
  } else if (status.connected) {
    companionBtn.classList.add("offline");
    companionText.textContent = "Companion connected · FFmpeg missing";
    companionBtn.title = "The companion answered, but FFmpeg was not found. Re-run companion\\Install-Companion.cmd.";
  } else {
    companionBtn.classList.add("offline");
    companionText.textContent = "Companion disconnected";
    companionBtn.title = status.reason || "";
  }
}

async function checkCompanion(explain = false) {
  setCompanion(null);
  let status;
  try { status = await send({ type: "companion-status" }); }
  catch (err) { status = { connected: false, reason: err?.message || String(err) }; }
  setCompanion(status);
  if (explain) {
    if (status.connected && status.outdated) showNotice(companionBtn.title, "error");
    else if (status.connected && status.ffmpegFound) showNotice(`Companion OK — ping answered by host ${status.version}; FFmpeg ready.`, "success", 4000);
    else showNotice(status.connected ? "The companion answered but FFmpeg is missing. Re-run companion\\Install-Companion.cmd." : status.reason, "error");
  }
}

/* ---------- loading ---------- */

async function load({ rescan = false } = {}) {
  hideNotice();
  if (tabId === null) {
    if (params.get("tabId")) tabId = Number(params.get("tabId"));
    else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id ?? null;
    }
    if (tabId === null) { showNotice("No active browser tab was found.", "error"); return; }
  }
  if (rescan) { await send({ type: "rescan", tabId }); await new Promise((r) => setTimeout(r, 700)); }
  const state = await send({ type: "get-state", tabId });
  items = state.items || [];
  hostname = state.hostname || "global";
  subtitleEl.textContent = state.title || "Detected media";
  for (const job of state.jobs || []) jobByItem.set(job.itemKey, job);
  render();
  updateTotalSpeed();
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "job-update" && message.job) onJob(message.job);
});

document.addEventListener("click", (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
$("refresh").addEventListener("click", () => load({ rescan: true }).catch(reportError));
companionBtn.addEventListener("click", () => checkCompanion(true));
$("clear").addEventListener("click", async () => {
  if (tabId === null) return;
  await send({ type: "clear-media", tabId });
  await load();
});

load().then(() => checkCompanion(false)).catch(reportError);
