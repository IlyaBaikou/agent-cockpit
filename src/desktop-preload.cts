import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hub", {
  state: () => ipcRenderer.invoke("hub:state"),
  connect: (input: unknown) => ipcRenderer.invoke("hub:connect", input),
  local: () => ipcRenderer.invoke("hub:local"),
  call: (op: string, input: unknown) => ipcRenderer.invoke("hub:call", op, input),
  saveAgent: (input: unknown) => ipcRenderer.invoke("hub:agent", input),
  checkAgent: (input: unknown) => ipcRenderer.invoke("hub:check", input),
  directory: () => ipcRenderer.invoke("hub:directory"),
  binary: () => ipcRenderer.invoke("hub:binary"),
  preferences: (input: unknown) => ipcRenderer.invoke("hub:preferences", input),
  testNotification: () => ipcRenderer.invoke("hub:notification-test"),
  invite: (name: string) => ipcRenderer.invoke("hub:invite", name),
  openLink: (url: string) => ipcRenderer.invoke("hub:link", url),
  openWorktree: (job: string) => ipcRenderer.invoke("hub:worktree", job),
  onChanged: (callback: (value: unknown) => void) => { ipcRenderer.on("hub:changed", (_event, value) => callback(value)); },
  onNavigate: (callback: (value: unknown) => void) => { ipcRenderer.on("hub:navigate", (_event, value) => callback(value)); },
});
