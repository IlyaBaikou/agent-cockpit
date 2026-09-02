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
    const cards = await window.webContents.executeJavaScript(`(() => {
      const saved = structuredClone(data);
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      navigate('demo-space', null);
      document.getElementById('composer').value = 'Черновик общего чата';
      let card = document.querySelector('[data-open-thread="demo-thread"]');
      check(card && card.innerText.includes('Ответов: 2'), 'General chat must show the existing thread and two replies');
      check(!document.getElementById('messages').innerText.includes('старые клиенты продолжат работать'), 'Agent replies must stay inside the thread');
      for (const state of ['working', 'waiting', 'paused', 'resolved', 'error']) {
        data.threads[0].status = state; renderChat();
        check(document.querySelector('[data-open-thread="demo-thread"]').innerText.includes(labels[state]), 'Live card status did not refresh: ' + state);
      }
      data.messages.push({ id: 'human-clarification', space: 'demo-space', thread: 'demo-thread', kind: 'human', author: 'peer', content: 'Уточнение: сохраняем старый формат.', createdAt: Date.now() });
      data.threads.push({ id: 'foreign-thread', space: 'other-space', owner: 'peer', title: 'Hidden other-space topic', status: 'open', createdAt: Date.now() });
      renderChat();
      check(document.querySelectorAll('[data-open-thread]').length === 1, 'Duplicate or cross-space card');
      check(document.querySelector('[data-open-thread="demo-thread"]').innerText.includes('Ответов: 3'), 'Human replies must count');
      data.threads[0].title = '<img src=x onerror="throw 1">'; renderChat();
      check(!document.querySelector('#messages img'), 'Thread title must be escaped');
      data = saved; renderChat();
      document.querySelector('[data-open-thread="demo-thread"]').click();
      check(threadId === 'demo-thread', 'Card must open its own thread');
      check(document.querySelectorAll('[data-open-thread]').length === 0, 'Cards must not appear inside the thread');
      check(document.getElementById('job-status').innerText.includes('укажите через @'), 'Human continuation guidance missing');
      check(document.querySelectorAll('article.message').length === 3, 'Thread history missing');
      navigate('demo-space', null);
      check(document.getElementById('composer').value === 'Черновик общего чата', 'Navigation must preserve the general-chat draft');
      document.getElementById('composer').value = '';
      return { existingThreadCard: true, liveStatuses: true, replyCount: true, scoped: true, escaped: true, navigation: true, draftPreserved: true };
    })()`);
    console.log("THREAD_CARD_UI_SMOKE_OK", cards);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-general.png'), (await window.webContents.capturePage()).toPNG());
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
