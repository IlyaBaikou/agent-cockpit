import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { resolve } from "node:path";
import { CockpitRuntime } from "./cockpit/runtime.js";

let window: BrowserWindow | undefined;
let runtime: CockpitRuntime | undefined;
let stopping = false;

function registerHandlers(activeRuntime: CockpitRuntime): void {
  ipcMain.handle("cockpit:state", () => activeRuntime.state());
  ipcMain.handle("cockpit:refresh-health", () => activeRuntime.refreshHealth());
  ipcMain.handle("cockpit:list", () => activeRuntime.list());
  ipcMain.handle("cockpit:get", (_event, id: string) => activeRuntime.get(id));
  ipcMain.handle("cockpit:open", (_event, input: Parameters<CockpitRuntime["open"]>[0]) => activeRuntime.open(input));
  ipcMain.handle("cockpit:reply", (_event, input: Parameters<CockpitRuntime["reply"]>[0]) => activeRuntime.reply(input));
  ipcMain.handle("cockpit:close", (_event, id: string) => activeRuntime.closeConversation(id));
  ipcMain.handle(
    "cockpit:update-settings",
    (_event, input: Parameters<CockpitRuntime["updateSettings"]>[0]) => activeRuntime.updateSettings(input),
  );
  ipcMain.handle("cockpit:copy", (_event, value: string) => clipboard.writeText(value));
}

async function createWindow(): Promise<void> {
  runtime = await CockpitRuntime.create({ args: process.argv.slice(2), cwd: process.cwd() });
  registerHandlers(runtime);

  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f3f0e9",
    webPreferences: {
      preload: resolve(process.cwd(), "dist/src/cockpit-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  runtime.on("changed", () => window?.webContents.send("cockpit:changed"));
  await window.loadFile(resolve(process.cwd(), "ui/cockpit.html"));
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    app.exit(1);
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (stopping || !runtime) return;
  event.preventDefault();
  stopping = true;
  void runtime.stop().finally(() => app.quit());
});
