using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;

namespace OberyunAutoComplete
{
    class Program
    {
        static void Main(string[] args)
        {
            Console.WriteLine("=========================================");
            Console.WriteLine("  Oberyun 自动完成课程 Launcher v1.0");
            Console.WriteLine("=========================================");

            string chromePath = FindChrome();
            if (string.IsNullOrEmpty(chromePath))
            {
                Console.WriteLine("[ERROR] Chrome not found! Please install Google Chrome.");
                Console.WriteLine("Download: https://www.google.com/chrome/");
                Console.ReadKey();
                return;
            }
            Console.WriteLine("[OK] Chrome: " + chromePath);

            // Kill existing debug instance
            try { Process.Start("cmd", "/c for /f %a in ('netstat -ano ^| findstr :9222 ^| findstr LISTENING') do taskkill /F /PID %a").WaitForExit(); } catch { }
            Thread.Sleep(500);

            // Start Chrome
            Console.WriteLine("Starting Chrome with remote debugging...");
            Process.Start(new ProcessStartInfo
            {
                FileName = chromePath,
                Arguments = "--remote-debugging-port=9222 --no-first-run --disable-extensions --user-data-dir=\"" + Path.Combine(Path.GetTempPath(), "OberyunAutoChrome") + "\" https://www.oberyun.com/ober/myHome",
                UseShellExecute = false
            });

            Console.WriteLine("Chrome started! Please login...");
            Console.WriteLine("Waiting for login...");

            // Load auto script
            string script = LoadScript();

            // Wait and inject
            for (int i = 0; i < 180; i++)
            {
                Thread.Sleep(1000);
                try
                {
                    var tabs = GetTabs();
                    if (tabs != null)
                    {
                        foreach (var t in tabs)
                        {
                            if (t.Contains("oberyun.com") && !t.Contains("login"))
                            {
                                Console.WriteLine("Detected page: " + t);
                                // Get WS URL and inject
                                var wsUrl = GetWsUrl(tabs, i);
                                if (!string.IsNullOrEmpty(wsUrl) && InjectScript(wsUrl, script))
                                {
                                    Console.WriteLine("Script injected! Automation started.");
                                    Console.WriteLine("Check Chrome Console (F12) for progress.");
                                    Console.WriteLine("Press Ctrl+C to exit (Chrome will stay open).");
                                    Thread.Sleep(Timeout.Infinite);
                                    return;
                                }
                            }
                        }
                    }
                }
                catch { }
                if (i % 15 == 0 && i > 0) Console.WriteLine("Still waiting... (" + i + "s)");
            }

            Console.WriteLine("Timeout! Please login manually, then run the script from oberyun-auto.js in F12 Console.");
            Console.ReadKey();
        }

        static string FindChrome()
        {
            string[] paths = {
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            };
            foreach (var p in paths) if (File.Exists(p)) return p;
            return null;
        }

        static string LoadScript()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string js = Path.Combine(dir, "oberyun-auto.js");
            if (File.Exists(js))
            {
                try { return File.ReadAllText(js); } catch { }
            }
            // Minimal fallback
            return "alert('Please put oberyun-auto.js next to this exe!');";
        }

        static string GetTabs()
        {
            try
            {
                using (var wc = new WebClient())
                {
                    return wc.DownloadString("http://127.0.0.1:9222/json");
                }
            }
            catch { return null; }
        }

        static string GetWsUrl(string json, int pageIndex)
        {
            try
            {
                // Parse JSON array manually
                int start = json.IndexOf("[");
                if (start < 0) return null;
                // Find webSocketDebuggerUrl for first "page" type
                int idx = 0;
                while (idx >= 0)
                {
                    idx = json.IndexOf("\"webSocketDebuggerUrl\"", idx);
                    if (idx < 0) break;
                    int colon = json.IndexOf(":", idx);
                    int q1 = json.IndexOf("\"", colon + 1);
                    int q2 = json.IndexOf("\"", q1 + 1);
                    if (q1 > 0 && q2 > 0)
                    {
                        return json.Substring(q1 + 1, q2 - q1 - 1);
                    }
                    idx++;
                }
            }
            catch { }
            return null;
        }

        static bool InjectScript(string wsUrl, string script)
        {
            try
            {
                using (var ws = new ClientWebSocket())
                {
                    ws.ConnectAsync(new Uri(wsUrl), CancellationToken.None).Wait();
                    
                    string cmd = "{\"id\":1,\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":" + Escape(script) + ",\"returnByValue\":true}}";
                    byte[] data = Encoding.UTF8.GetBytes(cmd);
                    ws.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Text, true, CancellationToken.None).Wait();

                    var buf = new byte[65536];
                    using (var ms = new MemoryStream())
                    {
                        while (true)
                        {
                            var result = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
                            ms.Write(buf, 0, result.Count);
                            if (result.EndOfMessage) break;
                        }
                        string resp = Encoding.UTF8.GetString(ms.ToArray());
                        if (resp.Contains("\"result\"") && !resp.Contains("\"error\""))
                        {
                            ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ok", CancellationToken.None).Wait();
                            return true;
                        }
                    }
                    ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ok", CancellationToken.None).Wait();
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Inject error: " + ex.Message);
            }
            return false;
        }

        static string Escape(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            sb.Append("\"");
            return sb.ToString();
        }
    }
}
