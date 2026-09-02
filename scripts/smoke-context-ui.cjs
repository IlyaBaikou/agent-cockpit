const { app, BrowserWindow } = require("electron");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const profile = mkdtempSync(join(tmpdir(), "agent-hub-ui-test-"));
app.setPath("userData", profile);
// Hosted Windows workers have no reliable accelerated desktop. Keep this UI
// fixture independent of GPU initialization and fail rather than hang forever.
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("Context UI fixture timed out"); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
  try {
    console.log("CONTEXT_UI_APP_READY");
    const window = new BrowserWindow({ width: 1450, height: 1000, show: false, webPreferences: { preload: join(__dirname, "context-ui-preload.cjs"), contextIsolation: true, sandbox: true } });
    window.webContents.on("render-process-gone", (_event, details) => { console.error("Renderer exited", details.reason); app.exit(1); });
    await window.loadFile(resolve(__dirname, "../ui/hub.html"));
    console.log("CONTEXT_UI_PAGE_LOADED");
    const result = await window.webContents.executeJavaScript(`
      navigate('demo-space', 'demo-thread');
      const panel = document.querySelector('.context-memory');
      if (!panel) throw new Error('Memory panel missing');
      panel.open = true;
      document.getElementById('messages').scrollTop = 0;
      ({ memoryVisible: panel.innerText.includes('Изменения кода пока не одобрены'), metricsVisible: panel.innerText.includes('символов'), messages: document.querySelectorAll('article.message').length });
    `);
    if (!result.memoryVisible || !result.metricsVisible || result.messages !== 3) throw new Error(JSON.stringify(result));
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), (await window.webContents.capturePage()).toPNG());
    console.log("CONTEXT_UI_SMOKE_OK", result); clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
// Chromium can still hold profile files on Windows during quit. Cleanup is
// best-effort; an uncaught EBUSY/EPERM would display a blocking Electron dialog.
app.on("quit", () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* synthetic OS-temp profile only */ } });
