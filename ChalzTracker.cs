using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Media;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("ChalzTracker")]
[assembly: AssemblyDescription("ChalzTracker — Your Personal AI Usage Tracker")]
[assembly: AssemblyProduct("ChalzTracker")]
[assembly: AssemblyVersion("2.1.0.0")]
[assembly: AssemblyFileVersion("2.1.0.0")]

namespace ChalzTrackerApp
{
    internal static class NativeMethods
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr LoadImage(IntPtr hInst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern bool Shell_NotifyIconW(uint dwMessage, ref NOTIFYICONDATAW lpData);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct NOTIFYICONDATAW
        {
            public uint cbSize;
            public IntPtr hWnd;
            public uint uID;
            public uint uFlags;
            public uint uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szTip;
            public uint dwState;
            public uint dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
            public string szInfo;
            public uint uTimeoutOrVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
            public string szInfoTitle;
            public uint dwInfoFlags;
            public Guid guidItem;
            public IntPtr hBalloonIcon;
        }

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        public const int SW_HIDE = 0;
        public const int SW_SHOWNORMAL = 1;
        public const int SW_RESTORE = 9;
        public const int SW_SHOW = 5;

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        public const uint WM_SETICON = 0x0080;
        public const uint IMAGE_ICON = 1;
        public const uint LR_LOADFROMFILE = 0x0010;

        public const uint NIM_MODIFY = 0x00000001;
        public const uint NIF_INFO = 0x00000010;
        public const uint NIIF_USER = 0x00000004;
        public const uint NIIF_NOSOUND = 0x00000010;
        public const uint NIIF_LARGE_ICON = 0x00000020;
    }

    internal static class ChalzAudioEngine
    {
        private struct ToneStep
        {
            public double FreqStart;
            public double FreqEnd;
            public double StartSec;
            public double DurSec;
            public double Gain;
            public int WaveKind; // 0 = harmonic shimmer, 1 = bell overtone, 2 = retro triangle/square, 3 = pure sine

            public ToneStep(double f0, double f1, double start, double dur, double gain, int kind)
            {
                FreqStart = f0;
                FreqEnd = f1;
                StartSec = start;
                DurSec = dur;
                Gain = gain;
                WaveKind = kind;
            }
        }

        public static void PlayAsync(string pack, string level)
        {
            if (string.IsNullOrEmpty(pack) || string.Equals(pack, "off", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            string safePack = pack.Trim().ToLowerInvariant();
            string safeLevel = string.IsNullOrEmpty(level) ? "reset" : level.Trim().ToLowerInvariant();
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    byte[] wav = SynthesizeStereoWav(safePack, safeLevel);
                    if (wav == null || wav.Length == 0) return;
                    using (MemoryStream ms = new MemoryStream(wav))
                    using (SoundPlayer player = new SoundPlayer(ms))
                    {
                        player.PlaySync();
                    }
                }
                catch { }
            });
        }

        private static ToneStep[] GetSteps(string pack, string level)
        {
            if (pack == "crystal")
            {
                if (level == "crit")
                {
                    return new[]
                    {
                        new ToneStep(880.0, 880.0, 0.00, 0.13, 0.24, 1),
                        new ToneStep(698.46, 698.46, 0.11, 0.13, 0.24, 1),
                        new ToneStep(587.33, 587.33, 0.22, 0.22, 0.26, 1)
                    };
                }
                if (level == "warn")
                {
                    return new[]
                    {
                        new ToneStep(659.25, 659.25, 0.00, 0.15, 0.20, 1),
                        new ToneStep(493.88, 493.88, 0.12, 0.20, 0.18, 1)
                    };
                }
                return new[]
                {
                    new ToneStep(1046.50, 1046.50, 0.00, 0.24, 0.18, 1),
                    new ToneStep(1318.51, 1318.51, 0.07, 0.26, 0.18, 1),
                    new ToneStep(1567.98, 1567.98, 0.14, 0.30, 0.20, 1),
                    new ToneStep(1975.53, 1975.53, 0.21, 0.36, 0.17, 1)
                };
            }

            if (pack == "arcade")
            {
                if (level == "crit")
                {
                    return new[]
                    {
                        new ToneStep(880.0, 830.0, 0.00, 0.09, 0.22, 2),
                        new ToneStep(659.25, 622.25, 0.10, 0.09, 0.22, 2),
                        new ToneStep(523.25, 493.88, 0.20, 0.18, 0.24, 2)
                    };
                }
                if (level == "warn")
                {
                    return new[]
                    {
                        new ToneStep(698.46, 698.46, 0.00, 0.09, 0.19, 2),
                        new ToneStep(523.25, 523.25, 0.10, 0.14, 0.19, 2)
                    };
                }
                return new[]
                {
                    new ToneStep(987.77, 987.77, 0.00, 0.09, 0.20, 2),
                    new ToneStep(1318.51, 1318.51, 0.08, 0.28, 0.22, 2)
                };
            }

            if (pack == "minimal")
            {
                if (level == "crit")
                {
                    return new[]
                    {
                        new ToneStep(660.0, 620.0, 0.00, 0.11, 0.24, 3),
                        new ToneStep(660.0, 520.0, 0.13, 0.16, 0.25, 3)
                    };
                }
                if (level == "warn")
                {
                    return new[]
                    {
                        new ToneStep(480.0, 360.0, 0.00, 0.14, 0.21, 3)
                    };
                }
                return new[]
                {
                    new ToneStep(520.0, 960.0, 0.00, 0.17, 0.23, 3)
                };
            }

            // Default: "cyber" — Cyber Harmonic (warm stereo detuned synth)
            if (level == "crit")
            {
                return new[]
                {
                    new ToneStep(783.99, 783.99, 0.00, 0.10, 0.24, 0),
                    new ToneStep(783.99, 783.99, 0.11, 0.10, 0.24, 0),
                    new ToneStep(587.33, 554.37, 0.22, 0.22, 0.26, 0)
                };
            }
            if (level == "warn")
            {
                return new[]
                {
                    new ToneStep(523.25, 523.25, 0.00, 0.12, 0.20, 0),
                    new ToneStep(659.25, 659.25, 0.10, 0.18, 0.20, 0)
                };
            }
            return new[]
            {
                new ToneStep(587.33, 587.33, 0.00, 0.20, 0.20, 0), // D5
                new ToneStep(880.00, 880.00, 0.09, 0.24, 0.21, 0), // A5
                new ToneStep(1318.51, 1318.51, 0.18, 0.34, 0.22, 0) // E6
            };
        }

        private static byte[] SynthesizeStereoWav(string pack, string level)
        {
            const int sampleRate = 44100;
            ToneStep[] steps = GetSteps(pack, level);
            double totalDuration = 0.25;
            for (int i = 0; i < steps.Length; i++)
            {
                double end = steps[i].StartSec + steps[i].DurSec + 0.04;
                if (end > totalDuration) totalDuration = end;
            }

            int totalSamples = (int)(sampleRate * totalDuration);
            double[] leftBuf = new double[totalSamples];
            double[] rightBuf = new double[totalSamples];

            for (int n = 0; n < steps.Length; n++)
            {
                ToneStep st = steps[n];
                int startIdx = Math.Max(0, (int)(st.StartSec * sampleRate));
                int len = Math.Max(1, (int)(st.DurSec * sampleRate));
                double phaseL = 0.0;
                double phaseR = 0.0;

                for (int i = 0; i < len && (startIdx + i) < totalSamples; i++)
                {
                    double progress = (double)i / len;
                    double t = (double)i / sampleRate;
                    double freq = st.FreqStart + (st.FreqEnd - st.FreqStart) * progress;

                    // Crisp 8ms attack + smooth exponential decay (zero clicks!)
                    double attack = t < 0.008 ? (t / 0.008) : 1.0;
                    double decay = Math.Exp(-4.6 * progress) * (1.0 - progress * 0.25);
                    if (progress > 0.92)
                    {
                        decay *= (1.0 - progress) / 0.08;
                    }
                    double env = attack * Math.Max(0.0, decay) * st.Gain;

                    phaseL += (2.0 * Math.PI * freq) / sampleRate;
                    phaseR += (2.0 * Math.PI * (freq * 1.0035)) / sampleRate;

                    double sigL;
                    double sigR;
                    if (st.WaveKind == 1)
                    {
                        // Crystal bell: fundamental + 2.756x inharmonic bell partial
                        sigL = Math.Sin(phaseL) * 0.78 + Math.Sin(phaseL * 2.756) * 0.22 * Math.Exp(-3.0 * progress);
                        sigR = Math.Sin(phaseR) * 0.78 + Math.Sin(phaseR * 2.756) * 0.22 * Math.Exp(-3.0 * progress);
                    }
                    else if (st.WaveKind == 2)
                    {
                        // Soft retro synth: fundamental + odd harmonics (3rd + 5th)
                        sigL = Math.Sin(phaseL) * 0.72 + Math.Sin(phaseL * 3.0) * 0.20 + Math.Sin(phaseL * 5.0) * 0.08;
                        sigR = Math.Sin(phaseR) * 0.72 + Math.Sin(phaseR * 3.0) * 0.20 + Math.Sin(phaseR * 5.0) * 0.08;
                    }
                    else if (st.WaveKind == 3)
                    {
                        // Minimal pure sine
                        sigL = Math.Sin(phaseL);
                        sigR = Math.Sin(phaseL);
                    }
                    else
                    {
                        // Cyber harmonic: warm detuned stereo fundamental + octave + soft 2nd harmonic
                        sigL = Math.Sin(phaseL) * 0.74 + Math.Sin(phaseL * 2.0) * 0.20 + Math.Sin(phaseL * 3.0) * 0.06;
                        sigR = Math.Sin(phaseR) * 0.74 + Math.Sin(phaseR * 2.0) * 0.20 + Math.Sin(phaseR * 3.0) * 0.06;
                    }

                    leftBuf[startIdx + i] += sigL * env;
                    rightBuf[startIdx + i] += sigR * env;
                }
            }

            int dataBytes = totalSamples * 4; // 2 channels * 2 bytes
            byte[] wavBytes = new byte[44 + dataBytes];
            using (MemoryStream ms = new MemoryStream(wavBytes))
            using (BinaryWriter bw = new BinaryWriter(ms))
            {
                bw.Write(Encoding.ASCII.GetBytes("RIFF"));
                bw.Write(36 + dataBytes);
                bw.Write(Encoding.ASCII.GetBytes("WAVE"));
                bw.Write(Encoding.ASCII.GetBytes("fmt "));
                bw.Write(16);
                bw.Write((short)1); // PCM
                bw.Write((short)2); // Stereo
                bw.Write(sampleRate);
                bw.Write(sampleRate * 4);
                bw.Write((short)4);
                bw.Write((short)16);
                bw.Write(Encoding.ASCII.GetBytes("data"));
                bw.Write(dataBytes);

                for (int i = 0; i < totalSamples; i++)
                {
                    double l = Math.Max(-0.96, Math.Min(0.96, leftBuf[i]));
                    double r = Math.Max(-0.96, Math.Min(0.96, rightBuf[i]));
                    bw.Write((short)(l * 32767.0));
                    bw.Write((short)(r * 32767.0));
                }
            }
            return wavBytes;
        }
    }

    internal sealed class WinHostContext : ApplicationContext
    {
        private readonly string _appDir;
        private readonly string _portMatch;
        private readonly NotifyIcon _notifyIcon;
        private readonly ToolStripMenuItem _topmostMenuItem;
        private readonly Control _invoker;
        private readonly System.Windows.Forms.Timer _watchTimer;
        private readonly System.Windows.Forms.Timer _balloonCleanupTimer;
        private readonly Dictionary<string, IntPtr> _balloonIconCache = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
        private IntPtr _cachedHwnd = IntPtr.Zero;
        private IntPtr _hIconSmall = IntPtr.Zero;
        private IntPtr _hIconBig = IntPtr.Zero;
        private NativeMethods.RECT _savedDashboardRect;
        private bool _hasSavedDashboardRect;
        private bool _isTopmost;
        private bool _trayPinned;
        private bool _everFoundWindow;
        private int _iconApplyTicks;
        private int _missingTicks;
        private string _pendingMode;
        private int _pendingW = 940;
        private int _pendingH = 640;
        private bool _pendingDock = true;

        public WinHostContext(string appDir, string port)
        {
            _appDir = appDir;
            _portMatch = string.IsNullOrEmpty(port) ? "" : ("127.0.0.1:" + port);

            _invoker = new Control();
            _invoker.CreateControl();

            string icoPath = Path.Combine(_appDir, "assets", "favicon.ico");
            if (File.Exists(icoPath))
            {
                _hIconSmall = NativeMethods.LoadImage(IntPtr.Zero, icoPath, NativeMethods.IMAGE_ICON, 16, 16, NativeMethods.LR_LOADFROMFILE);
                _hIconBig = NativeMethods.LoadImage(IntPtr.Zero, icoPath, NativeMethods.IMAGE_ICON, 32, 32, NativeMethods.LR_LOADFROMFILE);
            }

            Icon trayIcon = File.Exists(icoPath) ? new Icon(icoPath, 16, 16) : SystemIcons.Application;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem widgetItem = new ToolStripMenuItem("Show Compact Usage Widget");
            ToolStripMenuItem pillItem = new ToolStripMenuItem("Show Mini Usage Button");
            ToolStripMenuItem dashItem = new ToolStripMenuItem("Open Full Dashboard");
            _topmostMenuItem = new ToolStripMenuItem("Pin Always on Top");
            ToolStripMenuItem unpinItem = new ToolStripMenuItem("Unpin from System Tray");
            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit ChalzTracker");

            widgetItem.Click += (s, e) => RequestModeFromTray("widget");
            pillItem.Click += (s, e) => RequestModeFromTray("pill");
            dashItem.Click += (s, e) => RequestModeFromTray("dashboard");
            _topmostMenuItem.Click += (s, e) => Emit("EVT:TOGGLE_TOPMOST");
            unpinItem.Click += (s, e) =>
            {
                SetTrayVisible(false, false);
                EnsureWindowShown();
                Emit("EVT:UNPIN");
            };
            exitItem.Click += (s, e) =>
            {
                _notifyIcon.Visible = false;
                Emit("EVT:EXIT");
                ExitThread();
            };

            menu.Items.Add(widgetItem);
            menu.Items.Add(pillItem);
            menu.Items.Add(dashItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(_topmostMenuItem);
            menu.Items.Add(unpinItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            _notifyIcon = new NotifyIcon
            {
                Icon = trayIcon,
                Text = "ChalzTracker — Click to toggle compact usage",
                Visible = false,
                ContextMenuStrip = menu
            };

            _notifyIcon.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    IntPtr hwnd = FindAppWindow();
                    if (hwnd != IntPtr.Zero && NativeMethods.IsWindowVisible(hwnd) && !NativeMethods.IsIconic(hwnd))
                    {
                        NativeMethods.ShowWindow(hwnd, NativeMethods.SW_HIDE);
                        Emit("EVT:HIDDEN");
                    }
                    else if (hwnd == IntPtr.Zero)
                    {
                        _everFoundWindow = false;
                        _iconApplyTicks = 0;
                        _missingTicks = 0;
                        Emit("EVT:NEED_WINDOW:widget");
                    }
                    else
                    {
                        Emit("EVT:SHOW_WIDGET");
                    }
                }
            };

            _notifyIcon.BalloonTipClicked += (s, e) =>
            {
                IntPtr hwnd = FindAppWindow();
                if (hwnd == IntPtr.Zero)
                {
                    _everFoundWindow = false;
                    _iconApplyTicks = 0;
                    _missingTicks = 0;
                    Emit("EVT:NEED_WINDOW:dashboard");
                }
                else
                {
                    EnsureWindowShown();
                }
            };

            _balloonCleanupTimer = new System.Windows.Forms.Timer { Interval = 7500 };
            _balloonCleanupTimer.Tick += (s, e) =>
            {
                _balloonCleanupTimer.Stop();
                if (!_trayPinned && _notifyIcon != null)
                {
                    _notifyIcon.Visible = false;
                }
            };

            _watchTimer = new System.Windows.Forms.Timer { Interval = 900 };
            _watchTimer.Tick += (s, e) => WatchWindowLifecycle();
            _watchTimer.Start();

            Thread reader = new Thread(ReadStdinLoop) { IsBackground = true };
            reader.Start();
        }

        private string ResolveProviderPngPath(string provider)
        {
            string key = string.IsNullOrEmpty(provider) ? "chalz" : provider.Trim().ToLowerInvariant();
            if (key == "anthropic") key = "claude";
            else if (key == "openai" || key == "openai-codex") key = "codex";
            else if (key == "google-antigravity") key = "antigravity";
            else if (key == "google-gemini-cli") key = "gemini-cli";
            else if (key == "github-copilot") key = "copilot";
            else if (key == "kimi-code") key = "kimi";

            if (key != "chalz")
            {
                string iconPng = Path.Combine(_appDir, "assets", "icons", key + ".png");
                if (File.Exists(iconPng)) return iconPng;
            }
            string chalzPng = Path.Combine(_appDir, "assets", "chalz-icon-192.png");
            return File.Exists(chalzPng) ? chalzPng : null;
        }

        private static GraphicsPath CreateRoundedRectPath(float x, float y, float w, float h, float r)
        {
            float d = r * 2f;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(x, y, d, d, 180f, 90f);
            path.AddArc(x + w - d, y, d, d, 270f, 90f);
            path.AddArc(x + w - d, y + h - d, d, d, 0f, 90f);
            path.AddArc(x, y + h - d, d, d, 90f, 90f);
            path.CloseFigure();
            return path;
        }

        private IntPtr GetOrCreateBalloonHIcon(string provider, string level)
        {
            string normProvider = string.IsNullOrEmpty(provider) ? "chalz" : provider.Trim().ToLowerInvariant();
            string normLevel = string.IsNullOrEmpty(level) ? "info" : level.Trim().ToLowerInvariant();
            string cacheKey = normProvider + ":" + normLevel;

            IntPtr cached;
            if (_balloonIconCache.TryGetValue(cacheKey, out cached) && cached != IntPtr.Zero)
            {
                return cached;
            }

            string pngPath = ResolveProviderPngPath(normProvider);
            if (pngPath == null || !File.Exists(pngPath))
            {
                return _hIconBig;
            }

            try
            {
                const int size = 64;
                using (Bitmap src = new Bitmap(pngPath))
                using (Bitmap badge = new Bitmap(size, size, PixelFormat.Format32bppArgb))
                using (Graphics g = Graphics.FromImage(badge))
                {
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.Transparent);

                    Color ringColor = Color.FromArgb(180, 58, 60, 74);
                    if (normLevel == "reset") ringColor = Color.FromArgb(215, 48, 209, 88);
                    else if (normLevel == "warn") ringColor = Color.FromArgb(215, 245, 166, 35);
                    else if (normLevel == "crit") ringColor = Color.FromArgb(225, 239, 68, 68);

                    using (GraphicsPath bgPath = CreateRoundedRectPath(1.5f, 1.5f, size - 3f, size - 3f, 15f))
                    using (SolidBrush bgBrush = new SolidBrush(Color.FromArgb(255, 22, 23, 29)))
                    using (Pen ringPen = new Pen(ringColor, 1.8f))
                    {
                        g.FillPath(bgBrush, bgPath);
                        g.DrawPath(ringPen, bgPath);
                    }

                    float pad = normProvider == "chalz" ? 6f : 11f;
                    float drawW = size - pad * 2f;
                    float drawH = size - pad * 2f;
                    g.DrawImage(src, new RectangleF(pad, pad, drawW, drawH));

                    IntPtr hIcon = badge.GetHicon();
                    if (hIcon != IntPtr.Zero)
                    {
                        _balloonIconCache[cacheKey] = hIcon;
                        return hIcon;
                    }
                }
            }
            catch { }

            return _hIconBig;
        }

        private bool TryShowNativeProviderBalloon(string level, string provider, string title, string body)
        {
            try
            {
                if (!_notifyIcon.Visible)
                {
                    _notifyIcon.Visible = true;
                }

                Type niType = typeof(NotifyIcon);
                FieldInfo windowField = niType.GetField("window", BindingFlags.Instance | BindingFlags.NonPublic);
                FieldInfo idField = niType.GetField("id", BindingFlags.Instance | BindingFlags.NonPublic);
                if (windowField == null || idField == null) return false;

                NativeWindow nw = windowField.GetValue(_notifyIcon) as NativeWindow;
                if (nw == null || nw.Handle == IntPtr.Zero) return false;
                uint uId = (uint)(int)idField.GetValue(_notifyIcon);

                IntPtr hProviderIcon = GetOrCreateBalloonHIcon(provider, level);
                if (hProviderIcon == IntPtr.Zero) return false;

                string safeTitle = string.IsNullOrEmpty(title) ? "ChalzTracker" : title;
                if (safeTitle.Length > 63) safeTitle = safeTitle.Substring(0, 63);
                string safeBody = string.IsNullOrEmpty(body) ? " " : body;
                if (safeBody.Length > 255) safeBody = safeBody.Substring(0, 255);

                NativeMethods.NOTIFYICONDATAW nid = new NativeMethods.NOTIFYICONDATAW();
                nid.cbSize = (uint)Marshal.SizeOf(typeof(NativeMethods.NOTIFYICONDATAW));
                nid.hWnd = nw.Handle;
                nid.uID = uId;
                nid.uFlags = NativeMethods.NIF_INFO;
                nid.szInfoTitle = safeTitle;
                nid.szInfo = safeBody;
                nid.uTimeoutOrVersion = (uint)(level == "reset" ? 5200 : 3800);
                // NIIF_USER + NIIF_LARGE_ICON shows the official AI company logo instead of the blue (i) icon;
                // NIIF_NOSOUND suppresses Windows's default ding so our custom SoundPack plays cleanly!
                nid.dwInfoFlags = NativeMethods.NIIF_USER | NativeMethods.NIIF_LARGE_ICON | NativeMethods.NIIF_NOSOUND;
                nid.hBalloonIcon = hProviderIcon;

                return NativeMethods.Shell_NotifyIconW(NativeMethods.NIM_MODIFY, ref nid);
            }
            catch
            {
                return false;
            }
        }

        private static string CleanNotificationText(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            string cleaned = text
                .Replace(" (Antigravity)", "")
                .Replace(" (Google Antigravity)", "")
                .Replace(" (Cursor)", "")
                .Replace(" (Codex)", "")
                .Replace(" (Claude)", "");
            return cleaned;
        }

        private void ShowCustomBalloon(string level, string provider, string soundPack, string title, string body)
        {
            if (!_notifyIcon.Visible) _notifyIcon.Visible = true;
            string cleanTitle = CleanNotificationText(title);
            string cleanBody = CleanNotificationText(body);

            bool shownWithLogo = TryShowNativeProviderBalloon(level, provider, cleanTitle, cleanBody);
            if (!shownWithLogo)
            {
                _notifyIcon.ShowBalloonTip(level == "reset" ? 5200 : 3600, cleanTitle, cleanBody, ToolTipIcon.None);
            }

            ChalzAudioEngine.PlayAsync(soundPack, level);

            if (!_trayPinned)
            {
                _balloonCleanupTimer.Stop();
                _balloonCleanupTimer.Start();
            }
        }

        private void RequestModeFromTray(string mode)
        {
            IntPtr hwnd = FindAppWindow();
            if (hwnd == IntPtr.Zero)
            {
                _everFoundWindow = false;
                _iconApplyTicks = 0;
                _missingTicks = 0;
                Emit("EVT:NEED_WINDOW:" + mode);
            }
            else
            {
                Emit("EVT:MODE:" + mode);
            }
        }

        private void WatchWindowLifecycle()
        {
            IntPtr hwnd = FindAppWindow();
            if (hwnd != IntPtr.Zero)
            {
                bool firstSighting = !_everFoundWindow;
                _everFoundWindow = true;
                _missingTicks = 0;
                if (_iconApplyTicks < 6)
                {
                    ApplyIconToHwnd(hwnd);
                    _iconApplyTicks++;
                }
                if (_pendingMode != null)
                {
                    string pm = _pendingMode;
                    int pw = _pendingW;
                    int ph = _pendingH;
                    bool pd = _pendingDock;
                    _pendingMode = null;
                    ApplyModeAndBounds(pm, pw, ph, pd, _isTopmost);
                }
                else if (firstSighting)
                {
                    NativeMethods.RECT curRect;
                    Rectangle workArea = Screen.FromHandle(hwnd).WorkingArea;
                    if (NativeMethods.GetWindowRect(hwnd, out curRect))
                    {
                        if (curRect.Bottom > workArea.Bottom - 10 || (curRect.Bottom - curRect.Top) > workArea.Height - 36)
                        {
                            ApplyModeAndBounds("dashboard", 940, 640, true, _isTopmost);
                        }
                    }
                }
                return;
            }

            if (_everFoundWindow && !_trayPinned)
            {
                _missingTicks++;
                if (_missingTicks >= 2)
                {
                    _everFoundWindow = false;
                    Emit("EVT:WINDOW_CLOSED");
                }
            }
        }

        private void Emit(string line)
        {
            try
            {
                Console.WriteLine(line);
                Console.Out.Flush();
            }
            catch { }
        }

        private void ReadStdinLoop()
        {
            try
            {
                using (Stream stdin = Console.OpenStandardInput())
                using (StreamReader reader = new StreamReader(stdin, new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        string cmd = line.Trim();
                        if (cmd.Length == 0) continue;
                        try
                        {
                            _invoker.BeginInvoke((MethodInvoker)(() => HandleCommand(cmd)));
                        }
                        catch { }
                    }
                }
            }
            catch { }

            try
            {
                _invoker.BeginInvoke((MethodInvoker)(() =>
                {
                    _notifyIcon.Visible = false;
                    ExitThread();
                }));
            }
            catch { }
        }

        private IntPtr FindAppWindow()
        {
            if (_cachedHwnd != IntPtr.Zero && NativeMethods.IsWindow(_cachedHwnd))
            {
                StringBuilder sbCheck = new StringBuilder(256);
                NativeMethods.GetWindowText(_cachedHwnd, sbCheck, sbCheck.Capacity);
                string curTitle = sbCheck.ToString();
                if (curTitle.IndexOf("ChalzTracker", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (!string.IsNullOrEmpty(_portMatch) && curTitle.IndexOf(_portMatch, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    return _cachedHwnd;
                }
            }

            IntPtr foundVisible = IntPtr.Zero;
            IntPtr foundHidden = IntPtr.Zero;
            NativeMethods.EnumWindows((hWnd, lParam) =>
            {
                StringBuilder cls = new StringBuilder(128);
                NativeMethods.GetClassName(hWnd, cls, cls.Capacity);
                if (!string.Equals(cls.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal))
                {
                    return true;
                }
                StringBuilder sb = new StringBuilder(256);
                NativeMethods.GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (title.IndexOf("ChalzTracker", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (!string.IsNullOrEmpty(_portMatch) && title.IndexOf(_portMatch, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    if (NativeMethods.IsWindowVisible(hWnd))
                    {
                        foundVisible = hWnd;
                        return false;
                    }
                    if (foundHidden == IntPtr.Zero)
                    {
                        foundHidden = hWnd;
                    }
                }
                return true;
            }, IntPtr.Zero);

            IntPtr found = foundVisible != IntPtr.Zero ? foundVisible : foundHidden;
            if (found != IntPtr.Zero)
            {
                _cachedHwnd = found;
            }
            return found;
        }

        private void ApplyIconToHwnd(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            if (_hIconSmall != IntPtr.Zero)
                NativeMethods.SendMessage(hwnd, NativeMethods.WM_SETICON, new IntPtr(0), _hIconSmall);
            if (_hIconBig != IntPtr.Zero)
                NativeMethods.SendMessage(hwnd, NativeMethods.WM_SETICON, new IntPtr(1), _hIconBig);
        }

        private double GetWindowScale(IntPtr hwnd)
        {
            try
            {
                uint dpi = NativeMethods.GetDpiForWindow(hwnd);
                if (dpi >= 72 && dpi <= 480) return dpi / 96.0;
            }
            catch { }
            return 1.0;
        }

        private void EnsureWindowShown()
        {
            IntPtr hwnd = FindAppWindow();
            if (hwnd == IntPtr.Zero) return;
            ApplyIconToHwnd(hwnd);
            if (!NativeMethods.IsWindowVisible(hwnd))
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOW);
            if (NativeMethods.IsIconic(hwnd))
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
            NativeMethods.SetForegroundWindow(hwnd);
        }

        private void SetTrayVisible(bool visible, bool hideWindow)
        {
            bool wasPinned = _trayPinned;
            _trayPinned = visible;
            _balloonCleanupTimer.Stop();
            _notifyIcon.Visible = visible;
            if (visible && !wasPinned)
            {
                ShowCustomBalloon("info", "chalz", "off", "ChalzTracker", "Minimized to System Tray. Left-click the tray icon anytime to toggle your usage widget.");
            }
            if (visible && hideWindow)
            {
                IntPtr hwnd = FindAppWindow();
                if (hwnd != IntPtr.Zero)
                {
                    NativeMethods.ShowWindow(hwnd, NativeMethods.SW_HIDE);
                }
            }
        }

        private void ApplyModeAndBounds(string mode, int logicalW, int logicalH, bool dockBottomRight, bool topmost)
        {
            _isTopmost = topmost;
            _topmostMenuItem.Checked = topmost;

            IntPtr hwnd = FindAppWindow();
            if (hwnd == IntPtr.Zero)
            {
                _pendingMode = mode;
                _pendingW = logicalW;
                _pendingH = logicalH;
                _pendingDock = dockBottomRight;
                return;
            }
            _pendingMode = null;

            ApplyIconToHwnd(hwnd);

            double scale = GetWindowScale(hwnd);
            Rectangle workArea = Screen.FromHandle(hwnd).WorkingArea;

            if (mode == "dashboard")
            {
                if (!NativeMethods.IsWindowVisible(hwnd))
                    NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOW);
                if (NativeMethods.IsIconic(hwnd) || NativeMethods.IsZoomed(hwnd))
                    NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);

                int maxAllowedW = Math.Max(560, workArea.Width - (int)Math.Round(100 * scale));
                int maxAllowedH = Math.Max(460, workArea.Height - (int)Math.Round(72 * scale));

                int targetW, targetH, targetX, targetY;
                int savedW = _savedDashboardRect.Right - _savedDashboardRect.Left;
                int savedH = _savedDashboardRect.Bottom - _savedDashboardRect.Top;
                if (_hasSavedDashboardRect &&
                    savedW > (int)(540 * scale) &&
                    savedW < (workArea.Width - (int)(24 * scale)) &&
                    savedH < (workArea.Height - (int)(24 * scale)))
                {
                    targetW = Math.Min(savedW, maxAllowedW);
                    targetH = Math.Min(savedH, maxAllowedH);
                    targetX = Math.Max(workArea.Left + 8, Math.Min(_savedDashboardRect.Left, workArea.Right - targetW - 8));
                    targetY = Math.Max(workArea.Top + 8, Math.Min(_savedDashboardRect.Top, workArea.Bottom - targetH - 8));
                }
                else
                {
                    int reqW = logicalW > 540 ? logicalW : 940;
                    int reqH = logicalH > 420 ? logicalH : 640;
                    targetW = Math.Min((int)Math.Round(reqW * scale), maxAllowedW);
                    targetH = Math.Min((int)Math.Round(reqH * scale), maxAllowedH);
                    targetX = workArea.Left + (workArea.Width - targetW) / 2;
                    targetY = workArea.Top + (workArea.Height - targetH) / 2;
                }

                NativeMethods.SetWindowPos(
                    hwnd,
                    topmost ? NativeMethods.HWND_TOPMOST : NativeMethods.HWND_NOTOPMOST,
                    targetX, targetY, targetW, targetH,
                    NativeMethods.SWP_SHOWWINDOW
                );
                if (NativeMethods.IsZoomed(hwnd))
                {
                    NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                    NativeMethods.SetWindowPos(
                        hwnd,
                        topmost ? NativeMethods.HWND_TOPMOST : NativeMethods.HWND_NOTOPMOST,
                        targetX, targetY, targetW, targetH,
                        NativeMethods.SWP_SHOWWINDOW
                    );
                }
                NativeMethods.SetForegroundWindow(hwnd);
                return;
            }

            NativeMethods.RECT curRect;
            bool isCurrentlyZoomed = NativeMethods.IsZoomed(hwnd);
            if (NativeMethods.GetWindowRect(hwnd, out curRect))
            {
                int curW = curRect.Right - curRect.Left;
                int curH = curRect.Bottom - curRect.Top;
                if (!isCurrentlyZoomed &&
                    curW > (int)(740 * scale) &&
                    curW < (workArea.Width - (int)(24 * scale)) &&
                    curH < (workArea.Height - (int)(24 * scale)))
                {
                    _savedDashboardRect = curRect;
                    _hasSavedDashboardRect = true;
                }
            }

            if (!NativeMethods.IsWindowVisible(hwnd))
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOW);
            if (NativeMethods.IsIconic(hwnd) || NativeMethods.IsZoomed(hwnd))
            {
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
            }

            int w = Math.Min((int)Math.Round(logicalW * scale), workArea.Width - 16);
            int h = Math.Min((int)Math.Round(logicalH * scale), workArea.Height - 16);
            int margin = (int)Math.Round(14 * scale);

            int x = workArea.Right - w - margin;
            int y = workArea.Bottom - h - margin;

            if (!dockBottomRight && NativeMethods.GetWindowRect(hwnd, out curRect))
            {
                x = Math.Max(workArea.Left + 8, Math.Min(curRect.Left, workArea.Right - w - 8));
                y = Math.Max(workArea.Top + 8, Math.Min(curRect.Top, workArea.Bottom - h - 8));
            }

            NativeMethods.SetWindowPos(
                hwnd,
                topmost ? NativeMethods.HWND_TOPMOST : NativeMethods.HWND_NOTOPMOST,
                x, y, w, h,
                NativeMethods.SWP_SHOWWINDOW
            );
            if (NativeMethods.IsZoomed(hwnd))
            {
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                NativeMethods.SetWindowPos(
                    hwnd,
                    topmost ? NativeMethods.HWND_TOPMOST : NativeMethods.HWND_NOTOPMOST,
                    x, y, w, h,
                    NativeMethods.SWP_SHOWWINDOW
                );
            }
            NativeMethods.SetForegroundWindow(hwnd);
        }

        private void HandleCommand(string cmd)
        {
            string[] parts = cmd.Split('|');
            string op = parts[0];

            if (op == "ICON")
            {
                IntPtr hwnd = FindAppWindow();
                if (hwnd != IntPtr.Zero) ApplyIconToHwnd(hwnd);
            }
            else if (op == "FOCUS")
            {
                EnsureWindowShown();
            }
            else if (op == "HIDE")
            {
                IntPtr hwnd = FindAppWindow();
                if (hwnd != IntPtr.Zero) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_HIDE);
            }
            else if (op == "TOPMOST" && parts.Length >= 2)
            {
                bool top = parts[1] == "1";
                _isTopmost = top;
                _topmostMenuItem.Checked = top;
                IntPtr hwnd = FindAppWindow();
                if (hwnd != IntPtr.Zero)
                {
                    NativeMethods.SetWindowPos(
                        hwnd,
                        top ? NativeMethods.HWND_TOPMOST : NativeMethods.HWND_NOTOPMOST,
                        0, 0, 0, 0,
                        NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_SHOWWINDOW
                    );
                }
            }
            else if (op == "MODE" && parts.Length >= 6)
            {
                string mode = parts[1];
                int w, h;
                if (!int.TryParse(parts[2], out w)) w = 650;
                if (!int.TryParse(parts[3], out h)) h = 460;
                bool dock = parts[4] == "1";
                bool top = parts[5] == "1";
                ApplyModeAndBounds(mode, w, h, dock, top);
            }
            else if (op == "TRAY_ON")
            {
                bool hideWin = parts.Length >= 2 && parts[1] == "1";
                SetTrayVisible(true, hideWin);
            }
            else if (op == "TRAY_OFF")
            {
                SetTrayVisible(false, false);
                EnsureWindowShown();
            }
            else if (op == "BALLOON" && parts.Length >= 4)
            {
                if (parts.Length >= 6)
                {
                    string level = parts[1];
                    string provider = parts[2];
                    string soundPack = parts[3];
                    string title = parts[4];
                    string body = string.Join("|", parts, 5, parts.Length - 5);
                    ShowCustomBalloon(level, provider, soundPack, title, body);
                }
                else
                {
                    string level = parts[1];
                    string title = parts[2];
                    string body = string.Join("|", parts, 3, parts.Length - 3);
                    ShowCustomBalloon(level, "chalz", "cyber", title, body);
                }
            }
            else if (op == "SOUND" && parts.Length >= 3)
            {
                ChalzAudioEngine.PlayAsync(parts[1], parts[2]);
            }
            else if (op == "OPEN_URL" && parts.Length >= 2)
            {
                string targetUrl = string.Join("|", parts, 1, parts.Length - 1).Trim();
                if (targetUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                    targetUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = targetUrl,
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
            }
            else if (op == "QUIT")
            {
                _trayPinned = false;
                _balloonCleanupTimer.Stop();
                _notifyIcon.Visible = false;
                ExitThread();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_balloonCleanupTimer != null)
                {
                    _balloonCleanupTimer.Stop();
                    _balloonCleanupTimer.Dispose();
                }
                if (_watchTimer != null)
                {
                    _watchTimer.Stop();
                    _watchTimer.Dispose();
                }
                if (_notifyIcon != null)
                {
                    _notifyIcon.Visible = false;
                    _notifyIcon.Dispose();
                }
                foreach (KeyValuePair<string, IntPtr> kv in _balloonIconCache)
                {
                    if (kv.Value != IntPtr.Zero && kv.Value != _hIconBig && kv.Value != _hIconSmall)
                    {
                        try { NativeMethods.DestroyIcon(kv.Value); } catch { }
                    }
                }
                _balloonIconCache.Clear();
            }
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        private static string FindNodeExecutable()
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string rawDir in pathEnv.Split(Path.PathSeparator))
            {
                string dir = rawDir.Trim().Trim('"');
                if (dir.Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }

            string[] common = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
            };
            foreach (string c in common)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }

        private static bool TryWakeExistingInstance(string stateFile)
        {
            try
            {
                if (!File.Exists(stateFile)) return false;
                string portText = File.ReadAllText(stateFile).Trim();
                int port;
                if (!int.TryParse(portText, out port) || port <= 0 || port > 65535) return false;

                string url = "http://127.0.0.1:" + port + "/api/window";
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers["Origin"] = "http://127.0.0.1:" + port;
                req.Timeout = 1200;
                byte[] body = Encoding.UTF8.GetBytes("{\"action\":\"focus\"}");
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(body, 0, body.Length);
                }
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
                }
            }
            catch
            {
                return false;
            }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            try { NativeMethods.SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string appDir = AppDomain.CurrentDomain.BaseDirectory;

            if (args.Length > 0 && args[0] == "--win-host")
            {
                try
                {
                    Console.InputEncoding = new UTF8Encoding(false);
                    Console.OutputEncoding = new UTF8Encoding(false);
                }
                catch { }
                string port = args.Length > 1 ? args[1] : "";
                using (WinHostContext ctx = new WinHostContext(appDir, port))
                {
                    Application.Run(ctx);
                }
                return 0;
            }

            string stateFile = Path.Combine(Path.GetTempPath(), "chalztracker-active-port.txt");
            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"Local\ChalzTrackerSingleInstance_v2", out createdNew))
            {
                if (!createdNew || TryWakeExistingInstance(stateFile))
                {
                    TryWakeExistingInstance(stateFile);
                    return 0;
                }

                string distExe = Path.Combine(appDir, "dist-app", "ChalzTracker-desktop.exe");
                if (File.Exists(distExe))
                {
                    ProcessStartInfo distPsi = new ProcessStartInfo
                    {
                        FileName = distExe,
                        Arguments = "\"" + Path.Combine(appDir, ".") + "\"",
                        WorkingDirectory = appDir,
                        UseShellExecute = true
                    };
                    try
                    {
                        using (Process distProc = Process.Start(distPsi))
                        {
                            return 0;
                        }
                    }
                    catch { }
                }

                string nodeExe = FindNodeExecutable();
                if (nodeExe == null)
                {
                    MessageBox.Show(
                        "Node.js (node.exe) was not found on PATH.\nPlease install Node.js and reopen ChalzTracker.exe.",
                        "ChalzTracker",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return 1;
                }

                string serverJs = Path.Combine(appDir, "server.js");
                if (!File.Exists(serverJs))
                {
                    MessageBox.Show(
                        "Could not find server.js next to ChalzTracker.exe.",
                        "ChalzTracker",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return 1;
                }

                string extraArgs = "";
                foreach (string a in args)
                {
                    if (a == "--widget" || a == "--tray" || a == "--pill")
                        extraArgs += " " + a;
                }

                try { Environment.SetEnvironmentVariable("__COMPAT_LAYER", null); } catch { }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + serverJs + "\" --open --close-with-window" + extraArgs,
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                using (Process proc = Process.Start(psi))
                {
                    if (proc == null) return 1;
                    proc.WaitForExit();
                    return proc.ExitCode;
                }
            }
        }
    }
}
