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
    const mentions = await window.webContents.executeJavaScript(`(() => {
      const check = (v, why) => { if (!v) throw new Error(why); };
      navigate('demo-space', 'demo-thread');
      const fixture = document.createElement('div'); document.body.append(fixture);
      const tick = String.fromCharCode(96);
      fixture.innerHTML = markdown('@{u:peer} @{a:b} ' + tick + '@{a:a}' + tick + '\\n\\n> @{a:a}\\n\\n[Example @{a:a}](https://example.test)');
      check(fixture.querySelectorAll('[data-mention-id]').length === 2, 'Only real mentions should be interactive, not code/quotes/links');
      const input = document.getElementById('composer'); input.value = 'Ответ: '; input.setSelectionRange(input.value.length, input.value.length);
      const jobs = data.jobs.length;
      fixture.querySelector('[data-mention-kind="u"]').click();
      check(input.value === 'Ответ: @«Sam» ', 'Human chip inserts a readable recipient');
      fixture.querySelector('[data-mention-kind="a"]').click();
      check(encodeMentions(input.value) === 'Ответ: @{u:peer} @{a:b} ', 'Agent chip retains exact identity for dispatch');
      check(data.jobs.length === jobs, 'Clicking a chip must not send or launch an agent');
      for (const example of ['~~~\\n@{a:a}\\n~~~', tick.repeat(3) + '\\n@{a:a}', '~~~~\\n~~~\\n@{a:a}\\n~~~~']) {
        fixture.innerHTML = markdown(example);
        check(!fixture.querySelector('[data-mention-id]') && fixture.querySelector('pre'), 'Fenced examples must never look like live mention buttons');
      }
      fixture.remove(); input.value = ''; drafts.delete(draftKey());
      return { humans: true, agents: true, examplesIgnored: true, noAutomaticSend: true };
    })()`);
    console.log(JSON.stringify({ mentions }));
    const mentionOrdering = await window.webContents.executeJavaScript(`(() => {
      const check = (v, why) => { if (!v) throw new Error(why); };
      const saved = structuredClone(data), fixture = document.createElement('div');
      const ids = () => mentionOptions().map(o => o.kind + ':' + o.id).join(',');
      try {
        check(ids() === 'u:peer,a:b,a:a', 'Colleagues, peer agents, own agents; no self profile');
        data.employees.push({ id: 'peer2', name: data.me.name }, { id: 'outside', name: 'Outside' });
        const space = currentSpace(); space.members.push('peer2');
        data.agents.unshift(
          { id: 'own2', owner: 'owner', name: 'Own offline', executor: 'claude', enabled: true, ready: false, primary: true },
          { id: 'disabled', owner: 'peer', name: 'Disabled', executor: 'claude', enabled: false, ready: true },
          { id: 'external', owner: 'outside', name: 'External', executor: 'codex', enabled: true, ready: true }
        );
        data.agents.find(a => a.id === 'a').primary = false;
        data.agents.push({ id: 'peer-aux', owner: 'peer', name: 'Peer auxiliary', executor: 'codex', enabled: true, ready: true });
        data.agents.push({ id: 'peer-agent2', owner: 'peer2', name: 'Peer offline', executor: 'codex', enabled: true, ready: false, primary: true });
        const orderBefore = JSON.stringify({ employees: data.employees, agents: data.agents });
        check(ids() === 'u:peer,u:peer2,a:b,a:peer-agent2,a:own2,a:a', 'Picker exposes one default per colleague, then own agents with the default first');
        check(!mentionOptions().some(o => o.id === 'peer-aux'), 'A colleague auxiliary agent must not be directly selectable');
        check(JSON.stringify({ employees: data.employees, agents: data.agents }) === orderBefore, 'Picker must not reorder shared snapshot arrays');
        check(mentionOptions().some(o => o.id === 'peer2' && o.kind === 'u'), 'A colleague with the same display name must remain selectable');
        check(mentionOptions().filter(o => (o.title + ' ' + o.sub).toLowerCase().includes('offline')).map(o => o.id).join(',') === 'peer-agent2,own2', 'Filtering retains peer-before-own order even for offline agents');
        fixture.innerHTML = markdown('@{u:owner} @{u:peer} @{a:a}');
        check(!fixture.querySelector('[data-mention-id="owner"]') && fixture.querySelector('.mention').textContent === '@Alex', 'Existing self mentions stay readable but cannot insert a self mention');
        check(fixture.querySelector('[data-mention-id="peer"]') && fixture.querySelector('[data-mention-id="a"]'), 'Colleague and own-agent mention chips stay interactive');
        space.members = ['owner'];
        check(ids() === 'a:own2,a:a', 'Solo spaces still allow calling own agents');
        data.agents.forEach(a => { if (a.owner === 'owner') a.enabled = false; });
        check(mentionOptions().length === 0, 'Solo space without enabled agents has no self fallback');
        return { grouped: true, automaticPeerDefault: true, ownDefaultFirst: true, selfHidden: true, sameNamePeer: true, scoped: true, stable: true, solo: true, historyPreserved: true };
      } finally { data = saved; fixture.remove(); }
    })()`);
    console.log('MENTION_ORDER_UI_SMOKE_OK', mentionOrdering);
    const mentionKeyboard = await window.webContents.executeJavaScript(`(async () => {
      const check = (v, why) => { if (!v) throw new Error(why); };
      navigate('demo-space', 'demo-thread');
      const input = document.getElementById('composer'), picker = document.getElementById('mention-picker');
      const count = (await window.hub.testCalls()).filter(c => c.op === 'post').length;
      const type = (value, caret = value.length) => { input.value = value; input.focus(); input.setSelectionRange(caret, caret); input.dispatchEvent(new Event('input', { bubbles: true })); };
      const key = (value, extra = {}) => { const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }); input.dispatchEvent(event); return event; };
      type('@');
      check(input.getAttribute('aria-expanded') === 'true' && picker.querySelector('[aria-selected="true"]').dataset.index === '0', 'First mention should be highlighted');
      check(key('ArrowDown').defaultPrevented && picker.querySelector('.active').dataset.index === '1', 'Down selects next recipient without moving caret');
      key('ArrowUp'); check(picker.querySelector('.active').dataset.index === '0', 'Up selects previous recipient');
      key('ArrowUp'); check(picker.querySelector('.active').dataset.index === '2', 'Up wraps to own agent at the end');
      key('Enter');
      check(input.value === '@«Alex / Backend Codex» ' && picker.classList.contains('hidden') && !input.hasAttribute('aria-activedescendant'), 'Enter inserts own agent and closes picker immediately');
      check(encodeMentions(input.value) === '@{a:a} ', 'Selected own-agent identity preserved after reordering');
      type('До @fro после', 7); key('Enter', { ctrlKey: true });
      check(input.value === 'До @«Sam / Frontend Claude»  после', 'Filtered keyboard choice must preserve suffix, even with Ctrl+Enter');
      type('@sam'); check(picker.querySelectorAll('[role="option"]').length === 2 && picker.querySelector('.active').dataset.index === '0', 'Filtering resets active index');
      key('Escape'); check(picker.classList.contains('hidden') && input.value === '@sam', 'Escape closes without changing draft');
      type('@no-such-recipient'); key('ArrowDown'); key('Enter');
      check(input.value === '@no-such-recipient' && picker.classList.contains('hidden'), 'Empty results must not insert or send');
      type('@'); key('Enter', { isComposing: true }); check(!picker.classList.contains('hidden') && input.value === '@', 'IME composition must not select or send');
      key('Tab'); check(picker.classList.contains('hidden'), 'Tab closes picker');
      type('@'); picker.querySelector('[data-index="0"]').click();
      check(input.value === '@«Sam» ' && picker.classList.contains('hidden'), 'Mouse choice still closes picker');
      type('@'); document.getElementById('chat-title').dispatchEvent(new Event('pointerdown', { bubbles: true }));
      check(picker.classList.contains('hidden'), 'Outside click closes picker');
      check((await window.hub.testCalls()).filter(c => c.op === 'post').length === count, 'Mention navigation never sends a message');
      input.value = ''; drafts.delete(draftKey());
      return { arrows: true, wrap: true, enter: true, escape: true, filtered: true, mouse: true, composition: true, noSend: true };
    })()`);
    console.log('MENTION_KEYBOARD_UI_SMOKE_OK', mentionKeyboard);
    const notificationProbe = await window.webContents.executeJavaScript(`(async () => {
      const check = (v, why) => { if (!v) throw new Error(why); };
      document.getElementById('settings').click();
      const wait = async () => { for (let i=0;i<50;i++) { if (!document.getElementById('notification-test').disabled) return; await new Promise(r=>setTimeout(r,20)); } throw Error('Notification UI wait timed out'); };
      const button = document.getElementById('notification-test'), output = document.getElementById('notification-status');
      await window.hub.testConfigureNotification({ delayMs: 100, fail: true });
      button.click(); button.click();
      check(button.disabled && button.textContent.includes('Ждём'), 'Probe must wait and prevent duplicate tests');
      await wait(); check(output.textContent.includes('invalid signature') && !output.querySelector('img'), 'Native failure must be visible and escaped');
      check((await window.hub.testCalls()).filter(c=>c.op==='notification-test').length === 1, 'Double click must not send two notifications');
      await window.hub.testConfigureNotification({ unconfirmed: true }); button.click(); await wait();
      check(output.textContent.includes('не подтверждена'), 'Timeout must not claim delivery');
      await window.hub.testConfigureNotification({}); button.click(); await wait();
      check(output.textContent.includes('Система приняла'), 'Success requires acknowledgement');
      closeModal(); return { failure: true, timeout: true, acknowledged: true, deduplicated: true };
    })()`);
    console.log('NOTIFICATION_PROBE_UI_SMOKE_OK', notificationProbe);
    if (process.argv[2]) {
      await window.webContents.executeJavaScript(`(() => { const input = document.getElementById('composer'); input.value = '@'; input.focus(); input.setSelectionRange(1, 1); showMentions(); highlightMention(1); })()`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-mentions.png'), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`(() => { hideMentions(); document.getElementById('composer').value = ''; drafts.delete(draftKey()); })()`);
    }
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
    const layout = await window.webContents.executeJavaScript(`navigate('demo-space', 'demo-thread'); document.querySelector('.context-memory').open = true; document.getElementById('messages').scrollTop = 0;
      ['.chat', '.chat-header', '.chat-header .eyebrow', '.messages', '.workspace'].map(s => { const e = document.querySelector(s), r = e.getBoundingClientRect(); return { element: s, top: r.top, height: r.height, scroll: e.scrollTop }; });`);
    console.log("THREAD_LAYOUT", layout);
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
    const channels = await window.webContents.executeJavaScript(`(async () => {
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      const wait = () => new Promise(resolve => setTimeout(resolve, 70));
      const calls = async () => await window.hub.testCalls();
      closeModal(); navigate('demo-space', null);
      check(channelId === 'general:demo-space' && document.querySelector('[data-open-thread="demo-thread"]'), 'Legacy thread must live in General');
      document.getElementById('composer').value = 'Черновик общего канала';
      document.querySelector('[data-channel="gamification"]').click();
      check(channelId === 'gamification' && !document.querySelector('[data-open-thread="demo-thread"]'), 'Channel history must be separate');
      document.getElementById('composer').value = 'Черновик геймификации';
      navigate('demo-space', null);
      check(document.getElementById('composer').value === 'Черновик общего канала', 'General draft lost');
      navigate('demo-space', null, 'gamification');
      check(document.getElementById('composer').value === 'Черновик геймификации', 'Channel draft lost');
      document.getElementById('add-channel').click();
      document.getElementById('channel-name').value = 'Игра 2 <test>';
      document.getElementById('channel-description').value = 'Обсуждаем интеграцию';
      document.getElementById('channel-form').requestSubmit(); await wait();
      check(channelId === 'created-channel', 'New channel must open');
      check(document.getElementById('chat-title').textContent.includes('<test>') && !document.querySelector('#chat-title test'), 'Channel names must be escaped');
      document.getElementById('composer').value = 'Привет новому каналу.';
      document.getElementById('composer-form').requestSubmit(); await wait();
      check((await calls()).filter(c => c.op === 'post').at(-1).input.channel === 'created-channel', 'Posting channel missing');
      navigate('demo-space', null);
      check(!document.getElementById('messages').innerText.includes('Привет новому каналу.'), 'Message leaked into General');
      navigate('demo-space', null, 'gamification');
      document.getElementById('composer').value = '@{a:a} Уточни контракт прогресса для максимального уровня.';
      document.getElementById('composer-form').requestSubmit(); await wait();
      check(threadId === 'created-thread' && channelId === 'gamification', 'Agent thread must open in the source channel');
      check(document.getElementById('chat-eyebrow').textContent.includes('Геймификация'), 'Channel breadcrumb missing');
      document.getElementById('follow-thread').click(); await wait();
      check(document.getElementById('follow-thread').getAttribute('aria-pressed') === 'true', 'Subscribe toggle not wired');
      document.getElementById('composer').value = 'Уточнение человека: старый формат сохраняем.';
      document.getElementById('composer-form').requestSubmit(); await wait();
      document.getElementById('general').click();
      check(channelId === 'gamification' && threadId === null && document.querySelector('[data-open-thread="created-thread"]'), 'Back must return to the source channel card');
      check(document.querySelector('[data-open-thread="created-thread"]').innerText.includes('Ответов: 1'), 'Channel card replies');
      document.getElementById('mute-channel').click(); await wait();
      check(document.getElementById('mute-channel').getAttribute('aria-pressed') === 'true', 'Channel mute toggle missing');
      document.getElementById('channel-settings').click();
      document.getElementById('archive-channel').click(); await wait();
      check(document.getElementById('send').disabled && document.getElementById('composer').disabled, 'Archived channel must be read-only');
      check(document.querySelector('#archived-channels [data-channel="gamification"]'), 'Archived channel must remain accessible');
      document.querySelector('[data-open-thread="created-thread"]').click();
      check(document.getElementById('resolve').disabled && document.getElementById('job-status').innerText.includes('архиве'), 'Archived thread must be read-only');
      document.getElementById('channel-settings').click();
      document.getElementById('archive-channel').click(); await wait();
      check(!document.getElementById('composer').disabled && document.querySelector('#channels [data-channel="gamification"]'), 'Restore must retain history and allow chat');
      const thread = data.threads.find(t => t.id === 'created-thread');
      thread.status = 'waiting';
      data.messages.push({ id: 'peer-fixture', space: 'demo-space', channel: 'gamification', thread: thread.id, kind: 'agent', author: 'b', content: 'Контракт совместим. Осталось уточнить подпись для максимального уровня у человека.', createdAt: Date.now() });
      renderTopics(); renderChat();
      const modern = appState;
      receive({ ...modern, snapshot: { ...modern.snapshot, channels: undefined } });
      check(document.getElementById('add-channel').disabled, 'Old servers must not offer unsupported channels');
      receive(modern); navigate('demo-space', null, 'gamification');
      await window.hub.preferences({ theme: 'dark' });
      navigate('demo-space', null, 'gamification');
      return { migration: true, scopedHistory: true, drafts: true, creation: true, posting: true, agentThread: true, subscriptions: true, mute: true, archive: true, restore: true, legacyServer: true };
    })()`);
    console.log("CHANNELS_UI_SMOKE_OK", channels);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-channels.png'), (await window.webContents.capturePage()).toPNG());
    const delivery = await window.webContents.executeJavaScript(`(async () => {
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      const wait = async (condition) => { for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Delivery fixture timeout'); };
      const composer = document.getElementById('composer');
      navigate('demo-space', null, 'gamification'); composer.value = '';
      await window.hub.testConfigurePost({ delayMs: 180 });
      composer.value = 'Мгновенное сообщение'; document.getElementById('composer-form').requestSubmit();
      check(document.querySelector('.delivery.sending') && document.getElementById('messages').innerText.includes('Мгновенное сообщение'), 'Pending message must appear before network confirmation');
      check(composer.value === '', 'Accepted local send must immediately free the composer');
      const send = document.getElementById('send');
      check(send.disabled && send.textContent === 'Отправляется…' && send.getAttribute('aria-busy') === 'true' && !composer.disabled, 'Pending send must lock button, not the next draft');
      composer.value = 'Следующий черновик не потерять';
      send.click();
      document.getElementById('composer-form').requestSubmit();
      for (const modifier of ['ctrlKey', 'metaKey']) composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true }));
      check(composer.value === 'Следующий черновик не потерять' && !(await window.hub.testCalls()).some(c => c.op === 'post' && c.input.content === composer.value), 'Button/form/hotkey re-entry must preserve draft and prevent duplicate sends');
      await wait(() => !document.querySelector('.delivery.sending'));
      check(!send.disabled && send.textContent === 'Отправить ↑' && send.getAttribute('aria-busy') === 'false', 'Acknowledgement restores send button');
      check(composer.value === 'Следующий черновик не потерять', 'Server receipt must not clear newly typed text');
      check([...document.querySelectorAll('.message-body')].filter(m => m.innerText.includes('Мгновенное сообщение')).length === 1, 'Receipt duplicated message');
      check(document.querySelector('.delivery.sent'), 'Acknowledgement must be visible');
      composer.value = '';
      await window.hub.testConfigurePost({ delayMs: 80, loseAck: true });
      composer.value = 'Потерянное подтверждение'; document.getElementById('composer-form').requestSubmit();
      await wait(() => document.querySelector('[data-retry]'));
      const failed = [...outbox.values()].find(p => p.request.content === 'Потерянное подтверждение');
      check(failed?.state === 'failed', 'Failure must remain in the originating chat');
      check(!send.disabled && send.textContent === 'Отправить ↑', 'Failure unlocks send button');
      await window.hub.testConfigurePost({ delayMs: 120 });
      document.querySelector('[data-retry]').click();
      check(send.disabled && send.getAttribute('aria-busy') === 'true', 'Retry also locks composer send');
      await wait(() => !document.querySelector('[data-retry]') && !document.querySelector('.delivery.sending'));
      const attempts = (await window.hub.testCalls()).filter(c => c.op === 'post' && c.input.content === 'Потерянное подтверждение');
      check(attempts.length === 2 && attempts[0].input.requestId === attempts[1].input.requestId, 'Retry must keep immutable request ID');
      check(data.messages.filter(m => m.content === 'Потерянное подтверждение').length === 1, 'Lost acknowledgement duplicated accepted post');
      await window.hub.testConfigurePost({ delayMs: 100, fail: true });
      composer.value = 'Ошибка при смене канала'; document.getElementById('composer-form').requestSubmit();
      navigate('demo-space', 'demo-thread', 'general:demo-space'); composer.value = 'Черновик другого треда';
      check(!send.disabled && send.textContent === 'Отправить ↑', 'One conversation must not block a different thread');
      navigate('demo-space', null, 'gamification'); check(send.disabled, 'Returning to in-flight conversation restores send lock');
      navigate('demo-space', 'demo-thread', 'general:demo-space');
      await wait(() => [...outbox.values()].some(p => p.request.content === 'Ошибка при смене канала' && p.state === 'failed'));
      check(threadId === 'demo-thread' && composer.value === 'Черновик другого треда', 'Late failure must not navigate or replace another draft');
      check(!document.getElementById('messages').innerText.includes('Ошибка при смене канала'), 'Pending message leaked to another channel');
      navigate('demo-space', null, 'gamification'); check(document.querySelector('[data-retry]'), 'Failure disappeared on navigation');
      document.querySelector('[data-retry]').click(); await wait(() => !document.querySelector('[data-retry]'));
      // A slow new-thread acknowledgement must not pull a user out of another chat.
      await window.hub.testConfigurePost({ delayMs: 100 });
      composer.value = '@{a:a} Тест нового треда'; document.getElementById('composer-form').requestSubmit();
      navigate('demo-space', 'demo-thread', 'general:demo-space');
      await wait(() => ![...outbox.values()].some(p => p.request.content.includes('Тест нового треда') && p.state === 'sending'));
      check(threadId === 'demo-thread', 'Late receipt redirected the user');
      return { immediate: true, receipt: true, retrySameId: true, noDuplicates: true, draftPreserved: true, scoped: true, noLateRedirect: true };
    })()`);
    console.log("MESSAGE_DELIVERY_UI_SMOKE_OK", delivery);
    await window.webContents.executeJavaScript(`(() => {
      const check = (condition, detail) => { if (!condition) throw new Error(detail); };
      const d = { version: 1, provider: 'claude', stage: 'response', code: 'network', summary: 'CLI сообщил об ошибке соединения.', hint: 'Проверьте сеть и доступ к провайдеру.', at: Date.now(), exitCode: 0, systemCode: '', signal: '', binary: '[home]\\\\Claude\\\\claude.exe', platform: 'win32', osVersion: '10.0', arch: 'x64', cliVersion: '2.1.258', appVersion: '0.2.6', stdout: '{"result":""}', stderr: 'ECONNRESET <img src=x onerror=alert(1)>', outputTruncated: false };
      data.jobs.push({ id: 'diagnostic-demo', thread: 'demo-thread', agent: 'a', status: 'error', diagnostic: d });
      data.messages.push({ id: 'diagnostic-message', space: 'demo-space', channel: 'general:demo-space', thread: 'demo-thread', kind: 'system', author: 'hub', content: 'Backend Reviewer: CLI сообщил об ошибке соединения. Проверьте доступ к провайдеру.', diagnosticJob: 'diagnostic-demo', createdAt: Date.now() });
      navigate('demo-space', 'demo-thread', 'general:demo-space');
      check(document.querySelector('[data-diagnostic]'), 'Report link missing');
      document.querySelector('[data-diagnostic]').click();
      check(document.getElementById('modal-content').innerText.includes('ECONNRESET'), 'stderr missing');
      check(!document.querySelector('#modal-content img'), 'Diagnostic output must be HTML escaped');
      check(document.getElementById('modal-content').innerText.includes('0.2.6'), 'App version missing');
      check(document.getElementById('modal').open, 'Diagnostic modal did not open');
    })()`);
    await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 150))`);
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-diagnostic.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`(() => {
      closeModal(); delete data.jobs.find(j => j.id === 'diagnostic-demo').diagnostic; renderChat();
      if (document.querySelector('[data-diagnostic]')) throw new Error('Report button visible without permission/report');
    })()`);
    console.log("DIAGNOSTICS_UI_SMOKE_OK");
    await window.webContents.executeJavaScript(`(async () => {
      const saved = structuredClone(data);
      const check = (v, why) => { if (!v) throw new Error(why); };
      const t = data.threads.find(t => t.id === 'demo-thread'); t.status = 'waiting';
      data.participations = [{ id: 'permission', thread: t.id, agent: 'a', status: 'pending', remaining: 0, used: 0, revision: 1,
        request: { id: 'request', requestedBy: 'peer', sourceMessage: 'm3', createdAt: Date.now(), chainRemaining: 12, visited: [] } }];
      data.messages.find(m => m.id === 'm3').content = '<img src=x onerror=alert(1)> Can you review the API?';
      await window.hub.testSetSnapshot(data); navigate('demo-space', 'demo-thread');
      check(document.querySelectorAll('[data-participation][data-action="allow"]').length === 2, 'Owner needs 1 and 3 run controls');
      check(!document.querySelector('.participation-card img'), 'Approval question is untrusted text');
      check(document.getElementById('job-status').innerText.includes('ожидает разрешения'), 'Missing approval status');
      data.agents.find(a => a.id === 'a').owner = 'peer'; renderKey = ''; renderChat();
      check(!document.querySelector('[data-participation]'), 'Non-owner must not see approval buttons');
      data.agents.find(a => a.id === 'a').owner = 'owner'; await window.hub.testSetSnapshot(data); renderKey = ''; renderChat();
      document.querySelector('[data-participation][data-runs="3"]').click();
      await new Promise(r => setTimeout(r, 70));
      const call = (await window.hub.testCalls()).filter(c => c.op === 'participation').at(-1);
      check(call.input.runs === 3 && call.input.revision === 1 && call.input.threadRevision === t.revision, 'Decision must carry scope/revisions');
      check(document.querySelector('.participation-card').innerText.includes('Доступно запусков: 2'), 'Budget remaining missing');
      document.querySelector('[data-action="revoke"]').click(); await new Promise(r => setTimeout(r, 50));
      check(document.querySelector('.participation-card').innerText.includes('Разрешение отозвано'), 'Revocation missing');
      await window.hub.testSetSnapshot(saved);
    })()`);
    console.log('PARTICIPATION_UI_SMOKE_OK');
    await window.webContents.executeJavaScript(`(async () => {
      const check = (value, why) => { if (!value) throw new Error(why); };
      navigate('demo-space', 'demo-thread', 'general:demo-space');
      const input = document.getElementById('composer'), before = (await window.hub.testCalls()).length;
      input.value = 'Печатаю ответ'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const active = (await window.hub.testCalls()).slice(before).find(c => c.op === 'typing' && c.input.active);
      check(active && active.input.thread === 'demo-thread', 'Typing start must carry exact context');
      await window.hub.testSetTyping([{ type: 'typing', employee: 'peer', space: 'demo-space', channel: 'general:demo-space', thread: 'demo-thread', active: true, expiresAt: Date.now() + 5000, version: 1 }]);
      check(document.getElementById('typing-status').innerText.includes('Sam печатает'), 'Peer typing status missing');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 30));
      check((await window.hub.testCalls()).slice(before).some(c => c.op === 'typing' && !c.input.active), 'Typing stop missing');
      await window.hub.testSetTyping([]);
      check(document.getElementById('typing-status').classList.contains('hidden'), 'Expired typing must disappear');
    })()`);
    console.log('REALTIME_TYPING_UI_SMOKE_OK');
    await window.webContents.executeJavaScript(`(async () => {
      const saved = structuredClone(data), check = (v, why) => { if (!v) throw new Error(why); };
      let focused = false;
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      const t = data.threads.find(t => t.id === 'demo-thread'); t.channel = 'general:demo-space';
      data.readPositions = []; data.readBaseline = 0; data.participations = [];
      data.messages = [
        { id: 'root-unread', space: 'demo-space', channel: 'general:demo-space', thread: null, author: 'peer', kind: 'human', seq: 1, createdAt: 1, content: 'General chat message' },
        ...Array.from({ length: 55 }, (_, i) => ({ id: 'scroll-' + i, space: 'demo-space', channel: 'general:demo-space', thread: t.id, author: 'peer', kind: 'human', seq: i + 2, createdAt: i + 2, content: 'Message ' + i + ': long synthetic conversation content. '.repeat(5) }))
      ];
      data.notices = [{ seq: 1, employee: 'owner', space: 'demo-space', channel: 'general:demo-space', thread: t.id, title: 'Thread reply', body: 'Test' },
        { seq: 2, employee: 'owner', space: 'demo-space', channel: 'general:demo-space', thread: null, title: 'Root reply', body: 'Test' }]; data.sequence = 2;
      await window.hub.testSetSnapshot(data); navigate('demo-space', null, 'general:demo-space');
      check(document.querySelector('[data-space="demo-space"] .unread-badge').textContent === '56', 'Space aggregates all unread');
      check(document.querySelector('[data-channel="general:demo-space"] .unread-badge').textContent === '56', 'Channel aggregates root and thread');
      check(document.querySelector('[data-thread="demo-thread"] .unread-badge').textContent === '55', 'Thread has separate unread');
      focused = true; markCurrentRead(); await new Promise(r => setTimeout(r, 80));
      check(document.querySelector('[data-space="demo-space"] .unread-badge').textContent === '55', 'Opening channel must not read its thread');
      navigate('demo-space', t.id, 'general:demo-space');
      const box = document.getElementById('messages');
      check(box.scrollHeight - box.scrollTop - box.clientHeight < 2, 'Thread must open at end before animation');
      check(getComputedStyle(box).scrollBehavior === 'auto', 'History must not animate on navigation');
      markCurrentRead(); await new Promise(r => setTimeout(r, 80));
      check(!document.querySelector('[data-space="demo-space"] .unread-badge'), 'Opening thread must clear its badges');
      check(!document.getElementById('inbox-count').textContent, 'Seen replies must clear notification badge');
      focused = false;
      data.messages.push({ ...data.messages.at(-1), id: 'background-new', seq: 57, content: 'Background arrival' });
      await window.hub.testSetSnapshot(data); await new Promise(r => setTimeout(r, 80));
      check(unreadMessages().length === 1, 'Background window must not read arrivals');
      focused = true; box.scrollTop = 100; const beforeTop = box.scrollTop;
      data.messages.push({ ...data.messages.at(-1), id: 'history-new', seq: 58, content: 'Arrival while reading history' });
      await window.hub.testSetSnapshot(data); await new Promise(r => setTimeout(r, 60));
      check(Math.abs(box.scrollTop - beforeTop) < 2, 'New arrivals must preserve history scroll position');
      check(unreadMessages().length === 2, 'History readers must not consume new messages');
      data.notices.push({ seq: 3, employee: 'owner', space: 'demo-space', channel: 'general:demo-space', thread: t.id, title: 'New', body: 'Test' }); data.sequence = 3;
      await window.hub.testSetSnapshot(data); document.getElementById('inbox').click();
      check(document.querySelectorAll('.inbox-item.unread').length === 1, 'Unread notices group');
      document.getElementById('read-all-notices').click(); await new Promise(r => setTimeout(r, 60));
      check(document.querySelectorAll('.inbox-item.unread').length === 0, 'Mark all notices read');
      check(unreadMessages().length === 2, 'Marking inbox read must not read chat history');
      document.getElementById('clear-read-notices').click(); await new Promise(r => setTimeout(r, 60));
      check(document.querySelectorAll('.inbox-item').length === 0, 'Clear read notices');
      check(data.messages.length === 58, 'Clearing inbox must keep all messages');
      closeModal(); delete document.hasFocus; delete document.visibilityState; await window.hub.testSetSnapshot(saved);
    })()`);
    console.log('UNREAD_SCROLL_NOTICES_UI_SMOKE_OK');
    if (process.argv[2]) {
      await window.webContents.executeJavaScript(`(async () => {
        data.participations = [{ id: 'visual-approval', thread: 'demo-thread', agent: 'a', status: 'pending', remaining: 0, used: 3, revision: 1,
          request: { id: 'visual-request', requestedBy: 'peer', sourceMessage: 'm3', createdAt: Date.now(), chainRemaining: 6, visited: [] } }];
        data.messages.find(m => m.id === 'm3').content = 'Проверь, что новое поле nextLevelXp не ломает старые клиенты. Если контракт совместим, предложи формат ответа для максимального уровня. Пока только разбор, без изменений кода.';
        document.getElementById('toast').classList.add('hidden'); document.getElementById('composer').value = '';
        data.threads.find(t => t.id === 'demo-thread').status = 'waiting';
        await window.hub.testSetSnapshot(data); navigate('demo-space', 'demo-thread');
      })()`);
      for (const theme of ['dark', 'light']) {
        await window.webContents.executeJavaScript(`window.hub.preferences({ theme: '${theme}' })`);
        await window.webContents.executeJavaScript(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        writeFileSync(resolve(process.argv[2]).replace(/\.png$/, '-approval-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
      }
    }
    await window.webContents.executeJavaScript(`window.hub.preferences({ theme: 'system' });`);
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
