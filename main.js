const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { loginMicrosoft, loginOffline } = require('./auth');
const { getVersionList, scanLocalVersions, downloadVersion, launchGame } = require('./launcher');

const DATA_FILE = path.join(app.getPath('userData'), 'launcher.json');

const defaultSettings = {
  javaPath: 'java',
  memory: 2048,
  gameDir: path.join(app.getPath('userData'), '.minecraft'),
  versionIsolation: false,
  downloadSource: 'bmclapi'
};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // Merge: only override defaults with non-nullish saved values
    const saved = d.settings || {};
    d.settings = { ...defaultSettings };
    for (const [k, v] of Object.entries(saved)) {
      if (v != null) d.settings[k] = v;
    }
    return d;
  } catch {
    return { accounts: [], settings: { ...defaultSettings } };
  }
}

function saveData(obj) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

let win, data = loadData();

function createWindow() {
  win = new BrowserWindow({
    width: 960, height: 640,
    minWidth: 800, minHeight: 560,
    frame: false,
    transparent: false,
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile('renderer/index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// Window controls
ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('win:close', () => win.close());

// Data
ipcMain.handle('getData', () => data);

ipcMain.handle('saveSettings', (_, s) => {
  data.settings = { ...data.settings, ...s };
  saveData(data);
  return data.settings;
});

// Dialogs
ipcMain.handle('selectJava', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Java', extensions: ['exe', 'bat', 'cmd'] }] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('selectGameDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled) return null;
  data.settings.gameDir = r.filePaths[0];
  saveData(data);
  return { path: r.filePaths[0], localVersions: scanLocalVersions(r.filePaths[0]) };
});

// Auth
ipcMain.handle('loginMicrosoft', async () => {
  const acc = await loginMicrosoft();
  data.accounts = data.accounts.filter(a => a.uuid !== acc.uuid);
  data.accounts.push(acc);
  saveData(data);
  return acc;
});

ipcMain.handle('loginOffline', (_, name) => {
  const acc = loginOffline(name);
  data.accounts = data.accounts.filter(a => a.uuid !== acc.uuid);
  data.accounts.push(acc);
  saveData(data);
  return acc;
});

ipcMain.handle('removeAccount', (_, uuid) => {
  data.accounts = data.accounts.filter(a => a.uuid !== uuid);
  saveData(data);
});

// Versions
ipcMain.handle('getVersions', () => getVersionList(data.settings.downloadSource));

ipcMain.handle('getLocalVersions', () => scanLocalVersions(data.settings.gameDir));

// Auto-scan on game dir change
ipcMain.handle('scanGameDir', () => {
  return scanLocalVersions(data.settings.gameDir);
});

// Download
ipcMain.handle('downloadVersion', async (_, verId) => {
  const source = data.settings.downloadSource || 'bmclapi';
  for await (const ev of downloadVersion(verId, data.settings.gameDir, source))
    win.webContents.send('downloadProgress', ev);
  return 'done';
});

// Launch
ipcMain.handle('launch', async (_, account, verId) => {
  console.log('launch args:', { verId, gameDir: data.settings.gameDir, javaPath: data.settings.javaPath, memory: data.settings.memory, versionIsolation: data.settings.versionIsolation });
  if (!data.settings.gameDir) throw new Error('游戏目录未设置，请先在设置中选择游戏目录');
  await launchGame(verId, data.settings.gameDir, data.settings.javaPath, data.settings.memory, account, data.settings.versionIsolation);
});
