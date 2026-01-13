const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn, execSync } = require("child_process");
const os = require("os");

const MINECRAFT_DIR = path.join(os.homedir(), ".minecraft-launcher");
const VERSIONS_DIR = path.join(MINECRAFT_DIR, "versions");
const LIBRARIES_DIR = path.join(MINECRAFT_DIR, "libraries");
const ASSETS_DIR = path.join(MINECRAFT_DIR, "assets");
const VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest.json";

// Ensure directories exist
[MINECRAFT_DIR, VERSIONS_DIR, LIBRARIES_DIR, ASSETS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

async function getVersions() {
  try {
    const manifestResponse = await axios.get(VERSION_MANIFEST_URL);
    // Return all versions, sorted with releases first
    const versions = manifestResponse.data.versions
      .filter(v => v.type === "release" || v.type === "snapshot")
      .sort((a, b) => {
        // Sort by release date, newest first
        return new Date(b.releaseTime) - new Date(a.releaseTime);
      });
    return versions;
  } catch (error) {
    throw new Error(`Failed to get versions: ${error.message}`);
  }
}

async function getVersionData(versionId) {
  try {
    // Get version manifest
    const manifestResponse = await axios.get(VERSION_MANIFEST_URL);
    
    // If no version specified, use latest
    if (!versionId) {
      versionId = manifestResponse.data.latest.release;
    }
    
    // Find the version info
    const versionInfo = manifestResponse.data.versions.find(
      (v) => v.id === versionId
    );
    
    if (!versionInfo) {
      throw new Error(`Version ${versionId} not found in manifest`);
    }
    
    // Get version details
    const versionDetails = await axios.get(versionInfo.url);
    
    return {
      version: versionId,
      versionData: versionDetails.data,
    };
  } catch (error) {
    throw new Error(`Failed to get Minecraft version info: ${error.message}`);
  }
}

function downloadFile(url, filePath, onProgress) {
  return new Promise(async (resolve, reject) => {
    let writer = null;
    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Skip if file already exists
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          resolve();
          return;
        }
      }

      writer = fs.createWriteStream(filePath);

      const response = await axios({
        url: url,
        method: "GET",
        responseType: "stream",
        validateStatus: (status) => status === 200,
      });

      const totalLength = parseInt(response.headers["content-length"], 10);
      let downloaded = 0;

      response.data.on("data", (chunk) => {
        downloaded += chunk.length;
        if (onProgress && totalLength) {
          onProgress((downloaded / totalLength) * 100);
        }
      });

      response.data.on("error", (error) => {
        if (writer) writer.destroy();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        reject(error);
      });

      response.data.pipe(writer);

      writer.on("finish", () => {
        writer.close();
        resolve();
      });

      writer.on("error", (error) => {
        writer.destroy();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        reject(error);
      });
    } catch (error) {
      if (writer) writer.destroy();
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
      reject(error);
    }
  });
}

function parseLibraryPath(library) {
  // Use the path from downloads.artifact if available (more reliable)
  if (library.downloads && library.downloads.artifact && library.downloads.artifact.path) {
    return library.downloads.artifact.path;
  }
  
  // Fallback to parsing from name
  const parts = library.name.split(":");
  const group = parts[0].replace(/\./g, "/");
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3] ? `-${parts[3]}` : "";
  return `${group}/${artifact}/${version}/${artifact}-${version}${classifier}.jar`;
}

function shouldUseLibrary(library) {
  if (!library.rules) return true;
  
  let shouldUse = false;
  for (const rule of library.rules) {
    if (rule.action === "allow") {
      if (!rule.os) {
        shouldUse = true;
      } else {
        const osName = os.platform();
        if (rule.os.name === "windows" && osName === "win32") shouldUse = true;
        if (rule.os.name === "osx" && osName === "darwin") shouldUse = true;
        if (rule.os.name === "linux" && osName === "linux") shouldUse = true;
      }
    } else if (rule.action === "disallow") {
      if (!rule.os) {
        shouldUse = false;
      } else {
        const osName = os.platform();
        if (rule.os.name === "windows" && osName === "win32") shouldUse = false;
        if (rule.os.name === "osx" && osName === "darwin") shouldUse = false;
        if (rule.os.name === "linux" && osName === "linux") shouldUse = false;
      }
    }
  }
  return shouldUse;
}

async function downloadLibraries(versionData, onProgress) {
  if (!versionData.libraries) return;
  
  const libraries = versionData.libraries.filter(shouldUseLibrary);
  const total = libraries.length;
  let completed = 0;

  for (const library of libraries) {
    if (library.downloads && library.downloads.artifact) {
      const libPath = parseLibraryPath(library);
      const libFilePath = path.join(LIBRARIES_DIR, libPath);
      const libUrl = library.downloads.artifact.url;

      try {
        await downloadFile(libUrl, libFilePath, (progress) => {
          if (onProgress) {
            const overallProgress = (completed / total) * 100 + (progress / total);
            onProgress(overallProgress);
          }
        });
        completed++;
      } catch (error) {
        console.warn(`Failed to download library ${library.name}: ${error.message}`);
      // Continue with other libraries
      completed++;
      if (onProgress) {
        onProgress((completed / total) * 100);
      }
      continue;
      }
    }
  }
}

async function downloadAssets(versionData, onProgress) {
  if (!versionData.assetIndex) return;
  
  try {
    // Download asset index
    const assetIndexUrl = versionData.assetIndex.url;
    const assetIndexPath = path.join(ASSETS_DIR, "indexes", `${versionData.assetIndex.id}.json`);
    
    // Only download if not exists or empty
    if (!fs.existsSync(assetIndexPath) || fs.statSync(assetIndexPath).size === 0) {
      await downloadFile(assetIndexUrl, assetIndexPath);
    }

    // Read asset index
    const assetIndex = JSON.parse(fs.readFileSync(assetIndexPath, "utf8"));
    
    // Download all required objects
    const objects = assetIndex.objects || {};
    const total = Object.keys(objects).length;
    let completed = 0;
    let failed = 0;

    console.log(`Downloading ${total} asset files...`);

    // Download assets in parallel batches for better performance
    const batchSize = 10;
    const objectEntries = Object.entries(objects);
    
    for (let i = 0; i < objectEntries.length; i += batchSize) {
      const batch = objectEntries.slice(i, i + batchSize);
      const promises = batch.map(async ([assetPath, assetData]) => {
        const hash = assetData.hash;
        const hashPrefix = hash.substring(0, 2);
        const objectPath = path.join(ASSETS_DIR, "objects", hashPrefix, hash);
        const objectUrl = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;

        try {
          // Skip if already exists
          if (fs.existsSync(objectPath)) {
            const stats = fs.statSync(objectPath);
            if (stats.size > 0) {
              completed++;
              return;
            }
          }
          
          await downloadFile(objectUrl, objectPath);
          completed++;
        } catch (error) {
          failed++;
          console.warn(`Failed to download asset ${hash}: ${error.message}`);
          // Continue with other assets
        }
      });

      await Promise.all(promises);
      
      if (onProgress) {
        // Assets are last 10% of total progress (90-100%)
        const assetProgress = (completed / total) * 10;
        onProgress(90 + assetProgress);
      }
      
      // Log progress every 100 assets
      if (completed % 100 === 0 || completed === total) {
        console.log(`Assets: ${completed}/${total} downloaded (${failed} failed)`);
      }
    }
    
    console.log(`Asset download complete: ${completed}/${total} (${failed} failed)`);
  } catch (error) {
    console.error(`Asset download error: ${error.message}`);
    throw new Error(`Failed to download assets: ${error.message}`);
  }
}

function getJavaVersion(javaPath = "java") {
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, { encoding: "utf8", timeout: 5000 });
    // Parse version from output like: "openjdk version "21.0.1" 2023-10-17"
    const match = output.match(/version\s+"?(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  } catch (error) {
    return null;
  }
  return null;
}

function findJavaExecutable() {
  const javaPaths = [];
  
  // Priority 1: Check the specific Java installation path
  const specificJavaPath = "C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.1.8-hotspot\\bin\\java.exe";
  if (fs.existsSync(specificJavaPath)) {
    javaPaths.push(specificJavaPath);
  }
  
  // Priority 2: Try JAVA_HOME
  if (process.env.JAVA_HOME) {
    const javaHome = process.env.JAVA_HOME;
    javaPaths.push(path.join(javaHome, "bin", "java"));
    if (os.platform() === "win32") {
      javaPaths.push(path.join(javaHome, "bin", "java.exe"));
    }
  }
  
  // Priority 3: Try common installation paths on Windows (Eclipse Adoptium)
  if (os.platform() === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    
    // Check for Adoptium/Temurin - check all versions, newest first
    for (const base of [programFiles, programFilesX86]) {
      try {
        const adoptiumPath = path.join(base, "Eclipse Adoptium");
        if (fs.existsSync(adoptiumPath)) {
          const dirs = fs.readdirSync(adoptiumPath);
          // Sort directories to try newer versions first
          dirs.sort().reverse();
          for (const dir of dirs) {
            const javaPath = path.join(adoptiumPath, dir, "bin", "java.exe");
            if (fs.existsSync(javaPath)) {
              javaPaths.push(javaPath);
            }
          }
        }
      } catch (e) {}
    }
  }
  
  // Priority 4: Try java in PATH (java, java21, etc.)
  javaPaths.push("java");
  for (let version = 25; version >= 8; version--) {
    javaPaths.push(`java${version}`);
    if (os.platform() === "win32") {
      javaPaths.push(`java${version}.exe`);
    }
  }
  
  // Test each path
  for (const javaPath of javaPaths) {
    const version = getJavaVersion(javaPath);
    if (version !== null) {
      return { path: javaPath, version };
    }
  }
  
  return null;
}

function getRequiredJavaVersion(versionData) {
  // Check javaVersion field in version data
  if (versionData.javaVersion) {
    if (typeof versionData.javaVersion === "object") {
      return versionData.javaVersion.majorVersion || 21;
    }
    return versionData.javaVersion;
  }
  
  // Default to Java 21 for modern versions (1.20.5+)
  // Older versions might need Java 17 or 8
  const versionId = versionData.id || "";
  const majorVersion = parseInt(versionId.split(".")[1] || "0", 10);
  
  if (majorVersion >= 20) {
    return 21; // 1.20.5+ requires Java 21
  } else if (majorVersion >= 17) {
    return 17; // 1.17+ requires Java 17
  }
  return 8; // Older versions
}

function buildClassPath(version, versionData) {
  const classPath = [];
  
  // Add client JAR
  const versionJar = path.join(VERSIONS_DIR, version, `${version}.jar`);
  if (fs.existsSync(versionJar)) {
    classPath.push(versionJar);
  }
  
  // Add libraries
  if (versionData.libraries) {
    for (const library of versionData.libraries) {
      if (shouldUseLibrary(library) && library.downloads && library.downloads.artifact) {
        const libPath = parseLibraryPath(library);
        const libFilePath = path.join(LIBRARIES_DIR, libPath);
        if (fs.existsSync(libFilePath)) {
          classPath.push(libFilePath);
        }
      }
    }
  }
  
  return classPath.join(path.delimiter);
}

function launchMinecraft(versionId, username, ramAllocation, onProgress) {
  // Handle backward compatibility: if first arg is a function, it's the old signature
  if (typeof versionId === "function") {
    onProgress = versionId;
    versionId = null;
    username = "Player";
    ramAllocation = 2048;
  } else if (typeof username === "function") {
    onProgress = username;
    username = "Player";
    ramAllocation = ramAllocation || 2048;
  } else if (typeof ramAllocation === "function") {
    onProgress = ramAllocation;
    ramAllocation = 2048;
  }
  
  if (!username) {
    username = "Player";
  }
  
  if (!ramAllocation || typeof ramAllocation === "function") {
    ramAllocation = 2048;
  }
  
  return new Promise(async (resolve, reject) => {
    try {
      if (onProgress) onProgress(0);
      
      // Get version data
      const { version, versionData } = await getVersionData(versionId);
      if (onProgress) onProgress(5);
      
      // Download client JAR
      const versionDir = path.join(VERSIONS_DIR, version);
      if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
      }
      const clientJar = path.join(versionDir, `${version}.jar`);
      
      if (!fs.existsSync(clientJar) || fs.statSync(clientJar).size === 0) {
        await downloadFile(
          versionData.downloads.client.url,
          clientJar,
          (progress) => {
            if (onProgress) onProgress(5 + progress * 0.3); // 5-35%
          }
        );
      }
      if (onProgress) onProgress(35);
      
      // Download libraries
      await downloadLibraries(versionData, (progress) => {
        if (onProgress) onProgress(35 + progress * 0.5); // 35-85%
      });
      if (onProgress) onProgress(85);
      
      // Download assets (all required assets)
      try {
        await downloadAssets(versionData, onProgress);
      } catch (error) {
        console.warn(`Asset download had issues: ${error.message}`);
        // Continue anyway - some assets might be downloaded
      }
      if (onProgress) onProgress(100);
      
      // Check Java version requirements
      const requiredJavaVersion = getRequiredJavaVersion(versionData);
      const javaInfo = findJavaExecutable();
      
      if (!javaInfo) {
        reject(new Error(
          `Java not found. Please install Java ${requiredJavaVersion} or later and ensure it's in your PATH.\n` +
          `You can download it from: https://adoptium.net/`
        ));
        return;
      }
      
      if (javaInfo.version < requiredJavaVersion) {
        reject(new Error(
          `Java version ${javaInfo.version} is too old. Minecraft ${version} requires Java ${requiredJavaVersion} or later.\n` +
          `Current Java: ${javaInfo.version}\n` +
          `Required Java: ${requiredJavaVersion}\n` +
          `Please install Java ${requiredJavaVersion} from: https://adoptium.net/\n` +
          `Or set JAVA_HOME to point to Java ${requiredJavaVersion} installation.`
        ));
        return;
      }
      
      console.log(`Using Java ${javaInfo.version} at: ${javaInfo.path}`);
      
      // Build classpath
      const classPath = buildClassPath(version, versionData);
      
      // Get main class
      const mainClass = versionData.mainClass || "net.minecraft.client.main.Main";
      
      // Build JVM arguments
      const jvmArgs = [
        `-Djava.library.path=${path.join(MINECRAFT_DIR, "natives")}`,
        `-cp`, classPath,
        mainClass,
        "--version", version,
        "--gameDir", MINECRAFT_DIR,
        "--assetsDir", ASSETS_DIR,
        "--assetIndex", versionData.assetIndex?.id || "",
        "--username", username,
        "--accessToken", "0",
        "--userType", "legacy",
        "--versionType", "release"
      ];
      
      // Launch Minecraft
      const child = spawn(javaInfo.path, jvmArgs, {
        stdio: "inherit",
        cwd: MINECRAFT_DIR
      });

      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          reject(new Error("Java not found. Please install Java and ensure it's in your PATH."));
        } else {
          reject(error);
        }
      });

      child.on("close", (code) => {
        console.log(`Minecraft exited with code ${code}`);
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}


module.exports = { launchMinecraft, getVersions };
