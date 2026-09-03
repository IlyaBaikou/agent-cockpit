// Synthetic UI fixture only. No coordinator, credentials or real agents.
const { contextBridge } = require("electron");
const now = Date.now();
let postBehavior = {};
let notificationBehavior = {};
const receipts = new Map();
const me = { id: "owner", name: "Alex" };
const snapshot = {
  participationVersion: 1, participations: [], readVersion: 1, readBaseline: 0, readPositions: [],
  groupInvitations: [{ id: "demo-invite", owner: "owner", space: "demo-space", createdAt: now, expiresAt: now + 7 * 86400_000, maxUses: 100, uses: 3, revoked: false }],
  me, revision: 1, sequence: 0, notices: [], employees: [me, { id: "peer", name: "Sam" }],
  agents: [{ id: "a", owner: "owner", name: "Backend Codex", executor: "codex", enabled: true, ready: true, primary: true },
    { id: "b", owner: "peer", name: "Frontend Claude", executor: "claude", enabled: true, ready: true, primary: true }],
  spaces: [{ id: "demo-space", name: "Интеграция", owner: "owner", members: ["owner", "peer"] }],
  channels: [{ id: "general:demo-space", space: "demo-space", name: "Общий", description: "Объявления и вопросы команды", owner: "owner", archived: false, general: true },
    { id: "gamification", space: "demo-space", name: "Геймификация", description: "Прогресс, уровни и награды", owner: "owner", archived: false, general: false },
    { id: "game-one", space: "demo-space", name: "Игра 1", description: "Интеграция игрового клиента", owner: "peer", archived: false, general: false },
    { id: "math", space: "demo-space", name: "Математика", description: "Вероятности и расчёты", owner: "owner", archived: false, general: false }],
  channelPreferences: [], threadSubscriptions: [{ thread: "demo-thread", employee: "owner", following: true }],
  threads: [{ id: "demo-thread", space: "demo-space", owner: "owner", title: "Контракт прогресса · тестовый пример", status: "waiting", revision: 1,
    memory: { version: 1, summary: "**Решение:** сохраняем совместимость текущего API.\n\n**Открытый вопрос:** согласовать название нового поля с фронтендом.\n\nИзменения кода пока не одобрены. Нужен ответ владельца.", citations: ["m1", "m2"], agent: "a", createdAt: now } }],
  messages: [{ id: "g1", space: "demo-space", thread: null, kind: "human", author: "peer", content: "Коллеги, давайте уточним совместимость нового поля. Разбор с агентами — в отдельном треде.", createdAt: now - 60_000 },
    { id: "m1", space: "demo-space", thread: "demo-thread", kind: "human", author: "owner", content: "@{a:a} Обсудите совместимость с фронтендом. Пока без изменений кода.", createdAt: now },
    { id: "m2", space: "demo-space", thread: "demo-thread", kind: "agent", author: "a", content: "Контракт проверен. @{a:b}, можем добавить необязательное поле, сохранив старый формат?\n\n```ts\ninterface Progress {\n  level: number;\n  nextLevelXp?: number;\n}\n```", createdAt: now },
    { id: "m3", space: "demo-space", thread: "demo-thread", kind: "agent", author: "b", content: "Да, старые клиенты продолжат работать. Нужно решение человека по названию поля.", createdAt: now }],
  jobs: [{ id: "j", thread: "demo-thread", agent: "a", status: "done", mode: "read", contextStats: { historyChars: 52000, promptChars: 17000, summaryInputChars: 33000, summaryOutputChars: 1300, compacted: true, memoryReused: false } }],
};
snapshot.messages.forEach((m, i) => { m.seq = i + 1; });
const settings = { agents: [], local: false, url: "https://hub.example", theme: "system", notifications: true };
const state = () => ({ snapshot, connected: true, version: "0.2.7", settings });
let changed = () => {};
const calls = [];
let messageSequence = 0;
contextBridge.exposeInMainWorld("hub", {
  onChanged: (callback) => { changed = callback; }, onNavigate: () => {}, state: async () => state(),
  preferences: async (input) => { calls.push({ op: "preferences", input }); Object.assign(settings, input); changed(state()); },
  invite: async (input) => { calls.push({ op: "invite", input }); return { copied: true }; },
  joinInvite: async (input) => { calls.push({ op: "joinInvite", input }); return { space: "demo-space" }; },
  call: async (op, input) => {
    calls.push({ op, input }); let result = {};
    const behavior = op === "post" ? postBehavior : {};
    if (op === "post") {
      postBehavior = {};
      if (behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      if (behavior.fail) throw new Error("Соединение прервано: тест отправки");
      if (receipts.has(input.requestId)) { changed(state()); return receipts.get(input.requestId); }
    }
    if (op === "revoke-invite") snapshot.groupInvitations[0].revoked = true;
    if (op === 'read') {
      const message = snapshot.messages.find(m => m.id === input.through);
      if (message) {
        const position = snapshot.readPositions.find(p => p.channel === input.channel && p.thread === input.thread);
        if (position) position.through = Math.max(position.through, message.seq);
        else snapshot.readPositions.push({ employee: snapshot.me.id, channel: input.channel, thread: input.thread, through: message.seq });
      }
      snapshot.notices.filter(n => (n.channel ?? 'general:demo-space') === input.channel && n.thread === input.thread && n.seq <= input.noticeThrough).forEach(n => n.read = true);
    }
    if (op === 'notices') {
      if (input.action === 'read') snapshot.notices.filter(n => n.seq <= input.through).forEach(n => n.read = true);
      else snapshot.notices = snapshot.notices.filter(n => !(n.read && n.seq <= input.through));
    }
    if (op === 'participation') {
      const p = snapshot.participations.find(p => p.id === input.id);
      if (input.action === 'allow') { p.status = 'allowed'; p.remaining = input.runs - 1; p.used++; delete p.request; }
      else if (input.action === 'deny') { p.status = 'denied'; p.remaining = 0; }
      else { p.status = 'revoked'; p.remaining = 0; delete p.request; }
      p.revision++;
    }
    if (op === "channel") {
      const c = snapshot.channels.find(c => c.id === input.id) ?? { id: "created-channel", space: input.space, owner: "owner", general: false, archived: false };
      Object.assign(c, { name: input.name, description: input.description }); if (!input.id) snapshot.channels.push(c); result = c;
    }
    if (op === "channel-state") snapshot.channels.find(c => c.id === input.channel).archived = input.archived;
    if (op === "channel-preference") snapshot.channelPreferences = [{ employee: "owner", channel: input.channel, muted: input.muted }];
    if (op === "thread-subscription") snapshot.threadSubscriptions = [{ employee: "owner", thread: input.thread, following: input.following }];
    if (op === "post") {
      const thread = !input.thread && (input.newThread || input.content.includes('@{a:')) ? { id: "created-thread", space: input.space, channel: input.channel, title: input.title ?? "Проверка контракта прогресса", owner: "owner", status: "open", createdAt: Date.now() } : snapshot.threads.find(t => t.id === input.thread) ?? null;
      if (thread && !snapshot.threads.some(t => t.id === thread.id)) snapshot.threads.push(thread);
      const message = { id: `created-message-${++messageSequence}`, space: input.space, channel: input.channel, thread: thread?.id ?? input.thread ?? null, kind: "human", author: "owner", content: input.content, createdAt: Date.now(), clientRequestId: input.requestId };
      snapshot.messages.push(message); result = { thread, message };
      message.seq = Math.max(0, ...snapshot.messages.map(m => m.seq ?? 0)) + 1;
      if (input.requestId) receipts.set(input.requestId, result);
      if (behavior.loseAck) throw new Error("Подтверждение потеряно: тест отправки");
    }
    changed(state()); return result;
  },
  connect: async (input) => { calls.push({ op: "connect", input }); return state(); },
  testCalls: () => calls,
  testConfigurePost: (behavior) => { postBehavior = behavior; },
  testConfigureNotification: (behavior) => { notificationBehavior = behavior; },
  testNotification: async () => {
    calls.push({ op: 'notification-test' }); const behavior = notificationBehavior;
    if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
    if (behavior.fail) throw new Error('Система отклонила уведомление: invalid signature <img src=x>');
    return { status: behavior.unconfirmed ? 'unconfirmed' : 'accepted', detail: behavior.unconfirmed ? 'Доставка не подтверждена.' : 'Система приняла тестовое уведомление.' };
  },
  testSetSnapshot: (value) => { Object.assign(snapshot, value); changed(state()); },
});
