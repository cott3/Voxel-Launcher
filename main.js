const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const os = require("os");
const { launchMinecraft, getVersions } = require("./minecraft");
const { getPreferences, savePreferences } = require("./preferences");

function createWindow() {
  // Load saved window preferences
  const prefs = getPreferences();
  
  const win = new BrowserWindow({
    width: prefs.windowWidth || 800,
    height: prefs.windowHeight || 700,
    icon: path.join(__dirname, "build", "Stone-Block.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Save window size when resized
  win.on("resized", () => {
    const [width, height] = win.getSize();
    savePreferences({ windowWidth: width, windowHeight: height });
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

ipcMain.handle("get-versions", async () => {
  try {
    return await getVersions();
  } catch (err) {
    console.error(err);
    return [];
  }
});

ipcMain.handle("get-preferences", () => {
  return getPreferences();
});

ipcMain.handle("save-preferences", (event, preferences) => {
  return savePreferences(preferences);
});

ipcMain.handle("open-game-directory", () => {
  const os = require("os");
  const gameDir = path.join(os.homedir(), ".minecraft-launcher");
  shell.openPath(gameDir);
  return { success: true };
});

ipcMain.handle("get-system-ram", () => {
  const totalRamGB = Math.floor(os.totalmem() / (1024 * 1024 * 1024));
  return totalRamGB;
});

ipcMain.handle("launch-minecraft", async (event, version, username, ramAllocation) => {
  try {
    // Save preferences before launching
    const prefs = getPreferences();
    savePreferences({ username, version, ramAllocation: ramAllocation || prefs.ramAllocation });
    
    const launchPromise = launchMinecraft(version, username, ramAllocation || prefs.ramAllocation, (progress) => {
      event.sender.send("download-progress", progress);
    });
    
    // Send game started event
    event.sender.send("game-started");
    
    await launchPromise;
    
    // Send game closed event
    event.sender.send("game-closed");
    
    return { success: true };
  } catch (err) {
    console.error(err);
    // Send game closed event even on error
    event.sender.send("game-closed");
    return { success: false, error: err.message };
  }
});
