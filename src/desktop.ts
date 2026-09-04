import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, Tray } from "electron";
import { AgentExecutionError, agentFailure, type AgentDiagnostic } from "./agents/diagnostics.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { CollaborationClient, hubUrl } from "./collab/client.js";
import { EmployeeRunner, checkLocalAgent, type LocalAgent } from "./collab/runner.js";
import { SqliteStateStore } from "./collab/store.js";
import { CollaborationService } from "./collab/service.js";
import { collaborationHttp } from "./collab/http.js";
import { field, requireValue, type Agent, type LiveEvent, type Snapshot } from "./collab/model.js";
import { pendingNotices } from "./collab/notifications.js";
import { probeNotification } from "./notification-probe.js";
import { decodeInvitation, encodeInvitation } from "./collab/invitations.js";

type Settings = {
  version: 2; url: string; token: string; device: string; notifications: boolean;
  cursor: number | null; agents: LocalAgent[]; worktrees: Record<string, string>; local: boolean;
  theme: "system" | "light" | "dark";
};
let settings: Settings;
let configPath = "";
let window: BrowserWindow | undefined;
let windowReady = false;
let tray: Tray | undefined;
let client: CollaborationClient | undefined;
let snapshot: Snapshot | undefined;
let connectionError = "";
let quitting = false;
let syncing: Promise<void> | undefined;
let localServer: Server | undefined;
let localStore: SqliteStateStore | undefined;
let poll: NodeJS.Timeout | undefined;
let typingSweep: NodeJS.Timeout | undefined;
let eventsAbort: AbortController | undefined;
let realtime = false;
const typingPresence = new Map<string, Extract<LiveEvent, { type: "typing" }>>();
const typingVersions = new Map<string, number>();
const runners = new Map<string, EmployeeRunner>();
const health = new Map<string, { ready: boolean; detail: string; diagnostic?: AgentDiagnostic }>();
let saveQueue = Promise.resolve();

// Finder/Start Menu launches often have a minimal PATH. No login shell is executed.
process.env.PATH = [...new Set([
  ...String(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"),
  ...(process.platform === "win32" ? [join(process.env.APPDATA ?? homedir(), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
])].filter(Boolean).join(delimiter);
app.setName("Agent Hub");
app.setAppUserModelId("com.animaplay.agenthub");
if (process.argv.includes("--smoke-test")) {
  const smokeProfile = await mkdtemp(join(tmpdir(), "agent-hub-package-smoke-"));
  app.setPath("userData", smokeProfile); app.setPath("sessionData", smokeProfile);
  if (process.platform === "win32") app.disableHardwareAcceleration();
}
// Explicit development profile; never discover/copy a production profile.
const profileIndex = process.argv.indexOf("--profile-dir");
if (profileIndex >= 0) {
  const profile = resolve(field(process.argv[profileIndex + 1], "Каталог отдельного профиля", 4096));
  await mkdir(profile, { recursive: true });
  app.setPath("userData", profile); app.setPath("sessionData", profile);
}
if (!process.argv.includes("--smoke-test") && !app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => show());

function show(): void {
  if (!windowReady) return;
  window?.show(); window?.focus();
}
function state(): unknown {
  return { connected: Boolean(snapshot) && !connectionError, error: connectionError, snapshot,
    settings: { url: settings.url, device: settings.device, notifications: settings.notifications, local: settings.local, agents: settings.agents, theme: settings.theme },
    health: Object.fromEntries(health), notificationsSupported: Notification.isSupported(), version: app.getVersion(), realtime,
    typing: [...typingPresence.values()].filter((entry) => entry.active && entry.expiresAt > Date.now()) };
}
function changed(): void { window?.webContents.send("hub:changed", state()); }
function save(): Promise<void> {
  requireValue(safeStorage.isEncryptionAvailable(), "Хранилище ключей ОС недоступно. Не сохраняю токен открытым текстом.");
  const serialized = JSON.stringify({ ...settings, token: safeStorage.encryptString(settings.token).toString("base64") }, null, 2);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await writeFile(`${configPath}.pending`, serialized, { mode: 0o600 });
    await rename(`${configPath}.pending`, configPath);
  });
  return saveQueue;
}
async function load(): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  configPath = join(app.getPath("userData"), "connection-v2.json");
  settings = { version: 2, url: "", token: "", device: randomUUID(), notifications: true, cursor: null, agents: [], worktrees: {}, local: false, theme: "system" };
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as Settings;
    requireValue(stored.version === 2 && Array.isArray(stored.agents), "Настройки повреждены");
    settings = { ...settings, ...stored, token: safeStorage.decryptString(Buffer.from(stored.token, "base64")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Не удалось прочитать защищённые настройки. Оригинал сохранён; восстановите доступ к хранилищу ключей ОС.");
  }
  if (!["system", "light", "dark"].includes(settings.theme)) settings.theme = "system";
  if (settings.agents.length && !settings.agents.some((agent) => agent.primary)) settings.agents[0]!.primary = true;
  nativeTheme.themeSource = settings.theme;
  // Explicit migration only; the installer never searches for or copies credentials.
  const index = process.argv.indexOf("--import-legacy");
  if (!settings.url && index >= 0 && process.argv[index + 1]) {
    const legacy = JSON.parse(await readFile(resolve(process.argv[index + 1]!), "utf8")) as { serverUrl: string; controlToken: string };
    settings.url = hubUrl(legacy.serverUrl); settings.token = legacy.controlToken;
    await save();
  }
}
async function startLocal(): Promise<void> {
  localStore = new SqliteStateStore(join(app.getPath("userData"), "pilot.sqlite"));
  const service = new CollaborationService(localStore, [{ actor: "local", token: settings.token }]);
  localServer = createServer((req, res) => { void collaborationHttp(service, req, res); });
  localServer.requestTimeout = 30_000;
  await new Promise<void>((resolvePromise, reject) => { localServer!.once("error", reject); localServer!.listen(0, "127.0.0.1", resolvePromise); });
  const address = localServer.address();
  requireValue(address && typeof address !== "string", "Не удалось запустить локальный хаб");
  settings.url = `http://127.0.0.1:${address.port}`;
}
async function stopRunners(): Promise<void> { for (const runner of runners.values()) runner.stop(); runners.clear(); }
function startRunners(): void {
  if (!client || !snapshot || snapshot.participationVersion !== 1) return;
  for (const agent of settings.agents) {
    if (!agent.enabled || runners.has(agent.id)) continue;
    const remote = snapshot.agents.find((a) => a.id === agent.id && a.owner === snapshot!.me.id && a.device === settings.device);
    if (!remote?.enabled) continue;
    const runner = new EmployeeRunner(client, agent, settings.device, join(app.getPath("userData"), "worktrees"), undefined, app.getVersion());
    runner.on("health", (value: { id: string; ready: boolean; detail: string }) => { health.set(value.id, value); changed(); });
    runner.on("workspace", (value: { job: string; path: string }) => { settings.worktrees[value.job] = value.path; void save().catch((e: Error) => { connectionError = e.message; changed(); }); });
    runners.set(agent.id, runner); runner.start();
  }
}
async function sync(fresh = false): Promise<void> {
  if (!client || quitting) return;
  if (syncing) { await syncing; if (fresh) await sync(); return; }
  const task = performSync(); syncing = task;
  try { await task; } finally { if (syncing === task) syncing = undefined; }
}
async function performSync(): Promise<void> {
  try {
    snapshot = await client!.call<Snapshot>("sync", { channelVersion: 1 }); connectionError = "";
    if (snapshot.participationVersion !== 1) {
      await stopRunners();
      connectionError = "На сервере нет согласования участия. Обновите координатор до 0.2.7; локальные раннеры остановлены";
    }
    const notices = pendingNotices(snapshot.notices, settings.cursor, snapshot.sequence);
    if (notices.cursor !== settings.cursor) {
      settings.cursor = notices.cursor; await save();
      if (settings.notifications && Notification.isSupported()) for (const notice of notices.pending.slice(-5)) {
        const notification = new Notification({ title: notice.title, body: notice.title === "Нужно ваше решение" ? "Откройте тред, чтобы ответить и продолжить работу." : "В вашем спейсе есть обновление. Нажмите, чтобы открыть.", silent: false });
        notification.on("click", () => { show(); window?.webContents.send("hub:navigate", { space: notice.space, thread: notice.thread, channel: notice.channel }); });
        notification.on("failed", (_event, error) => { health.set("notifications", { ready: false, detail: error }); changed(); });
        notification.show();
      }
    }
    startRunners(); changed();
  } catch (error) { connectionError = error instanceof Error ? error.message : String(error); changed(); }
}

function stopEvents(): void {
  eventsAbort?.abort(); eventsAbort = undefined; realtime = false;
  typingPresence.clear(); typingVersions.clear();
}
function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) return resolvePromise();
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolvePromise(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
function receiveLiveEvent(event: LiveEvent): void {
  if (event.type === "ready") { realtime = true; changed(); return; }
  if (event.type === "change") {
    void sync(true).then(() => { for (const runner of runners.values()) runner.wake(); });
    return;
  }
  if (event.employee === snapshot?.me.id) return;
  const previous = typingVersions.get(event.employee) ?? 0;
  if (event.version < previous) return;
  typingVersions.set(event.employee, event.version);
  if (event.active && event.expiresAt > Date.now()) typingPresence.set(event.employee, event);
  else typingPresence.delete(event.employee);
  changed();
}
function startEvents(): void {
  stopEvents();
  const source = client;
  if (!source || quitting) return;
  const controller = new AbortController(); eventsAbort = controller;
  void (async () => {
    let retry = 500;
    while (!controller.signal.aborted && client === source && !quitting) {
      try {
        await source.events(controller.signal, (event) => { retry = 500; receiveLiveEvent(event); });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Realtime event stream disconnected", error instanceof Error ? error.message : String(error));
      }
      if (controller.signal.aborted) return;
      realtime = false; typingPresence.clear(); changed();
      await waitForRetry(retry, controller.signal); retry = Math.min(5_000, retry * 2);
    }
  })();
}

function handlers(): void {
  const register = (name: string, handler: (...args: any[]) => unknown): void => {
    ipcMain.handle(name, (event, ...args) => {
      requireValue(event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame, "Untrusted sender", 403);
      return handler(...args);
    });
  };
  register("hub:state", () => state());
  register("hub:connect", async (input: { url: string; credential: string; type: string; name?: string }) => {
    requireValue(safeStorage.isEncryptionAvailable(), "Сначала разблокируйте хранилище ключей ОС; приглашение пока не использовано.");
    requireValue(!settings.agents.length, "Для смены хаба используйте отдельный профиль приложения; локальные агенты уже привязаны к текущему хабу.");
    let url = input.url, credential = input.credential;
    if (credential.startsWith("AH2:")) {
      const invite = decodeInvitation(credential);
      url = invite.url; credential = invite.code; input.type = "invite";
    }
    const candidate = new CollaborationClient(url, input.type === "invite" ? "" : credential);
    const token = input.type === "invite" ? (await candidate.enroll(credential, input.name)).token : credential;
    const connected = new CollaborationClient(url, token);
    const result = await connected.call<Snapshot>("sync", { channelVersion: 1 });
    await stopRunners(); stopEvents();
    settings.url = connected.url; settings.token = token; settings.local = false; settings.cursor = null;
    await save(); client = connected; snapshot = result;
    await sync(true); startEvents(); return state();
  });
  register("hub:local", async () => {
    requireValue(!settings.url, "Хаб уже подключён");
    settings.token = randomBytes(32).toString("hex"); settings.local = true;
    await startLocal(); await save(); client = new CollaborationClient(settings.url, settings.token); await sync(); startEvents(); return state();
  });
  register("hub:typing", async (input: { space: string; channel: string; thread: string | null; active: boolean; version: number }) => {
    requireValue(client && snapshot, "Сначала подключитесь к хабу");
    await client.typing(input);
  });
  register("hub:call", async (op: string, input: Record<string, unknown>) => {
    requireValue(client && ["post", "space", "members", "thread-state", "profile", "revoke-invite", "channel", "channel-state", "channel-preference", "thread-subscription", "participation", "read", "notices"].includes(op), "Недоступная операция");
    requireValue(op !== "post" || snapshot?.participationVersion === 1, "Сначала обновите координатор до 0.2.7");
    const result = await client.call(op, { ...input, requestId: typeof input.requestId === "string" ? input.requestId : randomUUID() });
    // A post is acknowledged by the coordinator already. Do not hold its receipt
    // behind another full poll. The renderer reconciles it by request/message ID.
    if (op === "post" || op === "read") void sync(true);
    else await sync(true);
    return result;
  });
  register("hub:agent", async (input: LocalAgent) => {
    requireValue(client && snapshot, "Сначала подключитесь к хабу");
    const directory = await realpath(resolve(field(input.directory, "Рабочая папка", 4096)));
    requireValue((await stat(directory)).isDirectory(), "Выберите рабочую папку");
    requireValue(["codex", "claude", "cursor"].includes(input.executor), "Неизвестный исполнитель");
    const id = input.id || randomUUID();
    const agent: LocalAgent = { id, name: field(input.name, "Имя", 80), description: String(input.description ?? "").slice(0, 2000), directory, binary: String(input.binary ?? "").trim(), executor: input.executor, enabled: input.enabled === true, allowWrite: input.allowWrite === true, fallback: input.fallback || null, primary: input.primary === true };
    const registered = await client.call<Agent>("agent", { ...agent, device: settings.device, directory: undefined, binary: undefined });
    agent.primary = registered.primary === true;
    runners.get(id)?.stop(); runners.delete(id);
    settings.agents = [...settings.agents.filter((a) => a.id !== id).map((a) => registered.primary ? { ...a, primary: false } : a), agent]; await save(); await sync(true); return agent;
  });
  register("hub:check", async (input: LocalAgent) => {
    requireValue(["codex", "claude", "cursor"].includes(input.executor), "Неизвестный исполнитель");
    try { return { ok: true, detail: await checkLocalAgent(input) }; }
    catch (error) {
      const failure = error instanceof AgentExecutionError ? error : agentFailure({ provider: input.executor, stage: "version", error });
      failure.diagnostic.appVersion = app.getVersion();
      return { ok: false, detail: failure.message, diagnostic: failure.diagnostic };
    }
  });
  register("hub:directory", async () => (await dialog.showOpenDialog(window!, { properties: ["openDirectory"] })).filePaths[0] ?? "");
  register("hub:binary", async () => (await dialog.showOpenDialog(window!, { properties: ["openFile"] })).filePaths[0] ?? "");
  register("hub:preferences", async (input: { notifications?: boolean; theme?: Settings["theme"] }) => {
    if (input.theme !== undefined) requireValue(["system", "light", "dark"].includes(input.theme), "Неизвестная тема");
    if (input.notifications !== undefined) settings.notifications = input.notifications === true;
    if (input.theme !== undefined) { settings.theme = input.theme; nativeTheme.themeSource = input.theme; }
    await save(); changed();
  });
  register("hub:notification-test", async () => {
    requireValue(Notification.isSupported(), "Системные уведомления недоступны");
    try {
      const result = await probeNotification(new Notification({ title: "Agent Hub", body: "Тестовое уведомление. Здесь будут упоминания, ответы и запросы решения." }));
      health.set("notifications", { ready: result.status === "accepted", detail: result.detail }); changed();
      return result;
    } catch (error) {
      health.set("notifications", { ready: false, detail: error instanceof Error ? error.message : String(error) }); changed(); throw error;
    }
  });
  register("hub:invite", async (input: { kind: "personal" | "group"; name?: string; space?: string; days?: number; maxUses?: number }) => {
    requireValue(client && !settings.local, "Приглашения коллег доступны в удалённом хабе");
    requireValue(input.kind === "personal" || input.kind === "group", "Выберите тип приглашения");
    const group = input.kind === "group";
    const result = await client.call<{ code: string; id?: string }>(group ? "group-invite" : "invite", { ...input, requestId: randomUUID() });
    clipboard.writeText(encodeInvitation(settings.url, result.code, group)); await sync(true); return { copied: true, id: result.id };
  });
  register("hub:join-invite", async (value: string) => {
    requireValue(client && snapshot, "Сначала подключитесь к хабу");
    const invite = decodeInvitation(value);
    requireValue(invite.url === client.url, "Это приглашение в другой хаб. Текущий аккаунт не изменён");
    const result = await client.call("join-invite", { code: invite.code });
    await sync(true); return result;
  });
  register("hub:link", async (url: string) => {
    const parsed = new URL(url); requireValue(["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password, "Небезопасная ссылка");
    await shell.openExternal(parsed.href);
  });
  register("hub:worktree", async (job: string) => {
    const path = settings.worktrees[job]; requireValue(path, "Рабочая копия находится на компьютере владельца агента");
    const error = await shell.openPath(path); if (error) throw new Error(error);
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({ show: false, width: 1440, height: 920, minWidth: 1080, minHeight: 700, title: "Agent Hub", backgroundColor: nativeTheme.shouldUseDarkColors ? "#171a27" : "#f6f7fb", webPreferences: { preload: join(app.getAppPath(), "dist/src/desktop-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  handlers();
  // Commit the real document before showing a window or initializing native menus.
  // A visible initial about:blank could race Electron's sandbox startup data.
  await window.loadFile(join(app.getAppPath(), "ui/hub.html"));
  windowReady = true;
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVQ4T2NkoBAwUqifYdQABob/DP8ZGBgYRsQAkgxgYWBg+M/AwMDIyMjAYBaMFoAwNoBmgiEwGg0YBgYGABX6DBGTIWcAAAAASUVORK5CYII=");
  tray = new Tray(icon); tray.setToolTip("Agent Hub — агенты работают, пока приложение запущено");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Открыть Agent Hub", click: show }, { label: "Выйти и остановить агентов", click: () => app.quit() }]));
  tray.on("click", show);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Agent Hub", submenu: [{ label: "Открыть", click: show }, { role: "quit", label: "Выйти и остановить агентов" }] }, { role: "editMenu" }, { role: "viewMenu" }]));
  if (!quitting) show();
}

void app.whenReady().then(async () => {
  try {
    if (process.argv.includes("--smoke-test")) {
      await readFile(join(app.getAppPath(), "ui/hub.html"));
      await readFile(join(app.getAppPath(), "dist/src/desktop-preload.cjs"));
      const probe = new SqliteStateStore(":memory:");
      await probe.read((s) => requireValue(s.version === 2, "Invalid packaged store"));
      await probe.close();
      // Exercise the signed renderer too: file checks alone miss helper launch failures.
      ipcMain.handle("hub:state", () => ({ connected: false, settings: { url: "", agents: [], notifications: false, theme: "system" }, health: {}, version: app.getVersion() }));
      const renderer = new BrowserWindow({ show: false, webPreferences: { preload: join(app.getAppPath(), "dist/src/desktop-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const timeout = setTimeout(() => rejectProbe(new Error("Packaged renderer did not load within 20 seconds")), 20_000);
        renderer.webContents.once("render-process-gone", (_event, details) => { clearTimeout(timeout); rejectProbe(new Error(`Packaged renderer failed: ${details.reason} (${details.exitCode})`)); });
        renderer.loadFile(join(app.getAppPath(), "ui/hub.html")).then(() => { clearTimeout(timeout); resolveProbe(); }, (error) => { clearTimeout(timeout); rejectProbe(error); });
      });
      const ready = await renderer.webContents.executeJavaScript(`new Promise(resolve => {
        let attempts = 0;
        const check = () => {
          if (window.hub && !document.getElementById('onboarding')?.classList.contains('hidden')) return resolve(true);
          if (++attempts >= 50) return resolve(false);
          setTimeout(check, 20);
        };
        check();
      })`);
      requireValue(ready, "Packaged onboarding / preload did not initialize");
      renderer.destroy();
      console.log("PACKAGE_SMOKE_OK"); app.exit(0); return;
    }
    await load(); if (settings.local) await startLocal();
    await createWindow();
    if (settings.url) client = new CollaborationClient(settings.url, settings.token);
    await sync(); startEvents();
    poll = setInterval(() => void sync(), 30_000);
    typingSweep = setInterval(() => {
      let expired = false;
      for (const [employee, entry] of typingPresence) if (entry.expiresAt <= Date.now()) { typingPresence.delete(employee); expired = true; }
      if (expired) changed();
    }, 1_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--smoke-test")) console.error(message);
    else dialog.showErrorBox("Agent Hub", message);
    app.exit(1);
  }
});
app.on("activate", show);
app.on("before-quit", (event) => {
  if (quitting) return; event.preventDefault(); quitting = true;
  clearInterval(poll); clearInterval(typingSweep); stopEvents(); void stopRunners();
  localServer?.close(); void localStore?.close();
  void saveQueue.finally(() => setTimeout(() => app.exit(0), 2500));
});
