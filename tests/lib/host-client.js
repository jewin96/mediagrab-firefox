// Talks to MediaGrabHost.exe exactly like Firefox does (4-byte little-endian length + UTF-8 JSON).
"use strict";
const { spawn } = require("child_process");

class HostClient {
  constructor(exe, { env = {}, args = [] } = {}) {
    this.messages = [];
    this.waiters = [];
    this.buf = Buffer.alloc(0);
    this.parseErrors = [];
    this.stdoutBytes = 0;
    this.stderr = "";
    this.exitCode = null;
    this.exited = new Promise((resolve) => { this._resolveExit = resolve; });
    this.proc = spawn(exe, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.stdout.on("data", (chunk) => { this.stdoutBytes += chunk.length; this.buf = Buffer.concat([this.buf, chunk]); this._drain(); });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString("utf8"); });
    this.proc.on("exit", (code) => { this.exitCode = code; this._resolveExit(code); this._notify(); });
  }

  _drain() {
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > 1024 * 1024) { this.parseErrors.push(`implausible length ${len}`); this.buf = Buffer.alloc(0); return; }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try { this.messages.push(JSON.parse(body)); } catch (e) { this.parseErrors.push(`bad JSON: ${body.slice(0, 80)}`); }
    }
    this._notify();
  }

  _notify() { for (const w of [...this.waiters]) w(); }

  static frame(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  }

  send(obj) { this.proc.stdin.write(HostClient.frame(obj)); }
  sendRaw(buf) { this.proc.stdin.write(buf); }

  waitFor(pred, timeoutMs = 20000, label = "message") {
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = this.messages.find(pred);
        if (m) { cleanup(); resolve(m); }
        else if (this.exitCode !== null) { cleanup(); reject(new Error(`host exited (${this.exitCode}) while waiting for ${label}; stderr=${this.stderr}`)); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(this.messages.slice(-4))}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.waiters = this.waiters.filter((w) => w !== check); };
      this.waiters.push(check);
      check();
    });
  }

  // Waits for the terminal message of a job (completed or error).
  finish(jobId, timeoutMs = 60000) {
    return this.waitFor((m) => m.jobId === jobId && (m.type === "completed" || m.type === "error"), timeoutMs, `job ${jobId} to finish`);
  }

  jobMessages(jobId) { return this.messages.filter((m) => m.jobId === jobId); }

  async close() {
    try { this.proc.stdin.end(); } catch (_) {}
    const timer = setTimeout(() => { try { this.proc.kill(); } catch (_) {} }, 10000);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }

  // True when stdout carried nothing but whole, valid protocol packets.
  get stdoutClean() { return this.parseErrors.length === 0 && this.buf.length === 0; }
}

module.exports = { HostClient };
