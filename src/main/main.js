'use strict';

const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const { WindowManager } = require('./window-manager');
const { registerIpc } = require('./ipc');
const { setupWidevine, widevineStatus, isEcsRuntime } = require('./media');

// 可选启动追踪（BROWSER_TRACE=日志文件路径）
const TRACE_FILE = process.env.BROWSER_TRACE || '';
function trace(...parts) {
  if (!TRACE_FILE) return;
  try {
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {
    /* ignore */
  }
}
trace('main.js loaded');
process.on('uncaughtException', (err) => {
  trace('uncaughtException', err && err.stack ? err.stack : String(err));
  console.error(err);
});

// 产品名 / 数据目录 / UA
app.setName('浏览器');
if (process.platform === 'win32') app.setAppUserModelId('com.liulanqi.browser');

// 硬件加速：部分旧显卡驱动会被 Chromium 保守地加入黑名单，导致整机回退到
// 软件渲染（滚动、视频明显卡顿）。这里显式开启硬件合成 / 光栅化 / 视频解码，
// 并打开平滑滚动，让滚动动画更接近 Chrome / Edge 的手感。
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-smooth-scrolling');

// 去掉 UA 中的 Electron / 应用名标识，让网站把浏览器当作普通 Chrome 对待
try {
  app.userAgentFallback = app.userAgentFallback
    .replace(/\sElectron\/[\d.]+/g, '')
    .replace(/\s?liulanqi\/[\d.]+/gi, '')
    .trim();
} catch {
  /* ignore */
}

const APP_ROOT = path.join(__dirname, '..', '..');
const PRELOAD_PATH = path.join(APP_ROOT, 'src', 'preload', 'chrome-preload.js');
const RENDERER_PATH = path.join(APP_ROOT, 'src', 'renderer', 'index.html');

// 便携模式：exe 同目录存在 portable.txt 时，数据保存在同目录 data\ 下
try {
  const exeDir = path.dirname(process.execPath);
  const hasUserDataArg = process.argv.some((arg) => /^--user-data-dir(=|$)/.test(arg));
  if (fs.existsSync(path.join(exeDir, 'portable.txt')) && !hasUserDataArg) {
    const dataDir = path.join(exeDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
  }
} catch {
  /* 便携模式失败时退回默认数据目录 */
}

// Widevine DRM：在 ready 之前准备 CDM 组件（castlabs ECS 运行时）
const widevine = setupWidevine(app);
trace('widevine', JSON.stringify(widevine));

// castlabs ECS：等待 Widevine 组件注册完成后再创建窗口，否则渲染进程可能拿不到密钥系统
async function waitForWidevineComponents() {
  if (!isEcsRuntime()) return;
  let components = null;
  try {
    components = require('electron').components;
  } catch {
    return;
  }
  if (!components || typeof components.whenReady !== 'function') return;
  try {
    if (typeof components.status === 'function') trace('components status before', JSON.stringify(components.status()));
  } catch {
    /* ignore */
  }
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000));
    const result = await Promise.race([components.whenReady().then(() => 'ready'), timeout]);
    trace('components result', result);
  } catch (err) {
    trace('components error', String((err && err.message) || err));
  }
  try {
    if (typeof components.status === 'function') trace('components status after', JSON.stringify(components.status()));
  } catch {
    /* ignore */
  }
}

let wm = null;

const gotTheLock = app.requestSingleInstanceLock();
trace('single instance lock', gotTheLock);
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (wm) wm.focusLastWindow();
  });

  app.whenReady().then(async () => {
    trace('app ready');
    Menu.setApplicationMenu(null);
    await waitForWidevineComponents();
    trace('components waited');
    if (process.argv.includes('--e2e')) {
      // 自动化测试不污染真实下载目录
      const dl = path.join(app.getPath('userData'), 'Downloads');
      fs.mkdirSync(dl, { recursive: true });
      app.setPath('downloads', dl);
    }
    const store = new Store(app.getPath('userData'));
    trace('store loaded', app.getPath('userData'));
    // 退出前把防抖中的历史记录写入磁盘
    app.on('before-quit', () => {
      try {
        store.flush();
      } catch {
        /* ignore */
      }
    });
    wm = new WindowManager({
      store,
      preloadPath: PRELOAD_PATH,
      rendererPath: RENDERER_PATH,
      offscreen: process.argv.includes('--e2e'),
    });
    trace('window manager created');

    // 会话：默认（持久化） + 无痕（内存）
    wm.setupSession(require('electron').session.defaultSession);
    wm.setupSession(require('electron').session.fromPartition('incognito'));
    trace('sessions ready');

    registerIpc(wm);
    trace('ipc registered');
    wm.createWindow({});
    trace('window created');

    // 自动化端到端测试入口（仅开发/验证时使用）
    if (process.argv.includes('--e2e')) {
      try {
        require('./e2e').run(wm);
      } catch (err) {
        trace('e2e failed', err && err.stack ? err.stack : String(err));
        console.error('[e2e]', err);
        app.exit(1);
      }
    }

    // 性能自检入口（仅开发/验证时使用）
    if (process.argv.includes('--perf')) {
      try {
        require('./perf').run(wm);
      } catch (err) {
        trace('perf failed', err && err.stack ? err.stack : String(err));
        app.exit(1);
      }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (wm && wm.windows.size === 0) wm.createWindow({});
  });

  app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}

module.exports = { get wm() { return wm; } };