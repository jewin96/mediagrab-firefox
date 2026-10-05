/* MediaGrab shared pure helpers (no browser APIs).
 * Loaded by background.js and popup.js in Firefox, and by the Node tests via require().
 * Clean-room code; no DRM/encryption handling beyond *detecting* protected streams so we can refuse them.
 */
(function (root) {
  "use strict";
  const MG = {};

  /* ---------- file names ---------- */

  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  // Removes every character Windows forbids in file names, collapses whitespace,
  // trims spaces and trailing periods, avoids reserved device names, limits length.
  MG.sanitizeFileName = function (value, fallback = "media", maxChars = 150) {
    let s = String(value == null ? "" : value)
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    s = Array.from(s).slice(0, maxChars).join("");
    s = s.replace(/[\s.]+$/g, "").replace(/^\.+/, "").trim();
    if (!s) s = fallback;
    if (RESERVED.test(s) || RESERVED.test(s.split(".")[0])) s = "_" + s;
    return s;
  };

  MG.fileNameFromUrl = function (url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      return last.replace(/\.[a-z0-9]{2,5}$/i, "");
    } catch (_) { return ""; }
  };

  MG.EXT_BY_TYPE = {
    "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv", "video/quicktime": "mov",
    "video/x-matroska": "mkv", "video/x-m4v": "m4v",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/opus": "opus", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/wave": "wav"
  };

  MG.urlExtension = function (url) {
    try {
      const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : "";
    } catch (_) { return ""; }
  };

  // Extension the saved file should have for a direct (non-stream) download.
  MG.directExtension = function (item) {
    const fromUrl = MG.urlExtension(item.url);
    if (/^(mp4|m4v|webm|ogv|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$/.test(fromUrl)) return fromUrl;
    const ct = cleanType(item.contentType);
    return MG.EXT_BY_TYPE[ct] || (item.kind === "audio" ? "m4a" : "mp4");
  };

  /* Smart naming: page/video title when enabled and available, else the URL's file name. */
  MG.buildBaseName = function ({ title, url, smartname = true }) {
    const fromUrl = MG.fileNameFromUrl(url);
    const useful = fromUrl && !/^(index|master|playlist|manifest|stream|chunklist|media|main|video|audio)$/i.test(fromUrl);
    let base = smartname && title ? title : (useful ? fromUrl : (title || fromUrl));
    return MG.sanitizeFileName(base, "media");
  };

  MG.buildFileName = function (item, { audioOnly = false, smartname = true } = {}) {
    const base = MG.buildBaseName({ title: item.pageTitle, url: item.url, smartname });
    if (audioOnly) return `${base}.mp3`;
    if (item.kind === "hls" || item.kind === "dash") return `${base}.mp4`;
    return `${base}.${MG.directExtension(item)}`;
  };

  /* ---------- classification ---------- */

  function cleanType(value) { return String(value || "").split(";", 1)[0].trim().toLowerCase(); }
  MG.cleanType = cleanType;

  const DIRECT_EXT = "mp4|m4v|webm|ogv|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac";
  MG.EXT_RE = new RegExp(`\\.(?:${DIRECT_EXT}|m3u8|mpd)(?:$|[?#])`, "i");
  MG.DIRECT_EXT_RE = new RegExp(`\\.(?:${DIRECT_EXT})(?:$|[?#])`, "i");
  const STREAM_RE = /(?:mime|type)=(?:video|audio)(?:%2F|\/)/i;

  MG.mediaKind = function (url, contentType = "") {
    const ct = cleanType(contentType);
    const lower = String(url || "").toLowerCase();
    if (ct.includes("mpegurl") || /\.m3u8(?:$|[?#])/.test(lower)) return "hls";
    if (ct === "application/dash+xml" || /\.mpd(?:$|[?#])/.test(lower)) return "dash";
    if (ct.startsWith("video/")) return "video";
    if (ct.startsWith("audio/")) return "audio";
    if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/.test(lower)) return "audio";
    if (/\.(mp4|m4v|webm|ogv|mov|mkv)(?:$|[?#])/.test(lower)) return "video";
    if (STREAM_RE.test(url)) return "video";
    return "unknown";
  };

  MG.isCandidate = function (url, contentType = "") {
    const ct = cleanType(contentType);
    if (ct === "video/mp2t" || ct === "audio/mp2t") return false; // MPEG-TS segments
    return ct.startsWith("video/") || ct.startsWith("audio/") || ct === "application/dash+xml" ||
      ct.includes("mpegurl") || MG.EXT_RE.test(url) || STREAM_RE.test(url);
  };

  /* Heuristic: is this request one tiny piece of an adaptive stream rather than a standalone file?
   * Segment/fragment/init requests must not become separate "videos". */
  const SEG_NAME = /(?:^|[-_.])(?:seg(?:ment)?|chunk|frag(?:ment)?|part|init(?:ialization)?|sq|range)[-_.]?\d*(?:[-_.]|$)/i;
  const SEG_EXT = /\.(?:ts|m4s|mts|cmfv|cmfa|cmft|fmp4|vtt|webvtt|srt|m4f)$/i;
  const SEG_NUMBERED = /[-_.](?:0\d{2,}|\d{5,})\.(?:aac|ac3|eac3|m4a)$/i; // zero-padded / long sequence numbers only
  const SEG_QUERY = /[?&](?:sq|segment|seg|frag|fragment|chunk)=/i; // range/bytestart params are merged by normalizeKey instead

  MG.isSegmentLike = function (url, { contentType = "", length = null, partial = false } = {}) {
    let path = "", query = "";
    try { const u = new URL(url); path = u.pathname; query = u.search; } catch (_) { path = String(url); }
    const name = path.split("/").filter(Boolean).pop() || "";
    const ct = cleanType(contentType);
    if (ct === "video/mp2t" || ct === "audio/mp2t") return true;
    if (SEG_EXT.test(name)) return true;
    if (SEG_NUMBERED.test(name)) return true;
    if (SEG_QUERY.test(query)) return true;
    if (/\.(?:mp4|m4a|m4v|aac|webm)$/i.test(name) && SEG_NAME.test(name.replace(/\.[a-z0-9]+$/i, "")) && /\d/.test(name)) return true;
    if (/^init\.(?:mp4|m4a|m4v)$/i.test(name)) return true;
    if (partial && Number.isFinite(length) && length > 0 && length < 256 * 1024) return true; // tiny range probes
    if (Number.isFinite(length) && length > 0 && length < 2048 && !/m3u8|mpd/i.test(name)) return true;
    return false;
  };

  // Direct audio/video smaller than this is a UI sound / notification blip / tracking clip, not "a file to save".
  MG.MIN_MEDIA_BYTES = 100 * 1024;

  // Key used to merge repeated requests for the same media (drops fragment and range-style query params).
  const IGNORED_PARAMS = /^(?:range|bytestart|byteend|start|end|rn|rbuf|cmsid|_|t|ts|nocache|cachebust|cb|rand|random)$/i;
  MG.normalizeKey = function (url) {
    try {
      const u = new URL(url);
      u.hash = "";
      const keep = [];
      for (const [k, v] of u.searchParams) if (!IGNORED_PARAMS.test(k)) keep.push([k, v]);
      u.search = "";
      for (const [k, v] of keep) u.searchParams.append(k, v);
      return u.href;
    } catch (_) { return String(url); }
  };

  // Host + path without the query string: identifies a playlist even when tokens/params differ between requests.
  MG.pathKey = function (url) {
    try { const u = new URL(url); return u.origin + u.pathname; } catch (_) { return String(url); }
  };

  // Page identity for "is this still the same video?" decisions (SPA navigation): origin + path (+ ?v= for YouTube-style sites).
  MG.pageSignature = function (url) {
    try { const u = new URL(url); return u.origin + u.pathname + (u.searchParams.get("v") ? "?v=" + u.searchParams.get("v") : ""); }
    catch (_) { return String(url || ""); }
  };

  // "1.2.3" style comparison: <0, 0, >0
  MG.compareVersions = function (a, b) {
    const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0), pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  };

  MG.isHttpUrl = function (url) {
    try { const p = new URL(url).protocol; return p === "http:" || p === "https:"; } catch (_) { return false; }
  };

  // Compact display form: host + ... + file name.
  MG.abbreviateUrl = function (url, max = 58) {
    try {
      const u = new URL(url);
      const file = u.pathname.split("/").filter(Boolean).pop() || "";
      const head = `${u.host}/`;
      const middle = u.pathname.split("/").filter(Boolean).length > 1 ? "…/" : "";
      let s = `${head}${middle}${file}${u.search ? "?…" : ""}`;
      if (s.length > max) s = s.slice(0, Math.max(10, max - file.length - 2)) + "…" + (file ? "/" + file.slice(-Math.min(24, file.length)) : "");
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    } catch (_) { return String(url).slice(0, max); }
  };

  /* ---------- HLS ---------- */

  // YouTube tags each audio track with YT-EXT-XTAGS (base64 protobuf holding e.g. "acont" = original | dubbed-auto | descriptive).
  function decodeXtags(v) {
    if (!v) return "";
    try {
      const b64 = String(v).replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("latin1");
      return bin.replace(/[^\x20-\x7e]+/g, " ").toLowerCase();
    } catch (_) { return ""; }
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    return out;
  }

  function abs(rel, base) { try { return new URL(rel, base).href; } catch (_) { return null; } }

  /* Returns { valid, master, variants[], audioGroups{}, duration, live, drm, aes128 }.
   * drm is a human-readable reason when the playlist uses a key system we refuse to handle. */
  MG.parseHls = function (text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const res = { valid: false, master: false, variants: [], audioGroups: {}, duration: 0, segments: 0, live: false, drm: null, aes128: false };
    if (!lines.length || !lines[0].startsWith("#EXTM3U")) return res;
    res.valid = true;
    let pending = null, endlist = false, vodType = false;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        pending = parseAttrs(line.slice(18));
        res.master = true;
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        const a = parseAttrs(line.slice(13));
        if (a.TYPE === "AUDIO" && a.URI && a["GROUP-ID"]) {
          (res.audioGroups[a["GROUP-ID"]] = res.audioGroups[a["GROUP-ID"]] || []).push({
            url: abs(a.URI, baseUrl), name: a.NAME || "", language: a.LANGUAGE || "", default: /YES/i.test(a.DEFAULT || ""),
            autoselect: /YES/i.test(a.AUTOSELECT || ""), characteristics: a.CHARACTERISTICS || "",
            key: a.LANGUAGE || a.NAME || "", xtags: decodeXtags(a["YT-EXT-XTAGS"])
          });
        }
      } else if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
        const a = parseAttrs(line.slice(line.indexOf(":") + 1));
        const method = (a.METHOD || "NONE").toUpperCase();
        const fmt = (a.KEYFORMAT || "identity").toLowerCase();
        if (method === "NONE") continue;
        if (method === "AES-128" && fmt === "identity") res.aes128 = true;
        else if (!res.drm) res.drm = `${method}${fmt !== "identity" ? ` / ${a.KEYFORMAT}` : ""}`;
      } else if (line.startsWith("#EXTINF:")) {
        const d = parseFloat(line.slice(8));
        if (Number.isFinite(d)) res.duration += d;
        res.segments++;
      } else if (line.startsWith("#EXT-X-ENDLIST")) {
        endlist = true;
      } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
        vodType = /VOD/i.test(line);
      } else if (!line.startsWith("#") && pending) {
        const url = abs(line, baseUrl);
        if (url) {
          const m = /^(\d+)x(\d+)$/i.exec(pending.RESOLUTION || "");
          res.variants.push({
            url,
            width: m ? +m[1] : 0,
            height: m ? +m[2] : 0,
            bandwidth: +(pending["AVERAGE-BANDWIDTH"] || pending.BANDWIDTH) || 0,
            audioGroup: pending.AUDIO || "",
            codecs: pending.CODECS || ""
          });
        }
        pending = null;
      }
    }
    res.live = !res.master && !endlist && !vodType;
    return res;
  };

  /* Several audio tracks (original + dubs / audio description) are common. Prefer the original, then the playlist's default;
   * avoid dubbed, described and commentary tracks. */
  MG.audioScore = function (a) {
    const n = `${a.name || ""} ${a.language || ""} ${a.xtags || ""}`.toLowerCase();
    let score = 0;
    if (/original/.test(n)) score += 100;
    if (a.default) score += 50;
    if (a.autoselect) score += 5;
    if (/dub|descript|commentary|translated/.test(n) || /describes-video/i.test(a.characteristics || "")) score -= 200;
    if (/secondary/.test(n)) score -= 50;
    return score;
  };
  MG.pickAudio = function (list) {
    let best = null;
    for (const a of list || []) if (a.url && (!best || MG.audioScore(a) > MG.audioScore(best))) best = a;   // ties: first in playlist order
    return best;
  };
  MG.audioLabel = function (a) {
    const base = a.name || a.language || "Audio";
    return a.language && a.name && !a.name.toLowerCase().includes(a.language.toLowerCase()) ? `${base} (${a.language})` : base;
  };

  MG.qualityLabel = function (height, bandwidth) {
    if (height) return `${height}p`;
    if (bandwidth) return `${(bandwidth / 1e6).toFixed(bandwidth >= 1e7 ? 0 : 1)} Mbps`;
    return "Stream";
  };

  /* Real, selectable qualities for a master playlist. Best (ffmpeg's own pick) is implicit and not listed. */
  MG.hlsChoices = function (parsed) {
    if (!parsed || !parsed.master) return [];
    const byKey = new Map();
    for (const v of parsed.variants) {
      const key = v.height ? `h${v.height}` : `b${v.bandwidth}`;
      const cur = byKey.get(key);
      if (!cur || v.bandwidth > cur.bandwidth) byKey.set(key, v);
    }
    const choices = [...byKey.entries()].map(([id, v]) => {
      const group = (parsed.audioGroups[v.audioGroup] || []).filter((g) => g.url);
      const pick = MG.pickAudio(group);
      return {
        id, label: MG.qualityLabel(v.height, v.bandwidth), height: v.height, bandwidth: v.bandwidth, url: v.url,
        audioUrl: pick ? pick.url : "",
        audio: group.map((g) => ({ key: g.key, url: g.url }))     // this variant's own audio group, by language key
      };
    });
    choices.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return choices.length > 1 ? choices : [];
  };

  /* ---------- DASH ---------- */

  function isoDuration(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || ""));
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }
  MG.isoDuration = isoDuration;

  MG.parseDash = function (text) {
    const t = String(text || "");
    const res = { valid: /<MPD[\s>]/i.test(t), live: false, duration: 0, drm: null, heights: [] };
    if (!res.valid) return res;
    res.live = /<MPD\b[^>]*\btype\s*=\s*"dynamic"/i.test(t);
    const d = /mediaPresentationDuration\s*=\s*"([^"]+)"/i.exec(t);
    if (d) res.duration = isoDuration(d[1]);
    const cp = /<ContentProtection\b[^>]*\bschemeIdUri\s*=\s*"([^"]+)"/i.exec(t);
    if (cp) res.drm = cp[1];
    else if (/<ContentProtection\b/i.test(t)) res.drm = "ContentProtection";
    const hs = new Set();
    for (const m of t.matchAll(/<(?:Representation|AdaptationSet)\b[^>]*\bheight\s*=\s*"(\d+)"/gi)) hs.add(+m[1]);
    res.heights = [...hs].sort((a, b) => b - a);
    return res;
  };

  /* ---------- formatting ---------- */

  MG.formatBytes = function (bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  };

  // Bytes per second -> "12.4 MB/s" (decimal MB like network tools; tooltip text adds megabits).
  MG.formatSpeed = function (bps) {
    if (!Number.isFinite(bps) || bps <= 0) return "";
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 1 : 2)} MB/s`;
    if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`;
    return `${Math.round(bps)} B/s`;
  };
  MG.formatMbps = function (bps) { return Number.isFinite(bps) && bps > 0 ? `${((bps * 8) / 1e6).toFixed(0)} Mbit/s` : ""; };

  MG.formatDuration = function (seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };

  root.MG = MG;
  if (typeof module !== "undefined" && module.exports) module.exports = MG;
})(typeof self !== "undefined" ? self : globalThis);
