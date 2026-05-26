const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getFolders: () => ipcRenderer.invoke('get-folders'),
  createFolder: (name) => ipcRenderer.invoke('create-folder', name),
  openTerminal: (path) => ipcRenderer.invoke('open-terminal', path),
  openClaudeMd: (path) => ipcRenderer.invoke('open-claude-md', path),
  openGlobalClaudeMd: () => ipcRenderer.invoke('open-global-claude-md'),
  openExplorer: (path) => ipcRenderer.invoke('open-explorer', path),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  toggleArchive: (path) => ipcRenderer.invoke('toggle-archive', path),
  getBeepEnabled: () => ipcRenderer.invoke('get-beep-enabled'),
  setBeepEnabled: (enabled) => ipcRenderer.invoke('set-beep-enabled', enabled),
  testBeep: () => ipcRenderer.invoke('test-beep'),
  getCreateBrainEnabled: () => ipcRenderer.invoke('get-create-brain-enabled'),
  setCreateBrainEnabled: (enabled) => ipcRenderer.invoke('set-create-brain-enabled', enabled),
  getMemoryProtocolInstalled: () => ipcRenderer.invoke('get-memory-protocol-installed'),
  setMemoryProtocolInstalled: (enabled) => ipcRenderer.invoke('set-memory-protocol-installed', enabled),
  getMemoryPromptDismissed: () => ipcRenderer.invoke('get-memory-prompt-dismissed'),
  setMemoryPromptDismissed: (dismissed) => ipcRenderer.invoke('set-memory-prompt-dismissed', dismissed),
  generateSummary: (path) => ipcRenderer.invoke('generate-summary', path),
  setSummary: (path, text) => ipcRenderer.invoke('set-summary', path, text),
  suggestSummary: (path) => ipcRenderer.invoke('suggest-summary', path),
  // Status reports (v2.0)
  hasStatusReport: (path) => ipcRenderer.invoke('has-status-report', path),
  hasBrainFolder: (path) => ipcRenderer.invoke('has-brain-folder', path),
  generateStatusReport: (path) => ipcRenderer.invoke('generate-status-report', path),
  openStatusReport: (path) => ipcRenderer.invoke('open-status-report', path),
  deleteStatusReport: (path) => ipcRenderer.invoke('delete-status-report', path),
  scaffoldBrainForProject: (path) => ipcRenderer.invoke('scaffold-brain-for-project', path),
  openStatusTemplate: () => ipcRenderer.invoke('open-status-template'),
  resetStatusTemplate: () => ipcRenderer.invoke('reset-status-template'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadAndInstallUpdate: (downloadUrl, version) => ipcRenderer.invoke('download-and-install-update', downloadUrl, version),
  onUpdateDownloadProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update-download-progress', listener);
    return () => ipcRenderer.removeListener('update-download-progress', listener);
  }
});
