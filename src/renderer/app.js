'use strict';

/* ==========================================================================
   浏览器 —— Chrome UI 渲染层
   ========================================================================== */

const api = window.browser;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 内置壁纸（纯 CSS，无需网络）
const WALLPAPERS = {
  midnight: {
    name: '极夜',
    css:
      'radial-gradient(1000px 680px at 18% 12%, rgba(74,111,197,.38), transparent 62%),' +
      'radial-gradient(1100px 760px at 84% 82%, rgba(96,62,158,.30), transparent 64%),' +
      'linear-gradient(135deg, #0b0f18 0%, #0d1322 54%, #070a10 100%)',
  },
  dawn: {
    name: '晨雾',
    light: true,
    css:
      'radial-gradient(900px 620px at 15% 10%, rgba(255,255,255,.85), transparent 60%),' +
      'radial-gradient(1000px 700px at 85% 90%, rgba(205,216,228,.9), transparent 62%),' +
      'linear-gradient(135deg, #f1e9dd 0%, #e6dccd 46%, #dfe4e9 100%)',
  },
  teal: {
    name: '青碧',
    css:
      'radial-gradient(1100px 760px at 20% 16%, rgba(46,158,140,.34), transparent 62%),' +
      'radial-gradient(900px 640px at 82% 88%, rgba(28,94,92,.42), transparent 60%),' +
      'linear-gradient(140deg, #08130f 0%, #0a1b19 50%, #050b0a 100%)',
  },
  sunset: {
    name: '暮霞',
    css:
      'radial-gradient(1000px 700px at 78% 8%, rgba(214,104,120,.36), transparent 60%),' +
      'radial-gradient(900px 680px at 16% 90%, rgba(112,58,150,.38), transparent 62%),' +
      'linear-gradient(150deg, #120b14 0%, #1d1120 52%, #0a0710 100%)',
  },
  ocean: {
    name: '深海',
    css:
      'radial-gradient(1100px 720px at 12% 82%, rgba(34,94,160,.40), transparent 62%),' +
      'radial-gradient(900px 620px at 88% 18%, rgba(28,142,158,.24), transparent 60%),' +
      'linear-gradient(145deg, #050a12 0%, #081426 52%, #04070d 100%)',
  },
  paper: {
    name: '素白',
    light: true,
    css:
      'radial-gradient(900px 620px at 88% 8%, rgba(255,255,255,.9), transparent 58%),' +
      'radial-gradient(900px 700px at 10% 92%, rgba(203,211,219,.8), transparent 60%),' +
      'linear-gradient(135deg, #f7f5f1 0%, #efece6 50%, #e4e7ea 100%)',
  },
};

const SEARCH_ENGINES = {
  bing: 'Bing',
  baidu: '百度',
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
};

const THEMES = {
  dark: '深色',
  light: '浅色',
  auto: '跟随系统',
};

const BADGE_COLORS = ['#5b8def', '#7a6cf0', '#d96a9c', '#d98a4f', '#3fa98b', '#8a9b4e', '#a16fdc', '#4f9fd8'];

let state = null;
let tabs = [];
let activeTab = null;
let bookmarks = [];
let settings = { theme: 'auto', searchEngine: 'bing', bookmarksBar: false };
let wallpaperInfo = { type: 'preset', id: 'paper', version: 0 };
let customWallpaper = { version: -1, dataUrl: null };
let currentWallpaperCss = WALLPAPERS.paper.css;
let currentWallpaperLight = true;
let chromeTop = 78;
let page = null;
let pageKey = null;
let historyQuery = '';
let bookmarkQuery = '';
let appInfoCache = null;
let menuOpen = false;

const els = {};

// ───────────────────────────── 工具函数 ─────────────────────────────

function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

function parseInternal(url) {
  try {
    const u = new URL(url);
    const kind = (u.hostname || 'newtab').toLowerCase();
    return { kind, params: u.searchParams };
  } catch {
    return { kind: 'newtab', params: new URLSearchParams() };
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function badgeFor(text) {
  const value = String(text || '?');
  let hash = 0;
  for (const ch of value) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return {
    color: BADGE_COLORS[hash % BADGE_COLORS.length],
    letter: (value.trim()[0] || '?').toUpperCase(),
  };
}

function faviconHTML(url) {
  if (url) {
    return `<span class="favicon-box"><img src="${esc(url)}" alt="" loading="lazy"><svg class="icon fav-fallback"><use href="#i-globe"/></svg></span>`;
  }
  return `<span class="favicon-box no-icon"><svg class="icon fav-fallback"><use href="#i-globe"/></svg></span>`;
}

function timeText(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = midnight(now) - midnight(d);
  if (diff === 0) return '今天';
  if (diff === 86400000) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function greetingText() {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function resolveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function activeBookmarked() {
  return !!(activeTab && activeTab.url && bookmarks.some((b) => b.url === activeTab.url));
}

// ───────────────────────────── 初始化 ─────────────────────────────

async function init() {
  els.tabs = $('#tabs');
  els.address = $('#address');
  els.addressWrap = $('#address-wrap');
  els.addrIcon = $('#addr-icon');
  els.addrIconUse = $('#addr-icon-use');
  els.btnBack = $('#btn-back');
  els.btnForward = $('#btn-forward');
  els.btnReload = $('#btn-reload');
  els.reloadIcon = $('#reload-icon');
  els.bookmarkBtn = $('#bookmark-btn');
  els.bookmarkUse = $('#bookmark-use');
  els.menuBtn = $('#menu-btn');
  els.menu = $('#menu');
  els.bookmarksBar = $('#bookmarks-bar');
  els.pageHost = $('#page-host');
  els.snapshot = $('#page-snapshot');
  els.toasts = $('#toasts');
  els.incognitoBtn = $('#incognito-btn');
  els.incognitoWatermark = $('#incognito-watermark');
  els.winMaxIcon = $('#win-max-icon');

  bindEvents();
  bindSubscriptions();
  setInterval(updateClock, 1000);

  try {
    const initial = await api.ready();
    if (initial) applyState(initial);
  } catch (err) {
    console.error('初始化失败', err);
  }
}

function bindSubscriptions() {
  // 主进程已合并短时间内的多次状态广播，这里直接应用即可
  api.onState((next) => {
    try {
      applyState(next);
    } catch (err) {
      console.error('状态更新失败', err);
    }
  });
  api.onCommand((cmd) => {
    if (!cmd) return;
    if (cmd.action === 'focus-address') {
      els.address.focus();
      els.address.select();
    }
  });
  api.onToast((t) => {
    if (t) showToast(t.text, t.type);
  });
  api.onDownloads(() => {
    if (page && page.kind === 'downloads') page.update().catch(() => {});
  });
}

// ───────────────────────────── 状态应用 ─────────────────────────────

function applyState(next) {
  state = next;
  tabs = Array.isArray(next.tabs) ? next.tabs : [];
  bookmarks = Array.isArray(next.bookmarks) ? next.bookmarks : [];
  settings = next.settings || settings;
  wallpaperInfo = next.wallpaper || wallpaperInfo;
  const previousId = activeTab ? activeTab.id : null;
  activeTab = tabs.find((t) => t.id === next.activeTabId) || null;
  chromeTop = Number(next.chromeTop) || 78;

  document.documentElement.style.setProperty('--chrome-top', `${chromeTop}px`);
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
  document.documentElement.dataset.incognito = next.incognito ? '1' : '0';
  // 无痕窗口盖一层「无痕模式」水印（网页里的水印由主进程注入 CSS 实现）
  if (els.incognitoWatermark) els.incognitoWatermark.hidden = !next.incognito;
  // 无痕按钮随窗口状态变化：无痕窗口里点亮成紫色主题色，普通窗口保持常规颜色，
  // 这样一眼就能分清当前窗口是「无痕（不留痕迹）」还是「有痕迹」。
  if (els.incognitoBtn) {
    els.incognitoBtn.classList.toggle('active', !!next.incognito);
    els.incognitoBtn.setAttribute('aria-pressed', next.incognito ? 'true' : 'false');
    els.incognitoBtn.title = next.incognito
      ? '无痕浏览中：不保存浏览记录、Cookie 与表单数据（点击可再开一个无痕窗口）'
      : '无痕浏览：新建无痕窗口（Ctrl+Shift+N）';
  }
  if (!next.overlay) hideSnapshot();

  document.title = activeTab
    ? `${activeTab.title || '浏览器'}${next.incognito ? '（无痕）' : ''} - 浏览器`
    : '浏览器';

  renderTabs(previousId);
  renderToolbar();
  renderBookmarksBar();

  syncWallpaper()
    .then(() => renderActivePage())
    .catch((err) => console.error('壁纸/页面渲染失败', err));
}

function tabIconHTML(tab) {
  return tab.loading ? '<span class="spinner"></span>' : faviconHTML(tab.favicon);
}

function renderTabs(previousId) {
  const activeId = activeTab ? activeTab.id : null;
  const nodes = els.tabs.children;
  let sameStructure = nodes.length === tabs.length;
  if (sameStructure) {
    for (let i = 0; i < tabs.length; i += 1) {
      if (nodes[i].dataset.id !== String(tabs[i].id)) {
        sameStructure = false;
        break;
      }
    }
  }

  if (!sameStructure) {
    // 标签数量 / 顺序变化时才重建 DOM
    els.tabs.innerHTML = tabs
      .map((tab) => {
        return `<div class="tab${tab.id === activeId ? ' active' : ''}" data-action="select-tab" data-id="${tab.id}" title="${esc(tab.title || '')}">
        ${tabIconHTML(tab)}
        <span class="tab-title">${esc(tab.title || '新标签页')}</span>
        <button class="tab-close" data-action="close-tab" data-id="${tab.id}" title="关闭标签页" aria-label="关闭标签页">
          <svg class="icon"><use href="#i-close"/></svg>
        </button>
      </div>`;
      })
      .join('');
  } else {
    // 仅标题 / 图标 / 加载状态变化时就地更新，保留原有 DOM（不打断悬停与过渡）
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      const el = nodes[i];
      const isActive = tab.id === activeId;
      if (el.classList.contains('active') !== isActive) el.classList.toggle('active', isActive);
      const title = tab.title || '新标签页';
      const titleEl = el.querySelector('.tab-title');
      if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
      if (el.title !== title) el.title = title;
      const iconHTML = tabIconHTML(tab);
      const iconNode = el.firstElementChild;
      if (iconNode && iconNode.outerHTML !== iconHTML) iconNode.outerHTML = iconHTML;
    }
  }

  const activeEl = els.tabs.querySelector('.tab.active');
  if (activeEl) {
    try {
      activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* ignore */
    }
  }
}

function addressDisplayValue() {
  if (!activeTab) return '';
  const url = activeTab.url || '';
  if (!activeTab.internal) return url;
  const { kind } = parseInternal(url);
  if (kind === 'newtab' || kind === 'error') return '';
  return url;
}

function renderToolbar() {
  const tab = activeTab;
  els.btnBack.disabled = !tab || !tab.canGoBack;
  els.btnForward.disabled = !tab || !tab.canGoForward;

  const loading = !!(tab && tab.loading);
  els.reloadIcon.setAttribute('href', loading ? '#i-stop' : '#i-reload');
  els.btnReload.title = loading ? '停止加载 (Esc)' : '刷新 (Ctrl+R)';
  els.btnReload.setAttribute('aria-label', loading ? '停止加载' : '刷新');

  if (document.activeElement !== els.address) {
    els.address.value = addressDisplayValue();
  }
  if (state && state.incognito) els.address.placeholder = '无痕浏览 — 搜索或输入网址';

  const url = tab ? tab.url || '' : '';
  let icon = '#i-globe';
  let iconTitle = '搜索或输入网址';
  let secure = false;
  if (tab && tab.internal) {
    const { kind } = parseInternal(url);
    icon = kind === 'error' ? '#i-wifi-off' : '#i-globe';
    iconTitle = '浏览器内部页面';
  } else if (/^https:/i.test(url)) {
    icon = '#i-lock';
    iconTitle = '连接安全（HTTPS）';
    secure = true;
  } else if (/^http:/i.test(url)) {
    icon = '#i-globe';
    iconTitle = '未加密连接（HTTP）';
  } else if (url) {
    icon = '#i-info';
    iconTitle = '本地页面';
  }
  els.addrIconUse.setAttribute('href', icon);
  els.addrIcon.classList.toggle('secure', secure);
  els.addrIcon.title = iconTitle;

  const canBookmark = !!(
    tab &&
    !tab.internal &&
    (tab.url.startsWith('http://') || tab.url.startsWith('https://') || tab.url.startsWith('file:'))
  );
  els.bookmarkBtn.disabled = !canBookmark;
  const starred = canBookmark && activeBookmarked();
  els.bookmarkBtn.classList.toggle('starred', starred);
  els.bookmarkUse.setAttribute('href', starred ? '#i-star-filled' : '#i-star');
  els.bookmarkBtn.title = starred ? '已添加书签（Ctrl+D 移除）' : '添加书签（Ctrl+D）';

  els.winMaxIcon.setAttribute('href', state && state.maximized ? '#i-restore' : '#i-max');
}

function renderBookmarksBar() {
  const show = !!(settings && settings.bookmarksBar);
  els.bookmarksBar.hidden = !show;
  if (!show) {
    els.bookmarksBar.innerHTML = '';
    return;
  }
  if (!bookmarks.length) {
    els.bookmarksBar.innerHTML = '<span class="bm-empty">暂无书签 — 按 Ctrl+D 收藏当前页面</span>';
    return;
  }
  els.bookmarksBar.innerHTML = bookmarks
    .map((b) => {
      const badge = badgeFor(b.title || safeHost(b.url));
      return `<div class="bm-item" data-action="open-bookmark" data-url="${esc(b.url)}" title="${esc(b.url)}">
        <span class="bm-badge" style="background:${badge.color}">${esc(badge.letter)}</span>
        <span class="bm-title">${esc(b.title || safeHost(b.url))}</span>
      </div>`;
    })
    .join('');
}

// ───────────────────────────── 壁纸 ─────────────────────────────

async function syncWallpaper() {
  const wp = wallpaperInfo || { type: 'preset', id: 'paper' };
  if (wp.type === 'custom') {
    if (customWallpaper.version !== wp.version || !customWallpaper.dataUrl) {
      try {
        const data = await api.wallpaper.get();
        if (data && data.type === 'custom' && data.dataUrl) {
          customWallpaper = { version: data.version, dataUrl: data.dataUrl };
        } else {
          customWallpaper = { version: wp.version, dataUrl: null };
        }
      } catch {
        customWallpaper = { version: wp.version, dataUrl: null };
      }
    }
    if (customWallpaper.dataUrl) {
      currentWallpaperCss = `url("${customWallpaper.dataUrl}")`;
      currentWallpaperLight = false;
    } else {
      currentWallpaperCss = WALLPAPERS.paper.css;
      currentWallpaperLight = true;
    }
  } else {
    const def = WALLPAPERS[wp.id] || WALLPAPERS.paper;
    currentWallpaperCss = def.css;
    currentWallpaperLight = !!def.light;
  }
  applyWallpaperToDom();
}

function applyWallpaperToDom() {
  const wpEl = document.querySelector('.newtab .wallpaper');
  if (wpEl) wpEl.style.backgroundImage = currentWallpaperCss;
  const nt = document.querySelector('.page.newtab');
  if (nt) nt.classList.toggle('light', currentWallpaperLight);
}

// ───────────────────────────── 内页路由 ─────────────────────────────

async function renderActivePage() {
  if (!activeTab || !activeTab.internal) {
    els.pageHost.innerHTML = '';
    page = null;
    pageKey = null;
    return;
  }
  const url = activeTab.url;
  if (url !== pageKey) {
    pageKey = url;
    page = null;
    els.pageHost.innerHTML = '';
    const built = await buildPage(url);
    if (pageKey !== url) return;
    page = built;
    if (built) {
      els.pageHost.append(built.el);
      applyWallpaperToDom();
      await built.update();
    }
    return;
  }
  if (page && page.update) await page.update();
}

async function buildPage(url) {
  const info = parseInternal(url);
  switch (info.kind) {
    case 'newtab':
      return buildNewtabPage();
    case 'history':
      return buildHistoryPage();
    case 'bookmarks':
      return buildBookmarksPage();
    case 'settings':
      return buildSettingsPage();
    case 'downloads':
      return buildDownloadsPage();
    case 'about':
      return buildAboutPage();
    case 'error':
      return buildErrorPage(info.params);
    default:
      return buildNewtabPage();
  }
}

async function refreshPage() {
  if (page && page.update) {
    try {
      await page.update();
    } catch (err) {
      console.error(err);
    }
  }
}

// ───────────────────────────── 新标签页 ─────────────────────────────

function buildNewtabPage() {
  const el = h(`<div class="page newtab">
    <div class="wallpaper"></div>
    <div class="wallpaper-shade"></div>
    <div class="newtab-inner">
      <div class="clock">
        <div class="greeting"></div>
        <div class="clock-time">--:--</div>
        <div class="clock-date"></div>
      </div>
      <form class="newtab-search" id="newtab-form">
        <svg class="icon"><use href="#i-search"/></svg>
        <input id="newtab-input" type="text" autocomplete="off" spellcheck="false" placeholder="在浏览器中搜索或输入网址" aria-label="搜索" />
      </form>
      <div class="quick-links" id="quick-links"></div>
      <div class="newtab-footer">浏览器 · 简洁 · 无痕 · 无账号 · 无同步</div>
    </div>
  </div>`);

  const form = el.querySelector('#newtab-form');
  const input = el.querySelector('#newtab-input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value) api.tabs.navigate(value);
  });

  const update = async () => {
    el.classList.toggle('light', currentWallpaperLight);
    const wpEl = el.querySelector('.wallpaper');
    if (wpEl) wpEl.style.backgroundImage = currentWallpaperCss;
    updateClock();
    const quick = el.querySelector('#quick-links');
    const list = bookmarks.slice(0, 8);
    if (!list.length) {
      quick.innerHTML = '<div class="quick-hint">在地址栏点击 ☆ 收藏常用网站，它们会出现在这里</div>';
    } else {
      quick.innerHTML = list
        .map((b) => {
          const badge = badgeFor(b.title || safeHost(b.url));
          return `<div class="quick-link" data-action="open-bookmark" data-url="${esc(b.url)}" title="${esc(b.url)}">
            <span class="quick-badge" style="background:${badge.color}">${esc(badge.letter)}</span>
            <span class="quick-label">${esc(b.title || safeHost(b.url))}</span>
          </div>`;
        })
        .join('');
    }
  };
  update();
  return { kind: 'newtab', el, update };
}

function updateClock() {
  const timeEl = document.querySelector('.newtab .clock-time');
  if (!timeEl) return;
  const now = new Date();
  const dateEl = document.querySelector('.newtab .clock-date');
  const greetingEl = document.querySelector('.newtab .greeting');
  timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (dateEl) dateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${'日一二三四五六'[now.getDay()]}`;
  if (greetingEl) greetingEl.textContent = greetingText();
}

// ───────────────────────────── 历史记录 ─────────────────────────────

function buildHistoryPage() {
  const el = h(`<div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1>历史记录</h1>
          <p class="sub">浏览记录仅保存在这台设备上，不会上传或同步。</p>
        </div>
        <div class="head-actions">
          <label class="search-field">
            <svg class="icon"><use href="#i-search"/></svg>
            <input id="history-search" type="text" placeholder="搜索历史记录" autocomplete="off" spellcheck="false" />
          </label>
          <button class="btn danger" data-action="clear-history">清除全部</button>
        </div>
      </div>
      <div id="history-list"></div>
    </div>
  </div>`);

  const listEl = el.querySelector('#history-list');
  const searchEl = el.querySelector('#history-search');
  let items = [];

  searchEl.addEventListener('input', () => {
    historyQuery = searchEl.value;
    renderHistoryRows();
  });

  const renderHistoryRows = () => {
    const q = historyQuery.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (!q) return true;
      return (
        String(it.title || '').toLowerCase().includes(q) || String(it.url || '').toLowerCase().includes(q)
      );
    });

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty">
        <svg class="icon"><use href="#i-clock"/></svg>
        <h2>${q ? '没有找到匹配的记录' : '暂无历史记录'}</h2>
        <p>${q ? '换个关键词试试。' : '访问过的网页会显示在这里。'}</p>
      </div>`;
      return;
    }

    const groups = new Map();
    for (const it of filtered) {
      const label = dayLabel(it.time);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(it);
    }

    let html = '';
    for (const [label, list] of groups) {
      html += `<section class="day-group"><h2 class="day-title">${esc(label)}</h2><div class="list">`;
      html += list
        .map((it) => {
          const badge = badgeFor(it.title || safeHost(it.url));
          const host = safeHost(it.url);
          return `<div class="row" data-action="history-open" data-url="${esc(it.url)}">
            <span class="row-time">${esc(timeText(it.time))}</span>
            <span class="row-badge" style="background:${badge.color}">${esc(badge.letter)}</span>
            <div class="row-main">
              <div class="row-title">${esc(it.title || it.url)}</div>
              <div class="row-sub">${esc(host)}</div>
            </div>
            <button class="row-action" data-action="history-delete" data-id="${esc(it.id)}" title="删除这条记录" aria-label="删除这条记录">
              <svg class="icon"><use href="#i-trash"/></svg>
            </button>
          </div>`;
        })
        .join('');
      html += '</div></section>';
    }
    listEl.innerHTML = html;
  };

  const update = async () => {
    try {
      items = await api.history.list('', 500);
    } catch {
      items = [];
    }
    if (searchEl.value !== historyQuery) searchEl.value = historyQuery;
    renderHistoryRows();
  };

  return { kind: 'history', el, update, items: () => items };
}

// ───────────────────────────── 书签 ─────────────────────────────

function buildBookmarksPage() {
  const el = h(`<div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1>书签</h1>
          <p class="sub">收藏的网站只保存在本机；按 Ctrl+D 可以收藏当前页面。</p>
        </div>
        <div class="head-actions">
          <label class="search-field">
            <svg class="icon"><use href="#i-search"/></svg>
            <input id="bookmarks-search" type="text" placeholder="搜索书签" autocomplete="off" spellcheck="false" />
          </label>
        </div>
      </div>
      <div id="bookmarks-list"></div>
    </div>
  </div>`);

  const listEl = el.querySelector('#bookmarks-list');
  const searchEl = el.querySelector('#bookmarks-search');
  let items = [];

  searchEl.addEventListener('input', () => {
    bookmarkQuery = searchEl.value;
    renderBookmarkRows();
  });

  const renderBookmarkRows = () => {
    const q = bookmarkQuery.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (!q) return true;
      return String(it.title || '').toLowerCase().includes(q) || String(it.url || '').toLowerCase().includes(q);
    });

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty">
        <svg class="icon"><use href="#i-bookmark"/></svg>
        <h2>${q ? '没有找到匹配的书签' : '还没有书签'}</h2>
        <p>${q ? '换个关键词试试。' : '在地址栏点击 ☆ 收藏当前页面，或按 Ctrl+D。'}</p>
      </div>`;
      return;
    }

    listEl.innerHTML = `<div class="list">${filtered
      .map((it) => {
        const badge = badgeFor(it.title || safeHost(it.url));
        return `<div class="row" data-action="bookmark-open" data-url="${esc(it.url)}">
          <span class="row-badge" style="background:${badge.color}">${esc(badge.letter)}</span>
          <div class="row-main">
            <div class="row-title">${esc(it.title || safeHost(it.url))}</div>
            <div class="row-sub">${esc(it.url)}</div>
          </div>
          <button class="row-action" data-action="bookmark-delete" data-id="${esc(it.id)}" title="删除书签" aria-label="删除书签">
            <svg class="icon"><use href="#i-trash"/></svg>
          </button>
        </div>`;
      })
      .join('')}</div>`;
  };

  const update = async () => {
    try {
      items = await api.bookmarks.list();
    } catch {
      items = bookmarks.slice();
    }
    if (searchEl.value !== bookmarkQuery) searchEl.value = bookmarkQuery;
    renderBookmarkRows();
  };

  return { kind: 'bookmarks', el, update };
}

// ───────────────────────────── 设置 ─────────────────────────────

function buildSettingsPage() {
  const el = h(`<div class="page">
    <div class="page-inner narrow">
      <div class="page-head">
        <div>
          <h1>设置</h1>
          <p class="sub">所有设置只保存在本机。没有账号，也不会上传或同步任何数据。</p>
        </div>
      </div>

      <section class="card">
        <h2>外观</h2>
        <div class="field column">
          <span class="field-label">壁纸</span>
          <p class="field-hint">新标签页的背景。可以选择内置壁纸，或上传自己的图片。</p>
          <div class="wallpaper-grid" id="wallpaper-grid"></div>
          <div class="wallpaper-actions">
            <button class="btn" data-action="upload-wallpaper">
              <svg class="icon"><use href="#i-folder"/></svg>上传图片…
            </button>
            <button class="btn" data-action="reset-wallpaper">恢复默认</button>
          </div>
        </div>
        <div class="field">
          <div>
            <span class="field-label">主题</span>
            <p class="field-hint">界面颜色，跟随系统时会随 Windows 设置自动切换。</p>
          </div>
          <select id="theme-select">
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="auto">跟随系统</option>
          </select>
        </div>
        <div class="field">
          <div>
            <span class="field-label">显示书签栏</span>
            <p class="field-hint">在地址栏下方显示一条书签快捷栏。</p>
          </div>
          <label class="switch">
            <input id="bookmarks-switch" type="checkbox" /><span class="track"></span>
          </label>
        </div>
      </section>

      <section class="card">
        <h2>搜索</h2>
        <div class="field">
          <div>
            <span class="field-label">默认搜索引擎</span>
            <p class="field-hint">在地址栏输入文字时使用的搜索引擎。</p>
          </div>
          <select id="engine-select">
            <option value="bing">Bing</option>
            <option value="baidu">百度</option>
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
          </select>
        </div>
      </section>

      <section class="card">
        <h2>隐私与数据</h2>
        <div class="field">
          <div>
            <span class="field-label">浏览记录</span>
            <p class="field-hint">清除保存在本机的全部浏览记录。</p>
          </div>
          <button class="btn danger" data-action="clear-history">清除浏览记录</button>
        </div>
        <div class="field">
          <div>
            <span class="field-label">Cookie 与缓存</span>
            <p class="field-hint">清除后，网站可能需要重新登录。</p>
          </div>
          <button class="btn" data-action="clear-cookies">清除 Cookie 与缓存</button>
        </div>
        <div class="field">
          <div>
            <span class="field-label">无痕浏览</span>
            <p class="field-hint">不保存浏览记录、Cookie 和表单数据，关闭窗口后全部丢弃。</p>
          </div>
          <button class="btn" data-action="new-incognito">打开无痕窗口</button>
        </div>
      </section>

      <section class="card">
        <h2>关于</h2>
        <div class="field">
          <div>
            <span class="field-label">浏览器</span>
            <p class="field-hint" id="settings-version">基于 Chromium 的简洁浏览器</p>
          </div>
          <button class="btn" data-action="open-about">关于浏览器</button>
        </div>
      </section>
    </div>
  </div>`);

  const grid = el.querySelector('#wallpaper-grid');
  const themeSelect = el.querySelector('#theme-select');
  const engineSelect = el.querySelector('#engine-select');
  const barSwitch = el.querySelector('#bookmarks-switch');

  themeSelect.addEventListener('change', () => {
    api.settings.update({ theme: themeSelect.value });
  });
  engineSelect.addEventListener('change', () => {
    api.settings.update({ searchEngine: engineSelect.value });
  });
  barSwitch.addEventListener('change', () => {
    api.settings.update({ bookmarksBar: barSwitch.checked });
  });

  let appInfo = null;

  const update = async () => {
    if (!appInfo) {
      try {
        appInfo = await api.app.info();
      } catch {
        appInfo = null;
      }
    }
    const versionEl = el.querySelector('#settings-version');
    if (versionEl && appInfo) versionEl.textContent = `版本 ${appInfo.version} · Chromium ${appInfo.chrome}`;

    if (themeSelect.value !== settings.theme) themeSelect.value = settings.theme || 'dark';
    if (engineSelect.value !== settings.searchEngine) engineSelect.value = settings.searchEngine || 'bing';
    barSwitch.checked = !!settings.bookmarksBar;

    const activeCustom = wallpaperInfo.type === 'custom';
    let html = Object.entries(WALLPAPERS)
      .map(([id, def]) => {
        const selected = !activeCustom && wallpaperInfo.id === id;
        return `<div class="wallpaper-card${selected ? ' selected' : ''}" data-action="set-wallpaper" data-id="${id}">
          <span class="wp-preview" style="background-image:${def.css}"></span>
          <span class="wp-name">${esc(def.name)}</span>
          <span class="wp-check"><svg class="icon"><use href="#i-check"/></svg></span>
        </div>`;
      })
      .join('');

    const customPreview = activeCustom && customWallpaper.dataUrl
      ? `url("${customWallpaper.dataUrl}")`
      : 'repeating-linear-gradient(135deg, rgba(255,255,255,.055) 0 10px, rgba(255,255,255,.02) 10px 20px)';
    html += `<div class="wallpaper-card${activeCustom ? ' selected' : ''}" data-action="upload-wallpaper">
      <span class="wp-preview" style="background-image:${customPreview}"></span>
      <span class="wp-name">自定义图片</span>
      <span class="wp-check"><svg class="icon"><use href="#i-check"/></svg></span>
    </div>`;

    grid.innerHTML = html;
  };

  update();
  return { kind: 'settings', el, update };
}

// ───────────────────────────── 下载 ─────────────────────────────

function buildDownloadsPage() {
  const el = h(`<div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1>下载内容</h1>
          <p class="sub">文件默认保存到系统「下载」文件夹。</p>
        </div>
        <div class="head-actions">
          <button class="btn" data-action="clear-downloads">清空列表</button>
        </div>
      </div>
      <div id="downloads-list"></div>
    </div>
  </div>`);

  const listEl = el.querySelector('#downloads-list');

  const stateText = (rec) => {
    if (rec.state === 'completed') return '已完成';
    if (rec.state === 'cancelled') return '已取消';
    if (rec.state === 'interrupted') return '已失败';
    if (rec.total > 0) return `正在下载 ${Math.min(99, Math.round((rec.received / rec.total) * 100))}%`;
    return '正在下载…';
  };

  const update = async () => {
    let list = [];
    try {
      list = await api.downloads.list();
    } catch {
      list = [];
    }
    if (!list.length) {
      listEl.innerHTML = `<div class="empty">
        <svg class="icon"><use href="#i-download"/></svg>
        <h2>暂无下载内容</h2>
        <p>你下载的文件会显示在这里。</p>
      </div>`;
      return;
    }
    listEl.innerHTML = `<div class="list">${list
      .map((rec) => {
        const pct = rec.total > 0 ? Math.min(100, Math.round((rec.received / rec.total) * 100)) : 0;
        const progress =
          rec.state === 'progressing' && rec.total > 0
            ? `<div class="dl-progress"><i style="width:${pct}%"></i></div>`
            : '';
        const reveal = rec.savePath
          ? `<button class="btn" data-action="reveal-download" data-id="${rec.id}">打开所在文件夹</button>`
          : '';
        return `<div class="dl-row">
          <span class="dl-icon"><svg class="icon"><use href="#i-download"/></svg></span>
          <div class="dl-main">
            <div class="dl-name">${esc(rec.filename)}</div>
            <div class="dl-meta">${esc(stateText(rec))}${rec.savePath ? ' · ' + esc(rec.savePath) : ''}</div>
            ${progress}
          </div>
          ${reveal}
        </div>`;
      })
      .join('')}</div>`;
  };

  update();
  return { kind: 'downloads', el, update };
}

// ───────────────────────────── 关于 ─────────────────────────────

function buildAboutPage() {
  const el = h(`<div class="page">
    <div class="page-inner narrow">
      <div class="about-hero">
        <div class="about-logo"><svg class="icon"><use href="#i-globe"/></svg></div>
        <h1 class="about-name">浏览器</h1>
        <div class="about-version" id="about-version">基于 Chromium</div>
        <p class="about-desc">
          一个足够简洁的浏览器。没有账号、没有登录、没有云同步；<br />
          书签、历史记录和设置都只保存在你自己的电脑上。
        </p>
        <div class="chips">
          <span class="chip">纯净无广告</span>
          <span class="chip">无账号 · 无同步</span>
          <span class="chip">可更换壁纸</span>
          <span class="chip">无痕浏览</span>
          <span class="chip">本地书签</span>
          <span class="chip">本地历史记录</span>
        </div>
        <div class="about-actions">
          <button class="btn primary" data-action="open-newtab">打开新标签页</button>
          <button class="btn" data-action="open-settings">前往设置</button>
        </div>
      </div>

      <section class="card">
        <h2>运行环境</h2>
        <div class="tech-grid" id="tech-grid"></div>
      </section>

      <section class="card">
        <h2>快捷键</h2>
        <div class="shortcut-grid">
          <div class="shortcut-item"><span>新标签页</span><kbd>Ctrl + T</kbd></div>
          <div class="shortcut-item"><span>关闭标签页</span><kbd>Ctrl + W</kbd></div>
          <div class="shortcut-item"><span>重新打开关闭的标签页</span><kbd>Ctrl + Shift + T</kbd></div>
          <div class="shortcut-item"><span>新建无痕窗口</span><kbd>Ctrl + Shift + N</kbd></div>
          <div class="shortcut-item"><span>聚焦地址栏</span><kbd>Ctrl + L</kbd></div>
          <div class="shortcut-item"><span>刷新页面</span><kbd>Ctrl + R / F5</kbd></div>
          <div class="shortcut-item"><span>收藏当前页面</span><kbd>Ctrl + D</kbd></div>
          <div class="shortcut-item"><span>历史记录</span><kbd>Ctrl + H</kbd></div>
          <div class="shortcut-item"><span>下载内容</span><kbd>Ctrl + J</kbd></div>
          <div class="shortcut-item"><span>显示/隐藏书签栏</span><kbd>Ctrl + Shift + B</kbd></div>
          <div class="shortcut-item"><span>切换标签页</span><kbd>Ctrl + Tab</kbd></div>
          <div class="shortcut-item"><span>后退 / 前进</span><kbd>Alt + ← / →</kbd></div>
        </div>
      </section>

      <section class="card">
        <h2>隐私说明</h2>
        <p class="field-hint" style="margin:0;line-height:1.9">
          浏览器不会要求登录，也不会同步任何数据。浏览记录、书签、壁纸和设置存储在本机用户目录；
          无痕窗口使用独立的内存会话，关闭后不保留 Cookie、缓存与历史记录。清除数据不会影响已保存的书签或壁纸。
        </p>
      </section>
    </div>
  </div>`);

  let info = null;
  const update = async () => {
    if (!info) {
      try {
        info = await api.app.info();
      } catch {
        info = null;
      }
    }
    if (!info) return;
    const versionEl = el.querySelector('#about-version');
    if (versionEl) versionEl.textContent = `版本 ${info.version} · Chromium ${info.chrome}`;
    const grid = el.querySelector('#tech-grid');
    if (grid) {
      const wv = info.widevine || {};
      const widevineText = wv.available
        ? `${wv.version}（${wv.source || '系统'}）`
        : '未启用';
      const gpu = info.gpu || {};
      const gpuText =
        gpu.compositing === 'enabled'
          ? `硬件加速 · 视频解码${gpu.videoDecode === 'enabled' ? '已开启' : '未开启'}`
          : '软件渲染（可在设置中查看说明）';
      grid.innerHTML = [
        ['浏览器版本', info.version],
        ['Chromium', info.chrome],
        ['Electron', info.electron],
        ['Node.js', info.node],
        ['V8', info.v8],
        ['平台', `${info.platform} ${info.arch}`],
        ['视频解码', 'H.264 / AAC / AV1（Chromium）'],
        ['Widevine DRM', widevineText],
        ['硬件加速', gpuText],
      ]
        .map(([k, v]) => `<div class="tech-item"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
        .join('');
    }
  };
  update();
  return { kind: 'about', el, update };
}

// ───────────────────────────── 错误页 ─────────────────────────────

function buildErrorPage(params) {
  const url = params.get('url') || '';
  const code = params.get('code') || '';
  const desc = params.get('desc') || '';
  const el = h(`<div class="page">
    <div class="page-inner narrow error-page">
      <div class="error-icon"><svg class="icon"><use href="#i-wifi-off"/></svg></div>
      <h1>无法访问此网站</h1>
      <div class="error-url">${esc(url)}</div>
      <div class="error-detail">${esc(desc || '连接失败')}${code ? ' · 错误代码 ' + esc(code) : ''}</div>
      <div class="error-actions">
        <button class="btn primary" data-action="retry">重新加载</button>
        <button class="btn" data-action="open-newtab">回到新标签页</button>
      </div>
    </div>
  </div>`);
  return { kind: 'error', el, update: async () => {} };
}

// ───────────────────────────── 菜单 ─────────────────────────────

function renderMenu() {
  const bar = !!settings.bookmarksBar;
  els.menu.innerHTML = `
    <div class="menu-item" data-action="menu-new-tab">
      <svg class="icon"><use href="#i-plus"/></svg><span>新标签页</span><kbd>Ctrl+T</kbd>
    </div>
    <div class="menu-item" data-action="menu-new-incognito">
      <svg class="icon"><use href="#i-incognito"/></svg><span>新建无痕窗口</span><kbd>Ctrl+Shift+N</kbd>
    </div>
    <div class="menu-sep"></div>
    <div class="menu-item" data-action="menu-history">
      <svg class="icon"><use href="#i-clock"/></svg><span>历史记录</span><kbd>Ctrl+H</kbd>
    </div>
    <div class="menu-item" data-action="menu-bookmarks">
      <svg class="icon"><use href="#i-bookmark"/></svg><span>书签</span>
    </div>
    <div class="menu-item" data-action="menu-downloads">
      <svg class="icon"><use href="#i-download"/></svg><span>下载内容</span><kbd>Ctrl+J</kbd>
    </div>
    <div class="menu-sep"></div>
    <div class="menu-item" data-action="menu-toggle-bar">
      <svg class="icon"><use href="#i-star"/></svg><span>显示书签栏</span>
      ${bar ? '<span class="menu-check"><svg class="icon"><use href="#i-check"/></svg></span>' : '<kbd>Ctrl+Shift+B</kbd>'}
    </div>
    <div class="menu-item" data-action="menu-settings">
      <svg class="icon"><use href="#i-settings"/></svg><span>设置</span>
    </div>
    <div class="menu-item" data-action="menu-about">
      <svg class="icon"><use href="#i-info"/></svg><span>关于浏览器</span>
    </div>
    <div class="menu-sep"></div>
    <div class="menu-item danger" data-action="menu-quit">
      <svg class="icon"><use href="#i-close"/></svg><span>退出</span>
    </div>`;
}

function toggleMenu() {
  if (menuOpen) closeMenu();
  else openMenu();
}

async function openMenu() {
  menuOpen = true;
  renderMenu();
  els.menu.hidden = false;
  // 网页标签页是窗口原生子视图，层级在 chrome UI 之上；先让视图让位并铺一张页面快照，
  // 否则菜单会被网页盖住，既看不见也点不到。
  try {
    const res = await api.overlay.show();
    if (!menuOpen) {
      hideSnapshot();
      return;
    }
    if (res && res.image) {
      els.snapshot.src = res.image;
      els.snapshot.hidden = false;
    }
  } catch {
    /* 浮层降级：菜单仍然显示，只是网页区域可能被覆盖 */
  }
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  els.menu.hidden = true;
  hideSnapshot();
  try {
    api.overlay.hide();
  } catch {
    /* ignore */
  }
}

function hideSnapshot() {
  const el = els.snapshot;
  if (!el) return;
  if (!el.hidden) el.hidden = true;
  if (el.getAttribute('src')) el.removeAttribute('src');
}

// ───────────────────────────── Toast ─────────────────────────────

function showToast(text, type = 'info') {
  if (!text) return;
  const el = h(`<div class="toast ${esc(type)}">${esc(text)}</div>`);
  els.toasts.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 240);
  }, 2600);
}

// ───────────────────────────── 事件绑定 ─────────────────────────────

function bindEvents() {
  // 图片加载失败 → 回退到内置图标
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG' && target.closest('.favicon-box')) {
        target.closest('.favicon-box').classList.add('no-icon');
      }
    },
    true
  );

  // 统一点击分发
  document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      Promise.resolve(handleAction(actionEl.dataset.action, actionEl, e)).catch((err) => console.error(err));
    }
    if (!e.target.closest('#menu') && !(actionEl && actionEl.dataset.action === 'toggle-menu')) {
      closeMenu();
    }
  });

  // 中键关闭标签页
  els.tabs.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tabEl = e.target.closest('.tab');
    if (tabEl) {
      e.preventDefault();
      api.tabs.close(Number(tabEl.dataset.id));
    }
  });

  // 地址栏
  els.address.addEventListener('focus', () => {
    els.addressWrap.classList.add('focused');
    requestAnimationFrame(() => {
      try {
        els.address.select();
      } catch {
        /* ignore */
      }
    });
  });
  els.address.addEventListener('blur', () => {
    els.addressWrap.classList.remove('focused');
    els.address.value = addressDisplayValue();
  });
  els.address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = els.address.value.trim();
      if (value) {
        api.tabs.navigate(value);
        els.address.blur();
      }
    } else if (e.key === 'Escape') {
      els.address.value = addressDisplayValue();
      els.address.blur();
    }
  });

  // 菜单按钮
  els.menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  // 主题跟随系统
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') {
      document.documentElement.dataset.theme = resolveTheme('auto');
    }
  });

  // Esc 关闭菜单
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}

async function handleAction(action, el, event) {
  switch (action) {
    case 'select-tab':
      await api.tabs.select(Number(el.dataset.id));
      break;
    case 'close-tab':
      event.stopPropagation();
      await api.tabs.close(Number(el.dataset.id));
      break;
    case 'new-tab':
      await api.tabs.create('browser://newtab');
      break;
    case 'back':
      await api.tabs.back();
      break;
    case 'forward':
      await api.tabs.forward();
      break;
    case 'reload':
      if (activeTab && activeTab.loading) await api.tabs.stop();
      else await api.tabs.reload();
      break;
    case 'stop':
      await api.tabs.stop();
      break;
    case 'retry':
      await api.tabs.retry();
      break;
    case 'toggle-bookmark':
      await api.bookmarks.toggle();
      break;
    case 'toggle-menu':
      toggleMenu();
      break;
    case 'win-min':
      await api.window.minimize();
      break;
    case 'win-max':
      await api.window.toggleMaximize();
      break;
    case 'win-close':
      await api.window.close();
      break;
    case 'open-bookmark':
      if (el.dataset.url) await api.tabs.navigate(el.dataset.url);
      break;
    case 'history-open':
      if (el.dataset.url) await api.tabs.navigate(el.dataset.url);
      break;
    case 'history-delete':
      event.stopPropagation();
      await api.history.remove(el.dataset.id);
      await refreshPage();
      break;
    case 'clear-history':
      if (window.confirm('确定要清除全部浏览记录吗？此操作不可恢复。')) {
        await api.history.clear();
        showToast('浏览记录已清除', 'success');
        await refreshPage();
      }
      break;
    case 'bookmark-open':
      if (el.dataset.url) await api.tabs.navigate(el.dataset.url);
      break;
    case 'bookmark-delete':
      event.stopPropagation();
      await api.bookmarks.remove(el.dataset.id);
      await refreshPage();
      break;
    case 'set-wallpaper':
      await api.wallpaper.setPreset(el.dataset.id);
      showToast('壁纸已更换');
      break;
    case 'upload-wallpaper': {
      const result = await api.wallpaper.pick();
      if (!result) break;
      if (result.ok) showToast('壁纸已更换', 'success');
      else if (!result.canceled) showToast(result.error || '壁纸设置失败', 'error');
      break;
    }
    case 'reset-wallpaper':
      await api.wallpaper.reset();
      showToast('已恢复默认壁纸');
      break;
    case 'clear-cookies':
      if (window.confirm('确定要清除 Cookie 与缓存吗？网站可能需要重新登录。')) {
        await api.privacy.clear({ cookies: true, cache: true });
        showToast('Cookie 与缓存已清除', 'success');
      }
      break;
    case 'new-incognito':
      await api.window.newIncognito();
      break;
    case 'new-incognito-window':
      await api.window.newIncognito();
      showToast('已在新窗口打开无痕浏览', 'success');
      break;
    case 'reveal-download':
      await api.downloads.reveal(Number(el.dataset.id));
      break;
    case 'clear-downloads':
      await api.downloads.clear();
      await refreshPage();
      break;
    case 'open-about':
      await api.tabs.navigate('browser://about');
      break;
    case 'open-settings':
      await api.tabs.navigate('browser://settings');
      break;
    case 'open-newtab':
      await api.tabs.navigate('browser://newtab');
      break;
    case 'open-history':
      await api.tabs.navigate('browser://history');
      break;
    case 'open-bookmarks':
      await api.tabs.navigate('browser://bookmarks');
      break;
    case 'open-downloads':
      await api.tabs.navigate('browser://downloads');
      break;
    // 菜单
    case 'menu-new-tab':
      await api.tabs.create('browser://newtab');
      closeMenu();
      break;
    case 'menu-new-incognito':
      await api.window.newIncognito();
      closeMenu();
      break;
    case 'menu-history':
      await api.tabs.openInternal('browser://history');
      closeMenu();
      break;
    case 'menu-bookmarks':
      await api.tabs.openInternal('browser://bookmarks');
      closeMenu();
      break;
    case 'menu-downloads':
      await api.tabs.openInternal('browser://downloads');
      closeMenu();
      break;
    case 'menu-toggle-bar':
      await api.settings.update({ bookmarksBar: !settings.bookmarksBar });
      closeMenu();
      break;
    case 'menu-settings':
      await api.tabs.openInternal('browser://settings');
      closeMenu();
      break;
    case 'menu-about':
      await api.tabs.openInternal('browser://about');
      closeMenu();
      break;
    case 'menu-quit':
      await api.app.quit();
      break;
    default:
      break;
  }
}

// 启动
init();