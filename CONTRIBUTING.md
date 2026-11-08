# 贡献指南

感谢你愿意参与「浏览器」的开发。这是一个基于 Electron/Chromium 的浏览器外壳项目，
代码量不大，结构清晰，欢迎提交 Issue 与 Pull Request。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 我能贡献什么

- **Bug 报告**：按 Issue 模板填写，附上复现步骤、期望行为、实际行为、系统版本与日志。
- **功能建议**：说明使用场景与收益，而不只是「加一个 X 功能」。
- **代码**：修 Bug、补测试、改文档、修错别字都算。
- **兼容性反馈**：不同 Windows 版本、显卡、DPI 缩放比例下的表现。

## 开发环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10 / 11 | 当前仅支持 Windows |
| Node.js | ≥ 22 | 跑单元测试与脚本 |
| Electron 运行时 | 43.x | 见 [docs/BUILD.md](docs/BUILD.md)；需要 Widevine 时用 castlabs ECS 构建 |
| NSIS（可选） | 3.11 | 只有打安装包时才需要 |

快速开始：

```powershell
git clone https://github.com/shenghan1554/liulanqi-browser.git
cd liulanqi-browser

# 1) 跑单元测试（纯 Node，不需要 Electron）
npm test

# 2) 启动开发版（把 Electron 运行时放到 electron43-wv/，详见 docs/BUILD.md）
.\scripts\dev-run.ps1
```

## 目录约定

```
src/main/       主进程：窗口/标签页、存储、媒体与 DRM、IPC、E2E
src/preload/    contextBridge，向渲染层暴露 window.browser
src/renderer/   浏览器外壳 UI（HTML/CSS/JS）
test/           数据层单元测试
scripts/        开发、打包、验证脚本
installer/      NSIS 安装脚本与图标
screenshots/    E2E 截图与报告
docs/           构建说明
```

改代码时请遵守既有约定：

1. **主进程与渲染进程严格分离**：渲染层不直接拿 Node API，一律走 `preload` 的
   `contextBridge`；IPC 通道集中在 `src/main/ipc.js`。
2. **数据层保持纯 Node**：`src/main/store.js` 不允许 `require('electron')`，否则单元测试失效。
3. **所有落盘写入必须原子**：先写临时文件再 rename，沿用 `store.js` 的做法。
4. **新增用户可见文案走中文**，与现有界面保持一致；代码注释可用中英文。
5. **新功能补测试**：数据相关改 `test/store.test.js`；UI 相关扩展 `src/main/e2e.js` 的验收项。

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(renderer): 书签栏支持拖拽排序
fix(main): 修复历史记录并发写入丢失
docs: 补充 Widevine 授权说明
perf(renderer): 标签栏就地更新，避免整栏重建
test: 补充历史上限的单元测试
chore: 升级 NSIS 到 3.11
```

提交前请自检：

- [ ] `npm test` 全部通过
- [ ] 没有把 `electron43-wv/`、`data/`、`logs/`、`*.exe` 等产物提交进去
- [ ] 没有提交任何个人路径、令牌或密钥
- [ ] 改动若影响界面，附上一张截图

## Pull Request

1. 从 `main` 切出分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 一个 PR 只做一件事，描述里写清动机、做法与验证方式。
3. 若涉及视觉变化，贴前后截图对比。
4. 维护者可能会请求修改，请保持对话礼貌。

## 法律与商标

- 本项目以 MIT 协议发布，贡献即表示你同意以同一协议授权你的贡献。
- 请勿在仓库中分发 Chromium/Electron 运行时、Widevine CDM 或任何 DRM 绕过代码。
- 浏览器名称「浏览器」与图标是本项目的标识，请勿用于暗示官方背书的衍生发行版。