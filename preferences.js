const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const PREFERENCES_FILE = path.join(app.getPath("userData"), "preferences.json");

const DEFAULT_PREFERENCES = {
  username: "Player",
  version: null, // Will be set to latest on first load
  windowWidth: 800,
  windowHeight: 700,
  theme: "default", // default, dark, light
  ramAllocation: 2048, // MB
  showBetaAlpha: false, // Show beta and alpha versions
};

function getPreferences() {
  try {
    if (fs.existsSync(PREFERENCES_FILE)) {
      const data = fs.readFileSync(PREFERENCES_FILE, "utf8");
      const prefs = JSON.parse(data);
      // Merge with defaults to ensure all properties exist
      return { ...DEFAULT_PREFERENCES, ...prefs };
    }
  } catch (error) {
    console.error("Error reading preferences:", error);
  }
  return DEFAULT_PREFERENCES;
}

function savePreferences(preferences) {
  try {
    // Ensure directory exists
    const dir = path.dirname(PREFERENCES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Merge with existing preferences to preserve other settings
    const existing = getPreferences();
    const merged = { ...existing, ...preferences };
    
    fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(merged, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("Error saving preferences:", error);
    return false;
  }
}

module.exports = { getPreferences, savePreferences };
