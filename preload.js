const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (ch, ...args) => ipcRenderer.send(ch, ...args),
  getData: () => ipcRenderer.invoke('getData'),
  saveSettings: (s) => ipcRenderer.invoke('saveSettings', s),
  selectJava: () => ipcRenderer.invoke('selectJava'),
  selectGameDir: () => ipcRenderer.invoke('selectGameDir'),
  scanGameDir: () => ipcRenderer.invoke('scanGameDir'),
  loginMicrosoft: () => ipcRenderer.invoke('loginMicrosoft'),
  loginOffline: (n) => ipcRenderer.invoke('loginOffline', n),
  removeAccount: (u) => ipcRenderer.invoke('removeAccount', u),
  getVersions: () => ipcRenderer.invoke('getVersions'),
  getLocalVersions: () => ipcRenderer.invoke('getLocalVersions'),
  downloadVersion: (id) => ipcRenderer.invoke('downloadVersion', id),
  launch: (acc, verId) => ipcRenderer.invoke('launch', acc, verId),
  onProgress: (cb) => ipcRenderer.on('downloadProgress', (e, d) => cb(d))
});
