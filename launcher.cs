using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Agent Room")]
[assembly: AssemblyProduct("Agent Room")]
[assembly: AssemblyVersion("1.1.0.0")]

static class Program {
    static string Dir { get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); } }

    static string Quote(string s) {
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static void Log(Exception ex) {
        try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "agent-room-launcher-error.log"), ex.ToString()); } catch { }
    }

    [STAThread]
    static int Main(string[] args) {
        try {
            if (args.Length >= 2 && args[0] == "--window") return AppWindow.Run(args[1]);
            return StartLauncher(args);
        } catch (Exception ex) {
            Log(ex);
            return 1;
        }
    }

    // Default mode: run start.ps1 hidden. start.ps1 starts the hub and opens the client
    // (this exe in --window mode when WebView2 is available, otherwise the browser).
    static int StartLauncher(string[] args) {
        string script = Path.Combine(Dir, "start.ps1");
        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(ps)) ps = "powershell.exe";
        var sb = new StringBuilder();
        sb.Append("-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ");
        sb.Append(Quote(script));
        foreach (string a in args) {
            sb.Append(' ');
            sb.Append(Quote(a));
        }
        var psi = new ProcessStartInfo(ps, sb.ToString()) {
            WorkingDirectory = Dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        using (var p = Process.Start(psi)) {
            if (Array.Exists(args, x => string.Equals(x, "-Check", StringComparison.OrdinalIgnoreCase))) {
                p.WaitForExit(15000);
                return p.HasExited ? p.ExitCode : 0;
            }
        }
        return 0;
    }
}

// Native app window that hosts the existing local UI in WebView2. WebView2 types are only
// touched inside Host so the launcher still runs on machines without the SDK files.
static class AppWindow {
    const string Title = "Agent Room";
    const string BaseUrl = "http://127.0.0.1:4317";

    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);

    static string Dir { get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); } }

    public static int Run(string url) {
        if (!url.StartsWith(BaseUrl + "/", StringComparison.Ordinal)) return 2;
        bool created;
        using (var mutex = new Mutex(true, "AgentRoom.Window", out created)) {
            if (!created) {
                // Already open: bring the existing window to the front instead of opening another.
                IntPtr hwnd = FindWindow(null, Title);
                if (hwnd != IntPtr.Zero) {
                    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
                    SetForegroundWindow(hwnd);
                }
                return 0;
            }
            string sdk = Path.Combine(Dir, "webview2");
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
                string file = Path.Combine(sdk, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(Host.Create(url, sdk));
            return 0;
        }
    }
}

static class Host {
    const string BaseUrl = "http://127.0.0.1:4317";

    static string Dir { get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); } }
    static string StateFile { get { return Path.Combine(Dir, "local", "window.txt"); } }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

    static void ApplyWindowTheme(Form form, string theme) {
        try {
            bool light = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
            bool midnight = string.Equals(theme, "midnight", StringComparison.OrdinalIgnoreCase);
            int dark = light ? 0 : 1;
            DwmSetWindowAttribute(form.Handle, 20, ref dark, 4); // DWMWA_USE_IMMERSIVE_DARK_MODE
            int captionColor = light ? 0x00FBF6F4 : midnight ? 0x000E0907 : 0x0017110F; // BGR
            DwmSetWindowAttribute(form.Handle, 35, ref captionColor, 4); // DWMWA_CAPTION_COLOR (Win11)
            form.BackColor = light ? Color.FromArgb(244, 246, 251) : midnight ? Color.FromArgb(7, 9, 14) : Color.FromArgb(15, 17, 23);
        } catch { }
    }

    public static Form Create(string url, string sdk) {
        Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(sdk);
        var form = new Form { Text = "Agent Room", Width = 1280, Height = 860, StartPosition = FormStartPosition.CenterScreen, BackColor = Color.FromArgb(15, 17, 23) };
        try { form.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        RestoreBounds(form);
        form.HandleCreated += (s, e) => ApplyWindowTheme(form, "dark");
        var view = new Microsoft.Web.WebView2.WinForms.WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(15, 17, 23) };
        // Separate profile so cookies (the local access key) persist across launches.
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentRoom", "WebView2");
        view.CreationProperties = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties { UserDataFolder = profile };
        form.Controls.Add(view);
        view.CoreWebView2InitializationCompleted += (s, e) => {
            if (!e.IsSuccess) {
                MessageBox.Show(form, "앱 창을 열지 못했어요. 브라우저로 엽니다.\n" + e.InitializationException.Message, "Agent Room");
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                form.Close();
                return;
            }
            var core = view.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;
            // Links outside the local hub open in the default browser, never inside the app.
            core.NewWindowRequested += (o, a) => { a.Handled = true; OpenExternal(a.Uri); };
            core.NavigationStarting += (o, a) => {
                if (!a.Uri.StartsWith(BaseUrl + "/", StringComparison.Ordinal) && a.Uri != BaseUrl) { a.Cancel = true; OpenExternal(a.Uri); }
            };
            core.PermissionRequested += (o, a) => {
                if (a.PermissionKind == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Notifications
                    || a.PermissionKind == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.ClipboardRead)
                    a.State = Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow;
            };
            core.DocumentTitleChanged += (o, a) => { form.Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Agent Room" : core.DocumentTitle.StartsWith("Agent Room") ? core.DocumentTitle : "Agent Room"; };
            core.WebMessageReceived += (o, a) => {
                try {
                    string msg = a.TryGetWebMessageAsString();
                    if (msg != null && msg.StartsWith("theme:", StringComparison.Ordinal)) {
                        ApplyWindowTheme(form, msg.Substring(6));
                    }
                } catch { }
            };
        };
        form.Shown += (s, e) => { view.Source = new Uri(url); };
        form.FormClosing += (s, e) => SaveBounds(form);
        return form;
    }

    static void OpenExternal(string uri) {
        if (string.IsNullOrEmpty(uri)) return;
        if (!(uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))) return;
        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    static void RestoreBounds(Form form) {
        try {
            string[] p = File.ReadAllText(StateFile).Trim().Split(',');
            var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
            bool visible = false;
            foreach (var screen in Screen.AllScreens) if (screen.WorkingArea.IntersectsWith(r)) visible = true;
            if (visible && r.Width >= 480 && r.Height >= 360) { form.StartPosition = FormStartPosition.Manual; form.Bounds = r; }
            if (p.Length > 4 && p[4] == "max") form.WindowState = FormWindowState.Maximized;
        } catch { }
    }

    static void SaveBounds(Form form) {
        try {
            var r = form.WindowState == FormWindowState.Normal ? form.Bounds : form.RestoreBounds;
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile));
            File.WriteAllText(StateFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + (form.WindowState == FormWindowState.Maximized ? ",max" : ""));
        } catch { }
    }
}
