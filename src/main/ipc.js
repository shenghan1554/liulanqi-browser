'use strict';

const { ipcMain } = require('electron');

function registerIpc(wm) {
  // chrome UI 完成加载后握手，此时才创建第一个标签页并显示窗口
  ipcMain.handle('chrome:ready', (event) => {
    const w = wm.fromSender(event.sender);
    if (!w) return null;
    return wm.onChromeReady(w);
  });

  // 统一 API 通道：所有 chrome UI 的操作都经由这里分发
  ipcMain.handle('api', (event, method, payload) => {
    const w = wm.fromSender(event.sender);
    if (!w) throw new Error('窗口不存在');
    return wm.invoke(w, String(method || ''), payload || {});
  });
}

module.exports = { registerIpc };