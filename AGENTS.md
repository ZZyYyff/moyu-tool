# AGENTS.md

本文件为 ZCode 代理提供工作区指引。完整开发细节见 `CLAUDE.md`（内容最全），架构出处见规格文档。

## 项目概述

「摸鱼工具」（moyu-tool）——Windows 10+ 桌面右下角伪装成广告弹窗的 Electron 应用（Electron 43，原生 JS 无框架，node:test 测试）。拖入 URL → 内置多标签浏览器（WebContentsView）；拖入 .txt/.epub → 带目录/进度记忆的小说阅读器。全局热键一键隐藏，鼠标悬停揭示内容（可开关）。核心诉求：谁看都是一坨没人理会的广告。

## 目录

- `main/` — 主进程：main.js（入口/模式切换）、ipc.js、tabs.js（多标签 + zoom-to-fit）、window.js、hotkeys.js、novels.js、store.js、tray.js
- `renderer/` — 壳层渲染进程（单页无框架，经典 script 共享全局）：shell.js、settings.js、ad/（伪装广告，文案在 ad-themes.json）、reader/
- `preload/preload.js` — 仅壳层使用；远程页面无 preload
- `test/` — node:test 单元测试（只覆盖纯逻辑）
- `scripts/` — gen-icon.js；临时探针 probe-*.js（验证后删除）
- `docs/superpowers/` — 规格 + 实施计划（已 gitignore，仅本地保留）
- `assets/` — icon.ico、tray.png

## 权威文档（改动前先读）

- `CLAUDE.md` — 完整开发指引（架构细节与全部易踩点）
- 规格 `docs/superpowers/specs/2026-08-21-moyu-tool-design.md`（含裁定记录 A-AA；规格与代码冲突以规格为准，不要推翻已裁定决策）
- 实施计划 `docs/superpowers/plans/2026-08-21-moyu-tool.md`

## 常用命令

- `npm start` — 启动应用（无构建步骤，改完直接跑）
- `npm test` — 全部单元测试。glob 写死 `node --test "test/**/*.test.js"`（Node 26 下目录参数不递归，勿改回 `node --test test/`）
- 单个测试文件：`node --test test/novels.test.js`
- `npm run dist` — electron-builder Windows 便携版 exe（产物名 ASCII；中文文件名上传 GitHub Releases 会丢前缀）
- 提交需带身份：`git -c user.name=Zyf -c user.email=zyf@local commit -m "..."`（仓库未配置全局身份）

## 架构要点

- **模式切换（最重要的全局概念）**：`ad`（伪装 340×280）/ `content`（内容 1150×750），唯一切换入口是 main.js 的 `applyMode(m)`（mode 状态 + `tabsApi.setMode` + `applyBoundsForMode`）。主进程驱动的切换（托盘/热键/悬停）必须补发 `win.webContents.send('mode:set', m)` 让壳层同步 DOM。窗口尺寸按模式双槽记忆（`settings.adBounds`/`contentBounds`），最大化期间不持久化。
- **远程内容安全（不可破坏）**：每个 WebContentsView `sandbox:true, nodeIntegration:false, contextIsolation:true` 且无 preload（远程页零 IPC 面）；`window.open` → deny + 主进程新建标签；仅放行 http/https；每标签独立 `persist:tab-<id>` 分区；UA 剥离 Electron 标记（惰性求值——`app.userAgent` 在 ready 前是 undefined，模块顶层求值会崩）。
- **壳层脚本共享全局**：顶层 `const $` 只在 shell.js 声明一次（reader.js 重复声明曾致整个脚本 SyntaxError 静默失效）；`shell:ready` 初始化延迟到 window load（IPC 响应可能早于后续脚本求值）。
- **热键**：`normalizeAccelerator` 白名单校验；`setCallbacks({toggleWindow, toggleMode})` 回调表为 registerHotkeys 与 applyHotkeyChange 共用（Ruling B）。

## 已踩过的坑（勿重复）

- **拖拽区吞事件（踩过两次）**：`-webkit-app-region: drag` 矩形内所有鼠标事件被吞，无论上面叠什么。拖拽区仅 `.ad-top` 与 `#tabbar`（34px 顶带）；任何叠在顶带上的交互元素必须加 `-webkit-app-region: no-drag` 挖孔。CDP 合成点击绕过 OS 命中测试，验证不了这类问题，必须真实鼠标。
- **悬停揭示用轮询**：Electron 43 + Windows 无边框窗口 mouse-enter/leave 事件不触发，main.js 用 200ms 轮询 `screen.getCursorScreenPoint()` 判定；启动 2s 宽限期。
- **zoom-to-fit 禁止缩放中测量**：仅 zoom=1 时测页面真实内容宽度并记忆到 `tab.fitNeed`，溢出则 `setZoomFactor`（下限 0.25）；缩放状态下测量值随 zoom 漂移会振荡。加载/导航后重置 zoom=1 再测。
- **阅读器进度**：滚动防抖 2s 写盘；`saveNow` 有 hidden 守卫（display:none 下 scrollHeight=0 会算出 0 覆盖好进度）；切换标签/隐藏/关闭前必须 flush；续读定位用记录的 scrollRatio（clamp 0~0.95），不是固定值。
- **标签 failed 标志**：chrome-error 页会二次触发 did-finish-load（getURL 返回原 URL），只有 did-navigate（chrome-error 不触发）与 reload 前清除。
- **广告文案契约**：四套样式（news 默认/game/prize/sys）文案全在 `renderer/ad/ad-themes.json`——用户改文案不碰代码。假关闭按钮只隐藏到托盘，绝不关闭。
- **小说编码**：UTF-8 严格解码失败自动回落 GBK（裁定 R，不做手动选择）；文件只主进程读（`path.isAbsolute` 校验），副本存 `userData/novels/`。
- **设置存储**：`userData/settings.json` 原子写（tmp+rename，损坏 → 备份 .bak 后回默认）；进度在 `userData/progress.json`。

## 测试与验证惯例

- 测试只覆盖纯逻辑；UI 与 Electron 集成靠临时 harness `scripts/probe-*.js`（`npx electron scripts/probe-x.js`）验证后删除、不提交
- 真实 OS 交互（拖放、热键、托盘、悬停、拖拽区）必须人工确认，自动化验证不可信
- 提交历史按任务粒度；SDD 过程记录在 `.superpowers/sdd/`（git 忽略）
