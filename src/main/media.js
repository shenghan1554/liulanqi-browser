'use strict';

/**
 * 媒体能力：Widevine DRM 支持。
 *
 * 交付版使用 castlabs 的 Electron for Content Security（ECS）运行时：
 *  - ECS v16+（wvcus）通过 Chromium 的 Component Updater 在首次启动时安装
 *    Widevine CDM，目录为 <userData>/WidevineCdm/<version>/。
 *  - 在本机无法访问 Google 组件服务器时，首次启动会安装失败。此时浏览器会
 *    自动从系统已安装的 Microsoft Edge / Google Chrome 中复制同一份
 *    Widevine CDM 组件到该目录（不随应用分发任何专有二进制），再启动即生效。
 *
 * 如果使用官方 Electron 运行时（不含 Widevine 支持），则退回旧方案：
 * 通过 --widevine-cdm-path / --widevine-cdm-version 加载系统 CDM。
 */

const fs = require('fs');
const path = require('path');

let cached = null;
let bootstrapped = false;

function readDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function parseVersion(version) {
  return String(version || '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

function compareVersion(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (va[i] || 0) - (vb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function inspectCdmDir(dir, source) {
  if (!dir) return null;
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || !manifest.version) return null;
    const dll = path.join(dir, '_platform_specific', 'win_x64', 'widevinecdm.dll');
    if (!fs.existsSync(dll)) return null;
    return {
      dir,
      dll,
      version: String(manifest.version),
      source,
      hostVersions: manifest['x-cdm-host-versions'] || '',
      codecs: manifest['x-cdm-codecs'] || '',
      hasSignature: fs.existsSync(`${dll}.sig`),
    };
  } catch {
    return null;
  }
}

function findWidevineCdm() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const found = [];
  const seen = new Set();

  const push = (cdm, source) => {
    const info = inspectCdmDir(cdm, source);
    if (!info) return;
    const key = info.dll.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(info);
  };

  if (localAppData) {
    for (const [root, source] of [
      [path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'WidevineCdm'), 'Edge 组件'],
      [path.join(localAppData, 'Google', 'Chrome', 'User Data', 'WidevineCdm'), 'Chrome 组件'],
      [path.join(localAppData, 'Chromium', 'User Data', 'WidevineCdm'), 'Chromium 组件'],
    ]) {
      for (const versionDir of readDirs(root)) push(versionDir, source);
    }
  }

  for (const [appRoot, source] of [
    [path.join(programFilesX86, 'Microsoft', 'Edge', 'Application'), 'Edge'],
    [path.join(programFiles, 'Microsoft', 'Edge', 'Application'), 'Edge'],
    [path.join(programFiles, 'Google', 'Chrome', 'Application'), 'Chrome'],
    [path.join(programFilesX86, 'Google', 'Chrome', 'Application'), 'Chrome'],
    [path.join(localAppData, 'Google', 'Chrome', 'Application'), 'Chrome'],
  ]) {
    for (const versionDir of readDirs(appRoot)) {
      push(path.join(versionDir, 'WidevineCdm'), source);
    }
  }

  found.sort((a, b) => compareVersion(b.version, a.version));
  return found[0] || null;
}

// castlabs ECS 运行时的 exe 旁带有 VMP 签名文件（electron.exe.sig / 浏览器.exe.sig）
function isEcsRuntime() {
  try {
    return fs.existsSync(`${process.execPath}.sig`);
  } catch {
    return false;
  }
}

function installedComponent(userData) {
  const root = path.join(userData, 'WidevineCdm');
  return (
    readDirs(root)
      .map((dir) => inspectCdmDir(dir, '内置组件'))
      .filter(Boolean)
      .sort((a, b) => compareVersion(b.version, a.version))[0] || null
  );
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * ECS 首次启动时，如果 Widevine 组件目录为空，就从系统 Edge/Chrome 复制一份
 * 同版本的 CDM 组件进去（组件格式完全相同）。必须在 app ready 前调用。
 */
function bootstrapEcsCdm(app) {
  if (bootstrapped) return installedComponent(app.getPath('userData'));
  bootstrapped = true;
  const userData = app.getPath('userData');
  const installed = installedComponent(userData);
  if (installed) return installed;

  const system = findWidevineCdm();
  if (!system) return null;

  const target = path.join(userData, 'WidevineCdm', system.version);
  try {
    copyTree(system.dir, target);
    const info = inspectCdmDir(target, '内置组件');
    if (info) {
      info.bootstrap = `已从 ${system.source} 复制 Widevine CDM ${system.version}`;
      return info;
    }
  } catch {
    /* 复制失败时等待 ECS 组件更新或保持不可用 */
  }
  return null;
}

/**
 * 在 app ready 之前调用：准备 Widevine CDM。返回可序列化的状态。
 */
function setupWidevine(app) {
  if (cached) return cached;

  if (isEcsRuntime()) {
    const installed = bootstrapEcsCdm(app);
    cached = installed
      ? {
          available: true,
          version: installed.version,
          source: installed.source,
          hostVersions: installed.hostVersions,
          codecs: installed.codecs,
          signed: installed.hasSignature,
          bootstrap: installed.bootstrap || '',
        }
      : {
          available: false,
          version: null,
          source: null,
          error: 'Widevine CDM 尚未安装（需要联网组件更新，或安装 Microsoft Edge / Google Chrome 后重启浏览器）',
        };
    return cached;
  }

  // 官方 Electron：尝试加载系统 Edge/Chrome 的 CDM
  const override = process.env.BROWSER_WIDEVINE_DIR || '';
  let picked = override ? inspectCdmDir(override, '自定义目录') : null;
  if (!picked) picked = findWidevineCdm();

  if (picked) {
    try {
      app.commandLine.appendSwitch('widevine-cdm-path', picked.dll);
      app.commandLine.appendSwitch('widevine-cdm-version', picked.version);
      cached = {
        available: true,
        version: picked.version,
        source: picked.source,
        hostVersions: picked.hostVersions,
        codecs: picked.codecs,
        signed: picked.hasSignature,
      };
    } catch (err) {
      cached = { available: false, version: null, source: null, error: String(err && err.message) };
    }
  } else {
    cached = {
      available: false,
      version: null,
      source: null,
      error: '当前运行时不含 Widevine 支持，且本机未找到 Widevine CDM',
    };
  }
  return cached;
}

function widevineStatus() {
  return cached || { available: false, version: null, source: null, error: '尚未初始化' };
}

module.exports = { setupWidevine, widevineStatus, findWidevineCdm, isEcsRuntime };