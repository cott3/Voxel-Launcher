// preload.js (CommonJS)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getVersions: () => ipcRenderer.invoke("get-versions"),
  getPreferences: () => ipcRenderer.invoke("get-preferences"),
  savePreferences: (preferences) => ipcRenderer.invoke("save-preferences", preferences),
  launchMinecraft: (version, username, ramAllocation) => ipcRenderer.invoke("launch-minecraft", version, username, ramAllocation),
  openGameDirectory: () => ipcRenderer.invoke("open-game-directory"),
  getSystemRam: () => ipcRenderer.invoke("get-system-ram"),
  onDownloadProgress: (callback) => {
    ipcRenderer.on("download-progress", (event, percent) => callback(percent));
  },
  onGameStarted: (callback) => {
    ipcRenderer.on("game-started", () => callback());
  },
  onGameClosed: (callback) => {
    ipcRenderer.on("game-closed", () => callback());
  },
  removeDownloadProgressListener: () => {
    ipcRenderer.removeAllListeners("download-progress");
  },
});
