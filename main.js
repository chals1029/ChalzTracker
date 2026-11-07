const { app, BrowserWindow, screen, ipcMain, Tray, Menu, shell } = require('electron');
app.disableHardwareAcceleration();
const path = require('path');
const serverModule = require('./server.js');

const fs = require('fs');
const logDir = process.env.CHALZTRACKER_HOME || path.join(require('os').homedir(), '.chalztracker');
try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* Logging is optional. */ }
const lifeLog = path.join(logDir, 'electron-lifecycle.txt');
function log(msg) {
  try { fs.appendFileSync(lifeLog, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function registerWindowsNotificationIdentity(iconPath) {
  if (process.platform !== 'win32') return;
  const appId = 'com.chalztracker.desktop';
  const shortcutDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ChalzTracker');
  const shortcutPath = path.join(shortcutDir, 'ChalzTracker.lnk');
  const launcher = path.join(__dirname, 'ChalzTracker.exe');
  const target = fs.existsSync(launcher) ? launcher : process.execPath;
  try {
    fs.mkdirSync(shortcutDir, { recursive: true });
    if (fs.existsSync(shortcutPath) && shell.readShortcutLink(shortcutPath).appUserModelId !== appId) {
      log('notification shortcut belongs to another application');
      return;
    }
    const options = {
      target,
      cwd: __dirname,
      args: target === process.execPath ? `"${__dirname}"` : '',
      description: 'ChalzTracker',
      icon: iconPath,
      iconIndex: 0,
      appUserModelId: appId
    };
    if (!shell.writeShortcutLink(shortcutPath, options)) {
      log('failed to create notification shortcut');
      return;
    }
    app.setAppUserModelId(appId);
    try {
      const rootShortcut = path.join(path.dirname(shortcutDir), 'ChalzTracker.lnk');
      if (fs.existsSync(rootShortcut)) {
        const existing = shell.readShortcutLink(rootShortcut);
        const ownedTargets = [path.join(__dirname, 'dist-app', 'ChalzTracker-runtime.exe'), process.execPath]
          .map(file => path.resolve(file).toLowerCase());
        if (existing.appUserModelId === appId && ownedTargets.includes(path.resolve(existing.target).toLowerCase())) {
          const updated = shell.writeShortcutLink(rootShortcut, 'update', {
            target: process.execPath, cwd: __dirname, args: `"${__dirname}"`, icon: iconPath, iconIndex: 0
          });
          if (!updated) log('failed to refresh taskbar shortcut');
        }
      }
    } catch (error) {
      log('taskbar shortcut refresh error: ' + error.message);
    }
  } catch (error) {
    log('notification identity error: ' + error.message);
  }
}
process.on('uncaughtException', err => { try { fs.writeFileSync(path.join(logDir, 'electron-err.txt'), err && err.stack ? err.stack : String(err)); } catch {} });
process.on('unhandledRejection', err => { try { fs.writeFileSync(path.join(logDir, 'electron-rej.txt'), err && err.stack ? err.stack : String(err)); } catch {} });

let mainWindow = null;
let tray = null;
let currentMode = 'dashboard';
let isTopmost = false;

const gotTheLock = app.requestSingleInstanceLock();
log('gotTheLock: ' + gotTheLock);
if (!gotTheLock) {
  log('did not get lock, quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance event');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    log('app.whenReady resolved, calling initApp');
    return initApp();
  }).catch(err => {
    log('initApp error: ' + (err ? err.stack : err));
  });
}

function getWorkArea() {
  const primaryDisplay = screen.getPrimaryDisplay();
  return primaryDisplay.workArea;
}

function getDimensionsForMode(mode, dims = null) {
  const workArea = getWorkArea();
  if (mode === 'pill') {
    return dims && dims.expanded
      ? { w: dims.detailOpen ? 650 : 365, h: 535, dock: true }
      : { w: 360, h: 56, dock: true };
  }
  if (mode === 'widget') {
    const isExpanded = dims && dims.w > 400;
    return {
      w: isExpanded ? 650 : 365,
      h: 475,
      dock: true
    };
  }
  return {
    w: Math.min(940, workArea.width - 32),
    h: Math.min(640, workArea.height - 40),
    dock: false
  };
}

function applyMode(mode, dims = null, dock = true, topmost = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const workArea = getWorkArea();
  const previousMode = currentMode;
  currentMode = mode;
  isTopmost = Boolean(topmost);

  if (mode === 'pill') {
    const target = getDimensionsForMode('pill', dims);
    const bounds = mainWindow.getBounds();
    const area = previousMode === 'pill' ? screen.getDisplayMatching(bounds).workArea : workArea;
    const x = previousMode === 'pill'
      ? Math.max(area.x, Math.min(area.x + area.width - target.w, Math.round(bounds.x + (bounds.width - target.w) / 2)))
      : area.x + area.width - target.w - 16;
    const y = previousMode === 'pill'
      ? Math.max(area.y, Math.min(area.y + area.height - target.h, bounds.y + bounds.height - target.h))
      : area.y + area.height - target.h - 16;

    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setBounds({ x, y, width: target.w, height: target.h });
    mainWindow.webContents.send('window-mode-sync', 'pill');
  } else if (mode === 'widget') {
    const target = getDimensionsForMode('widget', dims);
    const x = workArea.x + workArea.width - target.w - 16;
    const y = workArea.y + workArea.height - target.h - 16;

    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(isTopmost, 'floating');
    mainWindow.setBounds({ x, y, width: target.w, height: target.h });
    mainWindow.webContents.send('window-mode-sync', 'widget');
  } else { // dashboard
    const target = getDimensionsForMode('dashboard');
    const x = workArea.x + Math.round((workArea.width - target.w) / 2);
    const y = workArea.y + Math.round((workArea.height - target.h) / 2);

    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x, y, width: target.w, height: target.h });
    mainWindow.webContents.send('window-mode-sync', 'dashboard');
  }
}

async function initApp() {
  log('initApp started');
  const iconPath = path.join(__dirname, 'assets', 'favicon.ico');
  registerWindowsNotificationIdentity(iconPath);

  mainWindow = new BrowserWindow({
    width: 940,
    height: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  log('mainWindow created, getting port');
  const server = serverModule.server;
  let port = null;
  if (server && server.address()) {
    port = server.address().port;
  } else {
    port = await new Promise(r => server.once('listening', () => r(server.address().port)));
  }
  log('got port: ' + port);
  const startUrl = `http://127.0.0.1:${port}/`;
  log('loading url: ' + startUrl);

  await mainWindow.loadURL(startUrl);
  log('loadURL complete');

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log('render-process-gone: ' + JSON.stringify(details));
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    log('did-fail-load: ' + code + ' ' + desc + ' ' + url);
  });
  mainWindow.on('unresponsive', () => log('mainWindow unresponsive'));

  applyMode('dashboard');
  mainWindow.show();
  mainWindow.focus();
  log('mainWindow shown and focused');

  // IPC handlers for frameless window controls
  ipcMain.on('window-mode', (_event, { mode, dims }) => {
    applyMode(mode, dims, true, isTopmost);
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.on('window-topmost', (_event, val) => {
    isTopmost = typeof val === 'boolean' ? val : !isTopmost;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(currentMode === 'pill' || isTopmost, 'floating');
    }
  });

  // Tray setup
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('ChalzTracker — Your Personal AI Usage Tracker');
    const trayMenu = Menu.buildFromTemplate([
      { label: 'Open Dashboard', click: () => { applyMode('dashboard'); mainWindow.show(); mainWindow.focus(); } },
      { label: 'Compact Widget (W)', click: () => { applyMode('widget'); mainWindow.show(); } },
      { label: 'Mini Pill (M)', click: () => { applyMode('pill'); mainWindow.show(); } },
      { type: 'separator' },
      { label: 'Quit ChalzTracker', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(trayMenu);
    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch { /* ignore tray error */ }

  mainWindow.on('close', (event) => {
    log('mainWindow close event, isQuitting=' + app.isQuitting);
    if (!app.isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    log('mainWindow closed event');
    mainWindow = null;
  });
}

app.on('child-process-gone', (e, details) => log('child-process-gone: ' + JSON.stringify(details)));
app.on('before-quit', (e) => log('app before-quit'));
app.on('will-quit', (e) => log('app will-quit'));
app.on('quit', (e, code) => log('app quit with code ' + code));

app.on('window-all-closed', () => {
  log('app window-all-closed event');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
