# Muse ai for Desktop (Windows, macOS, Linux)

<div align="center">

**Your Personal AI Agent in a Native, Lightweight Desktop App**

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/xusofty-cyber/muse-ai-Desktop?style=flat-square)](https://github.com/xusofty-cyber/muse-ai-Desktop/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)](#download--installation)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

---

## 🌟 Overview

**Muse Desktop** wraps Muse ([muse.ai](https://muse.ai)) and Meta AI ([meta.ai](https://www.meta.ai)) in a fast, privacy-focused native desktop container for **Windows, Linux, and macOS**. It delivers multi-account session isolation, global shortcut controls, adaptive proxy & TUN virtual adapter compatibility, automated permission approval (Auto-Allow), and instant chat export—all inside a clean, clutter-free desktop UI.

---

## ✨ Key Features

### 🌐 Cross-Platform Native Experience
- **Windows**: NSIS Setup installer & zero-install standalone Portable executable.
- **Linux**: AppImage, Debian package (`.deb`), and portable green tarball (`.tar.gz`).
- **macOS**: Native DMG installer and portable ZIP package.

### 🌐 Internationalization (i18n)
- **Full Bilingual UI**: Switch between **English** and **简体中文** anytime.
- **Instant Hot-Switching**: Change languages on the fly via the System Tray menu, the bottom-left Control Center popover, or the Settings dialog without restarting the app.

### ⚡ Ultra-Lightweight & Optimized
- **Deep Compression**: Powered by maximum LZMA compression and aggressive locale stripping (retaining only essential Chinese and English packs), reducing the binary footprint by 15–20MB.
- **High Performance**: Hardware-accelerated GPU rasterization and zero-copy rendering for fluid scrolling and low memory usage.

### 👥 Multi-Account Concurrent Login & Profile Isolation
- **Simultaneous Multi-Account Login**: Sign in to multiple Muse or Meta AI accounts simultaneously (e.g., Personal, Work, Project-specific, or Family accounts) without logging out.
- **True Session Isolation**: Powered by Chromium `persist:partition` storage. Cookies, local storage, tokens, caches, and history are completely isolated across accounts to prevent credential collision.
- **Zero-Latency Instant Switching**: Switch between active accounts in real-time via the sleek left-side Dock with zero page reloads.
- **Account Management & Customization**:
  - **Quick Add**: One-click `+` button on the Dock to spin up a fresh isolated login session.
  - **Custom Aliases**: Right-click any account badge to assign custom nicknames or notes (e.g., "Company Work", "Research").
  - **Independent Sign-Out & Wipe**: Log out or permanently delete specific profile caches without affecting other active accounts.
  - **Collapsible Dock**: Collapse the account Dock anytime to maximize conversational screen estate.

### 🎨 Visual Style & Theme Customization
- **Multiple Theme Styles**:
  - **Dark Mode 🌙**: High-contrast, deep night palette tailored for low-light environments and long coding/writing sessions.
  - **Light Mode ☀️**: Clean, crisp, and radiant daytime theme with sharp typography and minimal eye strain.
  - **System Adaptive 💻**: Seamlessly synchronizes with Windows, macOS, or Linux system-wide dark/light theme changes.
- **Instant Hot-Switching**: Toggle themes instantly via the bottom-left Control Center (`⚙`) popover or the Settings panel (`Ctrl+,` / `Cmd+,`) without reloading pages.
- **Interface Layout Flexibility**: Customize UI density, toggle the account Dock sidebar, and enjoy a distraction-free conversation canvas.

### ⚙️ Left-Bottom Unified Control Center
- **Distraction-Free Screen**: Floating overlay buttons have been consolidated into a sleek `⚙` Control Center button docked at the bottom-left corner to maximize chat visibility.
- **Quick Controls**: Access Theme/Style switching, Auto-Allow master switches, granular action categories, proxy configurations, and instant language switching in a single unified panel.

### 🛡️ Smart Automation (Auto-Allow)
- **Opt-In Safety**: Automation is completely disabled by default.
- **Granular Approvals**: Customize auto-approvals per action category:
  - App & Connector Integrations
  - File and Data Access
  - External Navigation & Links
  - Code & Script Execution
  - Microphone & Media Permissions
- **Per-Site Rules**: Set domain-specific override rules (e.g., `muse.ai` vs `meta.ai`).

### 🚀 Adaptive Network & Proxy Architecture
- **Self-Adaptive Mode (Default)**: Automatically detects Windows/Linux/macOS system network settings, corporate VPNs, and TUN virtual network adapters (Clash Verge, Sing-box, Surge, V2Ray). Works out-of-the-box on new devices without manual configuration.
- **Manual Proxy Override**: Supports custom local/LAN HTTP or SOCKS5 proxies (e.g., `127.0.0.1:7897`).
- **Direct Mode**: Fast direct connection bypassing all system proxies.
- **Auto-Recovery**: Automatic failover and diagnostic screen on network disconnects.

### ⌨️ Global Hotkeys & Utilities
- **Quick Chat Window**: Global popup shortcut (**Ctrl+Shift+Space** / **Cmd+Shift+Space**) for instant questions; automatically hides when losing focus.
- **Site Switcher**: Toggle seamlessly between Muse and Meta AI (**Ctrl+Shift+M**).
- **Mute Toggles**: Independent hotkeys to toggle microphone input (**Ctrl+Shift+U**) and app speaker output (**Ctrl+Shift+O**).
- **Chat History Exporter**: Export conversations with one click (**Ctrl+Shift+E**) into clean Markdown, formatted HTML, or structured JSON.
- **Clipboard Dump**: Save large clipboard snippets directly to `.txt` files to drag-and-drop into chat without browser freezes.

---

## 📥 Download & Installation

Visit the [GitHub Releases](https://github.com/xusofty-cyber/muse-ai-Desktop/releases) page to download the latest builds for your platform:

| Platform | Format | Description |
| :--- | :--- | :--- |
| **Windows** | `Muse Setup x.x.x.exe` | Standard NSIS installer with desktop shortcut |
| **Windows** | `Muse-Portable-x.x.x.exe` | Standalone portable executable (No install required) |
| **Linux** | `.AppImage` | Universal Linux binary, double-click to run |
| **Linux** | `.deb` | Debian / Ubuntu / Mint installer package |
| **Linux** | `.tar.gz` | Portable green archive (extract and execute `muse-desktop`) |
| **macOS** | `.dmg` | macOS drag-and-drop installer |
| **macOS** | `.zip` | Portable zipped application bundle |

---

## 🛠️ Build from Source

### Prerequisites
- Node.js 20+ (LTS recommended)
- npm or yarn

```bash
# 1. Clone the repository
git clone git@github.com:xusofty-cyber/muse-ai-Desktop.git
cd muse-ai-Desktop

# 2. Install dependencies
npm install

# 3. Start local development
npm start
```

### Packaging Distribution Packages

```bash
# Package for Windows (NSIS + Portable)
npm run dist:win

# Package for Linux (AppImage + DEB + tar.gz)
npm run dist:linux

# Package for macOS (DMG + ZIP)
npm run dist:mac
```

---

## ⌨️ Default Keyboard Shortcuts

| Shortcut (Win / Linux) | Shortcut (macOS) | Action |
| :--- | :--- | :--- |
| `Ctrl + Shift + Space` | `Cmd + Shift + Space` | Toggle quick floating chat popup |
| `Ctrl + Shift + M` | `Cmd + Shift + M` | Switch between Muse and Meta AI |
| `Ctrl + Shift + N` | `Cmd + Shift + N` | Cycle through saved accounts |
| `Ctrl + Shift + A` | `Cmd + Shift + A` | Toggle Auto-Allow master switch |
| `Ctrl + Shift + E` | `Cmd + Shift + E` | Export current chat session |
| `Ctrl + Shift + U` | `Cmd + Shift + U` | Mute / unmute microphone |
| `Ctrl + Shift + O` | `Cmd + Shift + O` | Mute / unmute app speaker sound |
| `Ctrl + =` / `Ctrl + -` | `Cmd + =` / `Cmd + -` | Zoom in / Zoom out |
| `Ctrl + 0` | `Cmd + 0` | Reset zoom level |

*All shortcuts can be fully customized in Settings (`⚙` > Open Full Settings & Hotkeys).*

---

## 🙏 Acknowledgments & Upstream

This project originated as a fork of [whxjwksjs/muse-windows](https://github.com/whxjwksjs/muse-windows). Special thanks to [@whxjwksjs](https://github.com/whxjwksjs) for the initial prototype and inspiration.

Building upon the original foundation, **Muse Desktop** (`muse-ai-Desktop`) has evolved into a comprehensive cross-platform client with significant additions:
- **Full Cross-Platform Support**: Native packaging & CI/CD workflows for Windows, Linux, and macOS.
- **Bilingual Internationalization (i18n)**: Seamless hot-switching between English and 简体中文.
- **Advanced Multi-Account Login**: Chromium partition-based session isolation with an instant-switch Dock.
- **UI & Control Center Redesign**: Distraction-free screen layout with dynamic theme switching (Dark/Light/System).
- **Extreme Footprint Optimization**: Aggressive locale stripping and LZMA deep compression.

---

## 🤝 Contributing & License

Contributions, issue reports, and pull requests are warmly welcomed!

This project is licensed under the MIT License.
