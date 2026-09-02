import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cockpit", {
  state: () => ipcRenderer.invoke("cockpit:state"),
  refreshHealth: () => ipcRenderer.invoke("cockpit:refresh-health"),
  list: () => ipcRenderer.invoke("cockpit:list"),
  get: (id: string) => ipcRenderer.invoke("cockpit:get", id),
  open: (input: unknown) => ipcRenderer.invoke("cockpit:open", input),
  reply: (input: unknown) => ipcRenderer.invoke("cockpit:reply", input),
  close: (id: string) => ipcRenderer.invoke("cockpit:close", id),
  updateSettings: (input: unknown) => ipcRenderer.invoke("cockpit:update-settings", input),
  copy: (value: string) => ipcRenderer.invoke("cockpit:copy", value),
  onChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("cockpit:changed", wrapped);
    return () => ipcRenderer.off("cockpit:changed", wrapped);
  },
});
