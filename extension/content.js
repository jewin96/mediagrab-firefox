/* MediaGrab content script: DOM/performance media discovery + page metadata.
 * Network observation in background.js is the primary detector; this catches <video>/<audio> sources
 * and resources already loaded before the extension started. Uses MG from lib/util.js. */

function absoluteUrl(value) {
  if (!value || value.startsWith("blob:") || value.startsWith("data:")) return null;
  try { return new URL(value, location.href).href; } catch { return null; }
}

// State for in-page (SPA) navigation: requests logged before it belong to the previous video, and og: tags that did not
// change since the first page load are left-overs.
let navStart = 0;
let spaNavigated = false;
const initialSignature = MG.pageSignature(location.href);
// True as soon as the address no longer matches the page that was loaded (no waiting for our polling to notice).
const navigatedSinceLoad = () => spaNavigated || MG.pageSignature(location.href) !== initialSignature;
const initialOgImage = document.querySelector('meta[property="og:image"]')?.content || "";

function siteName() { return document.querySelector('meta[property="og:site_name"]')?.content?.trim() || ""; }

// og: tags of single-page apps are often left over from the first page that was loaded; only trust them when og:url matches.
function ogFresh() {
  const og = document.querySelector('meta[property="og:url"]')?.content;
  return !og || MG.pageSignature(og) === MG.pageSignature(location.href);
}

function youtubeVideoId() {
  try {
    const u = new URL(location.href);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch" ? u.searchParams.get("v") : null;
  } catch { return null; }
}

function bestThumbnail() {
  const poster = absoluteUrl(document.querySelector("video")?.poster || "");
  if (poster) return poster;
  const yt = youtubeVideoId();
  if (yt && /^[\w-]{6,20}$/.test(yt)) return `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;   // og:image is stale after in-page navigation
  if (!ogFresh()) return "";
  if (navigatedSinceLoad() && (document.querySelector('meta[property="og:image"]')?.content || "") === initialOgImage) return "";
  for (const sel of ['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[property="twitter:image"]', 'link[rel="image_src"]']) {
    const el = document.querySelector(sel);
    const url = absoluteUrl(el?.content || el?.href || "");
    if (url) return url;
  }
  return "";
}

function cleanTitle(t) {
  t = String(t || "").replace(/^\(\d+\)\s*/, "").trim();            // "(3) Title": unread-notification counter
  const site = siteName().toLowerCase();
  if (site) for (const sep of [" - ", " | ", " \u2013 ", " \u2014 "]) {
    if (t.toLowerCase().endsWith(sep + site)) { t = t.slice(0, -(sep.length + site.length)).trim(); break; }
  }
  return t;
}

// document.title follows in-page navigation; og:title often does not. Use og only when the document title is empty/generic.
function pageTitle() {
  const doc = cleanTitle(document.title);
  const generic = !doc || doc.toLowerCase() === siteName().toLowerCase() || doc.toLowerCase() === location.hostname.replace(/^www\./, "");
  if (!generic) return doc;
  return ogFresh() ? cleanTitle(document.querySelector('meta[property="og:title"]')?.content) || doc : doc;
}

function durationSeconds() {
  const candidates = [...document.querySelectorAll("video,audio")]
    .map((el) => Number(el.duration))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 60 * 60 * 24 * 7);
  return candidates.length ? Math.max(...candidates) : null;
}

function scanDom() {
  const found = new Map();
  const add = (url, type = "", source = "page") => {
    const abs = absoluteUrl(url);
    if (!abs) return;
    const ct = String(type).toLowerCase();
    if (!MG.EXT_RE.test(abs) && !ct.startsWith("video/") && !ct.startsWith("audio/")) return;
    found.set(abs, { url: abs, contentType: type || "", source });
  };
  for (const el of document.querySelectorAll("video,audio")) {
    add(el.currentSrc || el.src, el.getAttribute("type") || "", "element");
    for (const source of el.querySelectorAll("source[src]")) add(source.src, source.type || "", "source");
  }
  for (const source of document.querySelectorAll("source[src]")) add(source.src, source.type || "", "source");
  try {
    for (const entry of performance.getEntriesByType("resource")) if (entry.startTime >= navStart) add(entry.name, "", "performance");
  } catch (_) {}
  return [...found.values()];
}

async function report() {
  try {
    await browser.runtime.sendMessage({
      type: "page-meta", title: pageTitle(), url: location.href, thumbnail: bestThumbnail(), duration: durationSeconds()
    });
    const items = scanDom();
    if (items.length) await browser.runtime.sendMessage({ type: "content-media", items });
  } catch (_) { /* extension reloaded or page unloading */ }
}

report();
setTimeout(report, 1800);
setTimeout(report, 5000);
setTimeout(report, 10000);

const hooked = new WeakSet();
function hookMediaElements() {
  for (const el of document.querySelectorAll("video,audio")) {
    if (hooked.has(el)) continue;
    hooked.add(el);
    el.addEventListener("loadedmetadata", report);
    el.addEventListener("play", report);
  }
}
hookMediaElements();

let timer = null;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(() => { hookMediaElements(); report(); }, 600);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "poster", "content"] });

// In-page navigation (YouTube-style): URL and title change without a reload. Re-report with fresh metadata.
let lastHref = location.href;
function onUrlChange() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  spaNavigated = true;
  navStart = performance.now() - 5000;   // a player's first requests can precede our (polled) detection of the URL change
  hookMediaElements();
  for (const ms of [0, 1200, 3500, 8000]) setTimeout(report, ms);
}
window.addEventListener("popstate", onUrlChange);
window.addEventListener("yt-navigate-finish", onUrlChange);
setInterval(onUrlChange, 1500);

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "rescan") { hookMediaElements(); return report().then(() => ({ ok: true })); }
});
