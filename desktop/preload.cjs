const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('setup:state'),
  openDesktop: () => ipcRenderer.invoke('setup:open-desktop'),
  retryDesktop: () => ipcRenderer.invoke('setup:retry-desktop'),
  phone: enabled => ipcRenderer.invoke('setup:phone', enabled),
  address: value => ipcRenderer.invoke('setup:address', value),
  copySetup: () => ipcRenderer.invoke('setup:copy-setup'),
  downloadVoice: model => ipcRenderer.invoke('setup:download-voice', model),
  importVoice: () => ipcRenderer.invoke('setup:import-voice'),
  subscribe: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('setup:update', handler);
    return () => ipcRenderer.removeListener('setup:update', handler);
  },
});
