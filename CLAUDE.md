# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

「摸鱼工具」——桌面右下角一个伪装成广告弹窗的 Electron 应用（Windows 10+）：拖入 URL 打开内置多标签浏览器（WebContentsView），拖入 .txt/.epub 进入带目录/进度记忆的小说阅读器，全局热键一键隐藏，鼠标悬停揭示内容、移开伪装（可开关）。**核心诉求：谁看都是一坨没人理会的广告。**

权威文档（改动前先读）：规格 `docs/superpowers/specs/2026-08-21-moyu-tool-design.md`（含裁定记录 A-AA 与修订措辞），实施计划 `docs/superpowers/plans/2026-08-21-moyu-tool.md`。规格与代码冲突时以规格为准；所有已裁定决策（Ruling A-AA）在规格/计划中有出处，不要推翻未经确认。

## 常用命令

- `npm start` — 启动应用（无构建步骤；开发迭代就是改完直接跑）
- `npm test` — 全部单元测试（node --test，glob 写法 `node --test "test/**/*.test.js"`——Node 26 下目录参数不递归，勿改回 `node --test test/`）
- 单个测试文件：`node --test test/novels.test.js`
- 测试只覆盖纯逻辑（store/window bounds/hotkeys normalize/novels 编码与章节/reader 进度纯函数）；**UI 与 Electron 集成靠临时 harness + CDP 探针验证后删除**（模式见下）
- 提交需带身份：`git -c user.name=Zyf -c user.email=zyf@local commit -m "..."`（仓库未配置全局身份）

## 架构（读多个文件才能理解的全局图）

**主进程（main/）** 与 **壳层渲染进程（renderer/，单页无框架）** 经 IPC 通信；远程网页在独立的 WebContentsView 中渲染（每标签一个，非 webview 标签）。

### 模式切换（最重要的全局概念）

两种模式：`ad`（伪装广告小窗，默认 340×280）与 `content`（内容，默认 1150×750）。**唯一切换入口是 main.js 的 `applyMode(m)`**：更新 mode 状态 + `tabsApi.setMode`（ad→摘除全部视图 / content→挂载当前标签）+ `applyBoundsForMode`（窗口按模式记忆尺寸 setBounds）。所有入口（IPC mode:set、托盘、热键、悬停揭示、壳层双击/按钮）都汇到这里。主进程驱动的切换（托盘/热键/悬停）必须额外 `win.webContents.send('mode:set', m)` 让壳层同步 DOM；壳层发起的切换（shell.js setMode）则先自己改 DOM 再发 IPC。

窗口尺寸按模式双槽记忆：`settings.adBounds` / `settings.contentBounds`（window.js `computeModeBounds`）；最大化期间不持久化。

### 远程内容安全纪律（不可破坏）

- 每个 WebContentsView：`sandbox: true, nodeIntegration: false, contextIsolation: true`、**无 preload**（远程页零 IPC 面）
- `window.open` → deny + 主进程新建标签；`will-navigate`/`tabs:create` 仅放行 http/https；每标签独立 `persist:tab-<id>` 分区
- 标签 UA 剥离 `Electron/x.y` 标记（惰性求值，`app.userAgent` 在 ready 前是 undefined——模块顶层求值会崩）
- 小说文件只主进程读（`path.isAbsolute` 校验），副本存 `userData/novels/<novelId>.txt`（UTF-8）

### 拖拽区陷阱（本项目已踩两次，务必记住）

Electron 的 `-webkit-app-region: drag` 区域会**吞掉其矩形内所有鼠标事件**，无论上面叠着什么元素。本项目拖拽区只有两处：`.ad-top`（广告顶栏）与 `#tabbar`（内容模式顶栏），都是 34px 顶带。**任何覆盖在 34px 顶带上的交互元素必须加 `-webkit-app-region: no-drag` 挖孔**——确认条按钮、阅读器工具栏按钮/目录浮层都是这样修好的（不然按钮点了没反应）。CDP 合成点击会绕过 OS 命中测试，验证不了这类问题，必须真实鼠标。

### 悬停揭示（hover）

main.js 里 200ms 轮询 `screen.getCursorScreenPoint()` 对窗口 bounds 判定，而非 mouse-enter/mouse-leave 事件——**实测 Electron 43 + Windows 无边框窗口这两个事件不触发**。启动 2s 宽限期（防光标恰好停在弹窗上时立刻揭开伪装）；设置开关 `hoverReveal`。

### 页面缩放适配（zoom-to-fit）

tabs.js `fitToWindow`：仅当 zoom=1 时测量页面真实内容宽度并记忆到 `tab.fitNeed`，溢出则 `setZoomFactor(cw/sw)`（下限 0.25）；缩放期间凭记忆判断恢复（物理宽度 ≥ fitNeed×1.03 才回 1:1）。**禁止在缩放状态下测量**——页面会在更大 CSS 视口重新排版填满，测量值随 zoom 漂移导致振荡。加载/导航后重置 zoom=1 再测。

### 阅读器

- 章节文本按 `/\n+/` 拆 `<p>` 渲染（textContent，无 XSS 面），`text-indent: 2em` 中文排版
- 进度：滚动防抖 2s 写盘；`saveNow` 有 hidden 守卫（`#reader-view` 或 `#content-view` hidden 时跳过——display:none 下 scrollHeight=0 会算出 0 覆盖好进度）；切换标签/隐藏/关闭前必须 flush（switchActiveTab 顶部、showEmptyState、主进程 hide/close 推送 `app:flush-progress`）
- 续读定位用**记录的 scrollRatio**（clamp 0~0.95），不是固定值；伪装模式下恢复需临时显形取真实布局（display:none 时 scrollHeight=0）
- 工具栏只三个按钮：目录/设置/返回伪装；字号/暗色/字体在独立阅读设置面板（即点即改，`setReaderPrefs` 合并进 settings.reader）
- 编码探测：UTF-8 严格解码失败自动回落 GBK（裁定 R，不做手动选择）
- epub 走 `importEpub` 分支（readEpub → 文本块拼 UTF-8 存储文件，startLine 按块累加行号，分隔符每块 +1 行）

### 广告伪装

四套样式（news 默认/game/prize/sys）文案全在 `renderer/ad/ad-themes.json`——**用户改文案不碰代码**，保持该契约。广告文案 HTML 结构含固定锚点（.ad-close[data-action=close] 假关闭、.ad-corner[data-action=menu] 隐蔽入口、.ad-top 拖拽区）。假关闭按钮只隐藏到托盘，绝不关闭。

### 会话与存储

- `userData/settings.json`（原子写 tmp+rename；损坏→备份 .bak 后回默认）：窗口双槽尺寸、adStyle、热键、reader 偏好、lastTabs/lastNovels（lastTabs 内容比较去重防抖，盘上内容做种子）
- `userData/progress.json`：novelId → {chapterIndex, scrollRatio, updatedAt}
- `userData/novels/`：小说副本
- 恢复顺序：lastTabs 数组序，末标签激活；novel 标签从 lastNovels 重建 novelsMeta（ipc.js 模块级 Map，Ruling C 登记点）

### 热键

可配置（设置面板改键）。`normalizeAccelerator` 白名单校验（VALID_KEYS/MODIFIERS）；`setCallbacks({toggleWindow, toggleMode})` 回调表是 registerHotkeys 与 applyHotkeyChange 共用（Ruling B）；`Ctrl+Shift+Z` 隐藏/恢复、`Ctrl+Shift+X` 切模式。

### 其他易踩点

- 壳层脚本全为经典 script 共享全局：**顶层 `const $` 只在 shell.js 声明一次**（reader.js 重复声明曾致整个脚本 SyntaxError 静默失效）；跨脚本函数（openNovel/saveNow/applyReaderPrefs/openSettings/renderAd）按加载顺序保证可用，`shell:ready` 初始化延迟到 window load（IPC 响应可能早于后续脚本求值）
- 确认条在 34px 顶带，天然被拖拽区覆盖——新加的顶带覆盖物都要 no-drag
- 标签 `failed` 标志（错误页机制）：chrome-error 提交会二次 did-finish-load（getURL 返原 URL），只有 did-navigate（实测 chrome-error 不触发）与 reload 前清除
- 测试探针惯例：临时 `scripts/probe-*.js` 用 `npx electron scripts/probe-x.js` 跑真实 renderer/模块，验证后删除、不提交；真实 OS 交互（拖放、热键、托盘、悬停、拖拽区）必须人工确认
- 提交历史按任务粒度；SDD 过程记录在 `.superpowers/sdd/`（git 忽略）
