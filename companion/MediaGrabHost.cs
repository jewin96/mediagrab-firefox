// MediaGrab native messaging host (Firefox <-> FFmpeg).
//
// Protocol (Firefox native messaging): 4-byte little-endian length + UTF-8 JSON, both directions.
// stdout carries ONLY protocol packets. All diagnostics go to the log file (and stderr for --self-test).
//
// Requests  (extension -> host), each may carry "reqId" which is echoed back:
//   {"action":"ping"}
//   {"action":"download","jobId":"...","url":"https://...","kind":"hls|dash|file","mode":"video|audio",
//    "title":"...","filename":"...","referer":"...","userAgent":"...","cookie":"...","origin":"...",
//    "audioUrl":"https://..."(optional separate audio rendition),"outputDirectory":"C:\\...","saveAs":false,
//    "durationSeconds":123}
//   {"action":"cancel","jobId":"...","save":false}
// Responses (host -> extension):
//   {"ok":true,"action":"pong","version":"...","ffmpeg":"...","ffmpegVersion":"..."}
//   {"type":"started","jobId":"..."}  {"type":"progress","jobId":"...","percent":42,...}
//   {"type":"completed","jobId":"...","file":"..."}  {"type":"error","jobId":"...","code":"...","message":"..."}
//
// Build: companion\Install-Companion.cmd (csc.exe from the .NET Framework that ships with Windows; C# 5).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Windows Job Object with KILL_ON_JOB_CLOSE: every ffmpeg we start dies with this process, even if Firefox
// force-terminates the host (crash, task manager), so no orphan keeps downloading.
public static class ChildReaper
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr job = IntPtr.Zero;
    static readonly object sync = new object();

    public static bool Adopt(Process p)
    {
        try
        {
            lock (sync)
            {
                if (job == IntPtr.Zero)
                {
                    IntPtr h = CreateJobObject(IntPtr.Zero, null);
                    if (h == IntPtr.Zero) return false;
                    ExtendedLimits lim = new ExtendedLimits();
                    lim.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    int size = Marshal.SizeOf(typeof(ExtendedLimits));
                    IntPtr mem = Marshal.AllocHGlobal(size);
                    try
                    {
                        Marshal.StructureToPtr(lim, mem, false);
                        if (!SetInformationJobObject(h, 9, mem, (uint)size)) return false; // 9 = JobObjectExtendedLimitInformation
                    }
                    finally { Marshal.FreeHGlobal(mem); }
                    job = h; // handle stays open for the life of the host; closing it (process exit) kills the children
                }
                return AssignProcessToJobObject(job, p.Handle);
            }
        }
        catch { return false; }
    }
}

public class JobException : Exception
{
    public string Code;
    public JobException(string code, string message) : base(message) { Code = code; }
}

public class Job
{
    public string Id;
    public Process Proc;
    public volatile bool CancelRequested;
    public volatile bool StopRequested; // stop recording but keep what was captured
    public readonly object Sync = new object();
    public double PctBase;    // progress already accounted for by an earlier phase (parallel segment download = 90)
    public bool Merging;      // true while FFmpeg only merges local files (no network speed to report)
}

public class SegItem { public string Url, Local; }
public class LocalTrack { public string PlaylistPath; public List<SegItem> Items = new List<SegItem>(); }
public class DlState
{
    public long Bytes;
    public int Done;
    public int Next = -1;
    public volatile bool Stop;
    public Exception Error;
    public readonly object Sync = new object();
}

public class Request
{
    public string JobId, Url, AudioUrl, Kind, Mode, Title, FileName, Referer, UserAgent, Cookie, Origin, OutputDir;
    public bool SaveAs;
    public bool Live;
    public bool LocalInputs;   // inputs are local playlists written by the parallel downloader
    public string CookieUrl = "";   // original URL that cookies are scoped to
    public double Duration;
    public bool AudioOnly { get { return Mode == "audio"; } }
}

public class StreamInfo
{
    public double Duration;
    public bool Live;
    public string Drm;
}

public static class MediaGrabHost
{
    public const string Version = "1.0.0";
    const int MaxIncoming = 8 * 1024 * 1024;
    const string DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly object OutLock = new object();
    static readonly object LogLock = new object();
    static readonly object PathLock = new object();
    static readonly HashSet<string> ReservedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, Job> Jobs = new Dictionary<string, Job>();
    static readonly SemaphoreSlim Slots = new SemaphoreSlim(2, 2);
    static Stream Stdout;
    static string InstallRoot;
    static string LogPath;
    static string FfmpegPath = "";
    static string FfmpegVersionLine = "";
    static string FfmpegSource = "";
    static int Connections = 16;   // parallel segment downloads; config.json "connections" (1-64) overrides
    static readonly object FfmpegLock = new object();
    static DateTime FfmpegTried = DateTime.MinValue;

    // ------------------------------------------------------------------ entry

    public static int Main(string[] args)
    {
        InstallRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        LogPath = Path.Combine(InstallRoot, "mediagrab-host.log");
        try
        {
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)(3072 | 12288 | 768 | 192); }
            catch { try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch { } }
            ServicePointManager.DefaultConnectionLimit = 32;

            // Firefox launches us as: host.exe <manifest path> <extension id>. Only "--flags" are ours.
            if (args != null && args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal))
                return RunCli(args);

            Stdout = Console.OpenStandardOutput();
            Stream stdin = Console.OpenStandardInput();
            LoadConfig();
            ResolveFfmpeg();
            Log("Host started v" + Version + " pid=" + Process.GetCurrentProcess().Id + " args=[" + String.Join(" | ", args) + "] ffmpeg=" + Show(FfmpegPath));

            while (true)
            {
                byte[] payload;
                try { payload = ReadPacket(stdin); }
                catch (Exception ex) { Log("Protocol read failure, exiting: " + ex.Message); Shutdown(); return 3; }
                if (payload == null) { Log("stdin closed by Firefox; exiting."); break; }

                Dictionary<string, object> msg = null;
                try { msg = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload)); }
                catch (Exception ex) { Log("Bad JSON: " + ex.Message); }
                if (msg == null) { SendError("", "", "bad_request", "The companion received a message that is not valid JSON."); continue; }
                try { Dispatch(msg); }
                catch (Exception ex)
                {
                    Log("Dispatch error: " + ex);
                    SendError(Str(msg, "jobId"), Str(msg, "reqId"), "internal", ex.Message);
                }
            }
            Shutdown();
            return 0;
        }
        catch (Exception ex)
        {
            try { Log("FATAL: " + ex); } catch { }
            return 1;
        }
    }

    static void Dispatch(Dictionary<string, object> msg)
    {
        string action = Str(msg, "action");
        if (action.Length == 0) action = Str(msg, "command"); // tolerate the 0.2.x field name
        string reqId = Str(msg, "reqId");
        Log("Request: " + action + (reqId.Length > 0 ? " reqId=" + reqId : ""));
        switch (action)
        {
            case "ping":
                ThreadPool.QueueUserWorkItem(delegate { SendPong(reqId); });
                break;
            case "download":
                Thread t = new Thread(delegate() { RunDownload(msg); });
                t.IsBackground = true;
                t.Name = "download";
                t.Start();
                break;
            case "cancel":
                CancelJob(Str(msg, "jobId"), Bool(msg, "save"));
                break;
            default:
                SendError(Str(msg, "jobId"), reqId, "unknown_action", "Unknown action: " + action);
                break;
        }
    }

    static void Shutdown()
    {
        List<Job> running;
        lock (Jobs) { running = new List<Job>(Jobs.Values); }
        foreach (Job j in running) { j.CancelRequested = true; KillProc(j); }
    }

    static void LoadConfig()
    {
        try
        {
            string cfg = Path.Combine(InstallRoot, "config.json");
            if (!File.Exists(cfg)) return;
            Dictionary<string, object> c = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(cfg, Encoding.UTF8));
            double n = Dbl(c, "connections");
            if (n >= 1 && n <= 64) Connections = (int)n;
        }
        catch (Exception ex) { Log("config.json (connections) unreadable: " + ex.Message); }
    }

    // ------------------------------------------------------------------ CLI helpers (never used by Firefox)

    static int RunCli(string[] args)
    {
        string flag = args[0].ToLowerInvariant();
        if (flag == "--version") { Console.Out.WriteLine(Version); return 0; }
        if (flag == "--self-test")
        {
            int fails = 0;
            Console.Out.WriteLine("MediaGrab host " + Version);
            Console.Out.WriteLine("Executable : " + System.Reflection.Assembly.GetExecutingAssembly().Location);
            ResolveFfmpeg();
            Console.Out.WriteLine("FFmpeg     : " + Show(FfmpegPath) + (FfmpegSource.Length > 0 ? "  (" + FfmpegSource + ")" : ""));
            Console.Out.WriteLine("FFmpeg ver : " + Show(FfmpegVersionLine));

            // Framing round trip using the real packet reader/writer.
            bool framing = false;
            try
            {
                using (MemoryStream ms = new MemoryStream())
                {
                    WritePacket(ms, Json.Serialize(new Dictionary<string, object> { { "action", "pong" }, { "text", "h\u00e9llo \u2713" } }));
                    byte[] raw = ms.ToArray();
                    int declared = BitConverter.ToInt32(raw, 0);
                    ms.Position = 0;
                    byte[] back = ReadPacket(ms);
                    Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(back));
                    framing = declared == raw.Length - 4 && Str(d, "text") == "h\u00e9llo \u2713";
                }
            }
            catch (Exception ex) { Console.Out.WriteLine("framing error: " + ex.Message); }
            Console.Out.WriteLine("Framing    : " + (framing ? "PASS" : "FAIL"));
            if (!framing) fails++;
            Console.Out.WriteLine("FFmpeg test: " + (FfmpegVersionLine.Length > 0 ? "PASS" : "FAIL"));
            if (FfmpegVersionLine.Length == 0) fails += 2;
            return fails == 0 ? 0 : (fails >= 2 ? 2 : 1);
        }
        Console.Error.WriteLine("Unknown option " + args[0]);
        return 64;
    }

    // ------------------------------------------------------------------ framing

    // Returns null on clean EOF before a header; throws on truncation or an impossible length.
    public static byte[] ReadPacket(Stream s)
    {
        byte[] header = new byte[4];
        int got = ReadFully(s, header, 4);
        if (got == 0) return null;
        if (got < 4) throw new EndOfStreamException("Truncated length header.");
        uint len = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
        if (len == 0 || len > MaxIncoming) throw new InvalidDataException("Invalid message length " + len + ".");
        byte[] payload = new byte[len];
        if (ReadFully(s, payload, (int)len) < (int)len) throw new EndOfStreamException("Truncated message body.");
        return payload;
    }

    static int ReadFully(Stream s, byte[] buf, int count)
    {
        int off = 0;
        while (off < count)
        {
            int n = s.Read(buf, off, count - off);
            if (n <= 0) break;
            off += n;
        }
        return off;
    }

    public static void WritePacket(Stream s, string json)
    {
        byte[] data = new UTF8Encoding(false).GetBytes(json);
        byte[] frame = new byte[4 + data.Length];
        frame[0] = (byte)(data.Length & 0xFF);
        frame[1] = (byte)((data.Length >> 8) & 0xFF);
        frame[2] = (byte)((data.Length >> 16) & 0xFF);
        frame[3] = (byte)((data.Length >> 24) & 0xFF);
        Buffer.BlockCopy(data, 0, frame, 4, data.Length);
        s.Write(frame, 0, frame.Length);
        s.Flush();
    }

    static void Send(Dictionary<string, object> obj)
    {
        lock (OutLock)
        {
            try { WritePacket(Stdout, Json.Serialize(obj)); }
            catch (Exception ex) { Log("Write to Firefox failed: " + ex.Message); }
        }
    }

    static Dictionary<string, object> Msg(string type, string jobId)
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["type"] = type;
        if (!String.IsNullOrEmpty(jobId)) d["jobId"] = jobId;
        return d;
    }

    static void SendError(string jobId, string reqId, string code, string message)
    {
        Dictionary<string, object> d = Msg("error", jobId);
        d["ok"] = false;
        d["code"] = code;
        d["message"] = message;
        if (!String.IsNullOrEmpty(reqId)) d["reqId"] = reqId;
        Send(d);
    }

    static void SendPong(string reqId)
    {
        ResolveFfmpeg();
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["ok"] = true;
        d["action"] = "pong";
        d["version"] = Version;
        d["ffmpegFound"] = FfmpegVersionLine.Length > 0;
        d["ffmpeg"] = FfmpegPath;
        d["ffmpegVersion"] = FfmpegVersionLine;
        d["downloadDir"] = DefaultOutputDir();
        if (reqId.Length > 0) d["reqId"] = reqId;
        Send(d);
    }

    // ------------------------------------------------------------------ logging

    public static void Log(string text)
    {
        try
        {
            lock (LogLock)
            {
                FileInfo fi = new FileInfo(LogPath);
                if (fi.Exists && fi.Length > 1024 * 1024) { try { File.Copy(LogPath, LogPath + ".old", true); File.Delete(LogPath); } catch { } }
                File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + "  " + text + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch { }
    }

    static string Redact(string url)
    {
        try { Uri u = new Uri(url); return u.Scheme + "://" + u.Host + u.AbsolutePath + (u.Query.Length > 1 ? "?…" : ""); }
        catch { return "(invalid url)"; }
    }

    static string Show(string s) { return String.IsNullOrEmpty(s) ? "NOT FOUND" : s; }

    // ------------------------------------------------------------------ ffmpeg discovery

    // Order: MEDIAGRAB_FFMPEG env, config.json written by the installer, bin\ffmpeg.exe, PATH, WinGet.
    // Resolved once per process; never scans the disk repeatedly.
    static void ResolveFfmpeg()
    {
        lock (FfmpegLock)
        {
            if (FfmpegVersionLine.Length > 0) return;
            if (FfmpegSource == "none" && (DateTime.UtcNow - FfmpegTried).TotalSeconds < 10) return; // retry, but not on every message
            FfmpegTried = DateTime.UtcNow;
            string found = "", how = "";
            string env = Environment.GetEnvironmentVariable("MEDIAGRAB_FFMPEG");
            if (!String.IsNullOrEmpty(env) && File.Exists(env)) { found = env; how = "MEDIAGRAB_FFMPEG"; }

            if (found.Length == 0)
            {
                try
                {
                    string cfg = Path.Combine(InstallRoot, "config.json");
                    if (File.Exists(cfg))
                    {
                        Dictionary<string, object> c = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(cfg, Encoding.UTF8));
                        string p = Str(c, "ffmpegPath");
                        if (p.Length > 0 && File.Exists(p)) { found = p; how = "config.json"; }
                        else if (p.Length > 0) Log("config.json ffmpegPath does not exist: " + p);
                    }
                }
                catch (Exception ex) { Log("config.json unreadable: " + ex.Message); }
            }
            if (found.Length == 0)
            {
                string local = Path.Combine(InstallRoot, "bin", "ffmpeg.exe");
                if (File.Exists(local)) { found = local; how = "bundled"; }
            }
            if (found.Length == 0)
            {
                string path = Environment.GetEnvironmentVariable("PATH") ?? "";
                foreach (string dir in path.Split(';'))
                {
                    try
                    {
                        if (dir.Trim().Length == 0) continue;
                        string cand = Path.Combine(dir.Trim().Trim('"'), "ffmpeg.exe");
                        if (File.Exists(cand)) { found = cand; how = "PATH"; break; }
                    }
                    catch { }
                }
            }
            if (found.Length == 0)
            {
                string la = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";
                if (la.Length > 0)
                {
                    string link = Path.Combine(la, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
                    if (File.Exists(link)) { found = link; how = "WinGet link"; }
                    else
                    {
                        try
                        {
                            string pk = Path.Combine(la, "Microsoft", "WinGet", "Packages");
                            if (Directory.Exists(pk))
                                foreach (string d in Directory.GetDirectories(pk, "*FFmpeg*"))
                                {
                                    string[] hits = Directory.GetFiles(d, "ffmpeg.exe", SearchOption.AllDirectories);
                                    if (hits.Length > 0) { found = hits[0]; how = "WinGet package"; break; }
                                }
                        }
                        catch { }
                    }
                }
            }
            FfmpegPath = found;
            FfmpegSource = found.Length > 0 ? how : "none";
            if (found.Length > 0)
            {
                string first;
                int code = RunCapture(found, "-hide_banner -version", 8000, out first);
                if (code == 0 && first.Length > 0) FfmpegVersionLine = first;
                else { Log("ffmpeg -version failed (exit " + code + "): " + first); FfmpegVersionLine = ""; FfmpegSource = "none"; }
            }
        }
    }

    static int RunCapture(string exe, string args, int timeoutMs, out string firstLine)
    {
        firstLine = "";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = true;
            using (Process p = Process.Start(psi))
            {
                p.StandardInput.Close();
                string err = null;
                Thread te = new Thread(delegate() { try { err = p.StandardError.ReadToEnd(); } catch { } });
                te.Start();
                string o = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } return -1; }
                te.Join(1000);
                string[] lines = (o ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length > 0) firstLine = lines[0].Trim();
                else if (!String.IsNullOrEmpty(err)) firstLine = err.Trim().Split('\n')[0].Trim();
                return p.ExitCode;
            }
        }
        catch (Exception ex) { firstLine = ex.Message; return -2; }
    }

    // ------------------------------------------------------------------ request parsing / validation

    static Request ParseRequest(Dictionary<string, object> msg)
    {
        Request r = new Request();
        r.JobId = Str(msg, "jobId");
        if (r.JobId.Length == 0) r.JobId = Guid.NewGuid().ToString();
        if (!Regex.IsMatch(r.JobId, "^[A-Za-z0-9_-]{8,64}$")) throw new JobException("bad_request", "Invalid job id.");

        r.Url = Str(msg, "url");
        r.AudioUrl = Str(msg, "audioUrl");
        RequireHttp(r.Url, "media URL");
        if (r.AudioUrl.Length > 0) RequireHttp(r.AudioUrl, "audio URL");

        r.Kind = Str(msg, "kind").ToLowerInvariant();
        if (r.Kind != "hls" && r.Kind != "dash" && r.Kind != "file")
        {
            string path = new Uri(r.Url).AbsolutePath.ToLowerInvariant();
            r.Kind = path.EndsWith(".m3u8") ? "hls" : (path.EndsWith(".mpd") ? "dash" : "file");
        }
        r.Mode = Str(msg, "mode").ToLowerInvariant();
        if (r.Mode.Length == 0) r.Mode = Bool(msg, "audioOnly") ? "audio" : "video";
        if (r.Mode != "video" && r.Mode != "audio") throw new JobException("bad_request", "Unsupported mode: " + r.Mode);

        r.Title = Clean(Str(msg, "title"), 300);
        r.FileName = Clean(Str(msg, "filename"), 300);
        r.Referer = HeaderValue(Str(msg, "referer"), "referer");
        r.UserAgent = HeaderValue(Str(msg, "userAgent"), "user agent");
        r.Cookie = HeaderValue(Str(msg, "cookie"), "cookie");
        r.Origin = HeaderValue(Str(msg, "origin"), "origin");
        if (r.Referer.Length > 0) RequireHttp(r.Referer, "referer");
        if (r.Origin.Length > 0) RequireHttp(r.Origin, "origin");
        r.SaveAs = Bool(msg, "saveAs");
        r.Duration = Dbl(msg, "durationSeconds");
        r.OutputDir = Str(msg, "outputDirectory");
        if (r.OutputDir.Length > 0)
        {
            if (!Regex.IsMatch(r.OutputDir, @"^[A-Za-z]:\\")) throw new JobException("bad_request", "Output directory must be an absolute local path.");
            if (r.OutputDir.IndexOfAny(Path.GetInvalidPathChars()) >= 0) throw new JobException("bad_request", "Output directory contains invalid characters.");
        }
        return r;
    }

    static void RequireHttp(string url, string what)
    {
        Uri u;
        if (url.Length == 0 || url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out u) ||
            (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps))
            throw new JobException("bad_url", "Only http: and https: " + what + "s are supported.");
    }

    static string HeaderValue(string v, string what)
    {
        if (v.Length == 0) return "";
        if (v.Length > 8192 || v.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
            throw new JobException("bad_request", "Invalid " + what + " header value.");
        return v;
    }

    static string Clean(string s, int max)
    {
        s = Regex.Replace(s ?? "", @"[\u0000-\u001F\u007F]", " ").Trim();
        return s.Length > max ? s.Substring(0, max) : s;
    }

    // ------------------------------------------------------------------ downloading

    static void RunDownload(Dictionary<string, object> msg)
    {
        string jobId = Str(msg, "jobId");
        Request req = null;
        Job job = null;
        bool gotSlot = false;
        try
        {
            req = ParseRequest(msg);
            jobId = req.JobId;
            job = new Job { Id = jobId };
            lock (Jobs)
            {
                if (Jobs.ContainsKey(jobId)) throw new JobException("bad_request", "Job id already in use.");
                Jobs[jobId] = job;
            }
            Log("Job " + jobId + " " + req.Kind + "/" + req.Mode + " " + Redact(req.Url));
            Send(Msg("started", jobId));

            if (!Slots.Wait(0))
            {
                Progress(jobId, null, "Queued — waiting for another download to finish…");
                while (!Slots.Wait(500)) { if (job.CancelRequested) throw new JobException("cancelled", "Download cancelled."); }
            }
            gotSlot = true;
            if (job.CancelRequested) throw new JobException("cancelled", "Download cancelled.");

            ResolveFfmpeg();
            if (FfmpegVersionLine.Length == 0)
                throw new JobException("ffmpeg_missing", "FFmpeg was not found. Re-run companion\\Install-Companion.cmd.");

            StreamInfo info = new StreamInfo();
            if (req.Kind == "hls" || req.Kind == "dash")
            {
                Progress(jobId, null, "Inspecting stream…");
                info = Preflight(req);
                if (info.Drm != null)
                    throw new JobException("drm", "This stream is protected (" + info.Drm + "). MediaGrab does not decrypt DRM or other protected media, so it cannot be downloaded.");
            }
            double duration = info.Duration > 0 ? info.Duration : req.Duration;
            if (info.Live) duration = 0;
            req.Live = info.Live;

            string output = ResolveOutput(req);
            Download(job, req, output, duration, info.Live);
        }
        catch (JobException je)
        {
            Log("Job " + jobId + " failed [" + je.Code + "]: " + je.Message);
            SendError(jobId, "", je.Code, je.Message);
        }
        catch (Exception ex)
        {
            Log("Job " + jobId + " crashed: " + ex);
            SendError(jobId, "", "internal", ex.Message);
        }
        finally
        {
            if (gotSlot) Slots.Release();
            if (job != null) lock (Jobs) { Jobs.Remove(jobId); }
        }
    }

    static void Progress(string jobId, double? percent, string status, double? speed = null, long? bytes = null)
    {
        Dictionary<string, object> d = Msg("progress", jobId);
        d["percent"] = percent.HasValue ? (object)Math.Round(percent.Value, 1) : null;
        d["status"] = status;
        if (speed.HasValue) d["speed"] = Math.Round(speed.Value);     // bytes per second
        if (bytes.HasValue) d["bytes"] = bytes.Value;
        Send(d);
    }

    static string DefaultOutputDir() { return Path.Combine(DownloadsFolder(), "MediaGrab"); }

    [DllImport("shell32.dll")]
    static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

    static string DownloadsFolder()
    {
        try
        {
            IntPtr p;
            if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, IntPtr.Zero, out p) == 0)
            {
                string s = Marshal.PtrToStringUni(p);
                Marshal.FreeCoTaskMem(p);
                if (!String.IsNullOrEmpty(s)) return s;
            }
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    // Decides the final path (Save As dialog if requested) and reserves it so concurrent jobs can't collide.
    static string ResolveOutput(Request req)
    {
        string hint = req.FileName.Length > 0 ? req.FileName : req.Title;
        string stem = StemOf(hint);
        string ext = req.AudioOnly ? ".mp3" : ".mp4";
        string dir = req.OutputDir.Length > 0 ? req.OutputDir : DefaultOutputDir();

        if (req.SaveAs)
        {
            string chosen = ShowSaveDialog(Directory.Exists(DownloadsFolder()) ? DownloadsFolder() : dir, stem + ext, req.AudioOnly);
            if (chosen == null) throw new JobException("cancelled", "Download cancelled.");
            string cext = Path.GetExtension(chosen).ToLowerInvariant();
            bool ok = req.AudioOnly ? cext == ".mp3" : (cext == ".mp4" || cext == ".mkv");
            if (!ok) chosen = Path.ChangeExtension(chosen, ext);
            Directory.CreateDirectory(Path.GetDirectoryName(chosen));
            lock (PathLock) { ReservedPaths.Add(chosen); }
            return chosen;
        }
        Directory.CreateDirectory(dir);
        SweepStaleTemp(dir);
        return ReserveUnique(dir, stem, ext);
    }

    static string ReserveUnique(string dir, string stem, string ext)
    {
        int room = 240 - Path.GetFullPath(dir).Length - 1 - ext.Length - ".part".Length - " (9999)".Length;
        if (room < 16) throw new JobException("io", "The output folder path is too long. Choose a shorter folder.");
        if (stem.Length > room) stem = stem.Substring(0, room).TrimEnd(' ', '.');
        lock (PathLock)
        {
            for (int i = 0; i < 10000; i++)
            {
                string name = i == 0 ? stem + ext : stem + " (" + i + ")" + ext;
                string path = Path.Combine(dir, name);
                if (!File.Exists(path) && !ReservedPaths.Contains(path))
                {
                    ReservedPaths.Add(path);
                    return path;
                }
            }
        }
        throw new JobException("io", "Could not find a free file name in " + dir);
    }

    static void Unreserve(string path) { lock (PathLock) { ReservedPaths.Remove(path); } }

    // Sanitized name without a trailing media extension. Only known extensions are stripped, so "Title v1.2" stays intact.
    public static string StemOf(string hint)
    {
        string s = SanitizeFileName(hint);
        s = Regex.Replace(s, @"\.(mp4|mkv|mp3|m4a|m4v|webm|mov|ts|aac|ogg|opus|wav|flac|m3u8|mpd)$", "", RegexOptions.IgnoreCase);
        return SanitizeFileName(s);
    }

    public static string SanitizeFileName(string s)
    {
        s = Regex.Replace(s ?? "", "[<>:\"/\\\\|?*\\u0000-\\u001F\\u007F]", " ");
        s = Regex.Replace(s, @"\s+", " ").Trim();
        if (s.Length > 150) s = s.Substring(0, 150);
        s = s.TrimEnd(' ', '.').TrimStart('.').Trim();
        if (s.Length == 0) s = "media";
        if (Regex.IsMatch(s.Split('.')[0], "^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", RegexOptions.IgnoreCase)) s = "_" + s;
        return s;
    }

    static string ShowSaveDialog(string initialDir, string fileName, bool audio)
    {
        string result = null;
        Thread t = new Thread(delegate()
        {
            try
            {
                using (Form owner = new Form())
                {
                    owner.TopMost = true;
                    owner.ShowInTaskbar = false;
                    owner.FormBorderStyle = FormBorderStyle.None;
                    owner.StartPosition = FormStartPosition.Manual;
                    owner.SetBounds(-32000, -32000, 1, 1);
                    owner.Show();
                    owner.Activate();
                    using (SaveFileDialog dlg = new SaveFileDialog())
                    {
                        dlg.Title = audio ? "Save MediaGrab audio" : "Save MediaGrab video";
                        dlg.Filter = audio ? "MP3 audio (*.mp3)|*.mp3" : "MP4 video (*.mp4)|*.mp4|Matroska video (*.mkv)|*.mkv";
                        dlg.FileName = fileName;
                        dlg.InitialDirectory = initialDir;
                        dlg.OverwritePrompt = true;
                        if (dlg.ShowDialog(owner) == DialogResult.OK) result = dlg.FileName;
                    }
                }
            }
            catch (Exception ex) { Log("Save dialog failed: " + ex.Message); }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return result;
    }

    // ------------------------------------------------------------------ stream inspection (DRM / live / duration)

    static StreamInfo Preflight(Request req)
    {
        StreamInfo info = new StreamInfo();
        string finalUrl;
        string text = FetchText(req.Url, req, out finalUrl);

        if (req.Kind == "dash")
        {
            if (!Regex.IsMatch(text, @"<MPD[\s>]", RegexOptions.IgnoreCase))
                throw new JobException("not_manifest", "The URL did not return a DASH manifest (the link may have expired or need a login).");
            Match cp = Regex.Match(text, "<ContentProtection\\b[^>]*?schemeIdUri\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
            if (cp.Success) info.Drm = "DASH ContentProtection " + cp.Groups[1].Value;
            else if (Regex.IsMatch(text, "<ContentProtection\\b", RegexOptions.IgnoreCase)) info.Drm = "DASH ContentProtection";
            info.Live = Regex.IsMatch(text, "<MPD\\b[^>]*\\btype\\s*=\\s*\"dynamic\"", RegexOptions.IgnoreCase);
            Match d = Regex.Match(text, "mediaPresentationDuration\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
            if (d.Success) info.Duration = IsoDuration(d.Groups[1].Value);
            return info;
        }

        if (!text.TrimStart('\uFEFF', ' ', '\r', '\n').StartsWith("#EXTM3U"))
            throw new JobException("not_manifest", "The URL did not return an HLS playlist (the link may have expired or need a login).");

        info.Drm = HlsKeyProblem(text);
        if (text.IndexOf("#EXT-X-STREAM-INF", StringComparison.Ordinal) >= 0)
        {
            // Master playlist: inspect the best variant for keys / duration / live.
            string variant = BestVariantUrl(text, finalUrl);
            if (variant != null)
            {
                string vfinal;
                string vtext = FetchText(variant, req, out vfinal);
                if (info.Drm == null) info.Drm = HlsKeyProblem(vtext);
                FillHlsMedia(info, vtext);
            }
        }
        else FillHlsMedia(info, text);
        return info;
    }

    static void FillHlsMedia(StreamInfo info, string text)
    {
        double total = 0;
        foreach (Match m in Regex.Matches(text, @"#EXTINF:([0-9.]+)"))
        {
            double v;
            if (Double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) total += v;
        }
        info.Duration = total;
        bool endlist = text.IndexOf("#EXT-X-ENDLIST", StringComparison.Ordinal) >= 0;
        bool vod = Regex.IsMatch(text, @"#EXT-X-PLAYLIST-TYPE:\s*VOD");
        info.Live = !endlist && !vod;
    }

    // AES-128 with an openly fetchable key is ordinary HLS and left to FFmpeg; anything else
    // (SAMPLE-AES, FairPlay/Widevine/PlayReady key formats) is DRM and refused.
    static string HlsKeyProblem(string text)
    {
        foreach (Match m in Regex.Matches(text, @"#EXT-X-(?:SESSION-)?KEY:([^\r\n]*)"))
        {
            string attrs = m.Groups[1].Value;
            Match method = Regex.Match(attrs, @"METHOD=([A-Za-z0-9-]+)");
            string meth = method.Success ? method.Groups[1].Value.ToUpperInvariant() : "NONE";
            if (meth == "NONE") continue;
            Match fmt = Regex.Match(attrs, "KEYFORMAT=\"([^\"]*)\"");
            string kf = fmt.Success ? fmt.Groups[1].Value : "identity";
            if (meth == "AES-128" && kf.Equals("identity", StringComparison.OrdinalIgnoreCase)) continue;
            return "HLS " + meth + (kf.Equals("identity", StringComparison.OrdinalIgnoreCase) ? "" : " / " + kf);
        }
        return null;
    }

    static string BestVariantUrl(string master, string baseUrl)
    {
        string audio;
        return PickVariant(master, baseUrl, out audio);
    }

    static string AttrValue(string line, string name)
    {
        Match m = Regex.Match(line, "(?:^|[:,])" + name + "=(?:\"([^\"]*)\"|([^,]*))");
        if (!m.Success) return "";
        return m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
    }

    // YouTube's YT-EXT-XTAGS: base64(url-safe) protobuf; we only need its readable text ("acont" -> original / dubbed-auto ...).
    static string DecodeXtags(string v)
    {
        if (String.IsNullOrEmpty(v)) return "";
        try
        {
            string b = v.Replace('-', '+').Replace('_', '/');
            while (b.Length % 4 != 0) b += "=";
            byte[] raw = Convert.FromBase64String(b);
            StringBuilder sb = new StringBuilder();
            foreach (byte x in raw) sb.Append(x >= 32 && x < 127 ? (char)x : ' ');
            return sb.ToString();
        }
        catch { return ""; }
    }

    static string ResolveHttp(Uri baseUri, string rel)
    {
        Uri u;
        if (Uri.TryCreate(baseUri, rel, out u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps)) return u.AbsoluteUri;
        return null;
    }

    // Highest-bandwidth variant of a master playlist, plus the default audio rendition of its audio group (if separate).
    static string PickVariant(string master, string baseUrl, out string audioUrl)
    {
        audioUrl = null;
        string[] lines = master.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        long bestBw = -1;
        string best = null, bestGroup = "";
        for (int i = 0; i < lines.Length; i++)
        {
            string l = lines[i].Trim();
            if (!l.StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal)) continue;
            long b;
            if (!Int64.TryParse(AttrValue(l, "BANDWIDTH"), out b)) b = 0;
            for (int j = i + 1; j < lines.Length; j++)
            {
                string u = lines[j].Trim();
                if (u.Length == 0 || u.StartsWith("#")) continue;
                if (b > bestBw)
                {
                    string abs = ResolveHttp(new Uri(baseUrl), u);
                    if (abs != null) { best = abs; bestBw = b; bestGroup = AttrValue(l, "AUDIO"); }
                }
                break;
            }
        }
        if (best != null && bestGroup.Length > 0)
        {
            // Several audio tracks (original + dubs / descriptions) are common: prefer the original, then the default,
            // and avoid dubbed / described / commentary tracks. Ties keep playlist order.
            int bestScore = Int32.MinValue;
            foreach (string raw in lines)
            {
                string l = raw.Trim();
                if (!l.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal)) continue;
                if (AttrValue(l, "TYPE") != "AUDIO" || AttrValue(l, "GROUP-ID") != bestGroup) continue;
                string uri = AttrValue(l, "URI");
                if (uri.Length == 0) continue;
                string abs = ResolveHttp(new Uri(baseUrl), uri);
                if (abs == null) continue;
                string label = (AttrValue(l, "NAME") + " " + AttrValue(l, "LANGUAGE") + " " + DecodeXtags(AttrValue(l, "YT-EXT-XTAGS"))).ToLowerInvariant();
                int score = 0;
                if (label.Contains("original")) score += 100;
                if (AttrValue(l, "DEFAULT") == "YES") score += 50;
                if (AttrValue(l, "AUTOSELECT") == "YES") score += 5;
                if (label.Contains("secondary")) score -= 50;
                if (Regex.IsMatch(label, "dub|descript|commentary|translated") || AttrValue(l, "CHARACTERISTICS").ToLowerInvariant().Contains("describes-video")) score -= 200;
                if (score > bestScore) { bestScore = score; audioUrl = abs; }
            }
        }
        return best;
    }

    static double IsoDuration(string s)
    {
        Match m = Regex.Match(s, @"^P(?:([0-9.]+)D)?(?:T(?:([0-9.]+)H)?(?:([0-9.]+)M)?(?:([0-9.]+)S)?)?$");
        if (!m.Success) return 0;
        double[] mul = { 86400, 3600, 60, 1 };
        double total = 0;
        for (int i = 0; i < 4; i++)
        {
            double v;
            if (m.Groups[i + 1].Success && Double.TryParse(m.Groups[i + 1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) total += v * mul[i];
        }
        return total;
    }

    static string FetchText(string url, Request r, out string finalUrl)
    {
        HttpWebRequest hr = (HttpWebRequest)WebRequest.Create(url);
        hr.Method = "GET";
        hr.AllowAutoRedirect = true;
        hr.MaximumAutomaticRedirections = 8;
        hr.Timeout = 20000;
        hr.ReadWriteTimeout = 20000;
        hr.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
        hr.UserAgent = r.UserAgent.Length > 0 ? r.UserAgent : DefaultUserAgent;
        if (r.Referer.Length > 0) hr.Referer = r.Referer;
        if (r.Origin.Length > 0) hr.Headers["Origin"] = r.Origin;
        if (r.Cookie.Length > 0)
        {
            // Container scopes the cookies to the manifest host; they are not replayed to other hosts on redirect.
            hr.CookieContainer = new CookieContainer();
            string host = new Uri(url).Host;
            foreach (string pair in r.Cookie.Split(';'))
            {
                int eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                try { hr.CookieContainer.Add(new Cookie(pair.Substring(0, eq).Trim(), pair.Substring(eq + 1).Trim(), "/", host)); } catch { }
            }
        }
        try
        {
            using (HttpWebResponse resp = (HttpWebResponse)hr.GetResponse())
            {
                finalUrl = resp.ResponseUri.AbsoluteUri;
                using (Stream rs = resp.GetResponseStream())
                {
                    byte[] buf = new byte[16384];
                    MemoryStream ms = new MemoryStream();
                    int n;
                    while ((n = rs.Read(buf, 0, buf.Length)) > 0)
                    {
                        ms.Write(buf, 0, n);
                        if (ms.Length > 8 * 1024 * 1024) throw new JobException("not_manifest", "The manifest is unexpectedly large.");
                    }
                    return Encoding.UTF8.GetString(ms.ToArray());
                }
            }
        }
        catch (WebException we)
        {
            HttpWebResponse er = we.Response as HttpWebResponse;
            if (er != null)
            {
                int code = (int)er.StatusCode;
                if (code == 401 || code == 403)
                    throw new JobException("http_" + code, "The server refused access (HTTP " + code + "). The link may have expired, or it needs a login/cookies that the browser did not share.");
                if (code == 404 || code == 410)
                    throw new JobException("http_" + code, "The stream was not found (HTTP " + code + "). The link has probably expired.");
                throw new JobException("http_" + code, "The server answered HTTP " + code + " for the stream manifest.");
            }
            throw new JobException("network", "Could not reach the stream: " + we.Message);
        }
    }

    // ------------------------------------------------------------------ ffmpeg

    // Windows command-line quoting (CommandLineToArgvW rules). Arguments are always built as a list.
    public static string QuoteArg(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        StringBuilder sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') bs++;
            else if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
            else { sb.Append('\\', bs); bs = 0; sb.Append(c); }
        }
        sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }

    public static string JoinArgs(List<string> args)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string a in args) { if (sb.Length > 0) sb.Append(' '); sb.Append(QuoteArg(a)); }
        return sb.ToString();
    }

    static void AddInputOptions(List<string> a, Request r, string inputUrl, bool hls)
    {
        if (r.LocalInputs)
        {
            // Everything (segments, init sections, AES key) is already on disk: merge with NO network access at all.
            a.Add("-protocol_whitelist"); a.Add("file,crypto");
            a.Add("-allowed_extensions"); a.Add("ALL");
            a.Add("-i"); a.Add(inputUrl);
            return;
        }
        a.Add("-protocol_whitelist"); a.Add("http,https,tcp,tls,crypto");
        if (hls) { a.Add("-allowed_extensions"); a.Add("ALL"); }
        a.Add("-rw_timeout"); a.Add("30000000");
        a.Add("-user_agent"); a.Add(r.UserAgent.Length > 0 ? r.UserAgent : DefaultUserAgent);
        if (r.Referer.Length > 0) { a.Add("-referer"); a.Add(r.Referer); }
        if (r.Origin.Length > 0) { a.Add("-headers"); a.Add("Origin: " + r.Origin + "\r\n"); }
        if (r.Cookie.Length > 0)
        {
            // -cookies is domain scoped, unlike -headers which would leak the cookie to every host in the playlist.
            // FFmpeg compares the cookie domain with "host[:port]" exactly as written in the URL, so scope to that.
            string cookieUrl = r.CookieUrl.Length > 0 ? r.CookieUrl : inputUrl;
            Match auth = Regex.Match(cookieUrl, @"^https?://(?:[^/?#@]*@)?([^/?#]+)", RegexOptions.IgnoreCase);
            string host = auth.Success ? auth.Groups[1].Value : new Uri(cookieUrl).Host;
            List<string> lines = new List<string>();
            foreach (string pair in r.Cookie.Split(';'))
            {
                string p = pair.Trim();
                if (p.IndexOf('=') > 0) lines.Add(p + "; path=/; domain=" + host);
            }
            if (lines.Count > 0) { a.Add("-cookies"); a.Add(String.Join("\n", lines.ToArray()) + "\n"); }
        }
        a.Add("-i"); a.Add(inputUrl);
    }

    public static List<string> BuildFfmpegArgs(Request r, string partPath, string container)
    {
        List<string> a = new List<string>();
        a.AddRange(new[] { "-hide_banner", "-loglevel", "error", "-y", "-nostats" });
        bool hls = r.Kind == "hls";
        AddInputOptions(a, r, r.Url, hls);
        bool second = r.AudioUrl.Length > 0 && !r.AudioOnly;
        if (second) AddInputOptions(a, r, r.AudioUrl, hls);

        if (r.AudioOnly)
        {
            a.AddRange(new[] { "-vn", "-sn", "-dn", "-c:a", "libmp3lame", "-q:a", "2", "-id3v2_version", "3" });
            if (r.Title.Length > 0) { a.Add("-metadata"); a.Add("title=" + r.Title); }
            a.Add("-f"); a.Add("mp3");
        }
        else
        {
            if (second) a.AddRange(new[] { "-map", "0:v:0", "-map", "1:a:0" });
            a.AddRange(new[] { "-sn", "-dn", "-c", "copy" });
            if (container == "mpegts") a.AddRange(new[] { "-f", "mpegts", "-flush_packets", "1" }); // live capture: always valid on disk
            else if (container == "matroska") a.AddRange(new[] { "-f", "matroska" });
            else a.AddRange(new[] { "-f", "mp4", "-movflags", "+faststart" });
        }
        a.AddRange(new[] { "-progress", "pipe:1" });
        a.Add(partPath);
        return a;
    }

    static void Download(Job job, Request orig, string finalPath, double duration, bool live)
    {
        if (live && !orig.AudioOnly) { DownloadLive(job, orig, finalPath); return; }
        Request req = orig;
        string tmpDir = null;
        try
        {
            if (orig.Kind == "hls" && !live)
            {
                tmpDir = Path.Combine(Path.GetDirectoryName(finalPath), "mg-" + job.Id.Substring(0, Math.Min(8, job.Id.Length)));
                Progress(job.Id, null, "Downloading segments in parallel…");
                Request local = null;
                try { local = PrepareLocalHls(job, orig, tmpDir); }
                catch (JobException) { Unreserve(finalPath); throw; }
                if (local != null) { req = local; job.PctBase = 90; job.Merging = true; }
                else { Log("Parallel HLS not applicable; using sequential FFmpeg download."); TryDeleteDir(tmpDir); tmpDir = null; }
            }
            DownloadWithFfmpeg(job, req, finalPath, duration, live);
        }
        finally { if (tmpDir != null) TryDeleteDir(tmpDir); }
    }

    // Segment folders of jobs that died with the host (crash / hard kill) are removed after a day.
    static void SweepStaleTemp(string dir)
    {
        try
        {
            foreach (string d in Directory.GetDirectories(dir, "mg-*"))
                if (Regex.IsMatch(Path.GetFileName(d), "^mg-[A-Za-z0-9_-]{1,8}$") && (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(d)).TotalHours > 24)
                    TryDeleteDir(d);
        }
        catch { }
    }

    static void TryDeleteDir(string dir) { try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { } }

    // ------------------------------------------------------------------ parallel HLS segment download

    // Downloads every segment of the chosen variant (and audio rendition) over several connections into a temp folder and
    // writes local copies of the playlists. Returns a Request whose inputs are those local playlists, or null when the
    // playlist needs features we leave to FFmpeg itself (byte ranges, SAMPLE-AES, live, ...).
    static Request PrepareLocalHls(Job job, Request req, string workDir)
    {
        string finalUrl;
        string videoUrl = req.Url, audioUrl = req.AudioUrl;
        string text = FetchText(req.Url, req, out finalUrl);
        if (text.IndexOf("#EXT-X-STREAM-INF", StringComparison.Ordinal) >= 0)
        {
            string a;
            videoUrl = PickVariant(text, finalUrl, out a);
            if (videoUrl == null) return null;
            if (audioUrl.Length == 0 && a != null) audioUrl = a;
        }
        Directory.CreateDirectory(workDir);
        LocalTrack v = null, au = null;
        if (!(req.AudioOnly && audioUrl.Length > 0))
        {
            v = BuildLocalTrack(videoUrl, req, workDir, "v");
            if (v == null) return null;
        }
        if (audioUrl.Length > 0)
        {
            au = BuildLocalTrack(audioUrl, req, workDir, "a");
            if (au == null) return null;
        }
        List<SegItem> all = new List<SegItem>();
        if (v != null) all.AddRange(v.Items);
        if (au != null) all.AddRange(au.Items);
        Log("Parallel HLS: " + all.Count + " files, " + Math.Min(Connections, all.Count) + " connections");
        DownloadSegments(job, req, all, workDir);

        Request lr = new Request();
        lr.JobId = req.JobId; lr.Kind = "hls"; lr.Mode = req.Mode; lr.Title = req.Title; lr.FileName = req.FileName;
        lr.Referer = req.Referer; lr.UserAgent = req.UserAgent; lr.Cookie = req.Cookie; lr.Origin = req.Origin;
        lr.OutputDir = req.OutputDir; lr.SaveAs = req.SaveAs; lr.Live = false; lr.Duration = req.Duration;
        lr.LocalInputs = true;
        lr.CookieUrl = req.Url;
        if (req.AudioOnly) { lr.Url = (au != null ? au : v).PlaylistPath.Replace('\\', '/'); lr.AudioUrl = ""; }
        else { lr.Url = v.PlaylistPath.Replace('\\', '/'); lr.AudioUrl = au != null ? au.PlaylistPath.Replace('\\', '/') : ""; }
        return lr;
    }

    static string SegmentExtension(string absUrl)
    {
        string ext = "";
        try { ext = Path.GetExtension(new Uri(absUrl).AbsolutePath).ToLowerInvariant(); } catch { }
        return Regex.IsMatch(ext, @"^\.[a-z0-9]{2,5}$") ? ext : ".ts";
    }

    static LocalTrack BuildLocalTrack(string playlistUrl, Request req, string workDir, string prefix)
    {
        string baseUrl;
        string text = FetchText(playlistUrl, req, out baseUrl);
        if (!text.TrimStart('\uFEFF', ' ', '\r', '\n').StartsWith("#EXTM3U", StringComparison.Ordinal)) return null;
        Uri baseUri = new Uri(baseUrl);
        LocalTrack t = new LocalTrack();
        Dictionary<string, string> seen = new Dictionary<string, string>();
        List<string> outLines = new List<string>();
        bool endlist = false;
        int idx = 0;
        foreach (string raw in text.Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith("#", StringComparison.Ordinal))
            {
                if (line.StartsWith("#EXT-X-BYTERANGE", StringComparison.Ordinal) || line.StartsWith("#EXT-X-I-FRAMES-ONLY", StringComparison.Ordinal) ||
                    line.StartsWith("#EXT-X-STREAM-INF", StringComparison.Ordinal) || line.StartsWith("#EXT-X-PART", StringComparison.Ordinal) ||
                    line.StartsWith("#EXT-X-PRELOAD-HINT", StringComparison.Ordinal) || line.StartsWith("#EXT-X-DEFINE", StringComparison.Ordinal))
                    return null;
                if (line.StartsWith("#EXT-X-ENDLIST", StringComparison.Ordinal)) endlist = true;
                if (line.StartsWith("#EXT-X-MAP:", StringComparison.Ordinal))
                {
                    if (AttrValue(line, "BYTERANGE").Length > 0) return null;
                    string abs = ResolveHttp(baseUri, AttrValue(line, "URI"));
                    if (abs == null) return null;
                    string local;
                    if (!seen.TryGetValue(abs, out local))
                    {
                        local = prefix + "init" + (idx++).ToString("D3") + SegmentExtension(abs);
                        seen[abs] = local;
                        t.Items.Add(new SegItem { Url = abs, Local = local });
                    }
                    string repl = local;
                    line = Regex.Replace(line, "URI=\"[^\"]*\"", delegate(Match m) { return "URI=\"" + repl + "\""; });
                }
                else if (line.StartsWith("#EXT-X-KEY:", StringComparison.Ordinal))
                {
                    string method = AttrValue(line, "METHOD").ToUpperInvariant();
                    if (method != "NONE")
                    {
                        string kf = AttrValue(line, "KEYFORMAT");
                        if (method != "AES-128" || (kf.Length > 0 && !kf.Equals("identity", StringComparison.OrdinalIgnoreCase))) return null;
                        string keyAbs = ResolveHttp(baseUri, AttrValue(line, "URI"));
                        if (keyAbs == null) return null;
                        // fetch the (openly served) key with the same headers, then reference the local copy
                        string keyLocal;
                        if (!seen.TryGetValue(keyAbs, out keyLocal))
                        {
                            keyLocal = prefix + "key" + (idx++).ToString("D3") + ".key";
                            seen[keyAbs] = keyLocal;
                            t.Items.Add(new SegItem { Url = keyAbs, Local = keyLocal });
                        }
                        string keyRepl = keyLocal;
                        line = Regex.Replace(line, "URI=\"[^\"]*\"", delegate(Match m) { return "URI=\"" + keyRepl + "\""; });
                    }
                }
                outLines.Add(line);
                continue;
            }
            string segAbs = ResolveHttp(baseUri, line);
            if (segAbs == null) return null;
            string segLocal;
            if (!seen.TryGetValue(segAbs, out segLocal))
            {
                segLocal = prefix + (idx++).ToString("D5") + SegmentExtension(segAbs);
                seen[segAbs] = segLocal;
                t.Items.Add(new SegItem { Url = segAbs, Local = segLocal });
            }
            outLines.Add(segLocal);
        }
        if (!endlist || t.Items.Count == 0) return null;   // live / empty playlists stay with FFmpeg
        t.PlaylistPath = Path.Combine(workDir, prefix + ".m3u8");
        File.WriteAllText(t.PlaylistPath, String.Join("\n", outLines.ToArray()) + "\n", new UTF8Encoding(false));
        return t;
    }

    static void DownloadSegments(Job job, Request req, List<SegItem> items, string workDir)
    {
        int conns = Math.Max(1, Math.Min(Connections, items.Count));
        DlState st = new DlState();
        string host = new Uri(req.Url).Host;
        Thread[] ts = new Thread[conns];
        for (int i = 0; i < conns; i++)
        {
            ts[i] = new Thread(delegate() { SegmentWorker(st, items, req, workDir, host); });
            ts[i].IsBackground = true;
            ts[i].Start();
        }
        DateTime last = DateTime.UtcNow;
        long lastBytes = 0;
        double speed = 0;
        int total = items.Count;
        while (true)
        {
            Thread.Sleep(300);
            int done = Thread.VolatileRead(ref st.Done);
            long bytes = Interlocked.Read(ref st.Bytes);
            DateTime now = DateTime.UtcNow;
            double dt = (now - last).TotalSeconds;
            if (dt > 0)
            {
                double inst = (bytes - lastBytes) / dt;
                speed = speed <= 0 ? inst : speed * 0.7 + inst * 0.3;   // smoothed
                last = now; lastBytes = bytes;
            }
            if (job.CancelRequested) st.Stop = true;
            if (st.Error != null || st.Stop || done >= total) break;
            Progress(job.Id, 1 + 89.0 * done / total, "Downloading segments " + done + "/" + total, speed, bytes);
        }
        foreach (Thread t in ts) t.Join(15000);
        if (job.CancelRequested) throw new JobException("cancelled", "Download cancelled.");
        if (st.Error != null)
        {
            JobException je = st.Error as JobException;
            if (je != null) throw je;
            throw new JobException("network", "Network error while downloading segments: " + st.Error.Message);
        }
        Progress(job.Id, 90, "Merging…", 0, Interlocked.Read(ref st.Bytes));
    }

    static void SegmentWorker(DlState st, List<SegItem> items, Request req, string workDir, string manifestHost)
    {
        try
        {
            while (!st.Stop)
            {
                int i = Interlocked.Increment(ref st.Next);
                if (i >= items.Count) return;
                FetchSegment(st, items[i].Url, Path.Combine(workDir, items[i].Local), req, manifestHost);
                Interlocked.Increment(ref st.Done);
            }
        }
        catch (Exception ex)
        {
            if (!(ex is OperationCanceledException)) lock (st.Sync) { if (st.Error == null) st.Error = ex; }
            st.Stop = true;
        }
    }

    static void FetchSegment(DlState st, string url, string dest, Request req, string manifestHost)
    {
        Exception last = null;
        for (int attempt = 0; attempt < 4 && !st.Stop; attempt++)
        {
            long[] counted = new long[1];
            try { GetToFile(st, url, dest, req, manifestHost, counted); return; }
            catch (OperationCanceledException) { throw; }
            catch (JobException) { throw; }
            catch (Exception ex)
            {
                Interlocked.Add(ref st.Bytes, -counted[0]);
                last = ex;
                WebException we = ex as WebException;
                HttpWebResponse er = we != null ? we.Response as HttpWebResponse : null;
                if (er != null)
                {
                    int code = (int)er.StatusCode;
                    if (code == 401 || code == 403) throw new JobException("http_" + code, "The server refused access (HTTP " + code + "). The link may have expired, or it needs a login/cookies/referer that the browser did not share.");
                    if (code == 404 || code == 410) throw new JobException("http_" + code, "A stream segment was not found (HTTP " + code + "). The link has probably expired.");
                }
                Thread.Sleep(250 * (attempt + 1));
            }
        }
        if (st.Stop) throw new OperationCanceledException();
        throw last ?? new IOException("segment download failed");
    }

    static void GetToFile(DlState st, string url, string dest, Request req, string manifestHost, long[] counted)
    {
        string cur = url;
        for (int hop = 0; hop < 6; hop++)
        {
            Uri cu = new Uri(cur);
            if (cu.Scheme != Uri.UriSchemeHttp && cu.Scheme != Uri.UriSchemeHttps) throw new JobException("bad_url", "A segment redirected to a non-http URL.");
            HttpWebRequest hr = (HttpWebRequest)WebRequest.Create(cur);
            hr.AllowAutoRedirect = false;
            hr.Timeout = 30000;
            hr.ReadWriteTimeout = 30000;
            hr.KeepAlive = true;
            hr.UserAgent = req.UserAgent.Length > 0 ? req.UserAgent : DefaultUserAgent;
            if (req.Referer.Length > 0) hr.Referer = req.Referer;
            if (req.Origin.Length > 0) hr.Headers["Origin"] = req.Origin;
            // cookies only go to the manifest's own host (same rule as the FFmpeg path)
            if (req.Cookie.Length > 0 && cu.Host.Equals(manifestHost, StringComparison.OrdinalIgnoreCase)) hr.Headers[HttpRequestHeader.Cookie] = req.Cookie;
            using (HttpWebResponse resp = (HttpWebResponse)hr.GetResponse())
            {
                int code = (int)resp.StatusCode;
                if (code >= 300 && code < 400)
                {
                    string loc = resp.Headers["Location"];
                    if (String.IsNullOrEmpty(loc)) throw new IOException("redirect without Location");
                    cur = new Uri(cu, loc).AbsoluteUri;
                    continue;
                }
                using (Stream rs = resp.GetResponseStream())
                using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.Read, 65536))
                {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = rs.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (st.Stop) throw new OperationCanceledException();
                        fs.Write(buf, 0, n);
                        Interlocked.Add(ref st.Bytes, n);
                        counted[0] += n;
                    }
                }
                if (resp.ContentLength > 0 && counted[0] != resp.ContentLength) throw new IOException("short read");
                return;
            }
        }
        throw new IOException("too many redirects");
    }

    static void DownloadWithFfmpeg(Job job, Request req, string finalPath, double duration, bool live)
    {
        string dir = Path.GetDirectoryName(finalPath);
        string stem = Path.GetFileNameWithoutExtension(finalPath);
        string curFinal = finalPath;
        string container = Path.GetExtension(finalPath).ToLowerInvariant() == ".mkv" ? "matroska" : "mp4";
        Progress(job.Id, null, live ? "Recording live stream…" : "Starting download…");

        for (int attempt = 0; attempt < 2; attempt++)
        {
            string part = curFinal + ".part";
            try { if (File.Exists(part)) File.Delete(part); } catch { }
            List<string> args = BuildFfmpegArgs(req, part, container);
            Log("ffmpeg " + JoinArgs(RedactArgs(args)));

            string tail;
            int exit = RunFfmpeg(job, args, duration, live, out tail);

            bool hasOutput = File.Exists(part) && new FileInfo(part).Length > 0;
            if (job.CancelRequested)
            {
                TryDelete(part); Unreserve(curFinal);
                throw new JobException("cancelled", "Download cancelled.");
            }
            if (exit == 0 || (job.StopRequested && hasOutput))
            {
                if (!hasOutput) { TryDelete(part); Unreserve(curFinal); throw new JobException("empty", "FFmpeg finished but produced no data."); }
                Progress(job.Id, 99, "Finalizing…");
                if (File.Exists(curFinal)) File.Delete(curFinal); // only reachable for a Save As the user confirmed overwriting
                File.Move(part, curFinal);
                Unreserve(curFinal);
                long size = new FileInfo(curFinal).Length;
                Log("Job " + job.Id + " completed: " + curFinal + " (" + size + " bytes)");
                Dictionary<string, object> d = Msg("completed", job.Id);
                d["file"] = curFinal;
                d["size"] = size;
                d["percent"] = 100;
                Send(d);
                return;
            }

            TryDelete(part);
            // Some DASH/WebM codecs cannot be stored in MP4; retry once as Matroska.
            if (attempt == 0 && !req.AudioOnly && container == "mp4" &&
                Regex.IsMatch(tail, "not currently supported in container|Could not write header|codec not supported|Tag .* incompatible", RegexOptions.IgnoreCase))
            {
                Unreserve(curFinal);
                curFinal = ReserveUnique(dir, stem, ".mkv");
                container = "matroska";
                Log("Retrying as Matroska: " + curFinal);
                Progress(job.Id, null, "Codec needs the MKV container; retrying…");
                continue;
            }
            Unreserve(curFinal);
            string code;
            string friendly = FriendlyFfmpegError(tail, exit, out code);
            throw new JobException(code, friendly);
        }
    }

    // Live streams run until the user presses Stop & save (or the stream ends). The capture is MPEG-TS flushed packet by
    // packet, so a forced stop still leaves a valid file; it is then remuxed (no re-encode) into the requested container.
    static void DownloadLive(Job job, Request req, string finalPath)
    {
        string capture = finalPath + ".capture.ts";
        TryDelete(capture);
        Progress(job.Id, null, "Recording live stream…");
        List<string> args = BuildFfmpegArgs(req, capture, "mpegts");
        Log("ffmpeg(live) " + JoinArgs(RedactArgs(args)));
        string tail;
        int exit = RunFfmpeg(job, args, 0, true, out tail);
        bool hasOutput = File.Exists(capture) && new FileInfo(capture).Length > 0;

        if (job.CancelRequested) { TryDelete(capture); Unreserve(finalPath); throw new JobException("cancelled", "Download cancelled."); }
        if (!(exit == 0 || (job.StopRequested && hasOutput)))
        {
            TryDelete(capture); Unreserve(finalPath);
            string code;
            string friendly = FriendlyFfmpegError(tail, exit, out code);
            throw new JobException(code, friendly);
        }
        if (!hasOutput) { TryDelete(capture); Unreserve(finalPath); throw new JobException("empty", "The live stream produced no data."); }

        Progress(job.Id, 99, "Finalizing…");
        string part = finalPath + ".part";
        TryDelete(part);
        bool mkv = Path.GetExtension(finalPath).ToLowerInvariant() == ".mkv";
        List<string> remux = new List<string> { "-hide_banner", "-loglevel", "error", "-y", "-nostdin", "-i", capture, "-sn", "-dn", "-c", "copy" };
        if (mkv) remux.AddRange(new[] { "-f", "matroska" }); else remux.AddRange(new[] { "-f", "mp4", "-movflags", "+faststart" });
        remux.Add(part);
        string rtail;
        int rexit = RunQuick(remux, out rtail);
        string result = finalPath;
        if (rexit == 0 && File.Exists(part) && new FileInfo(part).Length > 0)
        {
            if (File.Exists(finalPath)) File.Delete(finalPath);
            File.Move(part, finalPath);
            TryDelete(capture);
        }
        else
        {
            // Remux failed: keep the raw capture rather than lose the recording.
            Log("Remux failed (" + rexit + "): " + rtail);
            TryDelete(part);
            result = Path.ChangeExtension(finalPath, ".ts");
            if (File.Exists(result)) result = ReserveUnique(Path.GetDirectoryName(finalPath), Path.GetFileNameWithoutExtension(finalPath), ".ts");
            File.Move(capture, result);
        }
        Unreserve(finalPath);
        long size = new FileInfo(result).Length;
        Log("Job " + job.Id + " completed (live): " + result + " (" + size + " bytes)");
        Dictionary<string, object> d = Msg("completed", job.Id);
        d["file"] = result;
        d["size"] = size;
        d["percent"] = 100;
        Send(d);
    }

    static int RunQuick(List<string> args, out string errorTail)
    {
        ProcessStartInfo psi = new ProcessStartInfo(FfmpegPath, JoinArgs(args));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = InstallRoot;
        using (Process p = Process.Start(psi))
        {
            ChildReaper.Adopt(p);
            p.StandardInput.Close();
            string err = "";
            Thread te = new Thread(delegate() { try { err = p.StandardError.ReadToEnd(); } catch { } });
            te.Start();
            p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            te.Join(2000);
            errorTail = err.Trim();
            return p.ExitCode;
        }
    }

    static List<string> RedactArgs(List<string> args)
    {
        List<string> r = new List<string>(args);
        for (int i = 0; i < r.Count - 1; i++)
            if (r[i] == "-cookies" || r[i] == "-headers") r[i + 1] = "(redacted)";
        return r;
    }

    static int RunFfmpeg(Job job, List<string> args, double duration, bool live, out string errorTail)
    {
        ProcessStartInfo psi = new ProcessStartInfo(FfmpegPath, JoinArgs(args));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;   // never let ffmpeg read Firefox's pipe
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = InstallRoot;

        Queue<string> tailQ = new Queue<string>();
        object tailLock = new object();
        long outTimeUs = 0, totalSize = 0, lastSize = 0;
        DateTime lastSent = DateTime.MinValue;
        double lastPct = -1, speed = 0;

        using (Process p = new Process())
        {
            p.StartInfo = psi;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                string line = e.Data.Trim();
                int eq = line.IndexOf('=');
                if (eq <= 0) return;
                string k = line.Substring(0, eq), v = line.Substring(eq + 1);
                long n;
                if ((k == "out_time_us" || k == "out_time_ms") && Int64.TryParse(v, out n)) outTimeUs = n; // both are microseconds
                else if (k == "total_size" && Int64.TryParse(v, out n)) totalSize = n;
                else if (k == "progress")
                {
                    double secs = outTimeUs / 1000000.0;
                    double? pct = null;
                    string status;
                    if (duration > 0 && !live)
                    {
                        double frac = Math.Min(1.0, secs / duration);
                        pct = Math.Max(1, Math.Min(99, job.PctBase + (100.0 - job.PctBase) * frac));
                        status = (job.Merging ? "Merging… " : "Downloading… ") + Math.Round(pct.Value) + "%";
                    }
                    else status = (live ? "Recording " : "Downloaded ") + FormatClock(secs) + (totalSize > 0 ? " · " + FormatBytes(totalSize) : "");
                    DateTime now = DateTime.UtcNow;
                    bool changed = pct.HasValue ? Math.Abs(pct.Value - lastPct) >= 0.5 : true;
                    if (v != "end" && changed && (now - lastSent).TotalMilliseconds >= 500)
                    {
                        // network speed ~ bytes written per second in copy mode (not meaningful while merging local files)
                        double dt = lastSent == DateTime.MinValue ? 0 : (now - lastSent).TotalSeconds;
                        if (dt > 0 && !job.Merging)
                        {
                            double inst = Math.Max(0, (totalSize - lastSize) / dt);
                            speed = speed <= 0 ? inst : speed * 0.6 + inst * 0.4;
                        }
                        lastSize = totalSize;
                        lastSent = now;
                        if (pct.HasValue) lastPct = pct.Value;
                        Progress(job.Id, pct, status, (job.Merging || speed <= 0) ? (double?)null : speed, totalSize > 0 ? (long?)totalSize : null);
                    }
                }
            };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null || e.Data.Trim().Length == 0) return;
                lock (tailLock) { tailQ.Enqueue(e.Data.Trim()); while (tailQ.Count > 14) tailQ.Dequeue(); }
            };
            try { p.Start(); }
            catch (Exception ex) { errorTail = ex.Message; throw new JobException("ffmpeg_start", "Could not start FFmpeg (" + FfmpegPath + "): " + ex.Message); }
            if (!ChildReaper.Adopt(p)) MediaGrabHost.Log("Warning: could not add ffmpeg to the kill-on-close job object.");
            lock (job.Sync) { job.Proc = p; }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            if (job.CancelRequested) KillProc(job);
            p.WaitForExit();
            p.WaitForExit(); // second call waits for the async readers to drain
            lock (job.Sync) { job.Proc = null; }
            lock (tailLock) { errorTail = String.Join(" | ", tailQ.ToArray()); }
            return p.ExitCode;
        }
    }

    static void CancelJob(string jobId, bool save)
    {
        Job j;
        lock (Jobs) { Jobs.TryGetValue(jobId, out j); }
        if (j == null) { Log("Cancel for unknown job " + jobId); return; }
        if (save) j.StopRequested = true; else j.CancelRequested = true;
        lock (j.Sync)
        {
            if (j.Proc == null) return;
            try
            {
                if (save)
                {
                    // Graceful: 'q' makes ffmpeg finalize the file at its next packet. A live playlist that is waiting for
                    // new segments never reaches that point, so force-stop after a grace period (live output is Matroska).
                    Process target = j.Proc;
                    target.StandardInput.Write("q");
                    target.StandardInput.Flush();
                    ThreadPool.QueueUserWorkItem(delegate { try { if (!target.WaitForExit(6000)) target.Kill(); } catch { } });
                }
                else j.Proc.Kill();
            }
            catch (Exception ex) { Log("Cancel failed: " + ex.Message); }
        }
    }

    static void KillProc(Job j)
    {
        lock (j.Sync) { try { if (j.Proc != null && !j.Proc.HasExited) j.Proc.Kill(); } catch { } }
    }

    static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }

    static string FriendlyFfmpegError(string tail, int exit, out string code)
    {
        code = "ffmpeg";
        string t = tail ?? "";
        if (Regex.IsMatch(t, @"skd://|keyformat|SAMPLE-AES|widevine|playready|fairplay|cenc|Unsupported encryption|encrypted", RegexOptions.IgnoreCase))
        { code = "drm"; return "This stream appears to be protected or encrypted in a way MediaGrab does not support (" + Shorten(t) + ")."; }
        Match http = Regex.Match(t, @"Server returned (\d{3})");
        if (http.Success)
        {
            code = "http_" + http.Groups[1].Value;
            string c = http.Groups[1].Value;
            if (c == "401" || c == "403") return "The server refused access (HTTP " + c + "). The link may have expired, or it needs a login/cookies/referer that the browser did not share.";
            if (c == "404" || c == "410") return "The stream segments were not found (HTTP " + c + "). The link has probably expired.";
            return "The server answered HTTP " + c + " while downloading.";
        }
        if (Regex.IsMatch(t, "Protocol not on whitelist|not in the whitelist", RegexOptions.IgnoreCase))
        { code = "blocked"; return "The playlist referenced a protocol MediaGrab blocks for safety (" + Shorten(t) + ")."; }
        if (Regex.IsMatch(t, "Invalid data found when processing input", RegexOptions.IgnoreCase))
        { code = "invalid_data"; return "FFmpeg could not read this stream (invalid data). It may not be a normal HLS/DASH stream, or the link expired."; }
        if (Regex.IsMatch(t, "Connection (timed out|refused|reset)|Network is unreachable|Name or service not known|Failed to resolve", RegexOptions.IgnoreCase))
        { code = "network"; return "Network error while downloading: " + Shorten(t); }
        if (t.Length == 0) return "FFmpeg exited with code " + exit + ".";
        return "FFmpeg failed: " + Shorten(t);
    }

    static string Shorten(string s) { return s.Length > 300 ? s.Substring(0, 300) + "…" : s; }

    static string FormatClock(double secs)
    {
        TimeSpan ts = TimeSpan.FromSeconds(Math.Max(0, secs));
        return ((int)ts.TotalHours).ToString("00") + ":" + ts.Minutes.ToString("00") + ":" + ts.Seconds.ToString("00");
    }

    static string FormatBytes(long b)
    {
        string[] u = { "B", "KB", "MB", "GB", "TB" };
        double v = b; int i = 0;
        while (v >= 1024 && i < u.Length - 1) { v /= 1024; i++; }
        return v.ToString(v >= 10 || i == 0 ? "0" : "0.0", CultureInfo.InvariantCulture) + " " + u[i];
    }

    // ------------------------------------------------------------------ dictionary helpers

    static string Str(Dictionary<string, object> d, string key)
    {
        object v;
        return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture).Trim() : "";
    }

    static bool Bool(Dictionary<string, object> d, string key)
    {
        object v;
        if (d == null || !d.TryGetValue(key, out v) || v == null) return false;
        if (v is bool) return (bool)v;
        string s = Convert.ToString(v, CultureInfo.InvariantCulture).ToLowerInvariant();
        return s == "true" || s == "1";
    }

    static double Dbl(Dictionary<string, object> d, string key)
    {
        object v;
        double n;
        return d != null && d.TryGetValue(key, out v) && v != null &&
            Double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out n) ? n : 0;
    }
}
