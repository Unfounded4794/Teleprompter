const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } = require('electron');
const { readFile } = require('node:fs/promises');
const { basename, dirname, isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const QR = require('qrcode');
const { prepareCertificates } = require('./certificates.cjs');

const product = 'Teleprompter Setup';
const page = 'setup://app/';
const uiFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
protocol.registerSchemesAsPrivileged([{ scheme: 'setup', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName(product);
app.setAppUserModelId('local.teleprompter.setup');
if (isAbsolute(process.env.TELEPROMPTER_DESKTOP_DATA || '')) {
  app.setPath('userData', process.env.TELEPROMPTER_DESKTOP_DATA);
}

const resource = app.isPackaged ? join(process.resourcesPath, 'teleprompter') : dirname(__dirname);
const data = join(app.getPath('userData'), 'teleprompter-data');
const models = join(data, 'models');
let win;
let server;
let networks;
let voice;
let profile;
let busy = '';
let error = '';
let message = '';
let progress = '';
let qr = '';
let closing = false;
let voiceAbort;
let available = {};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(initialize).catch(cause => {
    dialog.showErrorBox(product, cause.message || 'The launcher could not start.');
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!server || closing) return;
  event.preventDefault();
  closing = true;
  voiceAbort?.abort();
  server.close().finally(() => app.quit());
});

async function initialize() {
  const toModule = name => import(pathToFileURL(join(resource, name)).href);
  const [{ createTeleprompterServer }, networkModule, voiceModule, profileModule] = await Promise.all([
    toModule('server.mjs'), toModule('scripts/local-network.mjs'),
    toModule('scripts/prepare-voice.mjs'), toModule('scripts/lan-profile.mjs'),
  ]);
  networks = networkModule;
  voice = voiceModule;
  profile = profileModule;
  server = createTeleprompterServer({ build: join(resource, 'dist'), data });
  await voice.installVoiceFromFolder(join(resource, 'bundled-models'), models, 'base');
  await voice.installVoiceFromFolder(join(resource, 'bundled-models'), models, 'tiny');
  await refreshModels();
  protocol.handle('setup', async request => {
    const url = new URL(request.url);
    const asset = url.host === 'app' && Object.hasOwn(uiFiles, url.pathname) ? uiFiles[url.pathname] : null;
    if (!asset) return new Response(null, { status: 404 });
    const [file, type] = asset;
    const filePath = file === 'icon.svg' ? join(resource, 'dist', file) : join(__dirname, 'ui', file);
    return new Response(await readFile(filePath), { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  });
  registerActions();
  win = new BrowserWindow({
    title: product,
    width: 795, height: 748, minWidth: 530, minHeight: 590,
    show: false, backgroundColor: '#101118', autoHideMenuBar: true,
    icon: join(resource, 'dist', 'icon-192.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  await win.loadURL(page);
  await run('desktop', startDesktop);
}

function registerActions() {
  method('state', snapshot);
  method('retry-desktop', () => run('desktop', startDesktop));
  method('open-desktop', () => run('browser', async () => {
    if (!server.state().desktopUrl) await startDesktop();
    await shell.openExternal(server.state().desktopUrl);
  }));
  method('phone', enabled => {
    if (typeof enabled !== 'boolean') return snapshot();
    return run('phone', async () => {
      if (!enabled) {
        await server.stopPhone();
        qr = '';
        return;
      }
      const addresses = networks.localInterfaces();
      if (!addresses.some(item => item.priority < 2)) throw new Error('Connect this computer to a local network, then try again.');
      await prepareCertificates(join(data, 'certs'), addresses.map(item => item.address), profile.writeLanProfile);
      if (closing) return;
      await server.startPhone({ addresses });
      await updateQr();
    });
  });
  method('address', address => run('address', async () => {
    if (typeof address !== 'string') return;
    server.selectAddress(address);
    await updateQr();
  }));
  method('copy-setup', () => {
    const link = selectedAddress()?.setupUrl;
    if (link) clipboard.writeText(link);
    return Boolean(link);
  });
  method('download-voice', model => {
    if (typeof model !== 'string' || !Object.hasOwn(voice.voiceModels, model)) return snapshot();
    return run('models', async () => {
      const label = voice.voiceModels[model].label;
      voiceAbort = new AbortController();
      progress = 'Preparing ' + label + '…';
      publish();
      try {
        await voice.downloadVoice(models, model, {
          signal: voiceAbort.signal,
          progress: item => reportProgress('Downloading ' + label, item),
        });
        await refreshModels();
        message = label + ' is ready to copy to your device.';
      } finally {
        voiceAbort = null;
      }
    });
  });
  method('import-voice', () => run('models', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a prepared voice model folder',
      properties: ['openDirectory'],
      defaultPath: app.isPackaged ? undefined : join(resource, '.local', 'models'),
    });
    if (picked.canceled) return;
    const chosen = picked.filePaths[0];
    const sourceFolders = [chosen, join(chosen, 'models')];
    if (Object.hasOwn(voice.voiceModels, basename(chosen))) sourceFolders.push(dirname(chosen));
    const imported = [];
    for (const [id, model] of Object.entries(voice.voiceModels)) {
      for (const folder of sourceFolders) {
        const ready = await voice.installVoiceFromFolder(folder, models, id, item => reportProgress('Copying ' + model.label, item));
        if (ready) { imported.push(model.label); break; }
      }
    }
    if (!imported.length) throw new Error('Choose a prepared model folder or the folder containing tiny, base, small, and turbo model folders.');
    await refreshModels();
    message = 'Ready to copy to your device: ' + imported.join(', ') + '.';
  }));
}

function method(name, action) {
  ipcMain.handle('setup:' + name, (event, argument) => {
    if (event.sender !== win?.webContents || event.senderFrame?.url !== page) throw new Error('The launcher window is required.');
    return action(argument);
  });
}

async function run(task, action) {
  if (busy || closing) return snapshot();
  busy = task;
  error = '';
  message = '';
  progress = '';
  publish();
  try {
    await action();
  } catch (cause) {
    if (cause.code === 'EADDRINUSE') {
      error = task === 'desktop' || task === 'browser'
        ? 'Port 4173 is in use. Close the other Teleprompter server and click Retry.'
        : 'Port 8443 is in use. Close the other local server and try phone setup again.';
    } else if (!closing) {
      error = cause.message === 'fetch failed'
        ? 'The model download could not connect. Try again online or import prepared models from a folder.'
        : cause.message || 'The action could not be completed.';
    }
  } finally {
    busy = '';
    progress = '';
    publish();
  }
  return snapshot();
}

function snapshot() {
  return { ...server.state(), qr, busy, error, message, progress, models: available };
}

function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('setup:update', snapshot());
}

async function refreshModels() {
  available = Object.fromEntries(await Promise.all(Object.entries(voice.voiceModels).map(async ([id, model]) => [
    id,
    { label: model.label, size: model.size, ready: Boolean(await voice.preparedVoice(models, id)) },
  ])));
}

function startDesktop() {
  return server.startDesktop();
}

function selectedAddress() {
  const state = server.state();
  return state.addresses.find(item => item.address === state.selectedHost);
}

async function updateQr() {
  const url = selectedAddress()?.setupUrl;
  qr = url ? await QR.toDataURL(url, { margin: 2, width: 320, errorCorrectionLevel: 'M' }) : '';
}

function reportProgress(label, { completed, total, percent }) {
  progress = label + ' · ' + completed + '/' + total + ' files' + (Number.isFinite(percent) ? ' · ' + percent + '%' : '');
  publish();
}
