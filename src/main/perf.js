'use strict';

/**
 * 性能自检（仅开发用）：electron.exe <app> --perf [--perf-url=<网址>]
 * 打开本地重内容页面或指定真实网站，测量 chrome 渲染层 / 网页层的帧率、
 * 掉帧、长任务、滚轮滚动表现与进程 CPU，用于定位卡顿来源。
 */

const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'logs', 'perf-report.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function perfUrlArg() {
  const hit = process.argv.find((a) => a.startsWith('--perf-url='));
  return hit ? hit.slice('--perf-url='.length) : '';
}

function fpsScript(ms, scroll) {
  return `(async () => {
    const t0 = performance.now();
    let frames = 0;
    let last = t0;
    let maxGap = 0;
    let longFrames = 0;
    const gaps = [];
    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
      });
      observer.observe({ type: 'longtask', buffered: false });
    } catch (err) {
      /* 不支持 longtask 时忽略 */
    }
    ${scroll ? 'let dir = 1;' : ''}
    await new Promise((resolve) => {
      function tick(ts) {
        if (frames > 0) {
          const gap = ts - last;
          gaps.push(gap);
          if (gap > maxGap) maxGap = gap;
          if (gap > 25) longFrames++;
        }
        last = ts;
        frames++;
        ${scroll ? `window.scrollBy(0, dir * 22);
        if (window.scrollY + innerHeight >= document.body.scrollHeight - 10) dir = -1;
        else if (window.scrollY <= 0) dir = 1;` : ''}
        if (ts - t0 < ${ms}) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    if (observer) observer.disconnect();
    const elapsed = performance.now() - t0;
    const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    gaps.sort((a, b) => a - b);
    return {
      frames,
      elapsed: Math.round(elapsed),
      fps: Math.round((frames / (elapsed / 1000)) * 10) / 10,
      avgGap: Math.round(avgGap * 10) / 10,
      p95Gap: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)] * 10) / 10 : 0,
      maxGap: Math.round(maxGap * 10) / 10,
      longFrames,
      longTasks: longTasks.length,
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      longTaskTotal: longTasks.reduce((a, b) => a + b, 0),
    };
  })()`;
}

async function measure(wc, ms, scroll) {
  try {
    return await wc.executeJavaScript(fpsScript(ms, scroll), true);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function cpuSnapshot() {
  try {
    const metrics = app.getAppMetrics();
    return metrics.map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Math.round((m.cpu && m.cpu.percentCPUUsage) || 0),
      workingSetMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
    }));
  } catch {
    return [];
  }
}

async function wheelScroll(wc, bounds, ms) {
  const x = Math.round(bounds.width / 2);
  const y = Math.round(bounds.height / 2);
  const start = Date.now();
  let sent = 0;
  const timer = setInterval(() => {
    if (Date.now() - start > ms) return;
    try {
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -160, canScroll: true });
      sent++;
    } catch {
      /* ignore */
    }
  }, 16);
  const measured = await measure(wc, ms, false);
  clearInterval(timer);
  measured.wheelEvents = sent;
  try {
    measured.scrollY = await wc.executeJavaScript('window.scrollY', true);
  } catch {
    /* ignore */
  }
  return measured;
}

function startLocalServer() {
  const rows = [];
  for (let i = 0; i < 1200; i++) {
    rows.push(
      `<div class="row" style="background:linear-gradient(90deg,hsl(${i % 360},55%,${40 + (i % 25)}%),hsl(${(i * 7) % 360},50%,32%))"><span>第 ${i + 1} 行 · 滚动性能测试内容块</span></div>`
    );
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>性能测试页</title>
<style>body{margin:0;font-family:"Microsoft YaHei UI",sans-serif;background:#0d1117;color:#e6edf3}
header{position:sticky;top:0;height:52px;display:flex;align-items:center;padding:0 18px;background:#161b22;border-bottom:1px solid #30363d}
.row{height:46px;display:flex;align-items:center;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px;color:#fff}
</style></head><body><header>滚动性能测试页 · 1200 行</header>${rows.join('')}</body></html>`;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function run(wm) {
  const report = {
    at: new Date().toISOString(),
    args: process.argv.slice(2),
    gpu: null,
    gpuInfo: null,
    chromeIdle: null,
    webIdle: null,
    webScroll: null,
    wheelScroll: null,
    chromeDuringScroll: null,
    cpuBefore: null,
    cpuDuring: null,
    memory: null,
  };
  try {
    report.gpu = app.getGPUFeatureStatus();
  } catch (err) {
    report.gpuError = String(err);
  }
  try {
    report.gpuInfo = await app.getGPUInfo('basic');
  } catch (err) {
    report.gpuInfoError = String(err);
  }

  let w = null;
  for (let i = 0; i < 120; i++) {
    const cand = [...wm.windows.values()][0];
    if (cand && cand.chromeReady) {
      w = cand;
      break;
    }
    await sleep(100);
  }
  if (!w) {
    report.error = '窗口未就绪';
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    app.exit(1);
    return;
  }
  if (process.argv.includes('--perf-max')) { try { w.win.maximize(); } catch {} await sleep(600); }
  report.windowBounds = w.win.getContentBounds();
  report.maximized = w.win.isMaximized();
  const chrome = w.win.webContents;
  await sleep(600);
  report.gpuAfterWindow = app.getGPUFeatureStatus();
  report.chromeIdle = await measure(chrome, 1500, false);

  let server = null;
  let url = perfUrlArg();
  if (!url) {
    const local = await startLocalServer();
    server = local.server;
    url = `http://127.0.0.1:${local.port}/`;
  }
  report.url = url;
  const startedAt = Date.now();
  wm.navigate(w, url);
  for (let i = 0; i < 300; i++) {
    const tab = wm.activeTab(w);
    if (tab && tab.view && !tab.view.webContents.isLoading() && tab.view.webContents.getURL() !== '') break;
    await sleep(100);
  }
  report.pageLoadMs = Date.now() - startedAt;
  const tab = wm.activeTab(w);
  if (!tab || !tab.view) {
    report.error = '网页未加载';
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    if (server) server.close();
    app.exit(1);
    return;
  }
  const web = tab.view.webContents;
  try {
    report.pageInfo = await web.executeJavaScript(
      `({ title: document.title, height: document.body.scrollHeight, images: document.images.length, dpr: devicePixelRatio, width: innerWidth, heightVp: innerHeight })`,
      true
    );
  } catch {
    /* ignore */
  }
  await sleep(1200);
  report.cpuBefore = cpuSnapshot();
  report.webIdle = await measure(web, 1500, false);
  report.webScroll = await measure(web, 2200, true);
  report.cpuDuring = cpuSnapshot();
  report.chromeDuringScroll = await measure(chrome, 1200, false);

  const bounds = tab.view.getBounds();
  report.wheelScroll = await wheelScroll(web, bounds, 2200);

  try {
    report.memory = process.getProcessMemoryInfo ? await process.getProcessMemoryInfo() : null;
  } catch {
    /* ignore */
  }

  if (server) server.close();

  const videoArg = process.argv.find((a) => a.startsWith('--perf-video='));
  if (videoArg) {
    const videoFile = videoArg.slice('--perf-video='.length);
    try {
      const buffer = fs.readFileSync(videoFile);
      const videoServer = http.createServer((req, res) => {
        if (req.url === '/video.mp4') {
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buffer.length });
          res.end(buffer);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>视频性能测试</title>
<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style></head>
<body><video id="v" src="/video.mp4" preload="auto"></video></body></html>`);
      });
      await new Promise((resolve) => videoServer.listen(0, '127.0.0.1', resolve));
      const vport = videoServer.address().port;
      wm.navigate(w, `http://127.0.0.1:${vport}/`);
      for (let i = 0; i < 150; i++) {
        const t = wm.activeTab(w);
        if (t && t.view && !t.view.webContents.isLoading() && t.view.webContents.getURL()) break;
        await sleep(100);
      }
      const vtab = wm.activeTab(w);
      if (vtab && vtab.view) {
        const vwc = vtab.view.webContents;
        await sleep(700);
        report.video = await vwc.executeJavaScript(
          `(async () => {
            const v = document.getElementById('v');
            const out = { canPlay: v.canPlayType('video/mp4; codecs="avc1.42E01E"') };
            try { await v.play(); out.playOk = true; } catch (e) { out.playOk = false; out.playError = String((e && e.message) || e); }
            const t0 = performance.now();
            let frames = 0;
            let last = t0;
            let maxGap = 0;
            const gaps = [];
            await new Promise((resolve) => {
              function tick(ts) {
                if (frames > 0) { const g = ts - last; gaps.push(g); if (g > maxGap) maxGap = g; }
                last = ts;
                frames++;
                if (ts - t0 < 6000) requestAnimationFrame(tick); else resolve();
              }
              requestAnimationFrame(tick);
            });
            const elapsed = performance.now() - t0;
            const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
            out.fps = Math.round((frames / (elapsed / 1000)) * 10) / 10;
            out.maxGap = Math.round(maxGap * 10) / 10;
            out.duration = v.duration;
            out.currentTime = v.currentTime;
            out.videoWidth = v.videoWidth;
            out.videoHeight = v.videoHeight;
            out.paused = v.paused;
            out.error = v.error ? { code: v.error.code, message: v.error.message } : null;
            out.dropped = q ? q.droppedVideoFrames : v.webkitDroppedFrameCount || 0;
            out.totalFrames = q ? q.totalVideoFrames : 0;
            out.decodedVideoBytes = v.webkitVideoDecodedByteCount || 0;
            out.decodedAudioBytes = v.webkitAudioDecodedByteCount || 0;
            out.readyState = v.readyState;
            return out;
          })()`,
          true
        );
        report.chromeDuringVideo = await measure(chrome, 1200, false);
      }
      videoServer.close();
    } catch (err) {
      report.videoError = String((err && err.stack) || err);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  app.exit(0);
}

module.exports = { run };

