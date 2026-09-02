import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CollaborationClient, hubUrl } from "./collab/client.js";
import { EmployeeRunner, checkLocalAgent, type LocalAgent } from "./collab/runner.js";
import { SqliteStateStore } from "./collab/store.js";
import { CollaborationService } from "./collab/service.js";
import { collaborationHttp } from "./collab/http.js";
import { field, requireValue, type Agent, type Snapshot } from "./collab/model.js";
import { pendingNotices } from "./collab/notifications.js";

type Settings = {
  version: 2; url: string; token: string; device: string; notifications: boolean;
  cursor: number | null; agents: LocalAgent[]; worktrees: Record<string, string>; local: boolean;
};
let settings: Settings;
let configPath = "";
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let client: CollaborationClient | undefined;
let snapshot: Snapshot | undefined;
let connectionError = "";
let quitting = false;
let syncing = false;
let localServer: Server | undefined;
let localStore: SqliteStateStore | undefined;
let poll: NodeJS.Timeout | undefined;
const runners = new Map<string, EmployeeRunner>();
const health = new Map<string, { ready: boolean; detail: string }>();
let saveQueue = Promise.resolve();

// Finder/Start Menu launches often have a minimal PATH. No login shell is executed.
process.env.PATH = [...new Set([
  ...String(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"),
  ...(process.platform === "win32" ? [join(process.env.APPDATA ?? homedir(), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
])].filter(Boolean).join(delimiter);
app.setName("Agent Hub");
app.setAppUserModelId("com.animaplay.agenthub");
if (!process.argv.includes("--smoke-test") && !app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => show());

function show(): void { window?.show(); window?.focus(); }
function state(): unknown {
  return { connected: Boolean(snapshot) && !connectionError, error: connectionError, snapshot,
    settings: { url: settings.url, device: settings.device, notifications: settings.notifications, local: settings.local, agents: settings.agents },
    health: Object.fromEntries(health), notificationsSupported: Notification.isSupported(), version: app.getVersion() };
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
  settings = { version: 2, url: "", token: "", device: randomUUID(), notifications: true, cursor: null, agents: [], worktrees: {}, local: false };
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as Settings;
    requireValue(stored.version === 2 && Array.isArray(stored.agents), "Настройки повреждены");
    settings = { ...settings, ...stored, token: safeStorage.decryptString(Buffer.from(stored.token, "base64")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Не удалось прочитать защищённые настройки. Оригинал сохранён; восстановите доступ к хранилищу ключей ОС.");
  }
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
  if (!client || !snapshot) return;
  for (const agent of settings.agents) {
    if (!agent.enabled || runners.has(agent.id)) continue;
    const remote = snapshot.agents.find((a) => a.id === agent.id && a.owner === snapshot!.me.id && a.device === settings.device);
    if (!remote?.enabled) continue;
    const runner = new EmployeeRunner(client, agent, settings.device, join(app.getPath("userData"), "worktrees"));
    runner.on("health", (value: { id: string; ready: boolean; detail: string }) => { health.set(value.id, value); changed(); });
    runner.on("workspace", (value: { job: string; path: string }) => { settings.worktrees[value.job] = value.path; void save().catch((e: Error) => { connectionError = e.message; changed(); }); });
    runners.set(agent.id, runner); runner.start();
  }
}
async function sync(): Promise<void> {
  if (!client || syncing || quitting) return;
  syncing = true;
  try {
    snapshot = await client.call<Snapshot>("sync"); connectionError = "";
    const notices = pendingNotices(snapshot.notices, settings.cursor, snapshot.sequence);
    if (notices.cursor !== settings.cursor) {
      settings.cursor = notices.cursor; await save();
      if (settings.notifications && Notification.isSupported()) for (const notice of notices.pending.slice(-5)) {
        const notification = new Notification({ title: notice.title, body: notice.title === "Нужно ваше решение" ? "Откройте тред, чтобы ответить и продолжить работу." : "В вашем спейсе есть обновление. Нажмите, чтобы открыть.", silent: false });
        notification.on("click", () => { show(); window?.webContents.send("hub:navigate", { space: notice.space, thread: notice.thread }); });
        notification.on("failed", (_event, error) => { health.set("notifications", { ready: false, detail: error }); changed(); });
        notification.show();
      }
    }
    startRunners(); changed();
  } catch (error) { connectionError = error instanceof Error ? error.message : String(error); changed(); }
  finally { syncing = false; }
}

function handlers(): void {
  const register = (name: string, handler: (...args: any[]) => unknown): void => {
    ipcMain.handle(name, (event, ...args) => {
      requireValue(event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame, "Untrusted sender", 403);
      return handler(...args);
    });
  };
  register("hub:state", () => state());
  register("hub:connect", async (input: { url: string; credential: string; type: string }) => {
    requireValue(safeStorage.isEncryptionAvailable(), "Сначала разблокируйте хранилище ключей ОС; приглашение пока не использовано.");
    requireValue(!settings.agents.length, "Для смены хаба используйте отдельный профиль приложения; локальные агенты уже привязаны к текущему хабу.");
    let url = input.url, credential = input.credential;
    if (credential.startsWith("AH2:")) {
      const invite = JSON.parse(Buffer.from(credential.slice(4), "base64url").toString("utf8")) as { url: string; code: string };
      url = invite.url; credential = invite.code; input.type = "invite";
    }
    const candidate = new CollaborationClient(url, input.type === "invite" ? "" : credential);
    const token = input.type === "invite" ? (await candidate.enroll(credential)).token : credential;
    const connected = new CollaborationClient(url, token);
    const result = await connected.call<Snapshot>("sync");
    await stopRunners();
    settings.url = connected.url; settings.token = token; settings.local = false; settings.cursor = null;
    await save(); client = connected; snapshot = result;
    await sync(); return state();
  });
  register("hub:local", async () => {
    requireValue(!settings.url, "Хаб уже подключён");
    settings.token = randomBytes(32).toString("hex"); settings.local = true;
    await startLocal(); await save(); client = new CollaborationClient(settings.url, settings.token); await sync(); return state();
  });
  register("hub:call", async (op: string, input: Record<string, unknown>) => {
    requireValue(client && ["post", "space", "members", "thread-state", "profile"].includes(op), "Недоступная операция");
    const result = await client.call(op, { ...input, requestId: typeof input.requestId === "string" ? input.requestId : randomUUID() });
    await sync(); return result;
  });
  register("hub:agent", async (input: LocalAgent) => {
    requireValue(client && snapshot, "Сначала подключитесь к хабу");
    const directory = await realpath(resolve(field(input.directory, "Рабочая папка", 4096)));
    requireValue((await stat(directory)).isDirectory(), "Выберите рабочую папку");
    requireValue(["codex", "claude", "cursor"].includes(input.executor), "Неизвестный исполнитель");
    const id = input.id || randomUUID();
    const agent: LocalAgent = { id, name: field(input.name, "Имя", 80), description: String(input.description ?? "").slice(0, 2000), directory, binary: String(input.binary ?? "").trim(), executor: input.executor, enabled: input.enabled === true, allowWrite: input.allowWrite === true, fallback: input.fallback || null };
    await client.call<Agent>("agent", { ...agent, device: settings.device, directory: undefined, binary: undefined });
    runners.get(id)?.stop(); runners.delete(id);
    settings.agents = [...settings.agents.filter((a) => a.id !== id), agent]; await save(); await sync(); return agent;
  });
  register("hub:check", async (input: LocalAgent) => ({ detail: await checkLocalAgent(input) }));
  register("hub:directory", async () => (await dialog.showOpenDialog(window!, { properties: ["openDirectory"] })).filePaths[0] ?? "");
  register("hub:binary", async () => (await dialog.showOpenDialog(window!, { properties: ["openFile"] })).filePaths[0] ?? "");
  register("hub:preferences", async (input: { notifications: boolean }) => { settings.notifications = input.notifications === true; await save(); changed(); });
  register("hub:notification-test", () => {
    requireValue(Notification.isSupported(), "Системные уведомления недоступны");
    new Notification({ title: "Agent Hub", body: "Уведомления работают. Здесь будут упоминания, ответы и запросы решения." }).show();
  });
  register("hub:invite", async (name: string) => {
    requireValue(client && !settings.local, "Приглашения коллег доступны в удалённом хабе");
    const result = await client.call<{ code: string }>("invite", { name, requestId: randomUUID() });
    const invite = `AH2:${Buffer.from(JSON.stringify({ url: settings.url, code: result.code })).toString("base64url")}`;
    clipboard.writeText(invite); await sync(); return { copied: true };
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
  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 700, title: "Agent Hub", backgroundColor: "#f6f7fb", webPreferences: { preload: join(app.getAppPath(), "dist/src/desktop-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  handlers();
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVQ4T2NkoBAwUqifYdQABob/DP8ZGBgYRsQAkgxgYWBg+M/AwMDIyMjAYBaMFoAwNoBmgiEwGg0YBgYGABX6DBGTIWcAAAAASUVORK5CYII=");
  tray = new Tray(icon); tray.setToolTip("Agent Hub — агенты работают, пока приложение запущено");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Открыть Agent Hub", click: show }, { label: "Выйти и остановить агентов", click: () => app.quit() }]));
  tray.on("click", show);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Agent Hub", submenu: [{ label: "Открыть", click: show }, { role: "quit", label: "Выйти и остановить агентов" }] }, { role: "editMenu" }, { role: "viewMenu" }]));
  await window.loadFile(join(app.getAppPath(), "ui/hub.html"));
}

void app.whenReady().then(async () => {
  try {
    if (process.argv.includes("--smoke-test")) {
      await readFile(join(app.getAppPath(), "ui/hub.html"));
      await readFile(join(app.getAppPath(), "dist/src/desktop-preload.cjs"));
      const probe = new SqliteStateStore(":memory:");
      await probe.read((s) => requireValue(s.version === 2, "Invalid packaged store"));
      await probe.close();
      console.log("PACKAGE_SMOKE_OK"); app.exit(0); return;
    }
    await load(); if (settings.local) await startLocal();
    await createWindow();
    if (settings.url) client = new CollaborationClient(settings.url, settings.token);
    await sync(); poll = setInterval(() => void sync(), 3000);
  } catch (error) { dialog.showErrorBox("Agent Hub", error instanceof Error ? error.message : String(error)); app.exit(1); }
});
app.on("activate", show);
app.on("before-quit", (event) => {
  if (quitting) return; event.preventDefault(); quitting = true;
  clearInterval(poll); void stopRunners();
  localServer?.close(); void localStore?.close();
  void saveQueue.finally(() => setTimeout(() => app.exit(0), 2500));
});
