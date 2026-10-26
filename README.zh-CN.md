# Muse Desktop: 原生跨平台 AI 桌面客户端 (Windows, macOS, Linux)

<div align="center">

**极速、原生、轻量且深度隔离的个人 AI 桌面工作助手（Muse Desktop / muse-desktop）**

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/xusofty-cyber/muse-ai-Desktop?style=flat-square&color=blue)](https://github.com/xusofty-cyber/muse-ai-Desktop/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)](#下载与安装)
[![Technology](https://img.shields.io/badge/Framework-Electron-blueviolet?style=flat-square)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

---

## 🌟 项目概览

**Muse Desktop**（开源代号 `muse-desktop` / **Muse AI Desktop**）是一款面向 **Windows、Linux 和 macOS** 的桌面原生客户端，将 Muse ([muse.ai](https://muse.ai)) 与 Meta AI ([meta.ai](https://www.meta.ai)) 深度封装于轻量原生窗口中。客户端深度集成操作系统底层特性：

- 🔒 **主密码安全锁屏**：基于加盐慢哈希密码学加密、防暴力破解锁定机制与空闲无操作自动锁屏，锁定时彻底遮蔽所有会话窗口；
- 👥 **多账号并发与深度隔离（支持 12+ 账号）**：基于 Chromium 原生 partition 的多账号独立存储与登录态隔离，防挤压纤细滚动条、移开自动收起与一键固定（📌）；
- 🚀 **自适应系统代理与 TUN 模式**：原生适配 Windows/Linux/macOS 系统代理与 Clash Verge、Sing-box、Surge、V2Ray 等虚拟网卡；
- 🎨 **左下角集成控制中心**：零遮挡极简对话视野，支持深色夜间、明亮日间与系统跟随三档主题即时热切换；
- ⌨️ **全局快捷键呼出与一键聊天导出**：快捷会话弹窗、全局锁屏、站点切换，并支持将对话一键导出为 Markdown、HTML 与 JSON。

---

## ✨ 核心特性

### 🔒 主密码安全锁屏与隐私守护
- **密码学级高强度安全**：采用 Node.js 原生慢哈希算法 `crypto.scryptSync`（16 字节随机 salt 派生 64 字节高抗碰撞密钥），存储绝无明文或弱散列；密码比对采用 `crypto.timingSafeEqual` 恒定时间校验，彻底杜绝时序侧信道攻击。
- **防暴力破解（Rate Limiting）**：连续输错 5 次密码自动触发 30 秒冷却倒计时锁定，主进程与渲染进程状态严格联动，冷却期内拒绝对比任何密码。
- **无操作空闲自动锁屏**：支持设置空闲超时自动锁定（可设 1、5、15、30、60 分钟），综合追踪操作系统空闲状态（`powerMonitor`）与应用内前台交互。
- **完全遮蔽会话与越权阻断**：锁屏时无条件全量隐匿所有主窗口、账号窗口与悬浮窗口，弹出独立置顶毛玻璃锁屏窗，阻断内容窥视，拦截全局切换与导出操作。
- **即时锁屏入口**：支持全局快捷键（**Ctrl+Shift+L** / **Cmd+Shift+L**）、托盘右键菜单或设置中心一键即刻锁屏。

### 🌐 跨平台全原生支持
- **Windows**: 提供 NSIS 安装包及免安装单文件便携版（Portable）。
- **Linux**: 提供通用 AppImage、Debian 软件包（`.deb`）及免安装绿色解压包（`.tar.gz`）。
- **macOS**: 提供标准 DMG 镜像安装包与绿色 ZIP 归档。

### 🌐 国际化与双语支持 (i18n)
- **全面双语界面**：原生支持**简体中文**与 **English**。
- **无缝即时切换**：随时可通过系统托盘菜单、左下角控制中心 Popover 或设置中心实时热切换语言，无需重启应用。

### ⚡ 极限瘦身与硬件加速
- **深度体积优化**：配置 LZMA 最大压缩算法，精准剔除 60+ 种冗余语言包（仅保留中英必需资源），Windows 便携版压至 88MB，Linux 绿色包仅 59MB。
- **高性能渲染**：启用 GPU 光栅化与零拷贝渲染，滚动丝滑流畅，内存开销极低。

### 👥 多账号并发登录与会话深度隔离（12+ 账号承载）
- **支持多账号同时在线**：无需频繁登出或切换浏览器无痕窗口，可在同一客户端内同时登录多个 Muse 或 Meta AI 账号（如个人私人号、团队工作号、专属项目号、家庭账号）。
- **真正的底层 Session 隔离**：基于 Chromium 原生 `persist:partition` 机制，每个账号拥有完全独立的 Cookie、LocalStorage、Token 凭据、缓存与对话上下文，杜绝多账号串号或登录凭证冲突。
- **12+ 账号高密度无挤压 Dock**：提供 16 档质感专属配色调色盘，自适应计算视口高度，多账号时展示纤细半透明滚动条，头像尺寸与间距绝不变形。
- **移开自动收起与一键固定（📌）**：未固定模式下鼠标移开（`mouseleave`）自动平滑缩进至屏幕边缘；点击顶部“📌”固定按钮即可锁定常驻展开。
- **零延迟秒级瞬切**：左侧悬浮 Dock 栏以醒目的头像/别名圆标排列，点击立即呈现对应账号的对话界面，无需等待任何网页重新加载。
- **灵活的账号配置与维护**：
  - **一键新建账号**：点击 Dock 栏底部的 `+` 按钮，即刻创建并开启全新独立的隔离会话。
  - **自定义个性化备注**：右键点击任意账号头像即可自定义备注别名。
  - **独立登出与缓存清理**：支持对单账号执行退出登录或彻底抹除本地会话缓存，完全不影响其他在线账号。

### 🎨 界面视觉风格与主题自由切换
- **多种专属视觉风格**：
  - **深色夜间模式 🌙**：高对比暗黑基调，防炫目防疲劳，专为深夜编程、深度写作与长时对话设计。
  - **明亮浅色模式 ☀️**：清晰锐利的日间排版，文字边缘锐利饱满，适合明亮采光的办公与学习环境。
  - **跟随系统联动 💻**：毫秒级自动感知 Windows、macOS 或 Linux 系统深浅色外观切换并动态响应。
- **免重启即时热切换**：随时可在左下角控制中心（`⚙`）或设置面板（`Ctrl+,` / `Cmd+,`）中即点即切，全应用界面与网页元素瞬间渲染生效，无需重启软件。
- **布局风格随心定制**：支持自由收起展开侧边 Dock 栏、调整界面紧凑度与字体排版，满足不同审美与屏幕尺寸需求。

### ⚙️ 左下角集成控制中心
- **零遮挡设计**：原右上角和右下角悬浮按钮已彻底移除，最大化释放网页可用可视面积。
- **一键聚合调控**：所有核心功能聚合至左下角 `⚙` 按钮，点击即刻唤出控制中心，统一调控主题风格切换、自动化授权白名单、网络代理与中英语言切换。

### 🛡️ 智能自动化审批 (Auto-Allow)
- **安全可控**：默认处于关闭状态（Opt-in），绝不静默越权。
- **细分动作控制**：支持精细化筛选自动同意的权限范围：
  - 应用与插件集成授权 (Connectors)
  - 文件与数据读写访问 (File Access)
  - 外部链接与窗口跳转 (External Links)
  - 代码执行与终端运行 (Code Execution)
  - 麦克风与多媒体权限 (Media Permissions)
- **分网站独立规则**：支持为指定域名（如 `muse.ai` 或 `meta.ai`）设定独立的白名单与规则覆盖。

### 🚀 自适应网络与代理架构
- **自适应系统模式 (默认推荐)**：自动探测系统代理与 TUN 虚拟网卡（兼容 Clash Verge, Surge, Sing-box, V2Ray 等），在新设备部署无需任何繁琐配置，开箱即连。
- **手动代理覆盖**：可强制指定本机或局域网的 HTTP / SOCKS5 代理地址与端口（如 `127.0.0.1:7897`）。
- **直连模式 (Direct)**：绕过一切系统网络代理，直接发起通信。
- **断网自愈与诊断**：网络异常时自动展示诊断页并主动弹出代理调整引导。

### ⌨️ 全局快捷键与实用工具
- **快捷会话弹窗**：随时按下 **Ctrl+Shift+Space**（macOS 上为 **Cmd+Shift+Space**）唤出微型对话浮窗，失焦自动隐藏。
- **双站点一键切换**：按下 **Ctrl+Shift+M** 瞬时在 Muse 与 Meta AI 之间切换。
- **硬件静音开关**：独立热键开关麦克风输入（**Ctrl+Shift+U**）与应用扬声器发声（**Ctrl+Shift+O**）。
- **会话记录导出**：一键将完整聊天记录（**Ctrl+Shift+E**）导出为排版优雅的 Markdown、结构化 JSON 或自包含 HTML。
- **剪贴板存为文本**：托盘提供剪贴板存为 `.txt` 功能，大段文本直接保存为文件拖入聊天框，彻底告别浏览器卡顿。

---

## 📥 下载与安装

前往 [GitHub Releases](https://github.com/xusofty-cyber/muse-ai-Desktop/releases) 下载适合您操作系统的最新安装包：

| 操作系统 | 安装包格式 | 说明 |
| :--- | :--- | :--- |
| **Windows** | `Muse Setup x.x.x.exe` | 标准 NSIS 安装包，自动生成桌面与开始菜单快捷方式 |
| **Windows** | `Muse-Portable-x.x.x.exe` | 免安装便携版单文件，双击即可运行 |
| **Linux** | `.AppImage` | 通用 Linux 单文件二进制，赋予执行权限后双击即开 |
| **Linux** | `.deb` | 适用于 Debian / Ubuntu / Linux Mint 等发行版的安装包 |
| **Linux** | `.tar.gz` | 便携绿色解压包（解压后直接执行 `muse-desktop`） |
| **macOS** | `.dmg` | macOS 拖拽安装镜像 |
| **macOS** | `.zip` | 便携式免安装应用程序包 |

---

## 🛠️ 本地开发与源码编译

### 环境准备
- Node.js 20+ (推荐使用 LTS 版本)
- npm 或 yarn

```bash
# 1. 克隆代码仓库
git clone git@github.com:xusofty-cyber/muse-ai-Desktop.git
cd muse-ai-Desktop

# 2. 安装项目依赖
npm install

# 3. 启动本地桌面客户端调试
npm start
```

### 多平台打包命令

```bash
# 构建 Windows 安装包与单文件便携版 (dist/ 目录)
npm run dist:win

# 构建 Linux AppImage, DEB 及 tar.gz 产物
npm run dist:linux

# 构建 macOS DMG 镜像与 ZIP 压缩包
npm run dist:mac
```

---

## ⌨️ 默认快捷键清单

| 快捷键 (Windows / Linux) | 快捷键 (macOS) | 功能说明 |
| :--- | :--- | :--- |
| `Ctrl + Shift + Space` | `Cmd + Shift + Space` | 唤出 / 隐藏快捷会话浮窗 |
| `Ctrl + Shift + L` | `Cmd + Shift + L` | 主密码快速锁屏保护 |
| `Ctrl + Shift + M` | `Cmd + Shift + M` | 切换 Muse 与 Meta AI 站点 |
| `Ctrl + Shift + N` | `Cmd + Shift + N` | 循环切换保存的多账号 |
| `Ctrl + Shift + A` | `Cmd + Shift + A` | 开关自动化审批总控 (Auto-Allow) |
| `Ctrl + Shift + E` | `Cmd + Shift + E` | 导出当前完整聊天记录为文件 |
| `Ctrl + Shift + U` | `Cmd + Shift + U` | 麦克风硬件静音 / 恢复 |
| `Ctrl + Shift + O` | `Cmd + Shift + O` | 应用声音静音 / 恢复 |
| `Ctrl + =` / `Ctrl + -` | `Cmd + =` / `Cmd + -` | 页面缩放 放大 / 缩小 |
| `Ctrl + 0` | `Cmd + 0` | 恢复默认 100% 页面缩放 |

*所有快捷键均可在设置面板中根据个人习惯自由修改绑定（`⚙` > 打开完整设置与快捷键）。*

---

## 🙏 致谢与上游声明

本项目最初 Fork 自 [whxjwksjs/muse-windows](https://github.com/whxjwksjs/muse-windows)。衷心感谢原作者 [@whxjwksjs](https://github.com/whxjwksjs) 提供的优秀原型与开源启发！

在此基础上，**Muse Desktop**（`muse-ai-Desktop`）进行了全面的架构扩展与功能演进：
- **全平台原生支持**：新增覆盖 Windows、Linux (AppImage/deb/tar.gz) 与 macOS (dmg/zip) 的全平台构建与 GitHub Actions 自动化发布流水线；
- **全链路中英双语国际化 (i18n)**：托盘、左下角控制中心、Dock 栏与设置面板的即时免重启热切换；
- **多账号并发与深度会话隔离**：基于 Chromium 原生 `persist:partition` 的多账号并行登录与左侧快捷 Dock 栏；
- **界面与交互重构**：移除遮挡页面的悬浮窗，打造左下角极简控制中心，支持深色/浅色/系统自适应风格热切换；
- **深度瘦身与体积优化**：剔除 60+ 冗余语言包与 LZMA 最大化压缩。

---

## 🤝 贡献与开源协议

欢迎提交 Issue 反馈问题或发起 Pull Request！

本项目基于 MIT 开源协议发布。
