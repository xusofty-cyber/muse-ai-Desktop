# 项目上下文与长期事实 (PROJECT_CONTEXT.md)

> **定位说明**：本文件记录 `muse-windows` 的核心架构事实与长期工程约束，作为 AI Agent 会话启动与技术决策的单一事实源（Single Source of Truth）。仅在系统架构、核心技术栈、持久层设计或全局红线发生重大变更时维护。会话级临时状态与进度断点请记录于 `SESSION_STATE.md`。

---

## 一、项目定位与核心业务

- **系统名称**：`muse-windows` (产品名称 Muse)
- **业务领域**：Windows 桌面原生封装客户端，为 Muse (muse.ai) 和 Meta AI (meta.ai) 提供原生桌面窗口运行环境，支持快捷对话、独立多会话 Profiles、托盘驻留与系统级能力集成。
- **核心业务矩阵**：
  1. **主窗口与双站点切换 (Main Window & Site Toggle)**：原生窗口封装 muse.ai 与 meta.ai，支持快捷键 (Ctrl+Shift+M) 或托盘菜单在两站点间快速切换并复用窗口，记忆窗口尺寸和位置，启用 GPU 光栅化以保证平滑滚动。
  2. **快速对话浮窗 (Quick Chat Popup)**：全局快捷键 (Ctrl+Shift+Space) 在任意界面唤起轻量快捷聊天窗口，失去焦点时自动隐藏。
  3. **多 Profile 与账号会话隔离 (Profiles & Account Switcher)**：基于 Electron Session Partition 实现多用户 Profile 独立登录与隔离；在 Meta AI 模式下提供多账号快速切换 (Ctrl+Shift+N) 与“添加 Meta AI 账号”能力。
  4. **系统级原生集成与控制 (System & Audio Controls)**：系统托盘驻留与菜单、开机自启、麦克风与扬声器全局静音切换、快捷键自定义配置页面 (`hotkeys.html`)、剪贴板超长文本导出为文件 (`Documents/Muse clips/`) 以及原生下载管理。
  5. **自动化控制与安全放行 (Automation / Auto-Allow Controls)**：显式 Opt-in 的自动化主开关、屏幕悬浮小部件、细粒度连接器/动作分类放行规则。
  6. **自动更新与跨端分发 (Auto-Update & Distribution)**：集成 GitHub Releases 自动检测与静默下载更新；支持构建 Windows NSIS 安装包 (`dist/Muse Setup 1.1.0.exe`) 及免安装便携版 (`dist/Muse-Portable-1.1.0.exe`)。

---

## 二、代码仓库与技术栈

### 1. 基础环境与分支
- **代码仓库**：`git@github.com:xusofty-cyber/muse-windows.git`（上游发布配置：`whxjwksjs/muse-windows`）
- **主分支 / 开发分支**：`main`
- **运行/部署环境**：Windows 桌面运行环境 (Node.js LTS 本地开发；生产分发为 Windows x64 NSIS 安装包及 Portable 便携版)

### 2. 技术栈选型

| 层级 / 领域 | 技术栈与版本 | 说明与关键库 |
|---|---|---|
| **核心语言 / 运行时** | JavaScript (ES6+ / Node.js 20 LTS) | 主业务逻辑开发语言与桌面端运行时 |
| **基础框架与构建** | Electron ^44.6.0 / electron-builder ^26.15.3 | 桌面原生窗口、系统托盘、快捷键及 NSIS/Portable 打包工具 |
| **持久化与缓存** | Electron Session Partition / 本地 JSON | 隔离 Profiles/会话 Cookie，持久化热键、自动化配置与窗口状态 |
| **接口与中间件** | Electron IPC (`ipcMain` / `ipcRenderer`) / Preload Scripts | 主进程与设置渲染页安全通信，网页注入脚本抓取与导出交互 |

---

## 三、核心架构与分层设计

- **架构模式**：Electron 主进程 (Main Process) + 预加载桥接 (Preload Scripts) + 多渲染上下文 (WebContents & Settings UI) 的桌面混合分层架构
- **关键模块与目录职责**：
  - `main.js`：Electron 主进程入口，负责应用生命周期、多窗口管理 (`mainWindow`, `quickWindow`, `settingsWindow`)、系统托盘、全局快捷键注册与状态持久化。
  - `preload-settings.js`：快捷键与设置页面的预加载桥接脚本，暴露安全的 IPC 接口。
  - `preload-chat-export.js`：网页注入预加载脚本，实现聊天内容抓取与导出等集成交互。
  - `hotkeys.html`：快捷键自定义配置页面（渲染进程 UI）。
  - `assets/`：应用程序图标与静态素材（`icon.ico` 等）。
  - `docs/`：技术架构、产品规约与参考文档。
  - `tasks/`：任务规划 (`todo.md`) 与研发经验沉淀 (`lessons.md`)。

---

## 四、关键技术约束与全局开发红线

1. **极简实现与不随意扩充依赖（Ponytail 懒人阶梯）**：
   - 改动前遵循决策阶梯：优先使用项目既有工具与标准库，满足明确要求的最小清晰实现，严禁非必要的投机性抽象或盲目引入新依赖。
2. **统一异常流与日志脱敏**：
   - 业务错误统一使用标准异常结构，禁止静默吞噬错误；
   - 严禁在日志、输出或代码中明文记录 API Key、Token、密码、私钥或敏感连接串。
3. **Git 授权与分支安全铁律**：
   - 受保护分支（`main` / `develop` / `master`）禁止直接提交，必须拉取临时特性分支；
   - 严禁盲目 `git add .` / `git add -A`，必须只暂存明确路径；严禁强制推送（`git push --force`）。

---

## 五、关键架构与技术决策记录 (ADR / Decision Log)

- **2026-10-15**：[初始化项目记忆规范与技术栈上下文]
  - **背景**：根据项目 README.md 与代码库建立统一的跨会话项目上下文记忆标准。
  - **决策**：在 `PROJECT_CONTEXT.md` 固化 `muse-windows` 的 Electron 架构事实、双站点封装机制、快捷键与持久化设计。
  - **影响**：所有 Agent 在会话启动阶段优先加载本文件，确保业务理解与技术决策准确一致。
- **2026-10-15**：[落地零重载多标签常驻架构与自适应代理防黑屏机制]
  - **背景**：原账号切换会销毁窗口或重新 `loadURL` 导致白屏打断体验；另外 Chromium 默认后量子握手与代理配置异常易触发握手中断 (`-100 ERR_CONNECTION_CLOSED` / `-130 ERR_PROXY_CONNECTION_FAILED`) 陷入黑屏。
  - **决策**：
    1. 采用 `profileWindows = new Map()` 维护常驻窗口实例，账号切换通过可见性瞬切与 Bounds 继承，实现 `< 10ms` 零重载、输入状态 100% 保留；
    2. 默认采用 `mode: 'system'` 自适应 Windows 系统代理与 TUN 虚拟网卡（开箱即用免配置），设置界面支持手动覆盖；禁用 `PostQuantumKeyAgreement` 彻底打通 TLS 握手，搭配 `offline.html` 离线诊断页保障黑屏自愈。
  - **影响**：多账号切换达到原生多标签体验，新环境部署免配置直接联网，彻底根治握手超时与黑屏。
