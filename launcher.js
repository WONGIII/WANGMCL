const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BMCLAPI = 'https://bmclapi2.bangbang93.com';
const MOJANG_META = 'https://launchermeta.mojang.com';
const MOJANG_LIB = 'https://libraries.minecraft.net';
const MOJANG_RES = 'https://resources.download.minecraft.net';

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
    });
  });
}

function getJSON(url) {
  return getFile(url).then(b => JSON.parse(b.toString()));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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
      ws.on('finish', () => { fs.renameSync(tmp, dest); resolve(); });
      res.on('error', reject);
      ws.on('error', reject);
    });
  });
  yield { type: 'file', path: dest, total, loaded };
}

async function getVersionList() {
  try {
    const m = await getJSON(`${BMCLAPI}/mc/game/version_manifest.json`);
    return m.versions.map(v => ({ id: v.id, type: v.type, time: v.releaseTime }));
  } catch {
    const m = await getJSON(`${MOJANG_META}/mc/game/version_manifest.json`);
    return m.versions.map(v => ({ id: v.id, type: v.type, time: v.releaseTime }));
  }
}

// Scan game directory for locally installed versions (vanilla, Forge, Fabric, etc.)
function scanLocalVersions(gameDir) {
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return [];

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  const versions = [];

  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const jsonPath = path.join(versionsDir, dir.name, `${dir.name}.json`);
    if (!fs.existsSync(jsonPath)) continue;

    try {
      const verJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const hasJar = fs.existsSync(path.join(versionsDir, dir.name, `${dir.name}.jar`));

      let verType = verJson.type || 'release';
      // Detect mod loaders
      if (verJson.inheritsFrom) {
        const mainClass = verJson.mainClass || '';
        if (mainClass.includes('fabric') || dir.name.includes('fabric')) verType = 'fabric';
        else if (mainClass.includes('forge') || dir.name.includes('forge')) verType = 'forge';
        else verType = 'modified';
      }

      versions.push({
        id: verJson.id,
        type: verType,
        time: verJson.releaseTime || verJson.time || '',
        local: true,
        hasJar,
        inheritsFrom: verJson.inheritsFrom || null,
        mainClass: verJson.mainClass || null,
        minecraftArguments: verJson.minecraftArguments || null,
        arguments: verJson.arguments || null,
        libraries: verJson.libraries || [],
        assetIndex: verJson.assetIndex || { id: verJson.assets || 'legacy' },
        logging: verJson.logging || null,
        downloads: verJson.downloads || null
      });
    } catch {
      // Skip broken json
    }
  }

  return versions;
}

async function* downloadVersion(versionId, gameDir) {
  ensureDir(gameDir);
  const versionsDir = path.join(gameDir, 'versions', versionId);

  // Get version JSON
  const vManifest = await getJSON(`${BMCLAPI}/mc/game/version_manifest.json`).catch(() =>
    getJSON(`${MOJANG_META}/mc/game/version_manifest.json`));
  const verEntry = vManifest.versions.find(v => v.id === versionId);

  let verJson;
  try { verJson = await getJSON(`${BMCLAPI}/version/${versionId}/json`); }
  catch { verJson = await getJSON(verEntry.url); }

  ensureDir(versionsDir);
  fs.writeFileSync(path.join(versionsDir, `${versionId}.json`), JSON.stringify(verJson, null, 2));

  // Client jar
  const jarUrl = verJson.downloads?.client?.url || `${BMCLAPI}/version/${versionId}/client`;
  yield* downloadFile(jarUrl, path.join(versionsDir, `${versionId}.jar`));

  // Libraries
  const libsDir = path.join(gameDir, 'libraries');
  for (const lib of filterLibs(verJson.libraries)) {
    const libUrl = lib.downloads.artifact.url;
    const mirrorUrl = libUrl.replace('https://libraries.minecraft.net', BMCLAPI + '/maven');
    const libPath = path.join(libsDir, lib.downloads.artifact.path);
    try { yield* downloadFile(mirrorUrl, libPath); }
    catch { yield* downloadFile(libUrl, libPath); }
  }

  // Assets
  const assetIndex = verJson.assetIndex;
  const indexesDir = path.join(gameDir, 'assets', 'indexes');
  const idxPath = path.join(indexesDir, `${assetIndex.id}.json`);
  let assets;
  try { assets = await getJSON(`${BMCLAPI}/assets/${assetIndex.id}.json`); }
  catch { ensureDir(indexesDir); const d = await getFile(assetIndex.url); fs.writeFileSync(idxPath, d); assets = JSON.parse(d.toString()); }
  ensureDir(indexesDir);
  fs.writeFileSync(idxPath, JSON.stringify(assets, null, 2));

  const objectsDir = path.join(gameDir, 'assets', 'objects');
  const totalAssets = Object.keys(assets.objects).length;
  let i = 0;
  for (const [name, obj] of Object.entries(assets.objects)) {
    i++;
    const hash2 = obj.hash.substring(0, 2);
    const assetPath = path.join(objectsDir, hash2, obj.hash);
    try { yield* downloadFile(`${BMCLAPI}/assets/${hash2}/${obj.hash}`, assetPath); }
    catch { yield* downloadFile(`${MOJANG_RES}/${hash2}/${obj.hash}`, assetPath); }
    yield { type: 'progress', stage: 'assets', current: i, total: totalAssets, name };
  }

  // Logging config
  if (verJson.logging?.client?.file) {
    const lc = verJson.logging.client;
    ensureDir(path.join(gameDir, 'assets', 'log_configs'));
    yield* downloadFile(lc.url, path.join(gameDir, 'assets', 'log_configs', lc.id));
  }

  yield { type: 'done' };
}

// --- Platform helpers ---
const isWin = process.platform === 'win32';
const osName = isWin ? 'windows' : (process.platform === 'darwin' ? 'osx' : 'linux');

function checkRules(rules) {
  if (!rules) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.os) {
      if (rule.os.name === osName) allowed = rule.action === 'allow';
    } else {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

function filterLibs(libs) {
  return (libs || []).filter(lib => lib.downloads?.artifact && checkRules(lib.rules));
}

// --- Launch ---
function getVersionJson(versionId, gameDir) {
  const p = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(p)) throw new Error(`版本 ${versionId} 未安装`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildClasspath(verJson, gameDir) {
  const libsDir = path.join(gameDir, 'libraries');
  const cp = [];

  // Main jar
  const jarP = path.join(gameDir, 'versions', verJson.id, `${verJson.id}.jar`);
  if (fs.existsSync(jarP)) cp.push(jarP);

  // Own libraries
  for (const lib of filterLibs(verJson.libraries || [])) {
    const p = path.join(libsDir, lib.downloads.artifact.path);
    if (fs.existsSync(p)) cp.push(p);
  }

  // If Forge/Fabric: also load parent version's classpath
  if (verJson.inheritsFrom) {
    const parentJson = getVersionJson(verJson.inheritsFrom, gameDir);
    const parentJar = path.join(gameDir, 'versions', verJson.inheritsFrom, `${verJson.inheritsFrom}.jar`);
    if (fs.existsSync(parentJar)) cp.unshift(parentJar);
    for (const lib of filterLibs(parentJson.libraries || [])) {
      const p = path.join(libsDir, lib.downloads.artifact.path);
      if (fs.existsSync(p) && !cp.includes(p)) cp.push(p);
    }
  }

  return cp.join(path.delimiter);
}

function launchGame(versionId, gameDir, javaPath, memory, account, versionIsolation = false) {
  return new Promise((resolve, reject) => {
    const verJson = getVersionJson(versionId, gameDir);
    const isModified = !!(verJson.inheritsFrom || verJson.mainClass);

    // Version isolation: use version-specific game dir
    const effectiveGameDir = versionIsolation
      ? path.join(gameDir, 'versions', versionId)
      : gameDir;
    ensureDir(effectiveGameDir);

    const classpath = buildClasspath(verJson, gameDir);
    const nativesPath = path.join(effectiveGameDir, 'natives');
    ensureDir(nativesPath);

    // Build game args (handle both old minecraftArguments and new arguments.game)
    let gameArgsArr = [];
    if (verJson.minecraftArguments) {
      gameArgsArr = verJson.minecraftArguments.split(' ').filter(Boolean);
    } else if (verJson.arguments?.game) {
      for (const arg of verJson.arguments.game) {
        if (typeof arg === 'string') { gameArgsArr.push(arg); continue; }
        if (checkRules(arg.rules)) {
          if (typeof arg.value === 'string') gameArgsArr.push(arg.value);
          else if (Array.isArray(arg.value)) gameArgsArr.push(...arg.value);
        }
      }
    }

    // For modified versions that inherit, also collect parent's game args
    if (verJson.inheritsFrom) {
      const parentJson = getVersionJson(verJson.inheritsFrom, gameDir);
      if (parentJson.minecraftArguments) {
        const parentGameArgs = parentJson.minecraftArguments.split(' ').filter(Boolean);
        // Merge: parent args + child-specific args (dedup)
        for (const a of parentGameArgs) {
          if (!gameArgsArr.includes(a)) gameArgsArr.unshift(a);
        }
      } else if (parentJson.arguments?.game) {
        for (const arg of parentJson.arguments.game) {
          if (typeof arg === 'string') { if (!gameArgsArr.includes(arg)) gameArgsArr.unshift(arg); continue; }
          if (checkRules(arg.rules)) {
            if (typeof arg.value === 'string' && !gameArgsArr.includes(arg.value)) gameArgsArr.unshift(arg.value);
            else if (Array.isArray(arg.value)) gameArgsArr.unshift(...arg.value.filter(v => !gameArgsArr.includes(v)));
          }
        }
      }
      // Use parent's assetIndex if this mod version doesn't have its own
      if (!verJson.assetIndex && parentJson.assetIndex) {
        verJson.assetIndex = parentJson.assetIndex;
      }
    }

    // JVM args
    const jvmArgs = [
      `-Xmx${memory}M`,
      `-Djava.library.path=${nativesPath}`,
      '-Dminecraft.launcher.brand=mc-launcher',
      '-Dminecraft.launcher.version=1.0',
      '-cp', classpath
    ];

    // JVM custom args from version json
    if (verJson.arguments?.jvm) {
      for (const arg of verJson.arguments.jvm) {
        if (typeof arg === 'string') { jvmArgs.push(arg); continue; }
        if (checkRules(arg.rules)) {
          if (typeof arg.value === 'string') jvmArgs.push(arg.value);
          else if (Array.isArray(arg.value)) jvmArgs.push(...arg.value);
        }
      }
    }

    // Logging
    if (verJson.logging?.client) {
      const lc = verJson.logging.client;
      const logPath = path.join(gameDir, 'assets', 'log_configs', lc.id);
      jvmArgs.push(lc.argument.replace('${path}', logPath));
    }

    // Main class
    jvmArgs.push(verJson.mainClass);

    // Template vars
    const vars = {
      '${auth_player_name}': account.name,
      '${auth_uuid}': account.uuid,
      '${auth_access_token}': account.accessToken || '0',
      '${version_name}': versionId,
      '${game_directory}': effectiveGameDir,
      '${game_assets}': path.join(effectiveGameDir, 'assets'),
      '${assets_root}': path.join(gameDir, 'assets'),
      '${assets_index_name}': verJson.assetIndex?.id || verJson.assets || 'legacy',
      '${auth_xuid}': account.xuid || '',
      '${user_type}': account.type === 'microsoft' ? 'msa' : 'mojang',
      '${version_type}': verJson.type || 'release',
      '${launcher_name}': 'mc-launcher',
      '${launcher_version}': '1.0',
      '${classpath_separator}': path.delimiter,
      '${library_directory}': path.join(gameDir, 'libraries'),
      '${clientid}': '0',
      '${auth_session}': account.accessToken || '0'
    };

    gameArgsArr = gameArgsArr.map(arg => {
      let a = arg;
      for (const [k, v] of Object.entries(vars)) a = a.replaceAll(k, v);
      return a;
    });

    const fullArgs = [...jvmArgs, ...gameArgsArr];

    const proc = spawn(javaPath, fullArgs, { cwd: effectiveGameDir, stdio: 'inherit', shell: false });
    proc.on('error', err => reject(new Error(`无法启动 Java: ${err.message}`)));
    setTimeout(() => resolve(), 3000);
  });
}

module.exports = { getVersionList, scanLocalVersions, downloadVersion, launchGame };
