const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn, execSync } = require("child_process");
const os = require("os");
const AdmZip = require("adm-zip");

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
    const versions = manifestResponse.data.versions
      .filter(v => v.type === "release" || v.type === "snapshot")
      .sort((a, b) => {
        return new Date(b.releaseTime) - new Date(a.releaseTime);
      });
    return versions;
  } catch (error) {
    throw new Error(`Failed to get versions: ${error.message}`);
  }
}

async function getVersionData(versionId) {
  try {
    const manifestResponse = await axios.get(VERSION_MANIFEST_URL);
    
    if (!versionId) {
      versionId = manifestResponse.data.latest.release;
    }
    
    const versionInfo = manifestResponse.data.versions.find(
      (v) => v.id === versionId
    );
    
    if (!versionInfo) {
      throw new Error(`Version ${versionId} not found in manifest`);
    }
    
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
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

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
  if (library.downloads && library.downloads.artifact && library.downloads.artifact.path) {
    return library.downloads.artifact.path;
  }
  
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
  let downloadedCount = 0;
  let skippedCount = 0;

  // Fallback Maven repositories for old libraries
  const MAVEN_REPOS = [
    'https://libraries.minecraft.net',
    'https://maven.minecraftforge.net',
    'https://repo1.maven.org/maven2',
    'https://maven.codehaus.org/maven2',
    'https://oss.sonatype.org/content/repositories/public'
  ];

  for (const library of libraries) {
    let downloadUrl = null;
    let libPath = null;
    let libFilePath = null;
    
    // Method 1: Use downloads.artifact if available (newer versions)
    if (library.downloads && library.downloads.artifact) {
      libPath = parseLibraryPath(library);
      libFilePath = path.join(LIBRARIES_DIR, libPath);
      downloadUrl = library.downloads.artifact.url;
    } else if (library.name) {
      // Method 2: Construct URL from library name (older versions like 1.8)
      libPath = parseLibraryPath(library);
      libFilePath = path.join(LIBRARIES_DIR, libPath);
      // Will try multiple Maven repos
    }
    
    // Download main library artifact
    if (libFilePath) {
      let downloaded = false;
      
      if (downloadUrl) {
        // Try the direct URL first
        try {
          await downloadFile(downloadUrl, libFilePath, (progress) => {
            if (onProgress) {
              const overallProgress = (completed / total) * 100 + (progress / total);
              onProgress(overallProgress);
            }
          });
          downloadedCount++;
          downloaded = true;
        } catch (error) {
          console.warn(`Direct URL failed for ${library.name}, trying fallback repos...`);
        }
      }
      
      // If direct URL failed or doesn't exist, try fallback repos
      if (!downloaded && libPath) {
        for (const repo of MAVEN_REPOS) {
          if (downloaded) break;
          
          const fallbackUrl = `${repo}/${libPath}`;
          try {
            await downloadFile(fallbackUrl, libFilePath, (progress) => {
              if (onProgress) {
                const overallProgress = (completed / total) * 100 + (progress / total);
                onProgress(overallProgress);
              }
            });
            console.log(`Downloaded ${library.name} from fallback repo: ${repo}`);
            downloadedCount++;
            downloaded = true;
          } catch (error) {
            // Try next repo
          }
        }
        
        if (!downloaded) {
          console.warn(`Failed to download library ${library.name} from all repos (404)`);
          skippedCount++;
        }
      } else if (!downloaded) {
        skippedCount++;
      }
    }
    
    // Download native classifiers if they exist
    if (library.downloads && library.downloads.classifiers) {
      const osName = os.platform();
      let nativeKey = null;
      
      if (library.natives) {
        if (osName === "win32" && library.natives.windows) {
          nativeKey = library.natives.windows.replace("${arch}", process.arch === "x64" ? "64" : "32");
        } else if (osName === "darwin" && library.natives.osx) {
          nativeKey = library.natives.osx.replace("${arch}", process.arch === "x64" ? "64" : "32");
        } else if (osName === "linux" && library.natives.linux) {
          nativeKey = library.natives.linux.replace("${arch}", process.arch === "x64" ? "64" : "32");
        }
      }
      
      if (nativeKey && library.downloads.classifiers[nativeKey]) {
        const nativeInfo = library.downloads.classifiers[nativeKey];
        const nativePath = nativeInfo.path;
        const nativeFilePath = path.join(LIBRARIES_DIR, nativePath);
        const nativeUrl = nativeInfo.url;
        
        try {
          await downloadFile(nativeUrl, nativeFilePath);
          downloadedCount++;
        } catch (error) {
          console.warn(`Failed to download native library ${library.name}: ${error.message}`);
          skippedCount++;
        }
      }
    }
    
    completed++;
    if (onProgress) {
      onProgress((completed / total) * 100);
    }
  }
  
  console.log(`Libraries downloaded: ${downloadedCount}, Failed: ${skippedCount}`);
}

async function downloadAssets(versionData, onProgress) {
  if (!versionData.assetIndex) return;
  
  try {
    const assetIndexUrl = versionData.assetIndex.url;
    const assetIndexPath = path.join(ASSETS_DIR, "indexes", `${versionData.assetIndex.id}.json`);
    
    if (!fs.existsSync(assetIndexPath) || fs.statSync(assetIndexPath).size === 0) {
      await downloadFile(assetIndexUrl, assetIndexPath);
    }

    const assetIndex = JSON.parse(fs.readFileSync(assetIndexPath, "utf8"));
    
    const objects = assetIndex.objects || {};
    const total = Object.keys(objects).length;
    let completed = 0;
    let failed = 0;
    const failedAssets = [];

    console.log(`Downloading ${total} asset files...`);

    const batchSize = 10;
    const objectEntries = Object.entries(objects);
    const maxRetries = 3;
    
    for (let i = 0; i < objectEntries.length; i += batchSize) {
      const batch = objectEntries.slice(i, i + batchSize);
      const promises = batch.map(async ([assetPath, assetData]) => {
        const hash = assetData.hash;
        const hashPrefix = hash.substring(0, 2);
        const objectPath = path.join(ASSETS_DIR, "objects", hashPrefix, hash);
        const objectUrl = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;

        // Check if file exists and has correct size
        if (fs.existsSync(objectPath)) {
          const stats = fs.statSync(objectPath);
          if (stats.size === assetData.size) {
            completed++;
            return;
          }
        }
        
        // Try downloading with retries
        let lastError = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            await downloadFile(objectUrl, objectPath);
            
            // Verify file size after download
            if (fs.existsSync(objectPath)) {
              const stats = fs.statSync(objectPath);
              if (stats.size === assetData.size) {
                completed++;
                return;
              } else {
                // Size mismatch, delete and retry
                fs.unlinkSync(objectPath);
                throw new Error(`Size mismatch: expected ${assetData.size}, got ${stats.size}`);
              }
            }
          } catch (error) {
            lastError = error;
            if (attempt < maxRetries - 1) {
              // Wait before retry (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
          }
        }
        
        // All retries failed
        failed++;
        failedAssets.push({ hash, path: assetPath, error: lastError?.message });
        console.warn(`Failed to download asset ${hash} after ${maxRetries} attempts`);
      });

      await Promise.all(promises);
      
      if (onProgress) {
        // Assets are last 10% of total progress (90-100%)
        const assetProgress = (completed / total) * 10;
        onProgress(90 + assetProgress);
      }
      
      if (completed % 100 === 0 || completed === total) {
        console.log(`Assets: ${completed}/${total} downloaded (${failed} failed)`);
      }
    }
    
    console.log(`Asset download complete: ${completed}/${total} (${failed} failed)`);
    
    // If too many assets failed, throw an error
    if (failed > total * 0.1) { // More than 10% failed
      throw new Error(
        `Too many asset downloads failed (${failed}/${total}). ` +
        `Please check your internet connection and try again.`
      );
    } else if (failed > 0) {
      console.warn(`Warning: ${failed} assets failed to download. Game may have missing textures or sounds.`);
    }
  } catch (error) {
    console.error(`Asset download error: ${error.message}`);
    throw error;
  }
}

function extractNatives(versionData, nativesDir) {
  // Clean up old natives
  if (fs.existsSync(nativesDir)) {
    fs.rmSync(nativesDir, { recursive: true, force: true });
  }
  fs.mkdirSync(nativesDir, { recursive: true });
  
  if (!versionData.libraries) return;
  
  const osName = os.platform();
  const libraries = versionData.libraries.filter(shouldUseLibrary);
  
  console.log("Extracting native libraries...");
  
  for (const library of libraries) {
    if (!library.downloads || !library.downloads.classifiers || !library.natives) {
      continue;
    }
    
    let nativeKey = null;
    if (osName === "win32" && library.natives.windows) {
      nativeKey = library.natives.windows.replace("${arch}", process.arch === "x64" ? "64" : "32");
    } else if (osName === "darwin" && library.natives.osx) {
      nativeKey = library.natives.osx.replace("${arch}", process.arch === "x64" ? "64" : "32");
    } else if (osName === "linux" && library.natives.linux) {
      nativeKey = library.natives.linux.replace("${arch}", process.arch === "x64" ? "64" : "32");
    }
    
    if (!nativeKey || !library.downloads.classifiers[nativeKey]) {
      continue;
    }
    
    const nativeInfo = library.downloads.classifiers[nativeKey];
    const nativePath = nativeInfo.path;
    const nativeFilePath = path.join(LIBRARIES_DIR, nativePath);
    
    if (!fs.existsSync(nativeFilePath)) {
      console.warn(`Native library not found: ${nativeFilePath}`);
      continue;
    }
    
    try {
      const zip = new AdmZip(nativeFilePath);
      const zipEntries = zip.getEntries();
      
      for (const entry of zipEntries) {
        // Skip META-INF directory
        if (entry.entryName.startsWith("META-INF/")) {
          continue;
        }
        
        // Only extract files (not directories)
        if (!entry.isDirectory) {
          const extractPath = path.join(nativesDir, entry.entryName);
          
          // Create parent directory if needed
          const parentDir = path.dirname(extractPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          
          // Extract the file
          zip.extractEntryTo(entry, parentDir, false, true);
        }
      }
      
      console.log(`Extracted natives from: ${library.name}`);
    } catch (error) {
      console.warn(`Failed to extract natives from ${library.name}: ${error.message}`);
    }
  }
  
  console.log("Native extraction complete");
}

function getJavaVersion(javaPath = "java") {
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, {
      encoding: "utf8",
      timeout: 5000
    });

    // Java 8 format: "1.8.0_xxx"
    const legacy = output.match(/version\s+"1\.(\d+)/);
    if (legacy) {
      return parseInt(legacy[1], 10);
    }

    // Java 9+ format: "17.0.10", "21.0.1", etc
    const modern = output.match(/version\s+"(\d+)/);
    if (modern) {
      return parseInt(modern[1], 10);
    }
  } catch {
    return null;
  }
  return null;
}


function findAllJavaInstallations() {
  const javaInstallations = [];
  const seenPaths = new Set(); // Track unique paths to avoid duplicates
  
  // Helper function to add Java if valid and not duplicate
  const addJavaIfValid = (javaPath, vendor = "Unknown") => {
    if (seenPaths.has(javaPath)) return;
    
    const version = getJavaVersion(javaPath);
    if (version !== null) {
      seenPaths.add(javaPath);
      javaInstallations.push({ path: javaPath, version, vendor });
    }
  };
  
  // Priority 1: Try JAVA_HOME
  if (process.env.JAVA_HOME) {
    const javaHome = process.env.JAVA_HOME;
    const javaPath = os.platform() === "win32" 
      ? path.join(javaHome, "bin", "java.exe")
      : path.join(javaHome, "bin", "java");
    
    if (fs.existsSync(javaPath)) {
      addJavaIfValid(javaPath, "JAVA_HOME");
    }
  }
  
  // Priority 2: Search common installation directories
  if (os.platform() === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    
    // Common Java distribution directories
    const javaVendors = [
      { name: "Eclipse Adoptium", vendor: "Adoptium" },
      { name: "Temurin", vendor: "Adoptium" },
      { name: "Java", vendor: "Oracle" },
      { name: "OpenJDK", vendor: "OpenJDK" },
      { name: "Zulu", vendor: "Azul Zulu" },
      { name: "Azul", vendor: "Azul Zulu" },
      { name: "Amazon Corretto", vendor: "Amazon Corretto" },
      { name: "Corretto", vendor: "Amazon Corretto" },
      { name: "Microsoft", vendor: "Microsoft" },
      { name: "BellSoft", vendor: "Liberica" },
      { name: "Liberica", vendor: "Liberica" },
      { name: "GraalVM", vendor: "GraalVM" },
      { name: "SapMachine", vendor: "SAP" },
      { name: "Semeru", vendor: "IBM Semeru" },
      { name: "RedHat", vendor: "Red Hat" }
    ];
    
    for (const base of [programFiles, programFilesX86]) {
      for (const { name, vendor } of javaVendors) {
        try {
          const vendorPath = path.join(base, name);
          if (!fs.existsSync(vendorPath)) continue;
          
          const dirs = fs.readdirSync(vendorPath);
          // Sort to try newer versions first
          dirs.sort().reverse();
          
          for (const dir of dirs) {
            const javaPath = path.join(vendorPath, dir, "bin", "java.exe");
            if (fs.existsSync(javaPath)) {
              addJavaIfValid(javaPath, vendor);
            }
          }
        } catch (e) {
          // Ignore errors and continue
        }
      }
      
      // Also check direct Program Files for jdk/jre folders
      try {
        const items = fs.readdirSync(base);
        for (const item of items) {
          if (item.toLowerCase().includes("jdk") || item.toLowerCase().includes("jre")) {
            const javaPath = path.join(base, item, "bin", "java.exe");
            if (fs.existsSync(javaPath)) {
              addJavaIfValid(javaPath, "Generic");
            }
          }
        }
      } catch (e) {}
    }
  } else if (os.platform() === "darwin") {
    // macOS common paths
    const macPaths = [
      "/Library/Java/JavaVirtualMachines",
      "/System/Library/Java/JavaVirtualMachines",
      path.join(os.homedir(), "Library/Java/JavaVirtualMachines")
    ];
    
    for (const basePath of macPaths) {
      try {
        if (!fs.existsSync(basePath)) continue;
        
        const jvms = fs.readdirSync(basePath);
        for (const jvm of jvms) {
          const javaPath = path.join(basePath, jvm, "Contents", "Home", "bin", "java");
          if (fs.existsSync(javaPath)) {
            let vendor = "Unknown";
            if (jvm.toLowerCase().includes("temurin") || jvm.toLowerCase().includes("adoptium")) vendor = "Adoptium";
            else if (jvm.toLowerCase().includes("zulu")) vendor = "Azul Zulu";
            else if (jvm.toLowerCase().includes("corretto")) vendor = "Amazon Corretto";
            else if (jvm.toLowerCase().includes("liberica")) vendor = "Liberica";
            else if (jvm.toLowerCase().includes("graalvm")) vendor = "GraalVM";
            else if (jvm.toLowerCase().includes("openjdk")) vendor = "OpenJDK";
            else if (jvm.toLowerCase().includes("oracle")) vendor = "Oracle";
            
            addJavaIfValid(javaPath, vendor);
          }
        }
      } catch (e) {}
    }
  } else if (os.platform() === "linux") {
    // Linux common paths
    const linuxPaths = [
      "/usr/lib/jvm",
      "/usr/java",
      "/opt/java",
      "/opt/jdk",
      path.join(os.homedir(), ".sdkman/candidates/java")
    ];
    
    for (const basePath of linuxPaths) {
      try {
        if (!fs.existsSync(basePath)) continue;
        
        const jvms = fs.readdirSync(basePath);
        for (const jvm of jvms) {
          const javaPath = path.join(basePath, jvm, "bin", "java");
          if (fs.existsSync(javaPath)) {
            let vendor = "Unknown";
            if (jvm.toLowerCase().includes("temurin") || jvm.toLowerCase().includes("adoptium")) vendor = "Adoptium";
            else if (jvm.toLowerCase().includes("zulu")) vendor = "Azul Zulu";
            else if (jvm.toLowerCase().includes("corretto")) vendor = "Amazon Corretto";
            else if (jvm.toLowerCase().includes("liberica")) vendor = "Liberica";
            else if (jvm.toLowerCase().includes("graalvm")) vendor = "GraalVM";
            else if (jvm.toLowerCase().includes("openjdk")) vendor = "OpenJDK";
            else if (jvm.toLowerCase().includes("oracle")) vendor = "Oracle";
            
            addJavaIfValid(javaPath, vendor);
          }
        }
      } catch (e) {}
    }
  }
  
  // Priority 3: Try java in PATH
  addJavaIfValid("java", "PATH");
  
  // Priority 4: Try versioned java commands in PATH
  for (let v = 25; v >= 8; v--) {
    const javaCmd = os.platform() === "win32" ? `java${v}.exe` : `java${v}`;
    addJavaIfValid(javaCmd, `PATH (Java ${v})`);
  }
  
  // Remove duplicates based on path (already done with seenPaths)
  // Sort by version (highest first)
  return javaInstallations.sort((a, b) => b.version - a.version);
}

function findBuiltInJavaInstallations() {
  const javaPaths = [];
  
  // Try multiple possible app directories
  let appDir = null;
  const possibleDirs = [
    process.env.PORTABLE_EXECUTABLE_DIR,                    // Portable mode
    path.dirname(process.execPath),                         // Electron app exe
    path.dirname(process.argv[0]),                          // Alternative
    process.env.ELECTRON_EXE ? path.dirname(process.env.ELECTRON_EXE) : null,
    __dirname,                                              // Current module directory
  ].filter(Boolean);
  
  console.log("=== Built-in Java Detection Debug ===");
  console.log(`process.execPath: ${process.execPath}`);
  console.log(`__dirname: ${__dirname}`);
  console.log(`process.argv[0]: ${process.argv[0]}`);
  
  // Try to find the java directory
  for (const dir of possibleDirs) {
    const javaDir = path.join(dir, "java");
    console.log(`Checking for java directory at: ${javaDir} - Exists: ${fs.existsSync(javaDir)}`);
    if (fs.existsSync(javaDir)) {
      appDir = dir;
      console.log(`✓ Found java directory at: ${javaDir}`);
      break;
    }
  }
  
  if (!appDir) {
    console.log("❌ Could not find java directory in any expected location");
    return javaPaths;
  }

  const builtInJavaBaseDir = path.join(appDir, "java");
  
  try {
    // Support Windows and cross-platform structure
    const winJavaDir = path.join(builtInJavaBaseDir, "win");
    const macJavaDir = path.join(builtInJavaBaseDir, "mac");
    const linuxJavaDir = path.join(builtInJavaBaseDir, "linux");
    
    const osName = os.platform();
    console.log(`Detected OS: ${osName}`);
    
    let platformJavaDir = null;
    let executable = "javaw.exe";
    
    if (osName === "win32") {
      platformJavaDir = winJavaDir;
      executable = "javaw.exe";
    } else if (osName === "darwin") {
      platformJavaDir = macJavaDir;
      executable = "java";
    } else if (osName === "linux") {
      platformJavaDir = linuxJavaDir;
      executable = "java";
    }
    
    console.log(`Platform Java directory: ${platformJavaDir}`);
    console.log(`Platform Java directory exists: ${fs.existsSync(platformJavaDir)}`);
    
    if (!platformJavaDir || !fs.existsSync(platformJavaDir)) {
      console.log(`❌ No built-in Java found for platform: ${osName}`);
      return javaPaths;
    }
    
    // Scan for Java installations following Zulu naming convention
    const javaFolders = fs.readdirSync(platformJavaDir);
    console.log(`Found ${javaFolders.length} folder(s): ${javaFolders.join(", ")}`);
    
    for (const folder of javaFolders) {
      const folderPath = path.join(platformJavaDir, folder);
      const stat = fs.statSync(folderPath);
      
      // Skip non-directories
      if (!stat.isDirectory()) {
        console.log(`  ❌ ${folder}: Not a directory, skipping`);
        continue;
      }
      
      const binPath = path.join(folderPath, "bin");
      const javaExe = path.join(binPath, executable);
      
      console.log(`\nChecking folder: ${folder}`);
      console.log(`  - Bin path exists: ${fs.existsSync(binPath)}`);
      console.log(`  - Java exe exists: ${fs.existsSync(javaExe)}`);
      
      if (!fs.existsSync(binPath) || !fs.existsSync(javaExe)) {
        console.log(`  ❌ Skipped: Missing bin directory or executable`);
        continue;
      }
      
      try {
        // Extract version from folder name (e.g., "zulu8.92.0.19-ca-jre8.0.482-win_x64")
        const versionMatch = folder.match(/zulu(\d+)/);
        
        if (!versionMatch) {
          console.log(`  ❌ Skipped: Folder name doesn't contain 'zulu' + number`);
          continue;
        }
        
        const version = parseInt(versionMatch[1], 10);
        
        javaPaths.push({
          version: version,
          path: javaExe,
          vendor: "Zulu (Built-in)",
          isBuiltIn: true
        });
        
        console.log(`  ✓ Found built-in Java ${version}`);
      } catch (err) {
        console.warn(`  ❌ Error processing Java folder ${folder}: ${err.message}`);
      }
    }
    
    console.log(`\n=== Total built-in Java found: ${javaPaths.length} ===\n`);
    return javaPaths;
  } catch (error) {
    console.error(`❌ Error scanning built-in Java directory: ${error.message}`);
    console.error(error.stack);
    return javaPaths;
  }
}

function getRequiredJavaVersion(versionData) {
  // Check javaVersion field in version data (most reliable)
  if (versionData.javaVersion) {
    if (typeof versionData.javaVersion === "object") {
      return versionData.javaVersion.majorVersion || 21;
    }
    return versionData.javaVersion;
  }
  
  // Fallback: Parse version string
  const versionId = versionData.id || "";
  
  // Handle snapshot versions (e.g., "24w10a")
  if (versionId.includes("w")) {
    const yearMatch = versionId.match(/^(\d{2})w/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      if (year >= 24) return 21; // 2024+ snapshots need Java 21
      if (year >= 21) return 17; // 2021+ snapshots need Java 17
    }
    return 21; // Default for snapshots
  }
  
  // Handle release versions (e.g., "1.20.4")
  const versionMatch = versionId.match(/^1\.(\d+)/);
  if (versionMatch) {
    const minorVersion = parseInt(versionMatch[1], 10);
    
    if (minorVersion >= 20) {
      // 1.20.5+ requires Java 21
      const patchMatch = versionId.match(/^1\.20\.(\d+)/);
      if (patchMatch && parseInt(patchMatch[1], 10) >= 5) {
        return 21;
      }
      return 17; // 1.20.0-1.20.4 uses Java 17
    } else if (minorVersion >= 18) {
      return 17; // 1.18+ requires Java 17
    } else if (minorVersion >= 17) {
      return 16; // 1.17 requires Java 16
    } else if (minorVersion >= 12) {
      return 8; // 1.12-1.16 uses Java 8
    }
  }
  
  return 8; // Very old versions
}

function selectBestJavaForVersion(requiredVersion, availableJava) {
  if (availableJava.length === 0) {
    return null;
  }
  
  // Find exact match first
  const exactMatch = availableJava.find(j => j.version === requiredVersion);
  if (exactMatch) {
    return exactMatch;
  }
  
  // Find the closest version that's >= required
  const compatibleJava = availableJava.filter(j => j.version >= requiredVersion);
  if (compatibleJava.length > 0) {
    // Return the one closest to required (smallest version that's still compatible)
    return compatibleJava.reduce((closest, current) => 
      current.version < closest.version ? current : closest
    );
  }
  
  // No compatible version found
  return null;
}

function buildClassPath(version, versionData) {
  const classPath = [];
  const missingLibraries = [];
  
  const versionJar = path.join(VERSIONS_DIR, version, `${version}.jar`);
  if (fs.existsSync(versionJar)) {
    classPath.push(versionJar);
  } else {
    console.warn(`⚠️  Version JAR not found: ${versionJar}`);
    missingLibraries.push(`${version}.jar`);
  }
  
  if (versionData.libraries) {
    let addedCount = 0;
    let skippedCount = 0;
    let nativeOnlyCount = 0;
    
    for (const library of versionData.libraries) {
      // Skip if this library shouldn't be used for this OS
      if (!shouldUseLibrary(library)) {
        continue;
      }
      
      // Skip native-only libraries (those with classifiers but no artifact)
      // These should only be extracted, not added to classpath
      if (library.downloads && library.downloads.classifiers && !library.downloads.artifact) {
        nativeOnlyCount++;
        continue;
      }
      
      let libFilePath = null;
      
      // Method 1: Use downloads.artifact if available (newer versions)
      if (library.downloads && library.downloads.artifact) {
        const libPath = parseLibraryPath(library);
        libFilePath = path.join(LIBRARIES_DIR, libPath);
      } else if (library.name) {
        // Method 2: Parse from library name (older versions like 1.8)
        const libPath = parseLibraryPath(library);
        libFilePath = path.join(LIBRARIES_DIR, libPath);
      }
      
      if (libFilePath) {
        const exists = fs.existsSync(libFilePath);
        if (exists) {
          classPath.push(libFilePath);
          addedCount++;
        } else {
          skippedCount++;
          missingLibraries.push(`${library.name} (${path.basename(libFilePath)})`);
        }
      }
    }
    
    console.log(`Library classpath: Added ${addedCount} libraries, Skipped ${skippedCount} missing, ${nativeOnlyCount} natives (extracted separately)`);
    
    if (missingLibraries.length > 0 && missingLibraries.length <= 10) {
      console.warn(`Missing libraries: ${missingLibraries.join(", ")}`);
    } else if (missingLibraries.length > 10) {
      console.warn(`Missing ${missingLibraries.length} libraries (too many to list)`);
    }
  }
  
  return classPath.join(path.delimiter);
}

function launchMinecraft(versionId, account, username, ramAllocation, onProgress) {
  // Handle backward compatibility
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
            if (onProgress) onProgress(5 + progress * 0.3);
          }
        );
      }
      if (onProgress) onProgress(35);
      
      // Download libraries
      await downloadLibraries(versionData, (progress) => {
        if (onProgress) onProgress(35 + progress * 0.5);
      });
      if (onProgress) onProgress(85);
      
      // Download assets
      await downloadAssets(versionData, onProgress);
      if (onProgress) onProgress(100);
      
      // Extract native libraries
      const nativesDir = path.join(MINECRAFT_DIR, "natives");
      extractNatives(versionData, nativesDir);
      
      // Determine required Java version
      const requiredJavaVersion = getRequiredJavaVersion(versionData);
      console.log(`Minecraft ${version} requires Java ${requiredJavaVersion}`);
      
      // Find Java installations (prioritize built-in)
      const builtInJava = findBuiltInJavaInstallations();
      const systemJava = findAllJavaInstallations();
      
      // Combine with built-in Java first (so it takes priority)
      const availableJava = [...builtInJava, ...systemJava];
      
      // Remove duplicates based on path
      const uniqueJava = Array.from(
        new Map(availableJava.map(j => [j.path, j])).values()
      );
      
      if (uniqueJava.length === 0) {
        reject(new Error(
          `No Java installation found. Please ensure built-in Java is included with the launcher, ` +
          `or install Java ${requiredJavaVersion} or later.\n` +
          `You can download it from: https://adoptium.net/`
        ));
        return;
      }
      
      console.log(`Found ${uniqueJava.length} Java installation(s):`);
      uniqueJava.forEach(j => console.log(`  - Java ${j.version} (${j.vendor}) at ${j.path}`));
      
      // Select best Java for this version
      const selectedJava = selectBestJavaForVersion(requiredJavaVersion, uniqueJava);
      
      if (!selectedJava) {
        const availableVersions = availableJava.map(j => j.version).join(", ");
        reject(new Error(
          `No compatible Java found for Minecraft ${version}.\n` +
          `Required: Java ${requiredJavaVersion} or later\n` +
          `Available: Java ${availableVersions}\n` +
          `Please install Java ${requiredJavaVersion} from: https://adoptium.net/`
        ));
        return;
      }
      
      console.log(`Selected Java ${selectedJava.version} (${selectedJava.vendor}) at: ${selectedJava.path}`);
      
      // Build classpath
      const classPath = buildClassPath(version, versionData);
      
      console.log(`\n=== MINECRAFT LAUNCH DEBUG ===`);
      console.log(`Classpath length: ${classPath.length} chars`);
      console.log(`Total classpath entries: ${classPath.split(path.delimiter).length}`);
      console.log(`Classpath preview: ${classPath.substring(0, 200)}...`);
      console.log(`Classpath end: ...${classPath.substring(classPath.length - 100)}`);
      
      // Get main class
      const mainClass = versionData.mainClass || "net.minecraft.client.main.Main";
      console.log(`Main class: ${mainClass}`);
      console.log(`Version data keys: ${Object.keys(versionData).join(", ")}`);
      
      //+++++++++++Auth args++++++++++++
      const { getSelectedAccount } = require("./accounts");

const account = getSelectedAccount();

if (!account) {
  throw new Error("No account selected");
}

console.log(`Account: ${account.username} (${account.type})`);

let authArgs;

if (account.type === "microsoft") {
  authArgs = [
    "--username", account.username,
    "--uuid", account.uuid,
    "--accessToken", account.accessToken,
    "--userType", "msa"
  ];
} else {
  // Offline account
  authArgs = [
    "--username", account.username,
    "--uuid", "00000000-0000-0000-0000-000000000000",
    "--accessToken", "0",
    "--userType", "legacy"
  ];
}

               
      // Build JVM arguments
      // Minecraft 1.8 uses minecraftArguments, newer versions use game arguments
      let gameArgs = [];
      
      if (versionData.minecraftArguments) {
        // Old format (Minecraft 1.8)
        const argsTemplate = versionData.minecraftArguments;
        gameArgs = argsTemplate
          .replace("${auth_player_name}", account.username)
          .replace("${version_name}", version)
          .replace("${game_directory}", MINECRAFT_DIR)
          .replace("${assets_root}", ASSETS_DIR)
          .replace("${assets_index_name}", versionData.assetIndex?.id || "")
          .replace("${auth_access_token}", account.type === "microsoft" ? account.accessToken : "0")
          .replace("${user_type}", account.type === "microsoft" ? "msa" : "legacy")
          .replace("${auth_uuid}", account.type === "microsoft" ? account.uuid : "00000000-0000-0000-0000-000000000000")
          .replace("${user_properties}", "{}")
          .split(" ");
      } else {
        // New format (Minecraft 1.13+)
        gameArgs = [
          "--version", version,
          "--gameDir", MINECRAFT_DIR,
          "--assetsDir", ASSETS_DIR,
          "--assetIndex", versionData.assetIndex?.id || "",
          ...authArgs,
          "--versionType", "release"
        ];
      }
      
      const jvmArgs = [
        `-Xmx${ramAllocation}M`,
        `-Xms${Math.floor(ramAllocation / 2)}M`,
        `-Djava.library.path=${nativesDir}`,
        "-cp", classPath,
        mainClass,
        ...gameArgs
      ];
      
      console.log(`\nTotal JVM args: ${jvmArgs.length}`);
      console.log(`Memory settings: ${jvmArgs[0]}, ${jvmArgs[1]}`);
      console.log(`Native library path: ${jvmArgs[2]}`);
      console.log(`Main class: ${mainClass}`);
      console.log(`Game version: ${version}`);
      console.log(`Game dir: ${MINECRAFT_DIR}`);
      console.log(`Username: ${account.username}`);
      console.log(`Game args format: ${versionData.minecraftArguments ? "Old (minecraftArguments)" : "New (game args)"}`);
      if (gameArgs.length <= 20) {
        console.log(`Game args: ${gameArgs.join(" ")}`);
      } else {
        console.log(`Game args: ${gameArgs.slice(0, 10).join(" ")} ... (${gameArgs.length} total)`);
      }
      console.log(`\nLaunching with: ${selectedJava.path}`);
      console.log(`=== END DEBUG ===\n`);
      
      // Launch Minecraft
      const child = spawn(selectedJava.path, jvmArgs, {
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
        if (code === 0) {
          console.log(`✓ Minecraft exited successfully`);
        } else {
          console.log(`❌ Minecraft exited with code ${code}`);
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { launchMinecraft, getVersions, findAllJavaInstallations, findBuiltInJavaInstallations };

