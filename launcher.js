const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MOJANG_META = 'https://launchermeta.mojang.com';
const MOJANG_LIB = 'https://libraries.minecraft.net';
const MOJANG_RES = 'https://resources.download.minecraft.net';

function getApiHost(source) {
  return source === 'mojang' ? null : 'https://bmclapi2.bangbang93.com';
}
function resolveUrl(url, source) {
  if (source === 'mojang') return url;
  // Rewrite Mojang URLs to BMCLAPI mirror
  let u = url.replace('https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com');
  u = u.replace('https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven');
  u = u.replace('https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets');
  u = u.replace('https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com');
  u = u.replace('https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com');
  return u;
}

// Detect platform
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const osName = isWin ? 'windows' : (isMac ? 'osx' : 'linux');
const is64 = os.arch().includes('64') || process.arch.includes('64');
const archBits = is64 ? '64' : '32';

function getProtocol(url) { return url.startsWith('https') ? https : http; }

function getFile(url) {
  return new Promise((resolve, reject) => {
    const proto = getProtocol(url);
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        getFile(res.headers.location).then(resolve).catch(reject); return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getJSON(url) {
  return getFile(url).then(b => JSON.parse(b.toString()));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// --- Download with progress ---
async function* downloadFile(url, dest) {
  const tmp = dest + '.tmp';
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) { yield { type: 'file', path: dest, total: 1, loaded: 1 }; return; }

  let total = 0, loaded = 0;
  await new Promise((resolve, reject) => {
    const proto = getProtocol(url);
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).next().then(resolve).catch(reject); return;
      }
      total = parseInt(res.headers['content-length'] || 0);
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      res.on('data', c => { loaded += c.length; });
      ws.on('finish', () => {
        try { fs.renameSync(tmp, dest); } catch {
          try { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); } catch {}
        }
        resolve();
      });
      res.on('error', reject);
      ws.on('error', reject);
    }).on('error', reject);
  });
  yield { type: 'file', path: dest, total, loaded };
}

// --- Version list ---
async function getVersionList(source = 'bmclapi') {
  const host = getApiHost(source);
  if (host) {
    try {
      const m = await getJSON(`${host}/mc/game/version_manifest.json`);
      return m.versions.map(v => ({ id: v.id, type: v.type, time: v.releaseTime }));
    } catch {}
  }
  const m = await getJSON(`${MOJANG_META}/mc/game/version_manifest.json`);
  return m.versions.map(v => ({ id: v.id, type: v.type, time: v.releaseTime }));
}

// --- Scan local versions ---
function scanLocalVersions(gameDir) {
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return [];

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  const versions = [];

  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const jsonPath = getRealPath(path.join(versionsDir, dir.name), '.json');
    if (!jsonPath) continue;

    try {
      const verJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const jarPath = getRealPath(path.join(versionsDir, dir.name), '.jar');

      let verType = verJson.type || 'release';
      if (verJson.inheritsFrom) {
        const mc = verJson.mainClass || '';
        if (mc.includes('fabric') || dir.name.toLowerCase().includes('fabric')) verType = 'fabric';
        else if (mc.includes('forge') || dir.name.toLowerCase().includes('forge')) verType = 'forge';
        else if (mc.includes('BootstrapLauncher')) verType = 'forge';
        else verType = 'modified';
      }

      versions.push({
        id: verJson.id,
        type: verType,
        time: verJson.releaseTime || verJson.time || '',
        local: true,
        hasJar: !!jarPath,
        inheritsFrom: verJson.inheritsFrom || null,
        mainClass: verJson.mainClass || null,
        minecraftArguments: verJson.minecraftArguments || null,
        arguments: verJson.arguments || null,
        libraries: verJson.libraries || [],
        assetIndex: verJson.assetIndex || null,
        assets: verJson.assets || null,
        logging: verJson.logging || null,
        downloads: verJson.downloads || null
      });
    } catch {
      // Skip broken json
    }
  }
  return versions;
}

// --- Get real file path in a directory ---
function getRealPath(dirPath, suffix) {
  if (!fs.existsSync(dirPath)) return null;
  const files = fs.readdirSync(dirPath);
  for (const f of files) {
    if (f.endsWith(suffix)) {
      const full = path.join(dirPath, f);
      // For .json, validate it's a Minecraft version file
      if (suffix === '.json') {
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (j.mainClass || j.minecraftArguments || j.arguments) return full;
        } catch {}
      } else {
        return full;
      }
    }
  }
  // Fallback: <dirname>.<suffix>
  const dirName = path.basename(dirPath);
  const fall = path.join(dirPath, dirName + suffix);
  if (fs.existsSync(fall)) return fall;
  return null;
}

// --- Rules checking ---
function checkRules(rules) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.os) {
      if (rule.os.name === osName || (osName === 'windows' && rule.os.name === 'windows')) {
        allowed = rule.action === 'allow';
      }
    } else {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

// --- Extract numbers from string ---
function extractNumber(str, digitOnly) {
  let result = '';
  for (const ch of str) {
    const isDigit = ch >= '0' && ch <= '9';
    if (digitOnly ? isDigit : !isDigit) result += ch;
  }
  return result;
}

// --- Convert name to path ---
// Format: package:name:version[@ext] → package/name/version/name-version.ext
function convertNameToPath(name) {
  // Handle @ext suffix (e.g. @jar, @zip)
  let ext = '.jar';
  const atIdx = name.lastIndexOf('@');
  if (atIdx > -1) {
    const suffix = name.substring(atIdx + 1);
    if (suffix && !suffix.includes(':')) {
      ext = '.' + suffix;
      name = name.substring(0, atIdx);
    }
  }

  const parts = name.split(':');
  if (parts.length < 3) return name;

  // package (replace dots with slashes)
  const pkg = parts[0].replace(/\./g, '/');
  const art = parts[1];
  const ver = parts[2];

  // Split version parts for building path
  const artParts = parts.slice(1); // [artifact, version]

  let result;
  if (parts.length === 3) {
    result = `${pkg}/${art}/${ver}/${art}-${ver}${ext}`;
  } else if (parts.length >= 4) {
    // For natives classifiers appended via colon
    const extra = parts.slice(3).join('-');
    result = `${pkg}/${art}/${ver}/${art}-${ver}-${extra}${ext}`;
  } else {
    result = `${pkg}/${art}/${ver}/${art}-${ver}${ext}`;
  }
  return result;
}

// --- Deduplicate libraries, keep highest version ---
function dedupLibs(libs) {
  const nameList = [];
  const deduped = [];

  for (const libName of libs) {
    if (!nameList.includes(libName)) {
      nameList.push(libName);
      deduped.push(libName);
    } else {
      // Compare versions - keep the one with higher version number
      const idx = nameList.indexOf(libName);
      const oldNum = extractNumber(libName, true);
      const newNum = extractNumber(libName, true);
      const oldName = extractNumber(libName, false);
      const newName = extractNumber(libName, false);

      if (oldName === newName && parseInt(newNum) >= parseInt(oldNum)) {
        deduped[idx] = libName;
      }
    }
  }
  return deduped;
}

// --- Get inheritsFrom parent version json ---
function getVersionJson(versionId, gameDir) {
  const verDir = path.join(gameDir, 'versions', versionId);
  if (!fs.existsSync(verDir)) return null;
  const jsonPath = getRealPath(verDir, '.json');
  if (!jsonPath) return null;
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

// --- Merge inheritsFrom: child json inherits parent ---
function mergeInheritsFrom(childJson, gameDir) {
  if (!childJson.inheritsFrom) return childJson;

  const parentJson = getVersionJson(childJson.inheritsFrom, gameDir);
  if (!parentJson) {
    console.warn('Parent version not found:', childJson.inheritsFrom);
    return childJson;
  }

  // Merge parent into a copy
  const merged = JSON.parse(JSON.stringify(parentJson));

  // Replace mainClass, id
  merged.mainClass = childJson.mainClass;
  merged.id = childJson.id;
  if (childJson.type) merged.type = childJson.type;

  // Append libraries
  merged.libraries = [...(merged.libraries || []), ...(childJson.libraries || [])];

  // Merge arguments.jvm
  if (childJson.arguments?.jvm) {
    if (!merged.arguments) merged.arguments = {};
    if (!merged.arguments.jvm) merged.arguments.jvm = [];
    for (const arg of childJson.arguments.jvm) {
      merged.arguments.jvm.push(arg);
    }
  }

  // Merge arguments.game
  if (childJson.arguments?.game) {
    if (!merged.arguments) merged.arguments = {};
    if (!merged.arguments.game) merged.arguments.game = [];
    for (const arg of childJson.arguments.game) {
      merged.arguments.game.push(arg);
    }
  }

  // Replace minecraftArguments (for ≤1.12.2)
  if (childJson.minecraftArguments) {
    merged.minecraftArguments = childJson.minecraftArguments;
  }

  // Keep child's downloads for client jar
  if (childJson.downloads?.client) {
    merged.downloads = merged.downloads || {};
    merged.downloads.client = childJson.downloads.client;
  }

  return merged;
}

// --- Build classpath ---
function buildClasspath(verJson, gameDir) {
  const libsDir = path.join(gameDir, 'libraries');
  const vdir = path.join(gameDir, 'versions', verJson.id);
  const cp = [];

  // Filter libraries: need artifact download, pass rules, no natives/classifiers
  const libs = verJson.libraries || [];
  const filteredLibNames = [];

  for (const lib of libs) {
    // Skip if has rules and not allowed
    if (lib.rules && !checkRules(lib.rules)) continue;
    // Must have a name
    if (!lib.name) continue;
    // Skip if name contains native classifier keywords
    const nameLower = lib.name.toLowerCase();
    if (/natives-\w+/.test(nameLower)) continue;
    // Must have artifact download
    if (!lib.downloads?.artifact?.path) continue;
    filteredLibNames.push(lib.name);
  }

  // Deduplicate
  const deduped = dedupLibs(filteredLibNames);

  // Convert names to paths and check existence
  for (const libName of deduped) {
    const libPath = path.join(libsDir, convertNameToPath(libName));
    if (fs.existsSync(libPath)) {
      if (!cp.includes(libPath)) cp.push(libPath);
    }
  }

  // Main jar from versions folder
  const mainJar = getRealPath(vdir, '.jar');
  if (mainJar) {
    if (!cp.includes(mainJar)) cp.push(mainJar);
  }

  return cp;
}

// --- Collect natives libraries ---
function collectNativesLibs(verJson) {
  const result = [];
  const libs = verJson.libraries || [];

  for (const lib of libs) {
    if (lib.rules && !checkRules(lib.rules)) continue;
    if (!lib.natives) continue;
    // Must have classifiers for natives
    if (!lib.downloads?.classifiers) continue;

    const winNatives = lib.natives[osName];
    if (!winNatives) continue;

    // Resolve ${arch} template
    const classifierKey = winNatives.replace('${arch}', archBits);
    const classifierEntry = lib.downloads.classifiers[classifierKey];

    // Try fallback without arch (e.g., natives-windows)
    if (!classifierEntry) {
      const fall = lib.downloads.classifiers[winNatives];
      if (fall) result.push({ ...lib, _classifierKey: winNatives, _classifierEntry: fall });
    } else {
      result.push({ ...lib, _classifierKey: classifierKey, _classifierEntry: classifierEntry });
    }
  }

  return result;
}

// --- Extract natives from jars ---
function extractNatives(nativesLibs, libsDir, nativesPath) {
  ensureDir(nativesPath);

  for (const lib of nativesLibs) {
    const entry = lib._classifierEntry;
    if (!entry?.path) continue;
    const jarPath = path.join(libsDir, entry.path);
    if (!fs.existsSync(jarPath)) {
      console.warn('[natives] jar not found:', jarPath);
      continue;
    }

    console.log('[natives] extracting:', path.basename(jarPath));
    let extracted = false;

    // Method 1: .NET ZipFile via PowerShell (most reliable on Windows)
    try {
      const { execSync } = require('child_process');
      const psScript = `[System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath.replace(/'/g, "''")}', '${nativesPath.replace(/'/g, "''")}')`;
      execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; ${psScript}"`, { stdio: 'ignore', timeout: 30000 });
      extracted = true;
      console.log('[natives] .NET OK');
    } catch (e) {
      console.warn('[natives] .NET failed:', e.message);
    }

    // Method 2: adm-zip
    if (!extracted) {
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(jarPath);
        zip.extractAllTo(nativesPath, true);
        extracted = true;
        console.log('[natives] adm-zip OK');
      } catch {}
    }

    if (!extracted) {
      console.warn('[natives] ALL methods failed for:', path.basename(jarPath));
    }
  }

  // Clean up non-native files
  if (fs.existsSync(nativesPath)) {
    const keepExts = ['.dll', '.so', '.dylib', '.jnilib'];
    const items = fs.readdirSync(nativesPath);
    for (const f of items) {
      const full = path.join(nativesPath, f);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && !keepExts.includes(path.extname(f).toLowerCase())) {
          fs.unlinkSync(full);
        } else if (stat.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

// --- Resolve template variables ---
function resolveVars(str, vars) {
  let result = str;
  for (const [k, v] of Object.entries(vars)) {
    result = result.split(k).join(v);
  }
  return result;
}

// --- Resolve a single argument (handles rules and arrays) ---
function resolveArg(arg, vars) {
  // String argument
  if (typeof arg === 'string') return resolveVars(arg, vars);
  // Object with rules
  if (arg.rules && !checkRules(arg.rules)) return null;
  const values = Array.isArray(arg.value) ? arg.value : [arg.value];
  return values.map(v => resolveVars(String(v), vars)).join(' ');
}

// --- Main launch function ---
function launchGame(versionId, gameDir, javaPath, memory, account, versionIsolation = false) {
  return new Promise((resolve, reject) => {
    if (!gameDir) return reject(new Error('请先在设置中选择游戏目录'));

    // 1. Get version JSON and merge inheritsFrom
    const versionsDir = path.join(gameDir, 'versions', versionId);
    const rawJson = getVersionJson(versionId, gameDir);
    if (!rawJson) return reject(new Error(`版本 ${versionId} 未安装`));

    const verJson = mergeInheritsFrom(rawJson, gameDir);
    const libsDir = path.join(gameDir, 'libraries');

    // 2. Determine effective game directory (version isolation)
    const effectiveGameDir = versionIsolation
      ? path.join(gameDir, 'versions', versionId)
      : gameDir;
    ensureDir(effectiveGameDir);

    // 3. Extract natives
    const nativesDirName = path.basename(getRealPath(versionsDir, 'natives') || 'natives');
    const nativesPath = path.join(versionIsolation ? effectiveGameDir : versionsDir, nativesDirName.includes('natives') ? nativesDirName : `${nativesDirName}-natives`);
    const nativesLibs = collectNativesLibs(verJson);
    if (nativesLibs.length > 0) {
      extractNatives(nativesLibs, libsDir, nativesPath);
    } else {
      ensureDir(nativesPath);
    }

    // 4. Build classpath
    const classpath = buildClasspath(verJson, gameDir);
    const classpathStr = classpath.join(path.delimiter);

    // 5. Prepare template variables
    const vars = {
      '${auth_player_name}': account.name,
      '${auth_uuid}': account.uuid,
      '${auth_access_token}': account.accessToken || '0',
      '${auth_session}': account.accessToken || '0',
      '${auth_xuid}': account.xuid || '',
      '${clientid}': '0',
      '${user_properties}': '{}',
      '${user_type}': account.type === 'microsoft' ? 'msa' : 'mojang',
      '${version_name}': verJson.id,
      '${version_type}': verJson.type || 'release',
      '${game_directory}': effectiveGameDir,
      '${game_assets}': path.join(effectiveGameDir, 'assets'),
      '${assets_root}': path.join(gameDir, 'assets'),
      '${assets_index_name}': verJson.assetIndex?.id || verJson.assets || 'legacy',
      '${launcher_name}': 'mc-launcher',
      '${launcher_version}': '1.0',
      '${classpath}': classpathStr,
      '${classpath_separator}': path.delimiter,
      '${library_directory}': libsDir,
      '${natives_directory}': nativesPath,
      '${path}': ''
    };

    // 6. Build JVM arguments
    const jvmArgs = [];

    // Default JVM args (always present)
    jvmArgs.push('-XX:+UseG1GC');
    jvmArgs.push('-XX:-UseAdaptiveSizePolicy');
    jvmArgs.push('-XX:-OmitStackTraceInFastThrow');
    jvmArgs.push('-Dfml.ignoreInvalidMinecraftCertificates=True');
    jvmArgs.push('-Dfml.ignorePatchDiscrepancies=True');
    jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
    jvmArgs.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');

    // Windows-specific
    if (isWin) {
      jvmArgs.push('-Dos.name=Windows 10');
      jvmArgs.push('-Dos.version=10.0');
    }

    // Native library path
    jvmArgs.push(`-Djava.library.path=${nativesPath}`);

    // Launcher brand
    jvmArgs.push('-Dminecraft.launcher.brand=mc-launcher');
    jvmArgs.push('-Dminecraft.launcher.version=1.0');

    // If version has its own arguments.jvm, use them (they contain -cp, -p, etc.)
    if (verJson.arguments?.jvm) {
      for (const arg of verJson.arguments.jvm) {
        const resolved = resolveArg(arg, vars);
        if (resolved) {
          // Split by spaces for spawn (each arg is separate)
          for (const part of resolved.split(' ').filter(Boolean)) {
            jvmArgs.push(part);
          }
        }
      }
    } else {
      // Legacy: no jvm args in JSON, add classpath ourselves
      jvmArgs.push('-cp', classpathStr);
    }

    // Ensure -Xmx is present
    if (!jvmArgs.some(a => a.startsWith('-Xmx'))) {
      jvmArgs.push(`-Xmx${memory}M`);
    }

    // Logging config (only if not already in JVM args)
    if (verJson.logging?.client?.file) {
      const lc = verJson.logging.client;
      const logPath = path.join(gameDir, 'assets', 'log_configs', lc.file.id);
      if (!fs.existsSync(logPath)) {
        ensureDir(path.dirname(logPath));
      }
      vars['${path}'] = logPath;
      if (!jvmArgs.some(a => a.includes('-Dlog4j.configurationFile'))) {
        const logArg = resolveVars(lc.argument || '-Dlog4j.configurationFile=${path}', vars);
        jvmArgs.push(logArg);
      }
    }

    // 7. Build game arguments
    const gameArgs = [];
    if (verJson.arguments?.game) {
      for (const arg of verJson.arguments.game) {
        const resolved = resolveArg(arg, vars);
        if (resolved) {
          for (const part of resolved.split(' ').filter(Boolean)) {
            gameArgs.push(part);
          }
        }
      }
    } else if (verJson.minecraftArguments) {
      const resolved = resolveVars(verJson.minecraftArguments, vars);
      for (const part of resolved.split(' ').filter(Boolean)) {
        gameArgs.push(part);
      }
    }

    // Add window size defaults (if not present)
    if (!gameArgs.includes('--width')) { gameArgs.push('--width', '854'); }
    if (!gameArgs.includes('--height')) { gameArgs.push('--height', '480'); }

    // 8. Main class
    const mainClass = verJson.mainClass || 'net.minecraft.client.main.Main';

    // 9. Final args array for spawn
    const fullArgs = [...jvmArgs, mainClass, ...gameArgs];

    console.log('=== LAUNCH ===');
    console.log('java:', javaPath);
    console.log('cwd:', effectiveGameDir);
    console.log('args:');
    fullArgs.forEach((a, i) => console.log(`  [${i}] ${a}`));

    // 10. Spawn the process
    const proc = spawn(javaPath, fullArgs, {
      cwd: effectiveGameDir,
      stdio: 'inherit',
      shell: false,
      detached: false
    });

    proc.on('error', err => {
      reject(new Error(`无法启动 Java: ${err.message}`));
    });

    proc.on('exit', (code) => {
      console.log('Minecraft exited with code:', code);
    });

    // Resolve after a short delay so the UI can update
    setTimeout(() => resolve(), 2000);
  });
}

// --- Download a version ---
async function* downloadVersion(versionId, gameDir, source = 'bmclapi') {
  ensureDir(gameDir);
  const versionsDir = path.join(gameDir, 'versions', versionId);
  ensureDir(versionsDir);

  const host = getApiHost(source);

  // Get version JSON
  const vManifestUrl = host
    ? `${host}/mc/game/version_manifest.json`
    : `${MOJANG_META}/mc/game/version_manifest.json`;
  const vManifest = await getJSON(vManifestUrl);
  const verEntry = vManifest.versions.find(v => v.id === versionId);

  let verJson;
  if (host) {
    try { verJson = await getJSON(`${host}/version/${versionId}/json`); }
    catch { verJson = await getJSON(resolveUrl(verEntry.url, source)); }
  } else {
    verJson = await getJSON(verEntry.url);
  }

  // Write the JSON with the correct filename
  fs.writeFileSync(path.join(versionsDir, `${versionId}.json`), JSON.stringify(verJson, null, 2));

  // Client jar
  const jarUrl = resolveUrl(verJson.downloads?.client?.url || '', source) || verJson.downloads?.client?.url;
  yield* downloadFile(jarUrl || `${MOJANG_META}/v1/packages/${verJson.downloads?.client?.sha1}/client.jar`, path.join(versionsDir, `${versionId}.jar`));

  // Libraries
  const libsDir = path.join(gameDir, 'libraries');
  const libsToDownload = verJson.libraries || [];
  for (const lib of libsToDownload) {
    if (lib.rules && !checkRules(lib.rules)) continue;

    // Download artifact
    if (lib.downloads?.artifact) {
      const libUrl = resolveUrl(lib.downloads.artifact.url, source);
      const libPath = path.join(libsDir, lib.downloads.artifact.path);
      yield* downloadFile(libUrl, libPath);
    }

    // Download native classifiers for current platform
    if (lib.downloads?.classifiers && lib.natives) {
      const winNatives = lib.natives[osName];
      if (winNatives) {
        const classifierKey = winNatives.replace('${arch}', archBits);
        const classifier = lib.downloads.classifiers[classifierKey] || lib.downloads.classifiers[winNatives];
        if (classifier) {
          const natUrl = resolveUrl(classifier.url, source);
          const natPath = path.join(libsDir, classifier.path);
          if (!fs.existsSync(natPath)) {
            yield* downloadFile(natUrl, natPath);
          }
        }
      }
    }
  }

  // Assets
  const assetIndex = verJson.assetIndex;
  if (assetIndex) {
    const indexesDir = path.join(gameDir, 'assets', 'indexes');
    const idxPath = path.join(indexesDir, `${assetIndex.id}.json`);
    let assets;
    const assetsUrl = resolveUrl(assetIndex.url, source);
    try {
      assets = await getJSON(assetsUrl);
    } catch {
      ensureDir(indexesDir);
      const d = await getFile(assetIndex.url); // fallback to official
      fs.writeFileSync(idxPath, d);
      assets = JSON.parse(d.toString());
    }
    ensureDir(indexesDir);
    fs.writeFileSync(idxPath, JSON.stringify(assets, null, 2));

    const objectsDir = path.join(gameDir, 'assets', 'objects');
    const assetNames = Object.keys(assets.objects || {});
    let i = 0;
    for (const name of assetNames) {
      i++;
      const obj = assets.objects[name];
      const hash2 = obj.hash.substring(0, 2);
      const assetPath = path.join(objectsDir, hash2, obj.hash);
      if (!fs.existsSync(assetPath)) {
        const assetUrl = resolveUrl(`${MOJANG_RES}/${hash2}/${obj.hash}`, source);
        yield* downloadFile(assetUrl, assetPath);
      }
      yield { type: 'progress', stage: 'assets', current: i, total: assetNames.length, name };
    }
  }

  // Logging config
  if (verJson.logging?.client?.file) {
    const lc = verJson.logging.client;
    const logDir = path.join(gameDir, 'assets', 'log_configs');
    ensureDir(logDir);
    const logPath = path.join(logDir, lc.file.id);
    if (!fs.existsSync(logPath)) {
      yield* downloadFile(resolveUrl(lc.file.url, source), logPath);
    }
  }

  yield { type: 'done' };
}

module.exports = { getVersionList, scanLocalVersions, downloadVersion, launchGame };
