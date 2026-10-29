using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32;

namespace OberyunAuto
{
    class Program
    {
        static void Main(string[] args)
        {
            Console.WriteLine("=========================================");
            Console.WriteLine("  Oberyun 自动完成课程 Launcher v3.2");
            Console.WriteLine("=========================================");

            string browserPath = FindDefaultBrowser();
            if (string.IsNullOrEmpty(browserPath))
            {
                Console.WriteLine("[ERROR] No browser found!");
                Console.ReadKey();
                return;
            }
            string browserName = Path.GetFileNameWithoutExtension(browserPath);
            Console.WriteLine("[OK] Default browser: " + browserPath);

            KillPort(9222);
            Thread.Sleep(500);

            string userDataDir = Path.Combine(Path.GetTempPath(), "OberyunAuto_" + browserName);
            Console.WriteLine("[OK] Profile dir: " + userDataDir);

            Process.Start(new ProcessStartInfo
            {
                FileName = browserPath,
                Arguments = "--remote-debugging-port=9222 --no-first-run --disable-extensions --user-data-dir=\"" + userDataDir + "\" https://www.oberyun.com/ober/myHome",
                UseShellExecute = false
            });

            Console.WriteLine("Browser started! Please login to Oberyun...");
            Console.WriteLine("Waiting for page load...");

            string script = LoadScript();
            Console.WriteLine("[OK] Script loaded: " + (script.Length > 0 ? script.Length + " chars" : "EMPTY!"));

            // 记录每个标签页最近一次注入时的 URL: URL 变化说明发生了页面跳转,
            // 新文档里脚本已不存在(CDP 的 addScriptToEvaluateOnNewDocument 会随
            // DevTools 会话关闭而失效), 必须重新注入. SPA 路由变化时脚本自带
            // __OberyunAutoRunning 防重入, 重复注入是安全的空操作.
            var injectedUrl = new Dictionary<string, string>();
            bool everInjected = false;

            // Loop FOREVER: poll for oberyun tabs every 3 seconds
            while (true)
            {
                try
                {
                    var tabs = GetTabs();
                    if (tabs != null)
                    {
                        foreach (var t in tabs)
                        {
                            if (string.IsNullOrEmpty(t.webSocketDebuggerUrl)) continue;
                            // Only inject into oberyun.com "page" type tabs (skip extensions, devtools)
                            if (!t.url.Contains("oberyun.com")) continue;
                            if (t.url.Contains("login")) continue;

                            // Extract tab ID from ws URL: ws://127.0.0.1:9222/devtools/page/<TAB_ID>
                            int lastSlash = t.webSocketDebuggerUrl.LastIndexOf('/');
                            string tabId = lastSlash >= 0 ? t.webSocketDebuggerUrl.Substring(lastSlash + 1) : t.webSocketDebuggerUrl;

                            if (injectedUrl.ContainsKey(tabId) && injectedUrl[tabId] == t.url) continue;

                            Console.WriteLine("[INJECT] Tab: " + t.url.Substring(0, Math.Min(80, t.url.Length)));
                            if (InjectScript(t.webSocketDebuggerUrl, script))
                            {
                                injectedUrl[tabId] = t.url;
                                if (!everInjected)
                                {
                                    Console.WriteLine("=========================================");
                                    Console.WriteLine("  Script injected! Automation running.");
                                    Console.WriteLine("  Check browser Console (F12) for progress.");
                                    Console.WriteLine("  Close browser to exit.");
                                    Console.WriteLine("=========================================");
                                    everInjected = true;
                                }
                            }
                        }
                    }
                }
                catch { }
                Thread.Sleep(3000);
            }
        }

        static string FindDefaultBrowser()
        {
            try
            {
                RegistryKey userChoice = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice");
                if (userChoice == null)
                    userChoice = Registry.CurrentUser.OpenSubKey(
                        @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice");

                if (userChoice != null)
                {
                    string progId;
                    using (userChoice) { progId = userChoice.GetValue("ProgId") as string; }

                    if (!string.IsNullOrEmpty(progId))
                    {
                        using var cmdKey = Registry.ClassesRoot.OpenSubKey(progId + @"\shell\open\command");
                        if (cmdKey != null)
                        {
                            string cmd = cmdKey.GetValue(null) as string;
                            if (!string.IsNullOrEmpty(cmd))
                            {
                                string exe = ParseExeFromCommand(cmd);
                                if (!string.IsNullOrEmpty(exe) && File.Exists(exe))
                                {
                                    Console.WriteLine("[REG] Default browser ProgId=" + progId + " -> " + exe);
                                    return exe;
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[REG] Registry failed: " + ex.Message); }

            Console.WriteLine("[REG] Falling back to known paths...");
            string[] paths = {
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Mozilla Firefox\firefox.exe",
                @"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
                @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\BraveSoftware\Brave-Browser\Application\brave.exe",
            };
            foreach (var p in paths) if (File.Exists(p)) return p;
            return null;
        }

        static string ParseExeFromCommand(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return null;
            cmd = cmd.Trim();
            if (cmd.StartsWith("\""))
            {
                int end = cmd.IndexOf('\"', 1);
                if (end > 0) return cmd.Substring(1, end - 1);
            }
            int space = cmd.IndexOf(' ');
            return space > 0 ? cmd.Substring(0, space) : cmd;
        }

        static void KillPort(int port)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :" + port + " ^| findstr LISTENING') do taskkill /F /PID %a 2>nul",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process.Start(psi)?.WaitForExit(2000);
            }
            catch { }
        }

        static string LoadScript()
        {
            string[] searchPaths = {
                Path.Combine(AppContext.BaseDirectory, "oberyun-auto.js"),
                @"d:\Code\auto\oberyun-auto.js",
            };
            foreach (var p in searchPaths)
            {
                try
                {
                    string full = Path.GetFullPath(p);
                    if (File.Exists(full))
                    {
                        Console.WriteLine("[OK] Script path: " + full);
                        return File.ReadAllText(full);
                    }
                }
                catch { }
            }
            Console.WriteLine("[WARN] oberyun-auto.js not found!");
            return "";
        }

        static System.Collections.Generic.List<TabInfo> GetTabs()
        {
            try
            {
                using var wc = new HttpClient();
                var json = wc.GetStringAsync("http://127.0.0.1:9222/json").Result;
                return JsonSerializer.Deserialize<System.Collections.Generic.List<TabInfo>>(json);
            }
            catch { return null; }
        }

        static bool InjectScript(string wsUrl, string script)
        {
            try
            {
                using var ws = new ClientWebSocket();
                ws.ConnectAsync(new Uri(wsUrl), CancellationToken.None).Wait();

                // Step 1: Register script to auto-run on EVERY new document/page navigation
                SendCommand(ws, 1, "Page.addScriptToEvaluateOnNewDocument", new { source = script });
                WaitForResponse(ws, 1);

                // Step 2: Enable Page domain (needed for navigation events)
                SendCommand(ws, 2, "Page.enable", new { });
                WaitForResponse(ws, 2);

                // Step 3: Run immediately on current page (awaitPromise=false to avoid timeout)
                SendCommand(ws, 3, "Runtime.evaluate", new
                {
                    expression = script,
                    returnByValue = true,
                    awaitPromise = false
                });
                WaitForResponse(ws, 3);

                // Step 4: Verify script actually started running
                Thread.Sleep(800);
                SendCommand(ws, 4, "Runtime.evaluate", new
                {
                    expression = "window.__OberyunAutoRunning === true",
                    returnByValue = true
                });
                var verifyResp = WaitForResponse(ws, 4);
                bool running = verifyResp.Contains("\"value\":true");

                ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ok", CancellationToken.None).Wait();
                if (running)
                {
                    Console.WriteLine("[OK] Script injected and running!");
                }
                else
                {
                    Console.WriteLine("[WARN] Script injected but not confirmed running (page may still be loading)");
                }
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Inject error: " + ex.Message);
                return false;
            }
        }

        static void SendCommand(ClientWebSocket ws, int id, string method, object parameters)
        {
            var cmd = new { id, method, @params = parameters };
            string json = JsonSerializer.Serialize(cmd);
            ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(json)), WebSocketMessageType.Text, true, CancellationToken.None).Wait();
        }

        static string WaitForResponse(ClientWebSocket ws, int id)
        {
            var buffer = new byte[262144];
            while (true)
            {
                using var ms = new MemoryStream();
                while (true)
                {
                    var result = ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None).Result;
                    ms.Write(buffer, 0, result.Count);
                    if (result.EndOfMessage) break;
                }
                string msg = Encoding.UTF8.GetString(ms.ToArray());
                // Check if this is the response for our command id
                if (msg.Contains("\"id\":" + id))
                {
                    return msg;
                }
                // Otherwise it's an event, skip it
            }
        }
    }

    class TabInfo
    {
        public string url { get; set; }
        public string webSocketDebuggerUrl { get; set; }
    }
}
