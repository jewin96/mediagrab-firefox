// Generates the store screenshots (store/screenshots/*.png) from the REAL popup running in a throwaway Firefox, using a
// generic sample page, then composes them onto 1280x800 canvases with Python/Pillow.
//   node tests/make-screenshots.js      (env TEST_TMP; needs the companion installed, Pillow for the final composition)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { generateMedia, startServer } = require("./lib/media-server");

const ROOT = path.resolve(__dirname, "..");
const TMP = process.env.TEST_TMP || path.join(os.tmpdir(), "mediagrab-tests");
const OUT = path.join(ROOT, "store", "screenshots");
const src = fs.readFileSync(path.join(__dirname, "e2e-firefox.js"), "utf8");
const Marionette = eval("(" + src.slice(src.indexOf("class Marionette"), src.indexOf("(async () => {")) + ")");
const net = require("net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ID = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
const UUID = "5f3c2a10-7b1e-4c55-9a3d-0d1e2f3a4b6e", PORT = 2939;
const unwrap = (r) => (r && typeof r === "object" && !Array.isArray(r) && "value" in r ? r.value : r);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  generateMedia(path.join(TMP, "shotmedia"));
  const server = await startServer(path.join(TMP, "shotmedia"));
  const profile = path.join(TMP, "shot-profile"); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
  const prefs = { "marionette.port": PORT, "extensions.webextensions.uuids": JSON.stringify({ [EXT_ID]: UUID }), "browser.shell.checkDefaultBrowser": false, "app.update.auto": false };
  fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
  const ff = spawn("C:/Program Files/Mozilla Firefox/firefox.exe", ["-no-remote", "-profile", profile, "-headless", "-marionette", "-remote-allow-system-access"], { stdio: "ignore" });
  const m = new Marionette();
  const shots = [];
  try {
    await m.connect(PORT); await m.cmd("WebDriver:NewSession", { capabilities: {} });
    await m.cmd("Addon:Install", { path: path.join(ROOT, "extension"), temporary: true });
    await m.cmd("WebDriver:Navigate", { url: server.base + "/media/store.html" });
    await sleep(3000);
    const pageHandle = String(unwrap(await m.cmd("WebDriver:GetWindowHandle")));
    await m.cmd("Marionette:SetContext", { value: "chrome" });
    await m.js("const t=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});gBrowser.selectedTab=t;return 1", [`moz-extension://${UUID}/popup/popup.html?tabId=-1`]);
    await m.cmd("Marionette:SetContext", { value: "content" }); await sleep(1500);
    const handles = unwrap(await m.cmd("WebDriver:GetWindowHandles"));
    await m.cmd("WebDriver:SwitchToWindow", { handle: String(handles.find((h) => String(h) !== pageHandle)) });
    const tabId = await m.jsAsync(`const cb=arguments[arguments.length-1]; window.wrappedJSObject.browser.tabs.query({}).then(ts=>{const t=ts.find(t=>t.url.indexOf('/media/store.html')>=0); cb(t?t.id:null)});`);
    await m.js("window.location.href = arguments[0]", [`moz-extension://${UUID}/popup/popup.html?tabId=${tabId}`]);
    await sleep(2000);
    for (let i = 0; i < 20; i++) {
      await m.js(`document.getElementById('refresh').click()`); await sleep(1800);
      if ((await m.js(`return document.querySelectorAll('.media-row').length`)) >= 3) break;
    }
    for (let i = 0; i < 30; i++) { if (/Companion connected/.test(await m.js(`return document.getElementById('companionText').textContent`))) break; await sleep(500); }
    const bottom = () => m.js(`let b = document.querySelector('footer').getBoundingClientRect().bottom; const menu = document.querySelector('.context-menu'); if (menu) b = Math.max(b, menu.getBoundingClientRect().bottom); return Math.ceil(b)`);

    // 1) detected media
    await m.shot(path.join(TMP, "s1.png")); shots.push({ file: "s1.png", h: await bottom(), out: "1-detected-media.png" });
    // 2) menu
    await m.js(`document.querySelectorAll('.media-row')[0].querySelector('.menu-action').click()`); await sleep(400);
    await m.shot(path.join(TMP, "s2.png")); shots.push({ file: "s2.png", h: await bottom(), out: "2-actions-menu.png" });
    await m.js(`document.body.click()`); await sleep(300);
    // 3) a running download with live speed (HLS row = the one with a quality list)
    const idx = await m.js(`return [...document.querySelectorAll('.media-row')].findIndex(r => r.querySelectorAll('.quality option').length > 1)`);
    await m.js(`const s = document.querySelectorAll('.media-row')[${idx}].querySelector('.quality'); s.selectedIndex = 1; s.dispatchEvent(new Event('change')); document.querySelectorAll('.media-row')[${idx}].querySelector('.primary-action').click()`);
    for (let i = 0; i < 200; i++) {
      await sleep(120);
      const sp = await m.js(`const t = document.getElementById('totalSpeed'); return t.classList.contains('hidden') ? '' : t.textContent`);
      if (/\/s/.test(sp)) break;
    }
    await sleep(500);
    await m.shot(path.join(TMP, "s3.png")); shots.push({ file: "s3.png", h: await bottom(), out: "3-progress-and-speed.png" });
    fs.writeFileSync(path.join(TMP, "shots.json"), JSON.stringify(shots));
    console.log("captured", shots.map((s) => `${s.out}(${s.h}px)`).join(", "));
  } catch (e) { console.log("ERR", e.stack || e.message); process.exitCode = 1; }
  finally {
    try { await m.cmd("Marionette:Quit", { flags: ["eForceQuit"] }, 5000); } catch (_) {}
    await sleep(1500);
    try { if (ff.exitCode === null) execFileSync("taskkill", ["/PID", String(ff.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) {}
    await server.close();
    // the test download wrote a file into Downloads\MediaGrab; remove only that sample
    for (const f of fs.existsSync(path.join(os.homedir(), "Downloads", "MediaGrab")) ? fs.readdirSync(path.join(os.homedir(), "Downloads", "MediaGrab")).filter((n) => /^Mountain Timelapse/.test(n)) : []) { try { fs.rmSync(path.join(os.homedir(), "Downloads", "MediaGrab", f), { force: true }); } catch (_) {} }
  }
})();
