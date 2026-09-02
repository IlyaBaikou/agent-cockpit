// Synthetic UI fixture only. No coordinator, credentials or real agents.
const { contextBridge } = require("electron");
const now = Date.now();
const me = { id: "owner", name: "Alex" };
const snapshot = {
  groupInvitations: [{ id: "demo-invite", owner: "owner", space: "demo-space", createdAt: now, expiresAt: now + 7 * 86400_000, maxUses: 100, uses: 3, revoked: false }],
  me, revision: 1, sequence: 0, notices: [], employees: [me, { id: "peer", name: "Sam" }],
  agents: [{ id: "a", owner: "owner", name: "Backend Codex", executor: "codex", enabled: true, ready: true },
    { id: "b", owner: "peer", name: "Frontend Claude", executor: "claude", enabled: true, ready: true }],
  spaces: [{ id: "demo-space", name: "Интеграция", owner: "owner", members: ["owner", "peer"] }],
  threads: [{ id: "demo-thread", space: "demo-space", owner: "owner", title: "Контракт прогресса · тестовый пример", status: "waiting", revision: 1,
    memory: { version: 1, summary: "**Решение:** сохраняем совместимость текущего API.\n\n**Открытый вопрос:** согласовать название нового поля с фронтендом.\n\nИзменения кода пока не одобрены. Нужен ответ владельца.", citations: ["m1", "m2"], agent: "a", createdAt: now } }],
  messages: [{ id: "g1", space: "demo-space", thread: null, kind: "human", author: "peer", content: "Коллеги, давайте уточним совместимость нового поля. Разбор с агентами — в отдельном треде.", createdAt: now - 60_000 },
    { id: "m1", space: "demo-space", thread: "demo-thread", kind: "human", author: "owner", content: "@{a:a} Обсудите совместимость с фронтендом. Пока без изменений кода.", createdAt: now },
    { id: "m2", space: "demo-space", thread: "demo-thread", kind: "agent", author: "a", content: "Контракт проверен. @{a:b}, можем добавить необязательное поле, сохранив старый формат?\n\n```ts\ninterface Progress {\n  level: number;\n  nextLevelXp?: number;\n}\n```", createdAt: now },
    { id: "m3", space: "demo-space", thread: "demo-thread", kind: "agent", author: "b", content: "Да, старые клиенты продолжат работать. Нужно решение человека по названию поля.", createdAt: now }],
  jobs: [{ id: "j", thread: "demo-thread", agent: "a", status: "done", mode: "read", contextStats: { historyChars: 52000, promptChars: 17000, summaryInputChars: 33000, summaryOutputChars: 1300, compacted: true, memoryReused: false } }],
};
const settings = { agents: [], local: false, url: "https://hub.example", theme: "system", notifications: true };
const state = () => ({ snapshot, connected: true, version: "0.2.4", settings });
let changed = () => {};
const calls = [];
contextBridge.exposeInMainWorld("hub", {
  onChanged: (callback) => { changed = callback; }, onNavigate: () => {}, state: async () => state(),
  preferences: async (input) => { calls.push({ op: "preferences", input }); Object.assign(settings, input); changed(state()); },
  invite: async (input) => { calls.push({ op: "invite", input }); return { copied: true }; },
  joinInvite: async (input) => { calls.push({ op: "joinInvite", input }); return { space: "demo-space" }; },
  call: async (op, input) => { calls.push({ op, input }); if (op === "revoke-invite") { snapshot.groupInvitations[0].revoked = true; changed(state()); } return {}; },
  connect: async (input) => { calls.push({ op: "connect", input }); return state(); },
  testCalls: () => calls,
});
