# 构建说明

本仓库**只包含应用源码**，不包含 Electron/Chromium 运行时（约 361 MB，且各平台不同）。
要跑起来或打包，需要自己准备一个 Electron 运行时。

## 1. 准备 Electron 运行时

### 情况 A：只关心功能，不需要 DRM 视频

用 npm 安装官方 Electron 即可：

```powershell
npm install --save-dev electron@43
npx electron .
```

绝大多数功能（标签页、书签、历史、无痕、壁纸、下载）都正常，只有 Widevine 加密视频
（Netflix 等）不可用，因为官方 Electron 不自带 Widevine CDM。

### 情况 B：需要 Widevine DRM 与 H.264/AAC 完整能力

用 castlabs 的 **Electron for Content Security (ECS)** 运行时（本项目交付版使用
`43.8.6+wvcus`，对应 Chromium 150.0.7871.250）：

1. 从 <https://github.com/castlabs/electron-releases/releases> 下载对应版本的
   Windows x64 免安装压缩包（文件名形如 `electron-v43.8.6+wvcus-win32-x64.zip`）；
2. 解压到本仓库根目录，并**重命名文件夹为 `electron43-wv`**：

```
liulanqi-browser/
├─ electron43-wv/         ← 解压出来的运行时（已被 .gitignore 忽略）
│  ├─ electron.exe
│  ├─ electron.exe.sig    ← castlabs VMP 签名，勿删
│  └─ ...
├─ src/
└─ package.json
```

3. 启动：

```powershell
.\scripts\dev-run.ps1
# 等价于：
.\electron43-wv\electron.exe . --no-sandbox --disable-gpu --disable-breakpad
```

> `--no-sandbox` 只在沙箱受限的环境（远程桌面、部分企业策略）需要。普通 Windows
> 上可以去掉以获得完整沙箱隔离。

### 关于 Widevine CDM 与 VMP 签名

- Widevine CDM 是 Google 的专有组件，**本项目不随包分发**。运行时会尝试从本机已安装的
  Microsoft Edge / Google Chrome 组件目录复制一份到数据目录（`data/WidevineCdm/<version>/`）。
- 若系统里既没有 Edge/Chrome，也无法访问 Google 组件更新服务器，则 DRM 不可用，
  浏览器其它功能不受影响。
- 交付版带 castlabs 的**开发用** VMP 签名（`electron.exe.sig` → `浏览器.exe.sig`）。
  Netflix、Amazon 等要求生产 VMP 签名的服务不保证可播放；需要生产签名时通过
  castlabs EVS 服务重新签名。
- 请勿以任何方式绕过 DRM 或分发 CDM 二进制。这属于违反 Widevine 许可条款的行为，
  与本项目无关。

## 2. 跑测试

```powershell
# 数据层单元测试（18 项，纯 Node，不需要 Electron）
npm test

# 端到端验收（真实点击 UI，输出报告与截图）
.\electron43-wv\electron.exe . --e2e --no-sandbox --disable-gpu --disable-breakpad
# 报告：logs/e2e-report.json    截图：screenshots/e2e-*.png
```

CI 只跑单元测试（见 `.github/workflows/test.yml`），因为端到端需要一个带 GUI 的 Windows 环境。

## 3. 打便携版

```powershell
.\scripts\build-portable.ps1
# 默认输出到仓库同级目录的 浏览器/ 文件夹
# 也可指定：
.\scripts\build-portable.ps1 -ElectronDir D:\ecs\electron43-wv -OutDir D:\dist\浏览器
```

脚本会做这几件事：

- 复制 `electron43-wv/` 全部文件到输出目录
- 把 `electron.exe` 改名为 `浏览器.exe`，并同步改名 `.sig` 签名文件
- 用 `installer/app.ico` 替换程序图标与版本信息（可选，需要 `rcedit`）
- 把 `package.json`、`src/`、`README.md` 放进 `resources/app/`
- 写入 `portable.txt`，让数据保存在同目录 `data/`
- 只保留 `zh-CN` / `en-US` / `en-GB` 语言包以减小体积

`rcedit` 是可选的：想替换图标就把 `rcedit-x64.exe` 放到 `tools/rcedit/`（相对仓库上级目录），
或跳过——跳过只影响图标与版本信息，不影响功能。

## 4. 打安装包

需要 **NSIS 3.11+**（Unicode 版）：

```powershell
# 先有便携版输出目录，再传给 build-installer.ps1
.\scripts\build-portable.ps1 -OutDir D:\dist\浏览器
.\scripts\build-installer.ps1 `
    -SourceDir D:\dist\浏览器 `
    -OutDir    D:\dist `
    -NsisDir   "C:\Program Files (x86)\NSIS"
```

输出 `D:\dist\浏览器-安装程序-<version>.exe`。

`build-installer.ps1` 会把 `STAGE_DIR`、`OUT_FILE`、`ICON_FILE` 和版本号作为宏传给
`installer/browser.nsi`，因此改版本号只需要改 `package.json`。

## 5. 验证安装/卸载

`scripts/verify-install.ps1` 会静默安装、检查快捷方式与注册表、启动应用、卸载并验证数据清理：

```powershell
.\scripts\verify-install.ps1 -Installer D:\dist\浏览器-安装程序-1.0.5.exe
```

注意它会**卸载/重装**应用并可能删除测试用的浏览数据，请只在测试机上跑。

## 常见问题

**双击后没窗口？**
改用 `兼容模式启动.cmd`（或加 `--no-sandbox` 参数）。多见于远程桌面、Hyper-V、
或被组策略限制的桌面环境。

**提示「软件渲染」？**
显卡驱动过旧或被远程桌面限制。更新显卡驱动；远程桌面下无法使用 GPU 加速属正常现象。

**视频只有声音没画面 / 黑屏？**
H.264 视频需要支持解码的运行时。确认你用的是 ECS 运行时而不是精简版 Electron。

**首次启动很慢？**
首次启动会准备 Widevine CDM（从本机 Edge/Chrome 复制组件），略慢属正常。