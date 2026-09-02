// Synthetic UI fixture only. No coordinator, credentials or real agents.
const { contextBridge } = require("electron");
const now = Date.now();
const me = { id: "owner", name: "Alex" };
const snapshot = {
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
contextBridge.exposeInMainWorld("hub", {
  onChanged: () => {}, onNavigate: () => {}, state: async () => ({ snapshot, connected: true, version: "0.2.1", settings: { agents: [], local: true, url: "http://localhost" } }),
});
