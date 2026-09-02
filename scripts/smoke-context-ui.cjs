const { app, BrowserWindow, nativeTheme } = require("electron");
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
    console.log("CONTEXT_UI_SMOKE_OK", result);
    const themes = await window.webContents.executeJavaScript(`(async () => {
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      await window.hub.preferences({ theme: 'light' });
      check(getComputedStyle(document.querySelector('.chat')).backgroundColor === 'rgb(255, 255, 255)', 'Light chat surface');
      document.getElementById('settings').click();
      const choice = document.querySelector('#modal [data-theme-choice]');
      choice.value = 'dark'; choice.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      check(appState.settings.theme === 'dark', 'Theme control must persist preferences');
      check(appState.settings.notifications === true, 'Theme change must preserve notifications');
      check(localStorage.getItem('agent-hub-theme') === 'dark', 'Theme first-paint cache missing');
      check(getComputedStyle(document.querySelector('.chat')).backgroundColor === 'rgb(23, 26, 39)', 'Dark chat surface');
      check(getComputedStyle(document.getElementById('modal')).backgroundColor === 'rgb(29, 33, 49)', 'Dark dialog surface');
      closeModal(); navigate('demo-space', null);
      check(getComputedStyle(document.querySelector('.thread-link-card')).backgroundColor === 'rgb(36, 32, 53)', 'Dark thread card');
      return { themeControl: true, light: true, dark: true, dialog: true, card: true, cache: true, notificationsPreserved: true };
    })()`);
    console.log("THEME_UI_SMOKE_OK", themes);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-dark-general.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`navigate('demo-space', 'demo-thread'); document.querySelector('.context-memory').open = true; document.getElementById('messages').scrollTop = 0;`);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-dark-thread.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`openInvitations('demo-space');`);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-invitations.png'), (await window.webContents.capturePage()).toPNG());
    const invites = await window.webContents.executeJavaScript(`(async () => {
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      const wait = () => new Promise(resolve => setTimeout(resolve, 50));
      check(document.getElementById('invite-limit').value === '100', 'Default invite limit');
      check(document.getElementById('invite-days').value === '7', 'Default expiry');
      check(document.querySelector('.invite-warning').innerText.includes('всю историю'), 'Access warning missing');
      document.getElementById('group-invite-form').requestSubmit(); await wait();
      const created = (await window.hub.testCalls()).find(c => c.op === 'invite');
      check(created.input.kind === 'group' && created.input.space === 'demo-space' && created.input.days === 7 && created.input.maxUses === 100 && !created.input.name, 'Shared invite must not require a colleague name');
      document.querySelector('[data-revoke-invite]').click(); await wait();
      check((await window.hub.testCalls()).some(c => c.op === 'revoke-invite' && c.input.id === 'demo-invite'), 'Revoke not wired');
      check(document.querySelector('.invite-list').innerText.includes('Отключено'), 'Revoke state not rendered');
      document.getElementById('space-invitation').value = 'AH2:synthetic-test-only';
      document.getElementById('join-space-form').requestSubmit(); await wait();
      check((await window.hub.testCalls()).some(c => c.op === 'joinInvite'), 'Existing employee join missing');
      check(!document.getElementById('modal').open && spaceId === 'demo-space' && threadId === null, 'Join should open general chat');
      const state = appState; receive({ ...state, snapshot: undefined });
      document.getElementById('credential').value = 'AH2:synthetic-test-only';
      document.getElementById('join-name').value = 'Taylor Example';
      document.getElementById('connect-form').requestSubmit(); await wait();
      const joined = (await window.hub.testCalls()).find(c => c.op === 'connect');
      check(joined.input.name === 'Taylor Example' && joined.input.type === 'invite', 'Enrollment name missing');
      check(document.getElementById('credential').value === '', 'Clear invite after enrollment');
      const upgraded = data; data = { ...data, groupInvitations: undefined }; openInvitations();
      check(document.querySelector('#group-invite-form button').disabled, 'Old coordinator must not offer unsupported shared invites');
      closeModal(); data = upgraded;
      await window.hub.preferences({ theme: 'system' });
      return { defaults: true, warning: true, create: true, revoke: true, existingJoin: true, enrollment: true, legacyServer: true };
    })()`);
    console.log("GROUP_INVITE_UI_SMOKE_OK", invites);
    for (const color of ["dark", "light"]) {
      nativeTheme.themeSource = color;
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now(); const check = () => {
          if (document.documentElement.dataset.theme === '${color}') return resolve(true);
          if (Date.now() - started > 2000) return reject(new Error('System theme did not follow OS'));
          setTimeout(check, 20);
        }; check();
      })`);
    }
    console.log("SYSTEM_THEME_SMOKE_OK"); clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
// Chromium can still hold profile files on Windows during quit. Cleanup is
// best-effort; an uncaught EBUSY/EPERM would display a blocking Electron dialog.
app.on("quit", () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* synthetic OS-temp profile only */ } });
