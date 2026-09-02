const { app, BrowserWindow } = require("electron");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const profile = mkdtempSync(join(tmpdir(), "agent-hub-ui-test-"));
app.setPath("userData", profile);
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ width: 1450, height: 1000, show: false, webPreferences: { preload: join(__dirname, "context-ui-preload.cjs"), contextIsolation: true, sandbox: true } });
    await window.loadFile(resolve(__dirname, "../ui/hub.html"));
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
    console.log("CONTEXT_UI_SMOKE_OK", result); window.destroy(); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on("will-quit", () => rmSync(profile, { recursive: true, force: true }));
