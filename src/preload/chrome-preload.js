'use strict';

/**
 * Chrome UI 的 preload：通过 contextBridge 暴露受控的浏览器 API。
 * 网页（WebContentsView）不加载此 preload，因此网页没有任何 Node/主进程能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 渲染层错误采集（供自动化测试与问题定位）
const diagnostics = { errors: [] };
window.addEventListener('error', (event) => {
  try {
    diagnostics.errors.push(String((event && event.message) || event));
  } catch {
    /* ignore */
  }
});
window.addEventListener('unhandledrejection', (event) => {
  try {
    diagnostics.errors.push(`unhandledrejection: ${String(event && event.reason)}`);
  } catch {
    /* ignore */
  }
});

const invoke = (method, payload) => ipcRenderer.invoke('api', method, payload || {});

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch (err) {
        console.error(`[${channel}]`, err);
      }
    };
    ipcRenderer.on(channel, handler);
    return () => {
      try {
        ipcRenderer.removeListener(channel, handler);
      } catch {
        /* ignore */
      }
    };
  };
}

contextBridge.exposeInMainWorld('browser', {
  ready: () => ipcRenderer.invoke('chrome:ready'),
  onState: subscribe('state'),
  onCommand: subscribe('command'),
  onToast: subscribe('toast'),
  onDownloads: subscribe('downloads'),

  tabs: {
    create: (url = 'browser://newtab', opts = {}) => invoke('tab.create', { url, background: !!opts.background }),
    close: (id) => invoke('tab.close', { id }),
    select: (id) => invoke('tab.select', { id }),
    navigate: (url) => invoke('tab.navigate', { url }),
    back: () => invoke('tab.back'),
    forward: () => invoke('tab.forward'),
    reload: () => invoke('tab.reload'),
    stop: () => invoke('tab.stop'),
    retry: () => invoke('tab.retry'),
    reopenClosed: () => invoke('tab.reopenClosed'),
    openInternal: (url) => invoke('tab.openInternal', { url }),
  },

  window: {
    minimize: () => invoke('window.minimize'),
    toggleMaximize: () => invoke('window.toggleMaximize'),
    close: () => invoke('window.close'),
    newIncognito: () => invoke('window.newIncognito'),
  },

  // HTML 浮层（菜单等）显示时，让网页视图暂时让位，避免被原生视图盖住
  overlay: {
    show: () => invoke('overlay.show'),
    hide: () => invoke('overlay.hide'),
  },

  bookmarks: {
    toggle: () => invoke('bookmark.toggle'),
    add: (url, title) => invoke('bookmark.add', { url, title }),
    remove: (id) => invoke('bookmark.remove', { id }),
    list: () => invoke('bookmark.list'),
    setBar: (enabled) => invoke('bookmark.bar', { enabled: !!enabled }),
  },

  history: {
    list: (query = '', limit = 300) => invoke('history.list', { query, limit }),
    remove: (id) => invoke('history.remove', { id }),
    clear: () => invoke('history.clear'),
  },

  downloads: {
    list: () => invoke('downloads.list'),
    clear: () => invoke('downloads.clear'),
    reveal: (id) => invoke('downloads.reveal', { id }),
  },

  settings: {
    get: () => invoke('settings.get'),
    update: (patch) => invoke('settings.update', { patch }),
  },

  wallpaper: {
    setPreset: (id) => invoke('wallpaper.setPreset', { id }),
    pick: () => invoke('wallpaper.pick'),
    reset: () => invoke('wallpaper.reset'),
    get: () => invoke('wallpaper.get'),
  },

  privacy: {
    clear: (options = {}) => invoke('privacy.clear', options),
  },

  app: {
    info: () => invoke('app.info'),
    quit: () => invoke('app.quit'),
  },

  diagnostics: {
    errors: () => diagnostics.errors.slice(),
  },
});