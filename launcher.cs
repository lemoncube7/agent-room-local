using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

[assembly: AssemblyTitle("Agent Room")]
[assembly: AssemblyProduct("Agent Room")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Program {
    static string Quote(string s) {
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    [STAThread]
    static int Main(string[] args) {
        try {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string script = Path.Combine(dir, "start.ps1");
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
                WorkingDirectory = dir,
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
        } catch (Exception ex) {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "agent-room-launcher-error.log"), ex.ToString()); } catch { }
            return 1;
        }
    }
}
