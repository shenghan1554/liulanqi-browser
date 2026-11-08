'use strict';

/**
 * 端到端自检（仅开发/验收使用）：
 *   electron.exe <app> --e2e --user-data-dir=<tmp>
 *
 * 窗口会被放到屏幕外（offscreen）运行，避免打扰用户；截图使用
 * webContents.capturePage()，不依赖桌面捕获。测试通过真实的 Chrome UI
 * DOM 操作（点击、输入、回车）驱动浏览器，断言标签页 / 导航 / 地址栏 /
 * 书签 / 历史 / 书签栏 / 壁纸 / 主题 / 设置 / 无痕窗口 / 错误页 / 快捷键。
 */

const { session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveInput } = require('./window-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'screenshots');
const REPORT_PATH = path.join(ROOT, 'logs', 'e2e-report.json');

const checks = [];
const notes = [];
const screenshots = [];
const domSnapshots = {};
let server = null;
let baseUrl = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name, condition, detail) {
  const pass = !!condition;
  checks.push({ name, pass, detail: detail === undefined ? null : detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !pass ? '  ->  ' + JSON.stringify(detail) : ''}`);
  return pass;
}

async function waitFor(label, fn, timeout = 10000) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(120);
  }
  throw new Error(`等待超时：${label}${lastErr ? '（' + lastErr.message + '）' : ''}`);
}

async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    check(label, false, { error: err && err.message ? err.message : String(err) });
  }
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const pages = {
        '/': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>浏览器测试页</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
font-family:"Microsoft YaHei UI",sans-serif;background:linear-gradient(135deg,#eef2ff,#e0f2fe 45%,#f8fafc);color:#16202c}
h1{font-size:40px;font-weight:600;margin:0 0 14px}p{color:#4b5a6b;margin:0 0 24px}
a{color:#3b6fe0;font-size:14px;text-decoration:none;border:1px solid #c7d6ef;border-radius:999px;padding:9px 18px;background:#fff}</style>
</head><body><h1>浏览器测试页</h1><p id="msg">本地测试页面加载成功</p>
<a id="newlink" href="/second" target="_blank">打开第二页（新标签）</a></body></html>`,
        '/second': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第二页</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Microsoft YaHei UI",sans-serif;background:#0f172a;color:#e5e9f0}
h1{font-size:34px;font-weight:600}</style></head><body><h1>第二页</h1></body></html>`,
        '/incognito-page': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无痕测试页</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Microsoft YaHei UI",sans-serif;background:#191225;color:#efe6ff}
h1{font-size:32px;font-weight:600}</style></head><body><h1>无痕测试页</h1></body></html>`,
        '/with-bookmarks': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>书签栏示例页</title></head>
<body style="margin:0;min-height:100vh;background:#f2f4f7;font-family:sans-serif;display:grid;place-items:center">
<h1 style="font-size:30px;color:#1b2028">书签栏示例页</h1></body></html>`,
        '/media': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>媒体能力测试</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Microsoft YaHei UI",sans-serif;background:#101823;color:#dce6f5}
h1{font-size:30px}</style></head><body><h1>媒体能力测试</h1></body></html>`,
      };
      if (req.url === '/sample.txt') {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="sample.txt"',
        });
        res.end('浏览器下载测试文件');
        return;
      }
      const body = pages[req.url] || '<h1>404</h1>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function captureShot(w, wm, name, wait = 260) {
  await sleep(wait);
  const tab = wm.activeTab(w);
  const hasView = !!(tab && tab.view);
  let moved = false;
  // 离屏窗口的 capturePage 可能返回旧帧/无显示表面，截图时临时移到屏幕内
  if (wm.offscreen) {
    try {
      w.win.setPosition(40, 40, false);
      moved = true;
      await sleep(520);
      w.win.webContents.invalidate();
      await sleep(120);
    } catch {
      /* ignore */
    }
  }
  try {
    const base = name.replace(/\.png$/, '');
    const chromePng = (await w.win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(SHOT_DIR, name), chromePng);
    screenshots.push({ name, file: path.join(SHOT_DIR, name), size: chromePng.length });
    if (hasView) {
      const contentPng = (await tab.view.webContents.capturePage()).toPNG();
      const contentName = `${base}.content.png`;
      fs.writeFileSync(path.join(SHOT_DIR, contentName), contentPng);
      screenshots.push({ name: contentName, file: path.join(SHOT_DIR, contentName), size: contentPng.length });
    }
  } catch (err) {
    notes.push(`截图失败（${name}）：${err && err.message}`);
  } finally {
    if (moved) {
      try {
        w.win.setPosition(-3600, 0, false);
      } catch {
        /* ignore */
      }
    }
  }
}

async function getDomText(wc, selector, limit = 2000) {
  return wc.executeJavaScript(
    `(document.querySelector(${JSON.stringify(selector)}) || document.body).innerText.slice(0, ${limit})`,
    true
  );
}

async function run(wm) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  await startServer();
  notes.push(`本地测试服务器：${baseUrl}`);

  // ── 等待第一个窗口的 chrome UI 就绪 ──
  const w = await waitFor('窗口就绪', async () => {
    const win = [...wm.windows.values()][0];
    return win && win.chromeReady ? win : null;
  });

  const chrome = w.win.webContents;
  chrome.on('console-message', (event, level, message) => {
    if (level >= 2) notes.push('console[' + level + ']: ' + message);
  });
  chrome.on('render-process-gone', (event, details) => notes.push('chrome renderer gone: ' + JSON.stringify(details)));
  const js = (code) => chrome.executeJavaScript(code, true);
  const active = () => wm.activeTab(w);

  const testUrl = baseUrl + '/';
  const secondUrl = baseUrl + '/second';
  const incognitoUrl = baseUrl + '/incognito-page';

  await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(400);

  // ── 1. 初始状态：新标签页 ──
  await step('初始状态：新标签页', async () => {
    check('初始标签数量为 1', w.tabs.length === 1, w.tabs.length);
    check('当前标签是新标签页', active() && active().url === 'browser://newtab', active() && active().url);
    // 默认设置：主题跟随系统、壁纸素白（仅全新数据目录成立，E2E 每次使用干净目录）
    check('默认主题为跟随系统', wm.store.getSettings().theme === 'auto', wm.store.getSettings().theme);
    check('默认壁纸为素白', wm.store.getSettings().wallpaper.id === 'paper', JSON.stringify(wm.store.getSettings().wallpaper));
    const resolvedTheme = await js("document.documentElement.dataset.theme");
    const sysDark = await js("window.matchMedia('(prefers-color-scheme: dark)').matches");
    check('跟随系统主题已解析', resolvedTheme === (sysDark ? 'dark' : 'light'), resolvedTheme + ' / system=' + (sysDark ? 'dark' : 'light'));
    const tabCount = await js("document.querySelectorAll('#tabs .tab').length");
    check('标签栏渲染 1 个标签', tabCount === 1, tabCount);
    // 顶部拖动条：10px 空白拖动区 + 标签空隙可拖动，标签本身不拖动
    const dragRegions = await js(`(() => {
      const region = (el) => (el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : null);
      const titlebar = document.querySelector('#titlebar');
      const tabs = document.querySelector('#tabs');
      const tab = document.querySelector('#tabs .tab');
      return {
        titlebar: region(titlebar),
        tabs: region(tabs),
        tab: region(tab),
        height: getComputedStyle(titlebar).height,
        padTop: getComputedStyle(titlebar).paddingTop,
      };
    })()`);
    check(
      '顶部留出可拖动区域',
      dragRegions.titlebar === 'drag' &&
        dragRegions.tabs === 'drag' &&
        dragRegions.tab === 'no-drag' &&
        parseInt(dragRegions.padTop, 10) >= 8,
      dragRegions
    );
    check('上方内容区起点已下移', wm.chromeTop(w) >= 90, wm.chromeTop(w));
    const clock = await js("document.querySelector('.newtab .clock-time')?.textContent || ''");
    check('新标签页时钟已渲染', /^\d{2}:\d{2}$/.test(clock), clock);
    const greeting = await js("document.querySelector('.newtab .greeting')?.textContent || ''");
    check('新标签页问候语已渲染', greeting.length > 0, greeting);
    const wallpaper = await js(
      "getComputedStyle(document.querySelector('.newtab .wallpaper')).backgroundImage"
    );
    check('新标签页壁纸已应用', /gradient|url\(/.test(wallpaper), wallpaper.slice(0, 80));
    const hint = await js("!!document.querySelector('.newtab .quick-hint')");
    check('无书签时显示收藏提示', hint === true);
    const search = await js("!!document.querySelector('.newtab #newtab-input')");
    check('新标签页有搜索框', search === true);
    domSnapshots.newtab = await getDomText(chrome, '.newtab', 600);
    await captureShot(w, wm, 'e2e-01-newtab.png');
  });

  // ── 2. 地址栏导航到本地页面 ──
  await step('地址栏输入网址并回车导航', async () => {
    await js(`(() => {
      const input = document.querySelector('#address');
      input.value = ${JSON.stringify(testUrl)};
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor('页面加载', () => {
      const t = active();
      return t && !t.internal && t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() === testUrl;
    }, 15000);
    await sleep(600);
    const title = await active().view.webContents.executeJavaScript('document.title');
    check('网页加载成功（标题正确）', title === '浏览器测试页', title);
    const h1 = await active().view.webContents.executeJavaScript(
      "document.querySelector('h1')?.textContent || ''"
    );
    check('网页 DOM 正确', h1 === '浏览器测试页', h1);
    await waitFor('标签标题同步', async () => {
      const text = await js("document.querySelector('.tab.active .tab-title')?.textContent || ''");
      return text === '浏览器测试页';
    }, 6000);
    check('标签页标题同步', true);
    const addr = await js("document.querySelector('#address').value");
    check('地址栏显示当前网址', addr === testUrl, addr);
    const backDisabled = await js("document.querySelector('#btn-back').disabled");
    check('新标签首次导航后返回按钮不可用', backDisabled === true, backDisabled);
    domSnapshots.testPage = await active().view.webContents.executeJavaScript(
      'document.body.innerText.slice(0,600)'
    );
    await captureShot(w, wm, 'e2e-02-webpage.png');
  });

  // ── 3. 前进 / 后退 ──
  await step('前进与后退', async () => {
    await js(`(() => {
      const input = document.querySelector('#address');
      input.value = ${JSON.stringify(secondUrl)};
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor('第二页加载', () => {
      const t = active();
      return t && t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() === secondUrl;
    }, 15000);
    await sleep(500);
    const backEnabled = await js("document.querySelector('#btn-back').disabled === false");
    check('跳转后返回按钮可用', backEnabled === true);
    await js("document.querySelector('#btn-back').click()");
    await waitFor('返回测试页', () => {
      const t = active();
      return t && t.view && t.view.webContents.getURL() === testUrl && !t.view.webContents.isLoading();
    }, 10000);
    const h1 = await active().view.webContents.executeJavaScript(
      "document.querySelector('h1')?.textContent || ''"
    );
    check('后退回到测试页', h1 === '浏览器测试页', h1);
    const forwardEnabled = await js("document.querySelector('#btn-forward').disabled === false");
    check('后退后前进按钮可用', forwardEnabled === true);
    await js("document.querySelector('#btn-forward').click()");
    await waitFor('前进到第二页', () => {
      const t = active();
      return t && t.view && t.view.webContents.getURL() === secondUrl && !t.view.webContents.isLoading();
    }, 10000);
    check('前进回到第二页', true);
    await js("document.querySelector('#btn-back').click()");
    await waitFor('再次返回测试页', () => {
      const t = active();
      return t && t.view && t.view.webContents.getURL() === testUrl && !t.view.webContents.isLoading();
    }, 10000);
    await sleep(400);
  });

  // ── 4. 浏览记录落盘（标题应为网页标题） ──
  await step('浏览记录写入并持久化', async () => {
    await waitFor('历史记录写入', async () => {
      const list = wm.store.listHistory({ limit: 20 });
      return list.some((item) => item.url === testUrl && item.title === '浏览器测试页');
    }, 8000);
    check('历史记录保存网页标题', wm.store.listHistory({ limit: 20 }).some((i) => i.url === testUrl && i.title === '浏览器测试页'));
    const historyFile = path.join(wm.store.dataDir, 'history.json');
    const arr = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    check('history.json 已落盘且包含两条记录', Array.isArray(arr) && arr.length >= 2, arr && arr.length);
    check('落盘记录包含第二页标题', arr.some((i) => i.url === secondUrl && i.title === '第二页'));
    check('落盘记录标题不是域名', arr.every((i) => i.title !== '127.0.0.1'));
  });

  // ── 5. 添加书签（点击星标） ──
  await step('添加书签', async () => {
    await js("document.querySelector('#bookmark-btn').click()");
    await waitFor('书签写入', () => wm.store.isBookmarked(testUrl), 6000);
    check('书签已保存', wm.store.isBookmarked(testUrl));
    await waitFor('星标状态', async () => js("document.querySelector('#bookmark-btn').classList.contains('starred')"), 5000);
    check('地址栏星标变为已收藏', true);
    const toastText = await js("document.querySelector('.toast')?.textContent || ''");
    check('显示添加书签提示', toastText.includes('书签'), toastText);
  });

  // ── 6. 新标签页 & 快捷书签磁贴 ──
  await step('新建标签页并显示书签磁贴', async () => {
    await js("document.querySelector('#new-tab-btn').click()");
    await waitFor('新标签页创建', () => w.tabs.length === 2, 6000);
    await waitFor('新页面渲染', async () => {
      const count = await js("document.querySelectorAll('.quick-link').length");
      return count >= 1;
    }, 6000);
    const tabsDom = await js("document.querySelectorAll('#tabs .tab').length");
    check('标签栏有 2 个标签', tabsDom === 2, tabsDom);
    const quickLabel = await js("document.querySelector('.quick-link .quick-label')?.textContent || ''");
    check('新标签页出现书签磁贴', quickLabel.includes('浏览器测试页'), quickLabel);
    const activeInternal = await js("document.querySelector('.newtab .clock-time') !== null");
    check('新标签页内容渲染', activeInternal === true);
    await captureShot(w, wm, 'e2e-03-newtab-bookmark.png');
  });

  // ── 7. 菜单 → 书签页面 ──
  await step('通过菜单打开书签管理页', async () => {
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    const menuItems = await js("document.querySelectorAll('#menu .menu-item').length");
    check('菜单项渲染正常', menuItems >= 8, menuItems);
    await js(`document.querySelector('#menu [data-action="menu-bookmarks"]').click()`);
    await waitFor('书签页打开', () => active() && active().url === 'browser://bookmarks', 6000);
    await waitFor('书签页渲染', async () => js("!!document.querySelector('.page-head h1')"), 6000);
    const heading = await js("document.querySelector('.page-head h1').textContent");
    check('书签页标题正确', heading === '书签', heading);
    const titles = await js("Array.from(document.querySelectorAll('.row-title')).map(el => el.textContent)");
    check('书签页列出已收藏页面', titles.includes('浏览器测试页'), titles);
    domSnapshots.bookmarks = await getDomText(chrome, '.page', 1200);
    await captureShot(w, wm, 'e2e-04-bookmarks.png');
  });

  // ── 8. 书签栏开关 ──
  await step('显示书签栏', async () => {
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    await js(`document.querySelector('#menu [data-action="menu-toggle-bar"]').click()`);
    await waitFor('设置写入', () => wm.store.getSettings().bookmarksBar === true, 5000);
    check('书签栏设置已开启', wm.store.getSettings().bookmarksBar === true);
    await waitFor('书签栏渲染', async () => {
      const hidden = await js("document.querySelector('#bookmarks-bar').hidden");
      const count = await js("document.querySelectorAll('#bookmarks-bar .bm-item').length");
      return !hidden && count >= 1;
    }, 6000);
    const chromeTop = await js("getComputedStyle(document.documentElement).getPropertyValue('--chrome-top').trim()");
    check('内容区域下移以容纳书签栏', chromeTop === '124px', chromeTop);
    await captureShot(w, wm, 'e2e-05-bookmarks-bar.png');
  });

  // ── 9. 菜单 → 历史记录 ──
  await step('历史记录页面', async () => {
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    await js(`document.querySelector('#menu [data-action="menu-history"]').click()`);
    await waitFor('历史页打开', () => active() && active().url === 'browser://history', 6000);
    await waitFor('历史页渲染', async () => js("document.querySelectorAll('.row').length >= 2"), 6000);
    const heading = await js("document.querySelector('.page-head h1').textContent");
    check('历史页标题正确', heading === '历史记录', heading);
    const titles = await js(
      "Array.from(document.querySelectorAll('.row-title')).map(el => el.textContent).slice(0, 10)"
    );
    check('历史页显示网页标题', titles.includes('浏览器测试页') && titles.includes('第二页'), titles);
    domSnapshots.history = await getDomText(chrome, '.page', 1200);
    await captureShot(w, wm, 'e2e-06-history.png');
  });

  // ── 10. 设置页 + 壁纸切换 ──
  await step('设置页与壁纸切换', async () => {
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    await js(`document.querySelector('#menu [data-action="menu-settings"]').click()`);
    await waitFor('设置页打开', () => active() && active().url === 'browser://settings', 6000);
    await waitFor('设置页渲染', async () => js("!!document.querySelector('#wallpaper-grid')"), 6000);
    const heading = await js("document.querySelector('.page-head h1').textContent");
    check('设置页标题正确', heading === '设置', heading);
    const presetCount = await js("document.querySelectorAll('#wallpaper-grid .wallpaper-card').length");
    check('壁纸选择器包含内置与自定义选项', presetCount === 7, presetCount);
    const engine = await js("document.querySelector('#engine-select').value");
    check('搜索引擎默认 Bing', engine === 'bing', engine);
    const barSwitch = await js("document.querySelector('#bookmarks-switch').checked");
    check('设置页书签栏开关状态同步', barSwitch === true, barSwitch);
    domSnapshots.settings = await getDomText(chrome, '.page', 1200);
    await captureShot(w, wm, 'e2e-07-settings.png');

    await js(`document.querySelector('#wallpaper-grid [data-id="ocean"]').click()`);
    await waitFor('壁纸设置写入', () => {
      const s = wm.store.getSettings();
      return s.wallpaper && s.wallpaper.type === 'preset' && s.wallpaper.id === 'ocean';
    }, 5000);
    check('壁纸切换为「深海」', wm.store.getSettings().wallpaper.id === 'ocean');
    const selected = await js(
      "document.querySelector('#wallpaper-grid [data-id=\"ocean\"]').classList.contains('selected')"
    );
    check('设置页选中态正确', selected === true);
  });

  // ── 11. 新标签页应用新壁纸 ──
  await step('新标签页应用新壁纸', async () => {
    wm.navigate(w, 'browser://newtab');
    await waitFor('回到新标签页', () => active() && active().url === 'browser://newtab', 5000);
    await waitFor('壁纸渲染', async () => {
      const bg = await js(
        "getComputedStyle(document.querySelector('.newtab .wallpaper')).backgroundImage"
      );
      return bg.includes('radial-gradient');
    }, 6000);
    const bg = await js("getComputedStyle(document.querySelector('.newtab .wallpaper')).backgroundImage");
    check('新标签页背景为渐变壁纸', bg.includes('radial-gradient'), bg.slice(0, 60));
    await captureShot(w, wm, 'e2e-08-wallpaper-ocean.png');
  });

  // ── 12. 自定义壁纸（模拟上传成功后的数据 + 广播） ──
  await step('自定义壁纸', async () => {
    const png1x1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    wm.store.setCustomWallpaper(Buffer.from(png1x1, 'base64'), 'png');
    wm._wallpaperCache = null;
    wm._wallpaperVersion += 1;
    wm.broadcastState();
    await waitFor('自定义壁纸渲染', async () => {
      const bg = await js(
        "getComputedStyle(document.querySelector('.newtab .wallpaper')).backgroundImage"
      );
      return bg.includes('data:image/jpeg') || bg.includes('data:image/png');
    }, 6000);
    check('自定义壁纸生效（data URL）', true);
    check('设置中记录为自定义壁纸', wm.store.getSettings().wallpaper.type === 'custom');
    wm.store.removeCustomWallpaper();
    wm._wallpaperCache = null;
    wm._wallpaperVersion += 1;
    wm.broadcastState();
    await sleep(300);
  });

  // ── 13. 主题切换 ──
  await step('主题切换', async () => {
    wm.navigate(w, 'browser://settings');
    await waitFor('设置页渲染', async () => js("!!document.querySelector('#theme-select')"), 6000);
    await js(`(() => {
      const sel = document.querySelector('#theme-select');
      sel.value = 'light';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor('主题写入', () => wm.store.getSettings().theme === 'light', 5000);
    await waitFor('浅色主题渲染', async () => (await js("document.documentElement.dataset.theme")) === 'light', 5000);
    check('浅色主题已应用', true);
    check('设置写入 theme=light', wm.store.getSettings().theme === 'light');
    await captureShot(w, wm, 'e2e-09-settings-light.png');
    await js(`(() => {
      const sel = document.querySelector('#theme-select');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor('主题恢复', () => wm.store.getSettings().theme === 'dark', 5000);
    await waitFor('深色主题渲染', async () => (await js("document.documentElement.dataset.theme")) === 'dark', 5000);
    check('主题切回深色', true);
  });

  // ── 14. 无痕窗口 ──
  await step('无痕窗口', async () => {
    const w2 = wm.createWindow({ incognito: true });
    await waitFor('无痕窗口就绪', () => (w2.chromeReady ? w2 : null), 12000);
    const chrome2 = w2.win.webContents;
    const js2 = (code) => chrome2.executeJavaScript(code, true);
    await js2(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await sleep(400);
    const incogState = await js2(`(() => {
      const btn = document.querySelector('#incognito-btn');
      return {
        badgeGone: !document.querySelector('#incognito-badge'),
        btnActive: !!(btn && btn.classList.contains('active')),
        attr: document.documentElement.dataset.incognito,
      };
    })()`);
    check('无痕窗口用紫色按钮标识状态', incogState.btnActive === true && incogState.attr === '1', incogState);
    check('无痕窗口不再显示「无痕」文字徽标', incogState.badgeGone === true, incogState);
    const watermark = await js2(`(() => {
      const el = document.querySelector('#incognito-watermark');
      if (!el) return null;
      const style = getComputedStyle(el);
      return { hidden: el.hidden, text: el.textContent.trim(), z: style.zIndex, pe: style.pointerEvents };
    })()`);
    check('无痕窗口界面有水印「无痕模式」', !!(watermark && watermark.hidden === false && watermark.text === '无痕模式'), watermark);
    check('水印不拦截鼠标点击', !!(watermark && watermark.pe === 'none'), watermark && watermark.pe);
    await js2(`(() => {
      const input = document.querySelector('#address');
      input.value = ${JSON.stringify(incognitoUrl)};
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor('无痕页面加载', () => {
      const t = wm.activeTab(w2);
      return t && !t.internal && t.view && t.view.webContents.getURL() === incognitoUrl;
    }, 15000);
    await sleep(600);
    const h1 = await wm.activeTab(w2).view.webContents.executeJavaScript(
      "document.querySelector('h1')?.textContent || ''"
    );
    check('无痕窗口可正常浏览', h1 === '无痕测试页', h1);
    const pageWatermark = await wm.activeTab(w2).view.webContents.executeJavaScript(
      `(() => {
        const pseudo = getComputedStyle(document.documentElement, '::after');
        return { content: pseudo.content, pointer: pseudo.pointerEvents, position: pseudo.position };
      })()`
    );
    check(
      '网页内也注入「无痕模式」水印',
      !!(pageWatermark && String(pageWatermark.content).includes('无痕模式') && pageWatermark.pointer === 'none'),
      pageWatermark
    );
    check('无痕窗口使用独立会话', wm.activeTab(w2).view.webContents.session !== session.defaultSession);
    const historyUrls = wm.store.listHistory({ limit: 100 }).map((i) => i.url);
    check('无痕浏览不写入历史记录', !historyUrls.some((u) => u.includes('/incognito-page')), historyUrls.slice(0, 5));
    await captureShot(w2, wm, 'e2e-10-incognito.png');
    w2.win.close();
    await waitFor('无痕窗口关闭', () => wm.windows.size === 1, 5000);
  });

  // ── 15. 视频解码与 Widevine DRM ──
  await step('视频解码与 Widevine DRM', async () => {
    const mediaUrl = baseUrl + '/media';
    wm.navigate(w, mediaUrl);
    await waitFor('媒体页加载', () => {
      const t = active();
      return t && t.view && t.view.webContents.getURL() === mediaUrl && !t.view.webContents.isLoading();
    }, 15000);
    await sleep(500);
    const res = await active().view.webContents.executeJavaScript(`(async () => {
      const video = (mime) => document.createElement('video').canPlayType(mime);
      const audio = (mime) => document.createElement('audio').canPlayType(mime);
      const ms = window.MediaSource;
      const out = {
        canH264: video('video/mp4; codecs="avc1.42E01E"'),
        canH264High: video('video/mp4; codecs="avc1.640028"'),
        canAac: audio('audio/mp4; codecs="mp4a.40.2"'),
        msH264: !!(ms && ms.isTypeSupported('video/mp4; codecs="avc1.42E01E"')),
        msAac: !!(ms && ms.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')),
        msBoth: !!(ms && ms.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')),
        secure: window.isSecureContext,
        videoDecoder: null,
        audioDecoder: null,
        widevine: null,
        mediaKeys: null,
      };
      try {
        out.videoDecoder = window.VideoDecoder
          ? (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 360 })).supported
          : false;
      } catch (err) { out.videoDecoder = String(err && err.message || err); }
      try {
        out.audioDecoder = window.AudioDecoder
          ? (await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 })).supported
          : false;
      } catch (err) { out.audioDecoder = String(err && err.message || err); }
      const cfg = [{
        initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      }];
      try {
        const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg);
        out.widevine = { ok: true, keySystem: access.keySystem };
        try {
          const keys = await access.createMediaKeys();
          out.mediaKeys = !!keys;
        } catch (err) { out.mediaKeys = String(err && err.message || err); }
      } catch (err) {
        out.widevine = { ok: false, name: err && err.name, message: err && err.message };
      }
      return out;
    })()`);
    notes.push(`媒体能力：${JSON.stringify(res)}`);
    check('H.264 (AVC1) 视频解码可用', res.canH264 === 'probably' || res.canH264 === 'maybe', res.canH264);
    check('H.264 High Profile 可用', res.canH264High === 'probably' || res.canH264High === 'maybe', res.canH264High);
    check('AAC (mp4a.40.2) 音频解码可用', res.canAac === 'probably' || res.canAac === 'maybe', res.canAac);
    check('MediaSource 支持 H.264', res.msH264 === true);
    check('MediaSource 支持 AAC', res.msAac === true);
    check('MediaSource 支持 H.264 + AAC（MP4）', res.msBoth === true);
    check('WebCodecs H.264 解码器可用', res.videoDecoder === true, res.videoDecoder);
    check('WebCodecs AAC 解码器可用', res.audioDecoder === true, res.audioDecoder);
    check('页面处于安全上下文（DRM 前提）', res.secure === true);
    check('Widevine 密钥系统可用', !!(res.widevine && res.widevine.ok === true), res.widevine);
    check('Widevine CDM 可创建 MediaKeys', res.mediaKeys === true, res.mediaKeys);
    const info = await chrome.executeJavaScript('window.browser.app.info()');
    check('关于页 Widevine 状态为已启用', !!(info.widevine && info.widevine.available === true), info.widevine);
    check('Widevine CDM 版本号有效', !!(info.widevine && /\d+\.\d+/.test(String(info.widevine.version))), info.widevine && info.widevine.version);
    notes.push(`Widevine 状态：${JSON.stringify(info.widevine)}`);
    domSnapshots.media = JSON.stringify(res, null, 2);
    await captureShot(w, wm, 'e2e-13-media.png');
  });

  // ── 16. 错误页 ──
  await step('错误页与重试', async () => {
    wm.navigate(w, 'http://127.0.0.1:59999/');
    await waitFor('错误页出现', () => {
      const t = active();
      return t && t.url.startsWith('browser://error');
    }, 15000);
    await waitFor('错误页渲染', async () => js("!!document.querySelector('.error-page')"), 6000);
    const heading = await js("document.querySelector('.error-page h1').textContent");
    check('显示「无法访问此网站」错误页', heading === '无法访问此网站', heading);
    const retryBtn = await js("!!document.querySelector('[data-action=\"retry\"]')");
    check('错误页有重试按钮', retryBtn === true);
    domSnapshots.error = await getDomText(chrome, '.error-page', 600);
    await captureShot(w, wm, 'e2e-11-error.png');
  });

  // ── 16. 快捷键与标签页关闭 ──
  await step('标签页关闭与快捷键', async () => {
    const before = w.tabs.length;
    const handled = wm.handleShortcut(w, { type: 'keyDown', control: true, meta: false, shift: false, alt: false, key: 't' });
    check('Ctrl+T 快捷键被处理', handled === true);
    await waitFor('Ctrl+T 新建标签页', () => w.tabs.length === before + 1, 6000);
    const activeTab = active();
    wm.closeTab(w, activeTab.id);
    await waitFor('标签页关闭', () => w.tabs.length === before, 6000);
    check('标签页可关闭', true);
  });

  // ── 17. 地址栏智能解析 ──
  await step('地址栏智能解析', async () => {
    check('输入网址原样解析', resolveInput('example.com', 'bing') === 'https://example.com');
    check('输入关键词走搜索引擎', resolveInput('浏览器 测试', 'bing').startsWith('https://www.bing.com/search?q='));
    check('输入 localhost 补全协议', resolveInput('localhost:8080', 'bing') === 'http://localhost:8080');
  });

  // ── 18. 删除书签 ──
  await step('删除书签', async () => {
    wm.store.addBookmark({ url: secondUrl, title: '第二页' });
    wm.broadcastState();
    wm.navigate(w, 'browser://bookmarks');
    await waitFor('书签页渲染', async () => js("document.querySelectorAll('.row').length >= 2"), 6000);
    await js(`(() => {
      const row = document.querySelector('.row[data-url="${secondUrl}"]');
      const btn = row && row.querySelector('[data-action="bookmark-delete"]');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await waitFor('书签删除', () => !wm.store.listBookmarks().some((b) => b.url === secondUrl), 6000);
    check('书签可删除', !wm.store.listBookmarks().some((b) => b.url === secondUrl));
  });

  // ── 19. 下载 ──
  await step('文件下载', async () => {
    const downloadUrl = baseUrl + '/sample.txt';
    wm.navigate(w, downloadUrl);
    const rec = await waitFor('下载完成', () => {
      const d = wm.downloads.find((x) => x.url === downloadUrl);
      return d && d.state === 'completed' ? d : null;
    }, 15000);
    check('下载记录已登记', !!rec);
    check('下载文件已保存到磁盘', !!(rec.savePath && fs.existsSync(rec.savePath)), rec.savePath);
    check(
      '下载文件内容正确',
      !!(rec.savePath && fs.readFileSync(rec.savePath, 'utf8') === '浏览器下载测试文件')
    );
    wm.navigate(w, 'browser://downloads');
    await waitFor('下载页渲染', async () => js("document.querySelectorAll('.dl-row').length >= 1"), 6000);
    const dlName = await js("document.querySelector('.dl-row .dl-name')?.textContent || ''");
    check('下载页列出文件', dlName === 'sample.txt', dlName);
    domSnapshots.downloads = await getDomText(chrome, '.page', 800);
    await captureShot(w, wm, 'e2e-12-downloads.png');
    await js(`document.querySelector('[data-action="clear-downloads"]').click()`);
    await waitFor('清空下载列表', () => wm.downloads.length === 0, 5000);
    check('下载列表可清空', wm.downloads.length === 0);
  });

  // ── 20. 书签栏快捷入口 ──
  await step('书签栏快捷入口', async () => {
    const barVisible = await waitFor('书签栏可见', async () => {
      const hidden = await js("document.querySelector('#bookmarks-bar').hidden");
      const count = await js("document.querySelectorAll('#bookmarks-bar .bm-item').length");
      return !hidden && count > 0 ? count : null;
    }, 6000);
    check('书签栏显示书签条目', barVisible >= 1, barVisible);
    const barUrl = await js("document.querySelector('#bookmarks-bar .bm-item').dataset.url");
    await js("document.querySelector('#bookmarks-bar .bm-item').click()");
    await waitFor('书签栏跳转', () => {
      const t = active();
      return t && t.view && t.view.webContents.getURL() === barUrl && !t.view.webContents.isLoading();
    }, 15000);
    const h1 = await active().view.webContents.executeJavaScript(
      "document.querySelector('h1')?.textContent || ''"
    );
    check('点击书签栏打开对应网页', h1 === '浏览器测试页', h1);
  });

  // ── 21. 网页打开时菜单浮层可用（回归：菜单被网页视图盖住，设置/历史打不开） ──
  await step('网页打开时菜单可用', async () => {
    wm.navigate(w, testUrl);
    await waitFor('测试页加载', () => {
      const t = active();
      return t && t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() === testUrl;
    }, 15000);
    await sleep(300);
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    await waitFor('网页视图为菜单让位', () => w.attachedTabId === null, 4000);
    check('菜单打开时网页视图已让位', w.attachedTabId === null);
    const snapshot = await waitFor('菜单快照就绪', async () => {
      const s = await js(`(() => {
        const el = document.querySelector('#page-snapshot');
        return { exists: !!el, hidden: !!(el && el.hidden), hasSrc: !!(el && el.getAttribute('src')) };
      })()`);
      if (!s.exists) return null;
      // 离屏窗口有时截不到画面，此时允许没有底图，但元素必须存在
      if (s.hasSrc || !w.overlayImage) return s;
      return null;
    }, 4000);
    check('菜单打开时保留页面快照元素', !!(snapshot && snapshot.exists === true), snapshot);
    notes.push(`菜单快照：${JSON.stringify(snapshot)}（overlayImage=${w.overlayImage ? 'yes' : 'no'}）`);
    await js(`document.querySelector('#menu [data-action="menu-settings"]').click()`);
    await waitFor('设置页打开', () => active() && active().url === 'browser://settings', 8000);
    check('网页打开时可通过菜单进入设置', active().url === 'browser://settings');
    await waitFor('菜单自动关闭', async () => js("document.querySelector('#menu').hidden"), 4000);
    check('菜单关闭后浮层状态复位', w.overlayTabId === null);
  });

  // ── 22. 菜单关闭后网页视图恢复 ──
  await step('关闭菜单后网页恢复', async () => {
    wm.navigate(w, testUrl);
    await waitFor('测试页重新加载', () => {
      const t = active();
      return t && t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL() === testUrl;
    }, 15000);
    await js("document.querySelector('#menu-btn').click()");
    await waitFor('菜单展开', async () => js("!document.querySelector('#menu').hidden"), 4000);
    await waitFor('视图让位', () => w.attachedTabId === null, 4000);
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor('视图恢复', () => {
      const t = active();
      return t && t.view && w.attachedTabId === t.id;
    }, 6000);
    check('关闭菜单后网页视图恢复', w.attachedTabId === active().id);
    const snapshotHidden = await js("document.querySelector('#page-snapshot').hidden");
    check('菜单关闭后快照隐藏', snapshotHidden === true);
  });

  // ── 23. 右上角无痕按钮 ──
  await step('右上角无痕按钮打开无痕窗口', async () => {
    const before = [...wm.windows.values()].filter((x) => x.incognito).length;
    await js("document.querySelector('#incognito-btn').click()");
    await waitFor('无痕窗口创建', () => {
      return [...wm.windows.values()].filter((x) => x.incognito).length === before + 1;
    }, 8000);
    const incog = [...wm.windows.values()].find((x) => x.incognito);
    check('右上角无痕按钮可打开无痕窗口', !!incog);
    if (incog) {
      await waitFor('无痕窗口渲染就绪', () => incog.chromeReady, 8000);
      const badgeGone = await incog.win.webContents.executeJavaScript(
        "(() => { return { badge: !!document.querySelector('#incognito-badge'), text: (document.querySelector('#titlebar-right')?.innerText || '').trim() }; })()"
      );
      check('无痕窗口不再显示「无痕」文字', badgeGone.badge === false && !badgeGone.text.includes('无痕'), badgeGone);
      await sleep(500); // 等颜色过渡结束再取计算样式
      const activeBtn = await incog.win.webContents.executeJavaScript(
        `(() => {
          const b = document.querySelector('#incognito-btn');
          if (!b) return null;
          return {
            active: b.classList.contains('active'),
            pressed: b.getAttribute('aria-pressed'),
            color: getComputedStyle(b).color,
            incogAttr: document.documentElement.dataset.incognito,
            tip: b.title,
          };
        })()`
      );
      check('无痕窗口无痕按钮点亮为主题色', !!(activeBtn && activeBtn.active === true), activeBtn);
      check('无痕按钮颜色为紫色', !!(activeBtn && activeBtn.color === 'rgb(201, 179, 255)'), activeBtn && activeBtn.color);
      check('无痕窗口 data-incognito=1', !!(activeBtn && activeBtn.incogAttr === '1'), activeBtn && activeBtn.incogAttr);
      check('无痕按钮提示文案说明状态', !!(activeBtn && activeBtn.tip && activeBtn.tip.includes('无痕浏览中')), activeBtn && activeBtn.tip);
      const incogWatermark = await incog.win.webContents.executeJavaScript(
        "(() => { const el = document.querySelector('#incognito-watermark'); return el ? { hidden: el.hidden, text: el.textContent.trim() } : null; })()"
      );
      check('右上角无痕按钮打开的无痕窗口带水印', !!(incogWatermark && incogWatermark.hidden === false && incogWatermark.text === '无痕模式'), incogWatermark);
      check('无痕窗口自带新标签页', incog.tabs.length >= 1, incog.tabs.length);
      incog.win.close();
      await waitFor('无痕窗口关闭', () => !wm.windows.has(incog.id), 6000);

      // 回到普通窗口：按钮应恢复成界面常规颜色（不再是紫色），水印也要消失
      const normalBtn = await js(
        `(() => {
          const b = document.querySelector('#incognito-btn');
          if (!b) return null;
          return {
            active: b.classList.contains('active'),
            pressed: b.getAttribute('aria-pressed'),
            color: getComputedStyle(b).color,
            incogAttr: document.documentElement.dataset.incognito,
            watermarkHidden: (document.querySelector('#incognito-watermark') || {}).hidden,
          };
        })()`
      );
      check('普通窗口无痕按钮未点亮', !!(normalBtn && normalBtn.active === false), normalBtn);
      check('普通窗口无痕按钮为常规颜色', !!(normalBtn && normalBtn.color !== 'rgb(201, 179, 255)'), normalBtn && normalBtn.color);
      check('普通窗口 data-incognito=0', !!(normalBtn && normalBtn.incogAttr === '0'), normalBtn && normalBtn.incogAttr);
      check('普通窗口不显示无痕水印', !!(normalBtn && normalBtn.watermarkHidden === true), normalBtn);
    }
  });

  // ── 24. 渲染层错误收集 ──
  await step('渲染层无 JavaScript 错误', async () => {
    const errors = await js('window.browser.diagnostics.errors()');
    check('Chrome UI 无渲染层错误', Array.isArray(errors) && errors.length === 0, errors);
  });

  // ── 汇总 ──
  const failed = checks.filter((c) => !c.pass);
  const report = {
    startedAt: new Date().toISOString(),
    baseUrl,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    notes,
    screenshots,
    domSnapshots,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(SHOT_DIR, 'e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nE2E 完成：${report.passed}/${report.total} 通过，失败 ${report.failed}`);
  console.log(`报告：${REPORT_PATH}`);
  if (server) server.close();
  await sleep(400);
  process.exit(failed.length ? 1 : 0);
}

module.exports = {
  run: async (wm) => {
    try {
      await run(wm);
    } catch (err) {
      console.error('[e2e] 异常终止', err);
      const report = {
        error: err && err.stack ? err.stack : String(err),
        total: checks.length,
        passed: checks.filter((c) => c.pass).length,
        failed: checks.filter((c) => !c.pass).length + 1,
        checks,
        notes,
        screenshots,
      };
      try {
        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  },
};