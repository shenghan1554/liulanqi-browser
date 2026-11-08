'use strict';

/**
 * Browser data layer.
 *
 * Pure Node module (never requires Electron). Synchronous, atomic persistence:
 * every mutation is written to a temporary file and renamed over the target, so
 * a crash mid-write never leaves a truncated JSON file behind.
 *
 * Usage:
 *   const Store = require('./store');
 *   const store = new Store(userDataDir);
 */

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_LIMIT = 3000;

const FILES = Object.freeze({
  settings: 'settings.json',
  history: 'history.json',
  bookmarks: 'bookmarks.json',
});

// 默认设置版本：1 = 深色 +「极夜」；2 = 跟随系统 +「素白」（1.0.5 起）
const DEFAULTS_VERSION = 2;

function defaultSettings() {
  return {
    searchEngine: 'bing',
    theme: 'auto',
    bookmarksBar: false,
    wallpaper: { type: 'preset', id: 'paper' },
    defaultsVersion: DEFAULTS_VERSION,
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function genId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

class Store {
  /**
   * @param {string} dataDir directory that stores settings.json/history.json/bookmarks.json
   */
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new TypeError('Store requires a non-empty dataDir string');
    }
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });

    this._seq = 0;
    this._downloads = [];
    this._historyTimer = null;

    const settings = this._readJson(FILES.settings, null, isPlainObject);
    this._settings = settings
      ? mergeSettings(defaultSettings(), settings)
      : defaultSettings();
    this._settings.wallpaper = normalizeWallpaper(this._settings.wallpaper);

    // 旧版本（1.0.4 及更早）的默认值是「深色 + 极夜」。升级到新默认值（跟随系统 + 素白）时，
    // 只迁移那些仍停留在旧默认值、从未手动改过主题/壁纸的用户，用户自己的选择保持不变。
    if (settings && settings.defaultsVersion !== DEFAULTS_VERSION) {
      if (
        this._settings.theme === 'dark' &&
        this._settings.wallpaper &&
        this._settings.wallpaper.type === 'preset' &&
        this._settings.wallpaper.id === 'midnight'
      ) {
        this._settings.theme = 'auto';
        this._settings.wallpaper = { type: 'preset', id: 'paper' };
      }
      this._settings.defaultsVersion = DEFAULTS_VERSION;
      this._writeJson(FILES.settings, this._settings);
    }

    const history = this._readJson(FILES.history, [], Array.isArray);
    this._history = history.filter(isHistoryEntry).map(normalizeHistoryEntry);

    const bookmarks = this._readJson(FILES.bookmarks, [], Array.isArray);
    this._bookmarks = bookmarks
      .filter(isBookmarkEntry)
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : genId(),
        url: String(item.url),
        title: typeof item.title === 'string' ? item.title : '',
        added: typeof item.added === 'number' ? item.added : Date.now(),
      }));
  }

  // ---------------------------------------------------------------- settings

  /** @returns {object} defaults deep-merged with values persisted on disk */
  getSettings() {
    return clone(this._settings);
  }

  /**
   * Merge `patch` into settings (one nested level, e.g. wallpaper) and persist.
   * @param {object} patch
   * @returns {object} merged settings
   */
  updateSettings(patch) {
    if (!isPlainObject(patch)) return this.getSettings();
    this._settings = mergeSettings(this._settings, patch);
    this._settings.wallpaper = normalizeWallpaper(this._settings.wallpaper);
    this._writeJson(FILES.settings, this._settings);
    return this.getSettings();
  }

  // ----------------------------------------------------------------- history

  /**
   * Add a history entry.
   * - url is required; blank/invalid urls are ignored (returns null)
   * - if the head entry has the same url, only title/time are updated
   * - otherwise a new entry is unshifted and the list is capped at 3000
   * @param {{url: string, title?: string}} item
   * @returns {object|null} the created / updated entry (copy)
   */
  addHistory(item) {
    const url = item && typeof item.url === 'string' ? item.url.trim() : '';
    if (!url) return null;
    const title =
      item && typeof item.title === 'string' ? item.title : '';

    const head = this._history[0];
    if (head && head.url === url) {
      if (title) head.title = title;
      head.time = Date.now();
      this._writeJson(FILES.history, this._history);
      return { ...head };
    }

    const entry = {
      id: genId(),
      url,
      title,
      time: Date.now(),
    };
    this._history.unshift(entry);
    if (this._history.length > HISTORY_LIMIT) {
      this._history.length = HISTORY_LIMIT;
    }
    this._writeJson(FILES.history, this._history);
    return { ...entry };
  }

  /**
   * @param {{query?: string, limit?: number}} [options]
   * @returns {object[]} entries sorted by time desc, filtered by query, at most `limit`
   */
  listHistory(options = {}) {
    const query =
      options && typeof options.query === 'string'
        ? options.query.trim().toLowerCase()
        : '';
    let limit = options && options.limit !== undefined ? Number(options.limit) : 300;
    if (!Number.isFinite(limit)) limit = 300;
    limit = Math.max(0, Math.floor(limit));

    let items = this._history.slice().sort((a, b) => b.time - a.time);
    if (query) {
      items = items.filter(
        (item) =>
          item.url.toLowerCase().includes(query) ||
          item.title.toLowerCase().includes(query)
      );
    }
    return items.slice(0, limit).map((item) => ({ ...item }));
  }

  // 只取最近一条记录（用于标题更新判断），避免对整个历史排序
  getLatestHistory() {
    return this._history[0] ? { ...this._history[0] } : null;
  }

  /**
   * 更新当前页面的标题（页面标题会频繁变化）：
   * 只改内存并防抖写盘，避免每次标题变化都同步写整个历史文件。
   */
  updateHistoryTitle(url, title) {
    const head = this._history[0];
    if (!head || head.url !== url) return null;
    if (title) head.title = title;
    head.time = Date.now();
    this._scheduleHistoryWrite();
    return { ...head };
  }

  _scheduleHistoryWrite() {
    if (this._historyTimer) return;
    this._historyTimer = setTimeout(() => {
      this._historyTimer = null;
      this._writeJson(FILES.history, this._history);
    }, 400);
    if (this._historyTimer.unref) this._historyTimer.unref();
  }

  /** 立即把防抖中的历史记录落盘（退出前调用） */
  flush() {
    if (this._historyTimer) {
      clearTimeout(this._historyTimer);
      this._historyTimer = null;
      this._writeJson(FILES.history, this._history);
    }
  }

  /** @returns {boolean} whether an entry was removed */
  removeHistory(id) {
    const index = this._history.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this._history.splice(index, 1);
    this._writeJson(FILES.history, this._history);
    return true;
  }

  clearHistory() {
    this._history = [];
    this._writeJson(FILES.history, this._history);
  }

  // --------------------------------------------------------------- bookmarks

  /** @returns {object[]} bookmarks in insertion order (newest last) */
  listBookmarks() {
    return this._bookmarks.map((item) => ({ ...item }));
  }

  /** @returns {boolean} */
  isBookmarked(url) {
    if (typeof url !== 'string' || url === '') return false;
    return this._bookmarks.some((item) => item.url === url);
  }

  /**
   * @param {{url: string, title?: string}} item
   * @returns {object|null} the existing bookmark for `url`, or the new one
   */
  addBookmark(item) {
    const url = item && typeof item.url === 'string' ? item.url.trim() : '';
    if (!url) return null;
    const existing = this._bookmarks.find((b) => b.url === url);
    if (existing) return { ...existing };

    const entry = {
      id: genId(),
      url,
      title: item && typeof item.title === 'string' ? item.title : '',
      added: Date.now(),
    };
    this._bookmarks.push(entry);
    this._writeJson(FILES.bookmarks, this._bookmarks);
    return { ...entry };
  }

  /** @returns {boolean} */
  removeBookmark(id) {
    const index = this._bookmarks.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this._bookmarks.splice(index, 1);
    this._writeJson(FILES.bookmarks, this._bookmarks);
    return true;
  }

  /** @returns {boolean} */
  removeBookmarkByUrl(url) {
    if (typeof url !== 'string') return false;
    const index = this._bookmarks.findIndex((item) => item.url === url);
    if (index === -1) return false;
    this._bookmarks.splice(index, 1);
    this._writeJson(FILES.bookmarks, this._bookmarks);
    return true;
  }

  // --------------------------------------------------------------- downloads
  // In-memory only (one browser session); not persisted by design.

  addDownload(item) {
    const entry = {
      status: 'progressing',
      receivedBytes: 0,
      totalBytes: 0,
      ...(isPlainObject(item) ? item : {}),
    };
    if (!entry.id) entry.id = genId();
    if (typeof entry.added !== 'number') entry.added = Date.now();
    this._downloads.push(entry);
    return { ...entry };
  }

  updateDownload(id, patch) {
    const entry = this._downloads.find((item) => item.id === id);
    if (!entry) return null;
    if (isPlainObject(patch)) Object.assign(entry, patch);
    return { ...entry };
  }

  listDownloads() {
    return this._downloads.map((item) => ({ ...item }));
  }

  clearDownloads() {
    this._downloads = [];
  }

  // -------------------------------------------------------------- wallpaper

  get _wallpaperDir() {
    return path.join(this.dataDir, 'wallpapers');
  }

  /**
   * Persist a custom wallpaper image.
   * @param {Buffer|Uint8Array} buffer image bytes
   * @param {string} ext file extension, e.g. 'png' or '.jpg'
   * @returns {string} absolute path of the written wallpaper
   */
  setCustomWallpaper(buffer, ext) {
    const data = toBuffer(buffer);
    const extension = normalizeExtension(ext);

    const dir = this._wallpaperDir;
    fs.mkdirSync(dir, { recursive: true });

    const fileName = `wallpaper.${extension}`;
    const filePath = path.join(dir, fileName);
    writeFileAtomic(filePath, data);

    // Drop stale wallpapers saved with a different extension.
    for (const name of fs.readdirSync(dir)) {
      if (name !== fileName && /^wallpaper\.[a-z0-9]+$/i.test(name)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* best effort */
        }
      }
    }

    this._settings.wallpaper = { type: 'custom', file: fileName };
    this._writeJson(FILES.settings, this._settings);
    return filePath;
  }

  removeCustomWallpaper() {
    const dir = this._wallpaperDir;
    const wallpaper = this._settings.wallpaper;
    if (wallpaper && wallpaper.type === 'custom' && wallpaper.file) {
      try {
        fs.unlinkSync(path.join(dir, path.basename(String(wallpaper.file))));
      } catch {
        /* already gone */
      }
    }
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^wallpaper\.[a-z0-9]+$/i.test(name)) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
    } catch {
      /* directory missing is fine */
    }
    this._settings.wallpaper = { type: 'preset', id: 'paper' };
    this._writeJson(FILES.settings, this._settings);
  }

  /** @returns {string|null} absolute path of an existing custom wallpaper */
  getWallpaperPath() {
    const wallpaper = this._settings.wallpaper;
    if (!wallpaper || wallpaper.type !== 'custom' || !wallpaper.file) {
      return null;
    }
    const filePath = path.join(
      this._wallpaperDir,
      path.basename(String(wallpaper.file))
    );
    return fs.existsSync(filePath) ? filePath : null;
  }

  // ---------------------------------------------------------------- helpers

  _readJson(fileName, fallback, isValid) {
    const filePath = path.join(this.dataDir, fileName);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return clone(fallback);
      renameCorrupt(filePath);
      return clone(fallback);
    }
    try {
      const parsed = JSON.parse(raw);
      if (isValid && !isValid(parsed)) {
        renameCorrupt(filePath);
        return clone(fallback);
      }
      return parsed;
    } catch {
      renameCorrupt(filePath);
      return clone(fallback);
    }
  }

  _writeJson(fileName, value) {
    // 紧凑 JSON：历史记录可达 3000 条，去掉缩进后写盘量与耗时都明显减少
    writeFileAtomic(
      path.join(this.dataDir, fileName),
      JSON.stringify(value)
    );
  }
}

// ------------------------------------------------------------------ utilities

function mergeSettings(base, patch) {
  const out = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined || typeof value === 'function') continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeSettings(out[key], value);
    } else if (isPlainObject(value)) {
      out[key] = mergeSettings({}, value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function normalizeWallpaper(wallpaper) {
  if (!isPlainObject(wallpaper)) return { type: 'preset', id: 'paper' };
  if (wallpaper.type === 'custom') {
    if (typeof wallpaper.file === 'string' && wallpaper.file !== '') {
      return { type: 'custom', file: wallpaper.file };
    }
    return { type: 'preset', id: 'paper' };
  }
  if (wallpaper.type === 'preset') {
    return {
      type: 'preset',
      id:
        typeof wallpaper.id === 'string' && wallpaper.id !== ''
          ? wallpaper.id
          : 'paper',
    };
  }
  return { type: 'preset', id: 'paper' };
}

function isHistoryEntry(item) {
  return isPlainObject(item) && typeof item.url === 'string' && item.url !== '';
}

function isBookmarkEntry(item) {
  return isPlainObject(item) && typeof item.url === 'string' && item.url !== '';
}

function normalizeHistoryEntry(item) {
  return {
    id: typeof item.id === 'string' ? item.id : genId(),
    url: item.url,
    title: typeof item.title === 'string' ? item.title : '',
    time: typeof item.time === 'number' ? item.time : Date.now(),
  };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError('setCustomWallpaper requires a Buffer/Uint8Array');
}

function normalizeExtension(ext) {
  let extension = typeof ext === 'string' ? ext.trim().toLowerCase() : 'png';
  if (extension.startsWith('.')) extension = extension.slice(1);
  if (!/^[a-z0-9]+$/.test(extension)) {
    throw new TypeError(`Invalid wallpaper extension: ${String(ext)}`);
  }
  return extension;
}

function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function renameCorrupt(filePath) {
  let dest = `${filePath}.corrupt`;
  if (fs.existsSync(dest)) {
    let n = 1;
    while (fs.existsSync(`${dest}.${n}`)) n += 1;
    dest = `${dest}.${n}`;
  }
  try {
    fs.renameSync(filePath, dest);
  } catch {
    /* nothing else we can do; fall back to defaults in memory */
  }
}

module.exports = Store;
module.exports.Store = Store;
module.exports.DEFAULT_SETTINGS = defaultSettings();