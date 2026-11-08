'use strict';

/**
 * WindowManager —— 浏览器的核心：窗口、标签页、WebContentsView、导航、数据接口。
 *
 * 设计要点：
 * - 每个窗口有一个 chrome UI（BrowserWindow 的 renderer，负责标签栏/地址栏/内页）。
 * - 每个网页标签页是一个 WebContentsView，叠加在 chrome UI 下方（内容区域）。
 * - 内页（browser://newtab / history / bookmarks / settings / downloads / about / error）
 *   由 chrome UI 自己渲染，因此不创建 WebContentsView。
 * - 无痕窗口使用非持久化 partition（'incognito'），不写历史、退出即销毁。
 */

const path = require('path');
const fs = require('fs');
const {
  BrowserWindow,
  WebContentsView,
  Menu,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  shell,
  session,
  app,
} = require('electron');
const { widevineStatus } = require('./media');

const TRACE_FILE = process.env.BROWSER_TRACE || '';
function trace(...parts) {
  if (!TRACE_FILE) return;
  try {
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} [wm] ${parts.join(' ')}\n`);
  } catch {
    /* ignore */
  }
}

// 标签栏高度比标签本身高 10px：顶部留出一条空白拖动条，方便用鼠标拖动整个窗口
const TABSTRIP_HEIGHT = 46;
const TOOLBAR_HEIGHT = 46;
const BOOKMARKS_BAR_HEIGHT = 32;

// 无痕窗口的水印（注入到网页里，网页视图会盖住 chrome UI 上的水印）
const INCOGNITO_WATERMARK_CSS = `
html::after {
  content: "无痕模式";
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483647;
  pointer-events: none;
  user-select: none;
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
  font-size: min(15vw, 170px);
  font-weight: 800;
  letter-spacing: 0.22em;
  color: rgba(126, 96, 230, 0.12);
  transform: rotate(-18deg);
  overflow: hidden;
}
`;

const INTERNAL_PAGES = {
  newtab: '新标签页',
  history: '历史记录',
  bookmarks: '书签',
  settings: '设置',
  downloads: '下载内容',
  about: '关于浏览器',
  error: '无法访问此网站',
};

const WALLPAPER_PRESETS = new Set(['midnight', 'dawn', 'teal', 'sunset', 'ocean', 'paper']);

const SEARCH_ENGINES = {
  bing: 'https://www.bing.com/search?q=%s',
  baidu: 'https://www.baidu.com/s?wd=%s',
  google: 'https://www.google.com/search?q=%s',
  duckduckgo: 'https://duckduckgo.com/?q=%s',
};

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

const APP_ICON = path.join(__dirname, '..', 'renderer', 'icon.png');

const MAX_CLOSED_TABS = 12;

let nextWindowId = 1;
let nextTabId = 1;
let nextDownloadId = 1;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function isInternalUrl(url) {
  return /^browser:\/\//i.test(url || '');
}

function internalPage(url) {
  if (!isInternalUrl(url)) return null;
  try {
    const u = new URL(url);
    const page = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
    return INTERNAL_PAGES[page] ? page : 'newtab';
  } catch {
    return 'newtab';
  }
}

function makeInternalUrl(page, params) {
  let url = `browser://${page}`;
  if (params && Object.keys(params).length) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

function resolveInput(raw, settings) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (isInternalUrl(s)) return s;
  if (/^(https?|file):/i.test(s)) return s;
  // 本机 / IP 地址（可带端口），未写协议时默认 http
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) {
    return 'http://' + s;
  }
  // 形如 example.com:8080/path —— 主机名 + 端口，不能当作协议处理
  if (/^[^\s:/]+:\d+(\/|$)/.test(s)) {
    return 'http://' + s;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // 其它协议交给错误页/外部程序处理
  if (/\s/.test(s)) {
    const q = encodeURIComponent(s);
    return (SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.bing).replace('%s', q);
  }
  if (/^[^\s/]+\.[^\s/]+/.test(s)) return 'https://' + s; // 形如 example.com/path
  const q = encodeURIComponent(s);
  return (SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.bing).replace('%s', q);
}

function cleanTitle(title, fallbackUrl) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t && t.length <= 120) return t;
  if (t) return t.slice(0, 120);
  try {
    const u = new URL(fallbackUrl);
    return u.hostname || fallbackUrl;
  } catch {
    return fallbackUrl || '新标签页';
  }
}

function uniquePath(dir, filename) {
  const safe = String(filename || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

class WindowManager {
  constructor({ store, preloadPath, rendererPath, offscreen = false }) {
    this.store = store;
    this.preloadPath = preloadPath;
    this.rendererPath = rendererPath;
    this.offscreen = offscreen;
    this.windows = new Map();
    this.downloads = [];
    this._wallpaperCache = null;
    this._wallpaperVersion = 0;
  }

  // ───────────────────────────── 窗口 ─────────────────────────────

  createWindow({ incognito = false } = {}) {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 460,
      ...(this.offscreen ? { x: -3600, y: 0, skipTaskbar: true } : {}),
      ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
      frame: false,
      show: false,
      backgroundColor: '#0b0d10',
      title: '浏览器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    if (process.platform === 'win32') {
      try {
        win.setBackgroundColor('#0b0d10');
      } catch {
        /* ignore */
      }
    }

    const w = {
      id: nextWindowId++,
      win,
      incognito,
      chromeWebContentsId: win.webContents.id,
      tabs: [],
      activeTabId: null,
      attachedTabId: null,
      closedTabs: [],
      chromeReady: false,
      stateQueued: false,
      layoutQueued: false,
      // 覆盖层（菜单等 HTML 浮层）：网页视图是窗口原生子视图，永远盖在 chrome UI 之上，
      // 打开浮层时先把视图摘下并保存一张页面快照，让浮层和点击都落到 chrome UI 上。
      overlayTabId: null,
      overlayImage: null,
    };
    this.windows.set(w.id, w);
    this._applyWindowTheme(w);
    this._attachWindowEvents(w);

    win.loadFile(this.rendererPath, {
      query: { incognito: incognito ? '1' : '0', wid: String(w.id) },
    }).then(() => trace('chrome ui loaded', w.id)).catch((err) => trace('chrome ui load error', err && err.message));

    // 兜底：若 chrome UI 迟迟没有握手，也把窗口显示出来
    const fallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 4000);
    win.once('closed', () => clearTimeout(fallback));

    return w;
  }

  _attachWindowEvents(w) {
    const { win } = w;
    win.on('resize', () => this._scheduleLayout(w));
    win.on('maximize', () => this.sendState(w));
    win.on('unmaximize', () => this.sendState(w));
    win.on('enter-full-screen', () => this.sendState(w));
    win.on('leave-full-screen', () => this.sendState(w));
    win.on('closed', () => this._onWindowClosed(w));
    win.webContents.on('before-input-event', (event, input) => {
      if (this.handleShortcut(w, input)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  _onWindowClosed(w) {
    for (const tab of w.tabs) {
      if (tab.view) {
        try {
          tab.view.webContents.close();
        } catch {
          /* ignore */
        }
        tab.view = null;
      }
    }
    w.tabs = [];
    this.windows.delete(w.id);
    if (w.incognito && ![...this.windows.values()].some((x) => x.incognito)) {
      session
        .fromPartition('incognito')
        .clearStorageData()
        .catch(() => {});
    }
  }

  fromSender(sender) {
    if (!sender) return null;
    for (const w of this.windows.values()) {
      if (w.chromeWebContentsId === sender.id) return w;
    }
    return null;
  }

  focusLastWindow() {
    const wins = [...this.windows.values()];
    if (!wins.length) return this.createWindow();
    const w = wins[wins.length - 1];
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
    return w;
  }

  // ───────────────────────────── 标签页 ─────────────────────────────

  activeTab(w) {
    return w.tabs.find((t) => t.id === w.activeTabId) || null;
  }

  createTab(w, rawUrl = 'browser://newtab', { select = true } = {}) {
    const tab = {
      id: nextTabId++,
      url: '',
      title: '新标签页',
      favicon: '',
      loading: false,
      error: null,
      errorUrl: null,
      view: null,
    };
    const settings = this.store.getSettings();
    const url = isInternalUrl(rawUrl) ? rawUrl : resolveInput(rawUrl, settings) || 'browser://newtab';

    w.tabs.push(tab);
    if (isInternalUrl(url)) {
      tab.url = url;
      tab.title = INTERNAL_PAGES[internalPage(url)] || '新标签页';
    } else {
      tab.url = url;
      this._ensureView(w, tab);
      this._loadInView(w, tab, url);
    }

    if (select) this.selectTab(w, tab.id);
    else this.sendState(w);
    return this._tabState(tab);
  }

  selectTab(w, id) {
    const tab = w.tabs.find((t) => t.id === id);
    if (!tab) return false;
    this._clearOverlay(w);
    if (w.activeTabId === id && w.attachedTabId === id) {
      this.sendState(w);
      return true;
    }
    if (w.attachedTabId && w.attachedTabId !== id) this._detachView(w);
    w.activeTabId = id;
    if (tab.view) {
      this._attachView(w, tab);
      try {
        tab.view.webContents.focus();
      } catch {
        /* ignore */
      }
    } else {
      w.win.webContents.focus();
    }
    this.layout(w);
    this.sendState(w);
    return true;
  }

  closeTab(w, id) {
    const idx = w.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this._clearOverlay(w);
    if (w.attachedTabId === id) this._detachView(w);
    const tab = w.tabs[idx];
    if (tab.view) {
      try {
        tab.view.webContents.close();
      } catch {
        /* ignore */
      }
      tab.view = null;
    }
    if (isHttpUrl(tab.url)) {
      w.closedTabs.push({ url: tab.url, title: tab.title });
      if (w.closedTabs.length > MAX_CLOSED_TABS) w.closedTabs.shift();
    }
    w.tabs.splice(idx, 1);
    if (w.activeTabId === id) {
      const next = w.tabs[Math.min(idx, w.tabs.length - 1)];
      if (next) this.selectTab(w, next.id);
      else this.createTab(w, 'browser://newtab');
    } else {
      this.sendState(w);
    }
    return true;
  }

  closeActiveTab(w) {
    if (w.activeTabId) this.closeTab(w, w.activeTabId);
  }

  reopenClosedTab(w) {
    const last = w.closedTabs.pop();
    if (!last) return false;
    this.createTab(w, last.url);
    return true;
  }

  cycleTab(w, delta) {
    if (w.tabs.length < 2) return;
    const idx = w.tabs.findIndex((t) => t.id === w.activeTabId);
    const next = (idx + delta + w.tabs.length) % w.tabs.length;
    this.selectTab(w, w.tabs[next].id);
  }

  openInternalTab(w, url) {
    return this.createTab(w, url, { select: true });
  }

  // ───────────────────────────── 导航 ─────────────────────────────

  _ensureView(w, tab) {
    if (tab.view) return tab.view;
    const webPreferences = {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    };
    if (w.incognito) webPreferences.partition = 'incognito';
    const view = new WebContentsView({ webPreferences });
    try {
      view.setBackgroundColor('#0b0d10');
    } catch {
      /* 老版本兼容 */
    }
    tab.view = view;
    this._wireView(w, tab, view);
    return view;
  }

  _wireView(w, tab, view) {
    const wc = view.webContents;
    const send = () => this.sendState(w);

    wc.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) this.createTab(w, url);
      else if (/^mailto:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      if (!/^(https?|file):|^about:blank$/i.test(url)) {
        event.preventDefault();
        if (/^mailto:/i.test(url)) shell.openExternal(url).catch(() => {});
      }
    });

    wc.on('page-title-updated', (event, title) => {
      tab.title = cleanTitle(title, tab.url);
      this._recordHistory(w, tab, true);
      send();
    });
    wc.on('page-favicon-updated', (event, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons[0] ? favicons[0] : '';
      send();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      send();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this._syncNavState(tab);
      this._recordHistory(w, tab);
      send();
    });
    wc.on('did-navigate', (event, url) => this._onDidNavigate(w, tab, url));
    wc.on('did-navigate-in-page', (event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this._onDidNavigate(w, tab, url);
      this._recordHistory(w, tab);
    });
    wc.on('did-fail-load', (event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED（用户主动取消）
      this._showErrorPage(w, tab, { code, description, url: validatedURL || tab.url });
    });
    wc.on('render-process-gone', () => {
      this._showErrorPage(w, tab, {
        code: 'renderer',
        description: '页面进程异常退出',
        url: tab.url,
      });
    });
    wc.on('context-menu', (event, params) => this._showContextMenu(w, tab, params));
    // 无痕窗口：网页视图盖在 chrome UI 上，把水印直接注入每个新文档
    if (w.incognito) {
      wc.on('dom-ready', () => {
        wc.insertCSS(INCOGNITO_WATERMARK_CSS).catch(() => {});
      });
    }
    wc.on('before-input-event', (event, input) => {
      if (this.handleShortcut(w, input)) event.preventDefault();
    });
    wc.on('app-command', (event, command) => {
      if (command === 'browser-backward') this.back(w);
      else if (command === 'browser-forward') this.forward(w);
    });
  }

  _attachView(w, tab) {
    if (!tab.view) return;
    try {
      w.win.contentView.addChildView(tab.view);
    } catch {
      /* 已经添加过 */
    }
    w.attachedTabId = tab.id;
    this.layout(w);
  }

  _detachView(w) {
    const prev = w.tabs.find((t) => t.id === w.attachedTabId);
    w.attachedTabId = null;
    if (prev && prev.view) {
      try {
        w.win.contentView.removeChildView(prev.view);
      } catch {
        /* ignore */
      }
    }
  }

  // ───────────────────────────── 浮层（菜单 / 弹层）─────────────────────────────
  //
  // 网页标签页是 WebContentsView，属于窗口原生子视图，层级永远高于 chrome UI 的
  // HTML；菜单这类 HTML 浮层如果直接显示会被网页盖住，既看不见也点不到。
  // 因此打开浮层时先把当前网页视图摘下（保留一张页面快照交给渲染层铺在内容区），
  // 浮层关闭后再把视图装回去。

  _clearOverlay(w) {
    if (!w) return;
    w.overlayTabId = null;
    w.overlayImage = null;
  }

  async showOverlay(w) {
    if (!w || w.win.isDestroyed()) return null;
    if (w.overlayTabId) return { active: true, tabId: w.overlayTabId, image: w.overlayImage };
    const tab = w.tabs.find((t) => t.id === w.attachedTabId);
    if (!tab || !tab.view) return null;

    // 先截一张当前网页的图，视图摘下后由渲染层铺在内容区，避免闪白。
    // 窗口刚显示 / 页面刚渲染时首帧可能还没合成，这里重试一次。
    let image = null;
    for (let attempt = 0; attempt < 2 && !image; attempt += 1) {
      try {
        const shot = await tab.view.webContents.capturePage();
        if (shot && !shot.isEmpty()) {
          const dataUrl = shot.toDataURL();
          if (dataUrl && dataUrl.length > 32) image = dataUrl;
        }
      } catch {
        /* 截图失败不影响功能，只是少一层底图 */
      }
      if (!image) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    if (w.win.isDestroyed()) return null;
    if (w.attachedTabId !== tab.id) return null;
    this._detachView(w);
    w.overlayTabId = tab.id;
    w.overlayImage = image;
    this.sendState(w);
    return { active: true, tabId: tab.id, image };
  }

  hideOverlay(w) {
    if (!w || w.win.isDestroyed()) return false;
    if (!w.overlayTabId) return false;
    const id = w.overlayTabId;
    this._clearOverlay(w);
    const tab = w.tabs.find((t) => t.id === id);
    if (tab && tab.id === w.activeTabId && tab.view) {
      this._attachView(w, tab);
      try {
        tab.view.webContents.focus();
      } catch {
        /* ignore */
      }
    }
    this.sendState(w);
    return true;
  }

  _loadInView(w, tab, url) {
    if (!tab.view) return;
    tab.loading = true;
    tab.error = null;
    tab.errorUrl = null;
    tab.view.webContents.loadURL(url).catch(() => {
      // 具体错误由 did-fail-load 统一处理
    });
  }

  _onDidNavigate(w, tab, url) {
    if (/^chrome-error:/i.test(url || '')) return; // 加载失败由错误页接管
    tab.url = url;
    tab.error = null;
    tab.errorUrl = null;
    if (tab.title === '新标签页' || !tab.title) tab.title = cleanTitle('', url);
    this._syncNavState(tab);
    this.sendState(w);
  }

  /**
   * 写入浏览记录：在页面加载完成 / 单页内导航 / 标题更新时调用，
   * 保证记录里保存的是网页标题而不是域名。titleOnly 仅更新当前条目标题。
   */
  _recordHistory(w, tab, titleOnly = false) {
    if (w.incognito || !isHttpUrl(tab.url)) return;
    try {
      if (titleOnly) {
        // 标题更新非常频繁：只改内存，写入磁盘交给防抖，避免每改一次标题都同步写文件
        this.store.updateHistoryTitle(tab.url, tab.title || '');
        return;
      }
      this.store.addHistory({ url: tab.url, title: tab.title || '' });
    } catch {
      /* 历史记录失败不应影响浏览 */
    }
  }

  _syncNavState(tab) {
    if (!tab.view) return;
    try {
      const history = tab.view.webContents.navigationHistory;
      tab.canGoBack = history.canGoBack();
      tab.canGoForward = history.canGoForward();
    } catch {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
  }

  _showErrorPage(w, tab, { code, description, url }) {
    trace('show error page', tab.id, code, description, url);
    if (w.attachedTabId === tab.id) {
      try {
        if (tab.view) w.win.contentView.removeChildView(tab.view);
      } catch {
        /* ignore */
      }
      w.attachedTabId = null;
    }
    if (tab.view) {
      try {
        tab.view.webContents.close();
      } catch {
        /* ignore */
      }
      tab.view = null;
    }
    tab.error = { code, description };
    tab.errorUrl = url;
    tab.url = makeInternalUrl('error', { url, code, desc: description || '' });
    tab.title = '无法访问此网站';
    tab.loading = false;
    tab.canGoBack = false;
    tab.canGoForward = false;
    w.win.webContents.focus();
    trace('error page set', tab.id, tab.url);
    this.sendState(w);
  }

  navigate(w, rawUrl, tabId) {
    const tab = tabId ? w.tabs.find((t) => t.id === tabId) : this.activeTab(w);
    if (!tab) return false;
    this._clearOverlay(w);
    const settings = this.store.getSettings();
    const url = resolveInput(rawUrl, settings);
    if (!url) return false;

    if (isInternalUrl(url)) {
      this._goInternal(w, tab, url);
      return true;
    }
    tab.url = url;
    tab.error = null;
    tab.errorUrl = null;
    tab.title = cleanTitle('', url);
    this._ensureView(w, tab);
    this._detachView(w);
    this._attachView(w, tab);
    this._loadInView(w, tab, url);
    try {
      tab.view.webContents.focus();
    } catch {
      /* ignore */
    }
    this.sendState(w);
    return true;
  }

  _goInternal(w, tab, url) {
    if (tab.view) {
      if (w.attachedTabId === tab.id) this._detachView(w);
      try {
        tab.view.webContents.close();
      } catch {
        /* ignore */
      }
      tab.view = null;
    }
    tab.url = url;
    tab.title = INTERNAL_PAGES[internalPage(url)] || '新标签页';
    tab.loading = false;
    tab.favicon = '';
    tab.error = null;
    tab.errorUrl = null;
    tab.canGoBack = false;
    tab.canGoForward = false;
    w.win.webContents.focus();
    this.sendState(w);
  }

  back(w) {
    const tab = this.activeTab(w);
    if (tab && tab.view) {
      try {
        if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
      } catch {
        /* ignore */
      }
    }
  }

  forward(w) {
    const tab = this.activeTab(w);
    if (tab && tab.view) {
      try {
        if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
      } catch {
        /* ignore */
      }
    }
  }

  reload(w) {
    const tab = this.activeTab(w);
    if (!tab) return;
    if (tab.view) {
      try {
        tab.view.webContents.reload();
      } catch {
        /* ignore */
      }
      return;
    }
    if (tab.errorUrl) {
      this.navigate(w, tab.errorUrl);
    } else if (isInternalUrl(tab.url)) {
      this.sendState(w);
    }
  }

  stop(w) {
    const tab = this.activeTab(w);
    if (tab && tab.view) {
      try {
        tab.view.webContents.stop();
      } catch {
        /* ignore */
      }
      tab.loading = false;
      this.sendState(w);
    }
  }

  retry(w) {
    const tab = this.activeTab(w);
    if (tab && tab.errorUrl) this.navigate(w, tab.errorUrl);
  }

  layout(w) {
    if (!w || w.win.isDestroyed()) return;
    const [width, height] = w.win.getContentSize();
    const top = this.chromeTop(w);
    for (const tab of w.tabs) {
      if (!tab.view) continue;
      try {
        tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
      } catch {
        /* ignore */
      }
    }
  }

  // 窗口拖动/缩放时 resize 事件非常密集，合并到一次布局，减少主进程抖动
  _scheduleLayout(w) {
    if (!w || w.layoutQueued || w.win.isDestroyed()) return;
    w.layoutQueued = true;
    setImmediate(() => {
      w.layoutQueued = false;
      if (w.win.isDestroyed()) return;
      this.layout(w);
    });
  }

  chromeTop(w) {
    const settings = w ? this.store.getSettings() : { bookmarksBar: false };
    return TABSTRIP_HEIGHT + TOOLBAR_HEIGHT + (settings.bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0);
  }

  // ───────────────────────────── 状态同步 ─────────────────────────────

  _tabState(tab) {
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      loading: !!tab.loading,
      canGoBack: !!tab.canGoBack,
      canGoForward: !!tab.canGoForward,
      internal: isInternalUrl(tab.url),
      error: !!tab.error,
    };
  }

  buildState(w) {
    const settings = this.store.getSettings();
    const wallpaper = settings.wallpaper || { type: 'preset', id: 'paper' };
    return {
      windowId: w.id,
      incognito: !!w.incognito,
      maximized: w.win.isMaximized(),
      chromeTop: this.chromeTop(w),
      overlay: !!w.overlayTabId,
      tabs: w.tabs.map((t) => this._tabState(t)),
      activeTabId: w.activeTabId,
      bookmarks: this.store.listBookmarks().map((b) => ({ id: b.id, url: b.url, title: b.title })),
      settings: {
        theme: settings.theme,
        searchEngine: settings.searchEngine,
        bookmarksBar: !!settings.bookmarksBar,
      },
      wallpaper: {
        type: wallpaper.type === 'custom' ? 'custom' : 'preset',
        id: wallpaper.type === 'custom' ? null : wallpaper.id || 'paper',
        version: this._wallpaperVersion,
      },
    };
  }

  sendState(w) {
    if (!w || !w.chromeReady || w.win.isDestroyed()) return;
    try {
      w.win.webContents.send('state', this.buildState(w));
    } catch {
      /* ignore */
    }
  }

  broadcastState() {
    for (const w of this.windows.values()) this.sendState(w);
  }

  broadcast(channel, payload) {
    for (const w of this.windows.values()) {
      if (!w.chromeReady || w.win.isDestroyed()) continue;
      try {
        w.win.webContents.send(channel, payload);
      } catch {
        /* ignore */
      }
    }
  }

  toast(w, text, type = 'info') {
    if (!w || w.win.isDestroyed()) return;
    try {
      w.win.webContents.send('toast', { text, type });
    } catch {
      /* ignore */
    }
  }

  toastAll(text, type = 'info') {
    this.broadcast('toast', { text, type });
  }

  async onChromeReady(w) {
    trace('chrome ready', w.id);
    w.chromeReady = true;
    if (!w.tabs.length) this.createTab(w, 'browser://newtab');
    else this.sendState(w);
    if (!w.win.isDestroyed() && !w.win.isVisible()) {
      if (this.offscreen) w.win.showInactive();
      else w.win.show();
    }
    this.layout(w);
    return this.buildState(w);
  }

  // ───────────────────────────── 书签 / 历史 / 设置 ─────────────────────────────

  toggleBookmark(w) {
    const tab = this.activeTab(w);
    if (!tab || !/^(https?|file):/i.test(tab.url)) {
      this.toast(w, '当前页面不支持添加书签', 'error');
      return false;
    }
    if (this.store.isBookmarked(tab.url)) {
      this.store.removeBookmarkByUrl(tab.url);
      this.toast(w, '已从书签中移除');
    } else {
      this.store.addBookmark({ url: tab.url, title: tab.title || tab.url });
      this.toast(w, '已添加书签', 'success');
    }
    this.sendState(w);
    return true;
  }

  addBookmark(w, { url, title }) {
    if (!url || !/^(https?|file):/i.test(url)) return null;
    const item = this.store.addBookmark({ url, title: title || url });
    this.sendState(w);
    this.toast(w, '已添加书签', 'success');
    return item;
  }

  removeBookmark(w, id) {
    const ok = this.store.removeBookmark(id);
    this.sendState(w);
    return ok;
  }

  updateBookmarksBar(enabled) {
    this.store.updateSettings({ bookmarksBar: !!enabled });
    for (const w of this.windows.values()) {
      this.layout(w);
      this.sendState(w);
    }
  }

  toggleBookmarksBar(w) {
    const settings = this.store.getSettings();
    this.updateBookmarksBar(!settings.bookmarksBar);
    this.toast(w, settings.bookmarksBar ? '已隐藏书签栏' : '已显示书签栏');
  }

  // ───────────────────────────── 壁纸 ─────────────────────────────

  getWallpaperPayload() {
    const settings = this.store.getSettings();
    if (settings.wallpaper && settings.wallpaper.type === 'custom') {
      return { type: 'custom', dataUrl: this._getCustomWallpaperDataUrl(), version: this._wallpaperVersion };
    }
    return { type: 'preset', id: (settings.wallpaper && settings.wallpaper.id) || 'paper', version: this._wallpaperVersion };
  }

  _getCustomWallpaperDataUrl() {
    if (this._wallpaperCache !== null) return this._wallpaperCache;
    const p = this.store.getWallpaperPath();
    if (!p) {
      this._wallpaperCache = null;
      return null;
    }
    try {
      let img = nativeImage.createFromPath(p);
      if (img.isEmpty()) {
        this._wallpaperCache = null;
        return null;
      }
      const size = img.getSize();
      if (size.width > 2560) img = img.resize({ width: 2560, quality: 'good' });
      this._wallpaperCache = 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
      return this._wallpaperCache;
    } catch {
      this._wallpaperCache = null;
      return null;
    }
  }

  setWallpaperPreset(id) {
    if (!WALLPAPER_PRESETS.has(id)) return false;
    this.store.updateSettings({ wallpaper: { type: 'preset', id } });
    this._wallpaperCache = null;
    this.broadcastState();
    return true;
  }

  async pickCustomWallpaper(w) {
    const parent = w && !w.win.isDestroyed() ? w.win : undefined;
    const result = await dialog.showOpenDialog(parent, {
      title: '选择壁纸',
      buttonLabel: '设为壁纸',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    try {
      const buf = fs.readFileSync(file);
      const probe = nativeImage.createFromBuffer(buf);
      if (probe.isEmpty()) return { ok: false, error: '无法识别的图片格式' };
      const ext = (path.extname(file) || '.jpg').toLowerCase().replace('.', '') || 'jpg';
      this.store.setCustomWallpaper(buf, ext);
      this._wallpaperCache = null;
      this._wallpaperVersion += 1;
      this.broadcastState();
      if (w) this.toast(w, '壁纸已更换', 'success');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || '壁纸设置失败' };
    }
  }

  resetWallpaper() {
    this.store.removeCustomWallpaper();
    this._wallpaperCache = null;
    this._wallpaperVersion += 1;
    this.broadcastState();
    return true;
  }

  // ───────────────────────────── 隐私 / 数据 ─────────────────────────────

  async clearPrivacyData({ history = false, cookies = false, cache = false } = {}) {
    if (history) this.store.clearHistory();
    const tasks = [];
    if (cookies) {
      tasks.push(
        session.defaultSession
          .clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache'],
          })
          .catch(() => {})
      );
    }
    if (cache) {
      tasks.push(session.defaultSession.clearCache().catch(() => {}));
    }
    await Promise.all(tasks);
    this.broadcastState();
    return true;
  }

  // ───────────────────────────── 下载 ─────────────────────────────

  registerDownload(item) {
    const rec = {
      id: nextDownloadId++,
      filename: path.basename(item.getFilename() || 'download'),
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      savePath: '',
      startTime: Date.now(),
    };
    try {
      const dir = app.getPath('downloads');
      fs.mkdirSync(dir, { recursive: true });
      const savePath = uniquePath(dir, rec.filename);
      item.setSavePath(savePath);
      rec.savePath = savePath;
    } catch {
      /* 使用系统默认路径 */
    }
    this.downloads.unshift(rec);
    if (this.downloads.length > 50) this.downloads.length = 50;

    const sync = () => {
      rec.state = item.getState();
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.savePath = item.getSavePath() || rec.savePath;
      this.broadcast('downloads', this.downloads);
    };
    item.on('updated', sync);
    item.on('done', (event, state) => {
      sync();
      if (state === 'completed') this.toastAll(`下载完成：${rec.filename}`, 'success');
      else if (state === 'cancelled') this.toastAll(`已取消下载：${rec.filename}`);
      else this.toastAll(`下载失败：${rec.filename}`, 'error');
    });
    this.broadcast('downloads', this.downloads);
  }

  // ───────────────────────────── 快捷键 ─────────────────────────────

  handleShortcut(w, input) {
    if (!input || input.type !== 'keyDown') return false;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    const shift = !!input.shift;

    if (key === 'f5' || (mod && key === 'r')) {
      this.reload(w);
      return true;
    }
    if (mod && shift && key === 'n') {
      this.createWindow({ incognito: true });
      return true;
    }
    if (mod && !shift && key === 't') {
      this.createTab(w, 'browser://newtab');
      return true;
    }
    if (mod && key === 'w') {
      this.closeActiveTab(w);
      return true;
    }
    if (mod && key === 'l') {
      w.win.webContents.focus();
      w.win.webContents.send('command', { action: 'focus-address' });
      return true;
    }
    if (mod && !shift && key === 'd') {
      this.toggleBookmark(w);
      return true;
    }
    if (mod && !shift && key === 'h') {
      this.openInternalTab(w, 'browser://history');
      return true;
    }
    if (mod && !shift && key === 'j') {
      this.openInternalTab(w, 'browser://downloads');
      return true;
    }
    if (mod && shift && key === 'b') {
      this.toggleBookmarksBar(w);
      return true;
    }
    if (mod && shift && key === 't') {
      this.reopenClosedTab(w);
      return true;
    }
    if (mod && shift && (key === 'delete' || key === 'backspace')) {
      this.openInternalTab(w, 'browser://settings');
      return true;
    }
    if (mod && key === 'tab') {
      this.cycleTab(w, shift ? -1 : 1);
      return true;
    }
    if (input.alt && key === 'arrowleft') {
      this.back(w);
      return true;
    }
    if (input.alt && key === 'arrowright') {
      this.forward(w);
      return true;
    }
    if (key === 'escape') {
      const tab = this.activeTab(w);
      if (tab && tab.loading) {
        this.stop(w);
        return true;
      }
    }
    if (mod && !shift && key === '0') {
      const tab = this.activeTab(w);
      if (tab && tab.view) tab.view.webContents.setZoomLevel(0);
      return true;
    }
    if (mod && !shift && (key === '=' || key === '+')) {
      const tab = this.activeTab(w);
      if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.min(6, tab.view.webContents.getZoomLevel() + 0.5));
      return true;
    }
    if (mod && !shift && key === '-') {
      const tab = this.activeTab(w);
      if (tab && tab.view) tab.view.webContents.setZoomLevel(Math.max(-5, tab.view.webContents.getZoomLevel() - 0.5));
      return true;
    }
    return false;
  }

  // ───────────────────────────── 右键菜单 ─────────────────────────────

  _showContextMenu(w, tab, params) {
    const wc = tab.view ? tab.view.webContents : null;
    if (!wc) return;
    const settings = this.store.getSettings();
    const template = [];

    if (params.linkURL) {
      template.push({
        label: '在新标签页中打开链接',
        click: () => this.createTab(w, params.linkURL),
      });
      template.push({
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL),
      });
      template.push({ type: 'separator' });
    }

    if (params.isEditable) {
      template.push({ label: '撤销', role: 'undo' });
      template.push({ label: '重做', role: 'redo' });
      template.push({ type: 'separator' });
      template.push({ label: '剪切', role: 'cut' });
      template.push({ label: '复制', role: 'copy' });
      template.push({ label: '粘贴', role: 'paste' });
      template.push({ label: '全选', role: 'selectAll' });
    } else if (params.selectionText) {
      template.push({ label: '复制', role: 'copy' });
      template.push({ type: 'separator' });
      const text = params.selectionText.length > 24 ? params.selectionText.slice(0, 24) + '…' : params.selectionText;
      template.push({
        label: `搜索“${text}”`,
        click: () => this.createTab(w, resolveInput(params.selectionText, settings)),
      });
    } else {
      let canBack = false;
      let canForward = false;
      try {
        canBack = wc.navigationHistory.canGoBack();
        canForward = wc.navigationHistory.canGoForward();
      } catch {
        /* ignore */
      }
      template.push({ label: '返回', enabled: canBack, click: () => this.back(w) });
      template.push({ label: '前进', enabled: canForward, click: () => this.forward(w) });
      template.push({ label: '重新加载', click: () => this.reload(w) });
      template.push({ type: 'separator' });
      template.push({
        label: this.store.isBookmarked(tab.url) ? '修改/移除书签' : '添加书签',
        click: () => this.toggleBookmark(w),
      });
      template.push({ label: '复制页面地址', click: () => clipboard.writeText(tab.url) });
      template.push({ type: 'separator' });
      template.push({ label: '检查元素', click: () => wc.inspectElement(params.x, params.y) });
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: w.win });
  }

  // ───────────────────────────── 主题 / 信息 ─────────────────────────────

  _applyWindowTheme(w) {
    try {
      const settings = this.store.getSettings();
      const dark = settings.theme === 'dark' || (settings.theme === 'auto' && nativeTheme.shouldUseDarkColors);
      w.win.setBackgroundColor(dark ? '#0b0d10' : '#f5f6f8');
    } catch {
      /* ignore */
    }
  }

  applyThemeToAll() {
    for (const w of this.windows.values()) this._applyWindowTheme(w);
  }

  appInfo() {
    let gpu = null;
    try {
      const status = app.getGPUFeatureStatus();
      gpu = {
        compositing: status.gpu_compositing,
        rasterization: status.rasterization,
        videoDecode: status.video_decode,
        webgl: status.webgl,
      };
    } catch {
      gpu = null;
    }
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      widevine: widevineStatus(),
      gpu,
    };
  }

  // ───────────────────────────── API 分发 ─────────────────────────────

  async invoke(w, method, payload = {}) {
    switch (method) {
      case 'state.get':
        return this.buildState(w);
      // 标签页
      case 'tab.create':
        return this.createTab(w, payload.url || 'browser://newtab', { select: payload.background !== true });
      case 'tab.close':
        return this.closeTab(w, payload.id);
      case 'tab.select':
        return this.selectTab(w, payload.id);
      case 'tab.navigate':
        this.navigate(w, payload.url);
        return true;
      case 'tab.back':
        this.back(w);
        return true;
      case 'tab.forward':
        this.forward(w);
        return true;
      case 'tab.reload':
        this.reload(w);
        return true;
      case 'tab.stop':
        this.stop(w);
        return true;
      case 'tab.retry':
        this.retry(w);
        return true;
      case 'tab.reopenClosed':
        return this.reopenClosedTab(w);
      case 'tab.openInternal':
        return this.openInternalTab(w, payload.url);
      // 浮层：网页视图会让位子 HTML 浮层（菜单等）
      case 'overlay.show':
        return this.showOverlay(w);
      case 'overlay.hide':
        return this.hideOverlay(w);
      // 窗口
      case 'window.minimize':
        w.win.minimize();
        return true;
      case 'window.toggleMaximize':
        if (w.win.isMaximized()) w.win.unmaximize();
        else w.win.maximize();
        return true;
      case 'window.close':
        w.win.close();
        return true;
      case 'window.newIncognito':
        this.createWindow({ incognito: true });
        return true;
      case 'window.newNormal':
        this.createWindow({});
        return true;
      // 书签
      case 'bookmark.toggle':
        return this.toggleBookmark(w);
      case 'bookmark.add':
        return this.addBookmark(w, payload);
      case 'bookmark.remove':
        return this.removeBookmark(w, payload.id);
      case 'bookmark.list':
        return this.store.listBookmarks();
      case 'bookmark.bar':
        this.updateBookmarksBar(payload.enabled);
        return true;
      // 历史
      case 'history.list':
        return this.store.listHistory({ query: payload.query || '', limit: payload.limit || 300 });
      case 'history.remove':
        this.store.removeHistory(payload.id);
        this.broadcastState();
        return true;
      case 'history.clear':
        this.store.clearHistory();
        this.broadcastState();
        return true;
      // 下载
      case 'downloads.list':
        return this.downloads;
      case 'downloads.clear':
        this.downloads = [];
        this.broadcast('downloads', this.downloads);
        return true;
      case 'downloads.reveal':
        return this._revealDownload(payload.id);
      // 设置
      case 'settings.get':
        return this.store.getSettings();
      case 'settings.update': {
        const settings = this.store.updateSettings(payload.patch || {});
        this._wallpaperCache = null;
        this.applyThemeToAll();
        for (const win of this.windows.values()) {
          this.layout(win);
          this.sendState(win);
        }
        return settings;
      }
      // 壁纸
      case 'wallpaper.setPreset':
        return this.setWallpaperPreset(payload.id);
      case 'wallpaper.pick':
        return this.pickCustomWallpaper(w);
      case 'wallpaper.reset':
        return this.resetWallpaper();
      case 'wallpaper.get':
        return this.getWallpaperPayload();
      // 隐私
      case 'privacy.clear':
        await this.clearPrivacyData(payload);
        return true;
      // 应用
      case 'app.info':
        return this.appInfo();
      case 'app.quit':
        app.quit();
        return true;
      default:
        throw new Error(`未知的 API 方法: ${method}`);
    }
  }

  _revealDownload(id) {
    const rec = this.downloads.find((d) => d.id === id);
    if (!rec) return false;
    if (rec.savePath && fs.existsSync(rec.savePath)) {
      shell.showItemInFolder(rec.savePath);
      return true;
    }
    return false;
  }

  // ───────────────────────────── 给 main.js 的会话配置 ─────────────────────────────

  setupSession(sess) {
    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    sess.setPermissionCheckHandler((webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
    try {
      sess.setSpellCheckerLanguages(['zh-CN', 'en-US']);
    } catch {
      /* 忽略 */
    }
    sess.on('will-download', (event, item) => {
      this.registerDownload(item);
    });
  }
}

module.exports = {
  WindowManager,
  TABSTRIP_HEIGHT,
  TOOLBAR_HEIGHT,
  BOOKMARKS_BAR_HEIGHT,
  isInternalUrl,
  internalPage,
  resolveInput,
};