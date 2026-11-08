(() => {
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
  let pendingMode = null;
  let notificationPermission = window.__CHALZ_NOTIFICATION_PERMISSION__;
  class DesktopNotification {
    constructor(title, options = {}) {
      if (notificationPermission !== 'granted') throw new Error('Notification permission not granted');
      invoke('notify', { title: String(title), body: String(options.body || '') }).catch(console.error);
    }
    static get permission() { return notificationPermission; }
    static async requestPermission() {
      notificationPermission = await invoke('notification_permission');
      return notificationPermission;
    }
  }
  window.Notification = DesktopNotification;
  const modeListeners = new Set();
  window.addEventListener('chalz-mode-sync', event => {
    for (const callback of modeListeners) callback(event.detail);
  });
  window.desktopAPI = Object.freeze({
    setMode: (mode, dims) => { pendingMode = { mode, dims }; },
    minimize: () => invoke('window_action', { action: 'minimize' }),
    maximize: () => invoke('window_action', { action: 'maximize' }),
    close: () => invoke('window_action', { action: 'close' }),
    toggleTopmost: () => invoke('window_action', { action: 'topmost' }),
    onModeSync: callback => { modeListeners.add(callback); return () => modeListeners.delete(callback); },
    getUpdateStatus: () => invoke('get_update_status'),
    installUpdate: () => invoke('install_update'),
    onUpdateStatus: callback => {
      const listener = event => callback(event.detail);
      window.addEventListener('chalz-update-status', listener);
      return () => window.removeEventListener('chalz-update-status', listener);
    }
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (pendingMode && requestUrl.origin === location.origin && method === 'POST' &&
        requestUrl.pathname === '/api/window' && typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      if (body.action === 'mode' && body.mode === pendingMode.mode) {
        init = { ...init, body: JSON.stringify({ ...body, desktopDims: pendingMode.dims }) };
        pendingMode = null;
      }
    }
    return originalFetch(input, init);
  };
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    if (event.target.closest('.desktop-titlebar, .widget-chrome, .mini-pill-drag')) {
      invoke('window_action', { action: 'drag' });
    }
  });
})();
