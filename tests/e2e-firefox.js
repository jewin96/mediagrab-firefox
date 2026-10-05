// Real-Firefox end-to-end test. Starts a SEPARATE headless Firefox (temp profile, -no-remote, Marionette), loads the
// extension as a temporary add-on, opens a local page that makes HLS requests, then drives the real popup: connection
// indicator, detection, Download -> native host -> FFmpeg -> file. Needs the companion installed (Install-Companion.cmd).
//   node tests/e2e-firefox.js   (env TEST_TMP)
"use strict";
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { generateMedia, startServer, probe } = require("./lib/media-server");

const ROOT = path.resolve(__dirname, "..");
const TMP = process.env.TEST_TMP || path.join(os.tmpdir(), "mediagrab-tests");
const FIREFOX = [process.env.FIREFOX_EXE, "C:\\Program Files\\Mozilla Firefox\\firefox.exe", "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"].find((p) => p && fs.existsSync(p));
const EXT_ID = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
const UUID = "5f3c2a10-7b1e-4c55-9a3d-0d1e2f3a4b5c";
const PORT = 2931;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "\n      " + detail}`); if (!ok) failed++; };

class Marionette {
  async connect(port) {
    for (let i = 0; i < 80; i++) {
      try { await new Promise((res, rej) => { const s = net.connect(port, "127.0.0.1", () => { this.sock = s; res(); }); s.once("error", rej); }); break; }
      catch (_) { await sleep(500); }
    }
    if (!this.sock) throw new Error("Marionette did not come up");
    this.buf = Buffer.alloc(0); this.id = 0; this.pending = new Map();
    this.sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    await new Promise((r) => { this.onHello = r; this.drain(); });
  }
  drain() {
    for (;;) {
      const colon = this.buf.indexOf(":");
      if (colon < 0) return;
      const len = parseInt(this.buf.subarray(0, colon).toString(), 10);
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString("utf8"));
      this.buf = this.buf.subarray(colon + 1 + len);
      if (Array.isArray(msg)) { const p = this.pending.get(msg[1]); if (p) { this.pending.delete(msg[1]); msg[2] ? p.reject(new Error(JSON.stringify(msg[2]))) : p.resolve(msg[3]); } }
      else if (this.onHello) { this.onHello(); this.onHello = null; }
    }
  }
  cmd(name, params = {}, timeout = 60000) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette ${name} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  async shot(file) { const r = await this.cmd("WebDriver:TakeScreenshot", { full: false, hash: false, scroll: true }); fs.writeFileSync(file, Buffer.from(r.value, "base64")); }
  async js(script, args = []) { try { const r = await this.cmd("WebDriver:ExecuteScript", { script, args, sandbox: "default" }); return r.value; } catch (e) { throw new Error(`script [${script.trim().slice(0, 90).replace(/\s+/g, " ")}] -> ${e.message.slice(0, 300)}`); } }
  async jsAsync(script, args = [], timeout = 30000) { try { const r = await this.cmd("WebDriver:ExecuteAsyncScript", { script, args, sandbox: "default", scriptTimeout: timeout }, timeout + 5000); return r.value; } catch (e) { throw new Error(`async script [${script.trim().slice(0, 90).replace(/\s+/g, " ")}] -> ${e.message.slice(0, 300)}`); } }
}

(async () => {
  if (!FIREFOX) { console.log("SKIP  Firefox not found"); process.exit(0); }
  const { ffmpeg, ffprobe } = generateMedia(path.join(TMP, "e2emedia"));
  const server = await startServer(path.join(TMP, "e2emedia"));
  const profile = path.join(TMP, "ff-profile"); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
  const prefs = {
    "marionette.port": PORT, "browser.shell.checkDefaultBrowser": false, "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false, "app.update.auto": false, "app.update.enabled": false,
    "browser.startup.homepage_override.mstone": "ignore", "startup.homepage_welcome_url": "about:blank", "browser.aboutwelcome.enabled": false,
    "extensions.webextensions.uuids": JSON.stringify({ [EXT_ID]: UUID }), "extensions.experiments.enabled": false,
    "network.proxy.type": 0, "browser.download.folderList": 1, "browser.download.useDownloadDir": true
  };
  fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));

  const ff = spawn(FIREFOX, ["-no-remote", "-profile", profile, "-headless", "-marionette", "-remote-allow-system-access"], { stdio: "ignore", windowsHide: true });
  const created = [];
  const m = new Marionette();
  try {
    await m.connect(PORT);
    const session = await m.cmd("WebDriver:NewSession", { capabilities: {} });
    console.log(`Firefox ${session.capabilities?.browserVersion || ""} driven via Marionette (temp profile ${profile})`);

    const inst = await m.cmd("Addon:Install", { path: path.join(ROOT, "extension"), temporary: true });
    check("extension installs as a temporary add-on in real Firefox", (inst && inst.value) === EXT_ID, JSON.stringify(inst));

    // page that issues HLS requests like a player would
    await m.cmd("WebDriver:Navigate", { url: server.base + "/media/page.html" });
    await sleep(2500);

    // open the popup as a tab, then find the test tab's id with the extension's own tabs API
    const popupBase = `moz-extension://${UUID}/popup/popup.html`;
    const unwrap = (r) => (r && typeof r === "object" && !Array.isArray(r) && "value" in r ? r.value : r);
    const pageHandle = String(unwrap(await m.cmd("WebDriver:GetWindowHandle")));
    // WebDriver cannot navigate to moz-extension:// URLs, so open the popup tab from Firefox's chrome context.
    await m.cmd("Marionette:SetContext", { value: "chrome" });
    await m.js(`const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = tab; return true;`, [popupBase + "?tabId=-1"]);
    await m.cmd("Marionette:SetContext", { value: "content" });
    await sleep(1500);
    const handles = unwrap(await m.cmd("WebDriver:GetWindowHandles"));
    const popupHandle = handles.find((h) => String(h) !== pageHandle);
    await m.cmd("WebDriver:SwitchToWindow", { handle: String(popupHandle) });
    const tabId = await m.jsAsync(`const cb = arguments[arguments.length-1];
      window.wrappedJSObject.browser.tabs.query({}).then(ts => { const t = ts.find(t => t.url.indexOf('/media/page.html') >= 0); cb(t ? t.id : null); });`);
    check("test page tab is visible to the extension", Number.isInteger(tabId), "tabId=" + tabId);
    await m.js(`window.location.href = arguments[0]`, [`${popupBase}?tabId=${tabId}`]);
    await sleep(1500);

    // 1) the exact thing that was broken: companion indicator, driven by a real ping/pong through Firefox's native messaging
    let companion = "";
    for (let i = 0; i < 40; i++) {
      companion = await m.js(`return document.getElementById('companionText').textContent + ' | ' + document.getElementById('companion').className;`);
      if (!/Checking/.test(companion)) break;
      await sleep(500);
    }
    check("popup shows GREEN 'Companion connected' (real Firefox -> registry -> host -> pong)", /Companion connected/.test(companion) && /online/.test(companion) && /FFmpeg \d/.test(companion), companion);

    // 2) detection + grouping
    let rows = [];
    for (let i = 0; i < 30; i++) {
      await m.js(`document.getElementById('refresh').click()`);
      await sleep(1800);
      rows = await m.js(`return [...document.querySelectorAll('.media-row')].map(r => ({ badge: r.querySelector('.format-badge').textContent, title: r.querySelector('.title').textContent, mime: r.querySelector('.subline span').textContent, url: r.querySelector('.url-line').textContent, quality: [...r.querySelectorAll('.quality option')].map(o => o.textContent.split(' ')[0]), key: r.dataset.key }))`);
      if (rows.some((r) => r.badge === "HLS" && r.quality.length)) break;
    }
    const hls = rows.find((r) => r.badge === "HLS");
    const mp4 = rows.find((r) => r.badge === "VIDEO");
    console.log("rows:", JSON.stringify(rows.map((r) => ({ b: r.badge, t: r.title, q: r.quality.join("/") }))));
    check("HLS master detected once (variant playlist + segments grouped away)", rows.filter((r) => r.badge === "HLS").length === 1 && !rows.some((r) => /\.ts\b/.test(r.url)), JSON.stringify(rows));
    check("stream size is an ESTIMATE of the video (≈ ...), not the playlist file's size", /^≈ /.test(await m.js(`return document.querySelectorAll('.media-row')[${rows.findIndex((r) => r.badge === "HLS")}].querySelector('.size').textContent`)), "");
    check("title comes from the page, quality choices are real (Best/360p/180p)", hls && hls.title === "Adam Scott - Armchair Expert with Dax Shepard" && hls.quality.join(",") === "Best,360p,180p", JSON.stringify(hls));
    check("direct MP4 (range request) is listed as VIDEO", !!mp4, JSON.stringify(rows));
    const countText = await m.js(`return document.getElementById('count').textContent`);
    check("detected-media counter matches", Number(countText) === rows.length, countText);

    await m.shot(path.join(TMP, "popup-detected.png"));
    // 3) Download HLS (180p) through the companion
    const hlsRowIdx = rows.findIndex((r) => r.badge === "HLS");
    await m.js(`const sel = document.querySelectorAll('.media-row')[${hlsRowIdx}].querySelector('.quality'); sel.value = [...sel.options].find(o => o.textContent.startsWith('180p')).value; sel.dispatchEvent(new Event('change'));`);
    await m.js(`document.querySelectorAll('.media-row')[${hlsRowIdx}].querySelector('.primary-action').click()`);
    let last = "";
    let sawSpeed = "", sawTotal = "", shotTaken = false;
    for (let i = 0; i < 400; i++) {
      await sleep(150);
      last = await m.js(`const r = document.querySelectorAll('.media-row')[${hlsRowIdx}]; return r.querySelector('.progress-text').textContent + ' || ' + r.querySelector('.progress-wrap').className + ' || ' + document.getElementById('notice').textContent;`);
      const sp = await m.js(`const r = document.querySelectorAll('.media-row')[${hlsRowIdx}]; const s = r.querySelector('.speed'); const t = document.getElementById('totalSpeed'); return (s.classList.contains('hidden') ? '' : s.textContent) + '|' + (t.classList.contains('hidden') ? '' : t.textContent);`);
      const [rowSpeed, totalSpeed] = sp.split("|");
      if (/\/s/.test(rowSpeed) && !sawSpeed) sawSpeed = rowSpeed;
      if (/\/s/.test(totalSpeed) && !sawTotal) sawTotal = totalSpeed;
      if (sawSpeed && sawTotal && !shotTaken) { shotTaken = true; await m.shot(path.join(TMP, "popup-speed.png")); }
      if (/Finished|Failed/.test(last)) break;
    }
    check("live speed shown beside the progress bar while downloading", /^↓ [\d.]+ (KB|MB)\/s$/.test(sawSpeed), JSON.stringify(sawSpeed));
    check("combined speed shown in the footer while downloading", /^↓ [\d.]+ (KB|MB)\/s$/.test(sawTotal), JSON.stringify(sawTotal));
    const finishedSpeed = await m.js(`const s = document.querySelectorAll('.media-row')[${hlsRowIdx}].querySelector('.speed'); const t = document.getElementById('totalSpeed'); return s.textContent + '|' + (t.classList.contains('hidden') ? 'footer-hidden' : 'footer-visible');`);
    check("after finishing: average speed kept on the row, footer total hidden", /^avg [\d.]+ (KB|MB)\/s\|footer-hidden$/.test(finishedSpeed), finishedSpeed);
    console.log("HLS row status:", last);
    await m.shot(path.join(TMP, "popup-finished.png"));
    const m1 = /Finished — (.*?) \|\|/.exec(last);
    const saved = path.join(os.homedir(), "Downloads", "MediaGrab", "Adam Scott - Armchair Expert with Dax Shepard.mp4");
    check("HLS download finished in the popup (progress -> finished state)", /Finished/.test(last) && /is-done/.test(last), last);
    if (fs.existsSync(saved)) {
      created.push(saved);
      const p = probe(ffprobe, saved);
      check("finished file is a playable 180p MP4 with audio, ~6 s, in Downloads\\MediaGrab", p.video[0]?.height === 180 && p.audio.length === 1 && Math.abs(p.duration - 6) < 0.7, JSON.stringify(p));
    } else check("finished file exists at Downloads\\MediaGrab\\<page title>.mp4", false, saved + " | " + (m1 ? m1[1] : last));

    // 4) Direct MP4 through Firefox's own Downloads API
    if (mp4) {
      const mp4Idx = rows.findIndex((r) => r.badge === "VIDEO");
      await m.js(`document.querySelectorAll('.media-row')[${mp4Idx}].querySelector('.primary-action').click()`);
      let t2 = "";
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        t2 = await m.js(`const r = document.querySelectorAll('.media-row')[${mp4Idx}]; return r.querySelector('.progress-text').textContent`);
        if (/Finished|Failed/.test(t2)) break;
      }
      const dir = path.join(os.homedir(), "Downloads", "MediaGrab");
      const direct = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^Adam Scott - Armchair Expert with Dax Shepard\(\d+\)\.mp4$/.test(f) && !created.includes(path.join(dir, f))) : [];
      direct.forEach((f) => created.push(path.join(dir, f)));
      check("direct MP4 download via Firefox Downloads API finished", /Finished/.test(t2) && direct.length === 1, `${t2} | ${direct}`);
    }

    // 5) the dropdown menu (all required entries)
    await m.js(`document.querySelector('.media-row .menu-action').click()`);
    await sleep(300);
    await m.shot(path.join(TMP, "popup-menu.png"));
    const menu = await m.js(`return [...document.querySelectorAll('.context-menu button')].map(b => b.textContent.replace(/\\s+/g,' ').trim())`);
    const wanted = ["Download Audio & Video", "Download As…", "Always Download As…", "Download Audio", "Always audio only for this website", "Copy URL", "Always copy URL", "Smartnaming ✓", "Details"];
    check("dropdown has every required entry", wanted.every((w) => menu.includes(w)), JSON.stringify(menu));

    // 6) single-page-app navigation (YouTube-style): stale og: tags, URL+title change without reload
    await m.cmd("WebDriver:SwitchToWindow", { handle: pageHandle });
    await m.cmd("WebDriver:Navigate", { url: server.base + "/media/spa.html" });
    await sleep(2500);
    await m.js(`window.wrappedJSObject.go()`);
    await sleep(6000);
    await m.cmd("WebDriver:SwitchToWindow", { handle: String(popupHandle) });
    await m.js(`document.getElementById('refresh').click()`);
    await sleep(2500);
    const spaRows = await m.js(`return [...document.querySelectorAll('.media-row')].map(r => ({ badge: r.querySelector('.format-badge').textContent, title: r.querySelector('.title').textContent, img: !!r.querySelector('.thumb img'), q: [...r.querySelectorAll('.quality option')].length }))`);
    const spaSub = await m.js(`return document.getElementById('subtitle').textContent`);
    console.log("SPA rows:", JSON.stringify(spaRows), "subtitle:", spaSub);
    check("after in-page navigation only the NEW video's stream is listed (previous video's media forgotten)", spaRows.length === 1 && spaRows[0].badge === "HLS" && spaRows[0].q === 3, JSON.stringify(spaRows));
    check("title follows the page after in-page navigation, not the stale og:title ('(2) ' counter and ' - Site' suffix removed)", spaRows[0] && spaRows[0].title === "Cool Video" && spaSub === "Cool Video", JSON.stringify([spaRows[0] && spaRows[0].title, spaSub]));
    check("stale og:image is not used as the thumbnail after in-page navigation", spaRows[0] && spaRows[0].img === false, JSON.stringify(spaRows[0]));
  } catch (e) {
    failed++; console.log("FAIL  e2e aborted:", e.stack || e.message);
  } finally {
    try { await m.cmd("Marionette:Quit", { flags: ["eForceQuit"] }, 8000); } catch (_) {}
    await sleep(1500);
    try { if (ff.exitCode === null) execFileSync("taskkill", ["/PID", String(ff.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {}
    await server.close();
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
  }
  console.log(failed ? `\n${failed} e2e check(s) FAILED` : "\nall e2e checks passed");
  process.exit(failed ? 1 : 0);
})();
