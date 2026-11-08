'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Store = require('../src/main/store.js');

const DEFAULTS = {
  searchEngine: 'bing',
  theme: 'auto',
  bookmarksBar: false,
  wallpaper: { type: 'preset', id: 'paper' },
  defaultsVersion: 2,
};

/** Fresh temp data dir, removed after the test. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-store-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('module export: require() returns the Store class (and named Store)', () => {
  assert.equal(typeof Store, 'function');
  const named = require('../src/main/store.js');
  assert.equal(named.Store, Store);
});

test('constructor creates a missing data directory and rejects invalid input', (t) => {
  const base = tempDir(t);
  const dir = path.join(base, 'a', 'b', 'c');
  const store = new Store(dir);
  assert.ok(fs.existsSync(dir));
  assert.equal(store.dataDir, path.resolve(dir));
  assert.throws(() => new Store(''), TypeError);
  assert.throws(() => new Store(null), TypeError);
});

test('settings: defaults are exact', (t) => {
  const store = new Store(tempDir(t));
  assert.deepEqual(store.getSettings(), DEFAULTS);
});

test('settings: old untouched defaults migrate to auto theme + paper wallpaper', (t) => {
  const dir = tempDir(t);
  // 1.0.4 及更早版本写出的 settings.json（无 defaultsVersion 字段）
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      searchEngine: 'bing',
      theme: 'dark',
      bookmarksBar: false,
      wallpaper: { type: 'preset', id: 'midnight' },
    })
  );

  const store = new Store(dir);
  assert.equal(store.getSettings().theme, 'auto');
  assert.deepEqual(store.getSettings().wallpaper, { type: 'preset', id: 'paper' });
  assert.equal(store.getSettings().defaultsVersion, 2);
  // 迁移结果已落盘
  assert.equal(readJson(path.join(dir, 'settings.json')).theme, 'auto');
});

test('settings: migration keeps user choices (light theme / custom wallpaper id)', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      searchEngine: 'baidu',
      theme: 'light',
      bookmarksBar: true,
      wallpaper: { type: 'preset', id: 'ocean' },
    })
  );

  const store = new Store(dir);
  assert.equal(store.getSettings().theme, 'light');
  assert.deepEqual(store.getSettings().wallpaper, { type: 'preset', id: 'ocean' });
  assert.equal(store.getSettings().defaultsVersion, 2);
});

test('settings: update merges (one nested level), persists and reloads', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);

  const merged = store.updateSettings({
    theme: 'light',
    bookmarksBar: true,
    wallpaper: { type: 'preset', id: 'ocean' },
  });

  assert.deepEqual(merged, {
    searchEngine: 'bing',
    theme: 'light',
    bookmarksBar: true,
    wallpaper: { type: 'preset', id: 'ocean' },
    defaultsVersion: 2,
  });
  assert.deepEqual(store.getSettings(), merged);
  // returned value is a copy, not live state
  merged.theme = 'mutated';
  assert.equal(store.getSettings().theme, 'light');

  // persisted synchronously, no temp file left behind
  assert.deepEqual(readJson(path.join(dir, 'settings.json')), store.getSettings());
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);

  // a new instance reloads the persisted values (disk wins over defaults)
  const reloaded = new Store(dir);
  assert.deepEqual(reloaded.getSettings(), store.getSettings());

  // non-object patches are ignored
  assert.deepEqual(reloaded.updateSettings(null), store.getSettings());
});

test('history: add creates entries, blank url is ignored', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);

  const first = store.addHistory({ url: 'https://a.test/', title: 'A' });
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0);
  assert.equal(first.url, 'https://a.test/');
  assert.equal(first.title, 'A');
  assert.equal(typeof first.time, 'number');

  assert.equal(store.addHistory({ url: '' }), null);
  assert.equal(store.addHistory({ url: '   ' }), null);
  assert.equal(store.addHistory({}), null);
  assert.equal(store.addHistory(null), null);

  const list = store.listHistory();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], first);
});

test('history: consecutive same url only updates title/time, no duplicate', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);

  const first = store.addHistory({ url: 'https://a.test/', title: 'old title' });
  const second = store.addHistory({ url: 'https://a.test/', title: 'new title' });

  assert.equal(second.id, first.id);
  assert.equal(second.title, 'new title');
  assert.ok(second.time >= first.time);
  assert.equal(store.listHistory().length, 1);

  // missing title on dedupe keeps the previous title
  const third = store.addHistory({ url: 'https://a.test/' });
  assert.equal(third.id, first.id);
  assert.equal(third.title, 'new title');

  // a different url creates a new head entry
  const other = store.addHistory({ url: 'https://b.test/', title: 'B' });
  const list = store.listHistory();
  assert.deepEqual(
    list.map((item) => item.url),
    ['https://b.test/', 'https://a.test/']
  );
  assert.equal(other.id !== first.id, true);

  const reloaded = new Store(dir);
  assert.deepEqual(reloaded.listHistory(), list);
});

test('history: capped at 3000 entries, oldest dropped', (t) => {
  const dir = tempDir(t);
  const seeded = [];
  for (let i = 0; i < 3000; i += 1) {
    seeded.push({
      id: `old-${i}`,
      url: `https://old.test/${i}`,
      title: `old ${i}`,
      time: 1_700_000_000_000 + (3000 - i),
    });
  }
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(seeded));

  const store = new Store(dir);
  assert.equal(store.listHistory({ limit: 5000 }).length, 3000);

  store.addHistory({ url: 'https://new.test/', title: 'new' });
  const list = store.listHistory({ limit: 5000 });
  assert.equal(list.length, 3000);
  assert.equal(list[0].url, 'https://new.test/');
  assert.equal(list[2999].url, 'https://old.test/2998');
  assert.equal(list.some((item) => item.url === 'https://old.test/2999'), false);

  const reloaded = new Store(dir);
  assert.equal(reloaded.listHistory({ limit: 5000 }).length, 3000);
});

test('history: listHistory filters by query (case-insensitive) and limit', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  store.addHistory({ url: 'https://github.com/', title: 'GitHub' });
  store.addHistory({ url: 'https://example.com/', title: 'Example Site' });
  store.addHistory({ url: 'https://docs.test/guide', title: 'Guide' });

  assert.deepEqual(
    store.listHistory({ query: 'github' }).map((item) => item.url),
    ['https://github.com/']
  );
  assert.deepEqual(
    store.listHistory({ query: 'GITHUB' }).map((item) => item.url),
    ['https://github.com/']
  );
  // title match, case-insensitive
  assert.deepEqual(
    store.listHistory({ query: 'EXAMPLE' }).map((item) => item.url),
    ['https://example.com/']
  );
  assert.deepEqual(store.listHistory({ query: 'no-such-entry' }), []);
  assert.equal(store.listHistory({ limit: 2 }).length, 2);
  assert.equal(store.listHistory({ limit: 0 }).length, 0);

  // newest first
  const all = store.listHistory();
  assert.deepEqual(
    all.map((item) => item.url),
    ['https://docs.test/guide', 'https://example.com/', 'https://github.com/']
  );
});

test('history: removeHistory returns bool and clearHistory persists', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const a = store.addHistory({ url: 'https://a.test/', title: 'A' });
  store.addHistory({ url: 'https://b.test/', title: 'B' });

  assert.equal(store.removeHistory('missing-id'), false);
  assert.equal(store.removeHistory(a.id), true);
  assert.deepEqual(
    store.listHistory().map((item) => item.url),
    ['https://b.test/']
  );
  assert.equal(new Store(dir).listHistory().length, 1);

  store.clearHistory();
  assert.deepEqual(store.listHistory(), []);
  assert.deepEqual(new Store(dir).listHistory(), []);
});

test('bookmarks: add dedupes, isBookmarked, remove and removeBookmarkByUrl', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);

  assert.equal(store.isBookmarked('https://x.test/'), false);
  assert.equal(store.addBookmark({ url: '' }), null);
  assert.equal(store.addBookmark({}), null);

  const x = store.addBookmark({ url: 'https://x.test/', title: 'X' });
  assert.equal(typeof x.id, 'string');
  assert.equal(typeof x.added, 'number');
  assert.equal(store.isBookmarked('https://x.test/'), true);

  const duplicate = store.addBookmark({ url: 'https://x.test/', title: 'X dup' });
  assert.equal(duplicate.id, x.id);
  assert.equal(store.listBookmarks().length, 1);
  assert.equal(store.listBookmarks()[0].title, 'X');

  const y = store.addBookmark({ url: 'https://y.test/', title: 'Y' });
  assert.deepEqual(
    store.listBookmarks().map((item) => item.url),
    ['https://x.test/', 'https://y.test/']
  );

  // persistence across instances, insertion order preserved
  const reloaded = new Store(dir);
  assert.deepEqual(reloaded.listBookmarks(), store.listBookmarks());
  assert.equal(reloaded.isBookmarked('https://y.test/'), true);

  assert.equal(store.removeBookmark('missing-id'), false);
  assert.equal(store.removeBookmarkByUrl('https://y.test/'), true);
  assert.equal(store.removeBookmarkByUrl('https://y.test/'), false);
  assert.equal(store.removeBookmark(x.id), true);
  assert.deepEqual(store.listBookmarks(), []);
  assert.deepEqual(new Store(dir).listBookmarks(), []);
  assert.equal(y.id !== x.id, true);
});

test('corrupt files: fall back to defaults and rename to .corrupt', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
  fs.writeFileSync(path.join(dir, 'history.json'), 'not-json either');
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), '{"truncated":');

  const store = new Store(dir);
  assert.deepEqual(store.getSettings(), DEFAULTS);
  assert.deepEqual(store.listHistory(), []);
  assert.deepEqual(store.listBookmarks(), []);

  for (const name of ['settings.json', 'history.json', 'bookmarks.json']) {
    assert.equal(fs.existsSync(path.join(dir, `${name}.corrupt`)), true, name);
    assert.equal(fs.existsSync(path.join(dir, name)), false, name);
  }

  // store remains usable and writes fresh valid files
  store.updateSettings({ theme: 'light' });
  store.addHistory({ url: 'https://after-corrupt.test/', title: 'ok' });
  store.addBookmark({ url: 'https://after-corrupt.test/', title: 'ok' });
  const reloaded = new Store(dir);
  assert.equal(reloaded.getSettings().theme, 'light');
  assert.equal(reloaded.listHistory()[0].url, 'https://after-corrupt.test/');
  assert.equal(reloaded.listBookmarks()[0].url, 'https://after-corrupt.test/');
  // corrupt copies are preserved
  assert.equal(fs.existsSync(path.join(dir, 'settings.json.corrupt')), true);
});

test('corrupt files: structurally invalid JSON (wrong type) also falls back', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '[]');
  fs.writeFileSync(path.join(dir, 'history.json'), '{"not":"an array"}');
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), 'null');

  const store = new Store(dir);
  assert.deepEqual(store.getSettings(), DEFAULTS);
  assert.deepEqual(store.listHistory(), []);
  assert.deepEqual(store.listBookmarks(), []);
  for (const name of ['settings.json', 'history.json', 'bookmarks.json']) {
    assert.equal(fs.existsSync(path.join(dir, `${name}.corrupt`)), true, name);
  }
});

test('wallpaper: setCustomWallpaper writes file, updates settings and reloads', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  assert.equal(store.getWallpaperPath(), null);

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const written = store.setCustomWallpaper(bytes, '.PNG');

  assert.equal(written, path.join(path.resolve(dir), 'wallpapers', 'wallpaper.png'));
  assert.ok(fs.existsSync(written));
  assert.deepEqual(fs.readFileSync(written), bytes);
  assert.deepEqual(store.getSettings().wallpaper, {
    type: 'custom',
    file: 'wallpaper.png',
  });
  assert.equal(store.getWallpaperPath(), written);

  // settings + image survive a reload
  const reloaded = new Store(dir);
  assert.equal(reloaded.getWallpaperPath(), written);
  assert.equal(reloaded.getSettings().wallpaper.type, 'custom');

  // setting a different extension replaces the stale image
  const jpg = reloaded.setCustomWallpaper(Buffer.from('jpeg-bytes'), 'jpg');
  assert.ok(fs.existsSync(jpg));
  assert.equal(fs.existsSync(written), false);
  assert.equal(reloaded.getWallpaperPath(), jpg);

  // switching back to a preset through updateSettings drops the custom ref
  const preset = reloaded.updateSettings({
    wallpaper: { type: 'preset', id: 'ocean' },
  });
  assert.deepEqual(preset.wallpaper, { type: 'preset', id: 'ocean' });
  assert.equal(reloaded.getWallpaperPath(), null);
});

test('wallpaper: removeCustomWallpaper deletes file and restores preset', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const written = store.setCustomWallpaper(Buffer.from('image'), 'png');

  store.removeCustomWallpaper();
  assert.equal(fs.existsSync(written), false);
  assert.deepEqual(store.getSettings().wallpaper, {
    type: 'preset',
    id: 'paper',
  });
  assert.equal(store.getWallpaperPath(), null);
  // idempotent: removing twice is not an error
  assert.doesNotThrow(() => store.removeCustomWallpaper());
  assert.deepEqual(new Store(dir).getSettings().wallpaper, {
    type: 'preset',
    id: 'paper',
  });

  assert.throws(() => store.setCustomWallpaper('not a buffer', 'png'), TypeError);
  assert.throws(() => store.setCustomWallpaper(Buffer.from('x'), '../evil'), TypeError);
});

test('wallpaper: getWallpaperPath returns null when the custom file is missing', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const written = store.setCustomWallpaper(Buffer.from('image'), 'png');
  fs.unlinkSync(written);
  assert.equal(store.getWallpaperPath(), null);
});

test('downloads: in-memory add/update/list/clear', (t) => {
  const store = new Store(tempDir(t));

  const download = store.addDownload({
    url: 'https://files.test/a.zip',
    filename: 'a.zip',
  });
  assert.equal(typeof download.id, 'string');
  assert.equal(download.status, 'progressing');
  assert.equal(download.filename, 'a.zip');

  assert.equal(store.updateDownload('missing-id', { status: 'done' }), null);

  const updated = store.updateDownload(download.id, {
    status: 'completed',
    receivedBytes: 42,
    totalBytes: 42,
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.receivedBytes, 42);

  assert.deepEqual(
    store.listDownloads().map((item) => item.id),
    [download.id]
  );

  // list returns copies
  store.listDownloads()[0].status = 'mutated';
  assert.equal(store.listDownloads()[0].status, 'completed');

  store.clearDownloads();
  assert.deepEqual(store.listDownloads(), []);
});