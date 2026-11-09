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
  // Keep the native window and its hit area aligned with the visible panels.
  window.addEventListener('DOMContentLoaded', () => {
    const widget = document.getElementById('widget-shell');
    const widgetHost = document.getElementById('widget-host');
    const pill = document.getElementById('mini-pill-dock');
    const toasts = document.getElementById('toast-container');
    if (!widget || !widgetHost || !pill) return;
    let scheduled = false;
    let last = '';
    let pendingKey = '';
    let pendingAttempts = 0;
    let queue = Promise.resolve();
    const update = () => {
      scheduled = false;
      const mode = document.body.dataset.viewMode;
      let regions;
      if (mode === 'dashboard') {
        const radius = parseFloat(getComputedStyle(document.body).borderTopLeftRadius) || 0;
        regions = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, radius }];
      } else if (mode === 'widget' || mode === 'pill') {
        const visible = [widget, pill, ...Array.from(toasts?.children || []).slice(-62)]
          .filter(element => element.getClientRects().length);
        regions = visible.map(element => {
          const rect = element.getBoundingClientRect();
          const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            radius: Math.min(radius, rect.width / 2, rect.height / 2) };
        }).filter(rect => rect.width > 0 && rect.height > 0);
        if (!regions.length) return;
      } else { return; }
      const key = JSON.stringify([window.devicePixelRatio, regions]);
      if (key === last) return;
      if (key !== pendingKey) { pendingKey = key; pendingAttempts = 0; }
      last = key;
      queue = queue.then(async () => {
        const status = await invoke('set_glass_regions', { regions });
        if (status === 'ready') document.documentElement.dataset.nativeBlur = 'true';
        else delete document.documentElement.dataset.nativeBlur;
        if (status === 'pending' && pendingAttempts++ < 50) {
          setTimeout(() => { if (last === key) { last = ''; schedule(); } }, 200);
        }
      }).catch(error => {
        delete document.documentElement.dataset.nativeBlur;
        last = '';
        console.error('Could not update glass window shape', error);
      });
    };
    const schedule = () => {
      if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
    };
    const sizeObserver = new ResizeObserver(schedule);
    [widget, pill, document.body].forEach(element => sizeObserver.observe(element));
    const visibilityObserver = new MutationObserver(schedule);
    visibilityObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-view-mode', 'data-pill-expanded'] });
    [widgetHost, pill].forEach(element => visibilityObserver.observe(element, { attributes: true, attributeFilter: ['hidden'] }));
    if (toasts) {
      sizeObserver.observe(toasts);
      visibilityObserver.observe(toasts, { childList: true });
    }
    window.addEventListener('resize', schedule);
    schedule();
  });
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    if (event.target.closest('.desktop-titlebar, .widget-chrome, .mini-pill-drag')) {
      invoke('window_action', { action: 'drag' });
    }
  });
})();
