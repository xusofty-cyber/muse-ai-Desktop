// src/child-windows.js
// 账号所属的子窗口: OAuth / 连接器授权弹窗的登记与跟随显隐, 以及用账号自己的 session
// 打开的账号页面窗口 (Meta 账户中心、站内分享/文档等)。
// 2026-11-22 main.js 拆分 第 3 步, 函数体原样迁移。
//
// 依赖注入: 账号页面窗口需要 main.js 的 setupExternalLinkHandler 等装饰函数, 而 main.js 又要用
// 这里的函数, 为避免循环 require, 由 main.js 在创建时传入 decorateWindow 回调。
'use strict';

const { BrowserWindow } = require('electron');
const { isDownloadLikeUrl } = require('./link-rules');

/**
 * @param {Object} deps
 * @param {(profileId: string) => string} deps.getProfileName 账号显示名 (用于窗口标题)
 * @param {string} deps.iconPath 窗口图标
 * @param {string} deps.userAgent 子窗口 UA
 * @param {(win: BrowserWindow, profileId: string) => void} deps.decorateWindow
 *        给新建的账号页面窗口挂缩放快捷键、右键菜单与外链拦截
 */
function createChildWindowManager({ getProfileName, iconPath, userAgent, decorateWindow }) {
  // ---- 子弹窗 (OAuth/连接器) 追踪 (v1.5.15, 评审 P1-6) -------------------------
  // 此前 did-create-window 的子窗口无人登记: 切账号不跟随、登出/删号关不掉,
  // 开着的授权弹窗能在存储清除后回写 Cookie 让已登出会话复活。现在按父窗口
  // 所属 profile 登记, closed 时注销, 并提供跟随显隐与批量关闭工具。
  const childWindowsByProfile = new Map(); // profileId -> Set<BrowserWindow>
  const childrenHiddenBySwitch = new WeakSet();

  function trackChildWindow(profileId, childWin) {
    if (!profileId || !childWin) return;
    let set = childWindowsByProfile.get(profileId);
    if (!set) { set = new Set(); childWindowsByProfile.set(profileId, set); }
    set.add(childWin);
    childWin.on('closed', () => {
      const st = childWindowsByProfile.get(profileId);
      if (st) { st.delete(childWin); if (!st.size) childWindowsByProfile.delete(profileId); }
    });
  }

  function setChildWindowsVisible(profileId, visible) {
    const set = childWindowsByProfile.get(profileId);
    if (!set) return;
    for (const child of set) {
      if (!child || child.isDestroyed()) continue;
      if (visible) {
        if (childrenHiddenBySwitch.has(child)) { childrenHiddenBySwitch.delete(child); child.show(); }
      } else if (child.isVisible()) {
        childrenHiddenBySwitch.add(child);
        child.hide();
      }
    }
  }

  function closeChildWindows(profileId) {
    const set = childWindowsByProfile.get(profileId);
    if (!set) return;
    for (const child of [...set]) {
      if (child && !child.isDestroyed()) { try { child.destroy(); } catch {} }
    }
    childWindowsByProfile.delete(profileId);
  }

  /** 反查 webContents 属于哪个账号的子窗口, 找不到返回 null */
  function findChildOwner(wc) {
    if (!wc) return null;
    const same = (w) => w && !w.isDestroyed() && (w.webContents === wc || w.webContents.id === wc.id);
    for (const [pid, set] of childWindowsByProfile) {
      for (const w of set) if (same(w)) return { profileId: pid, win: w };
    }
    return null;
  }

  // 同一账号 + 同一站点只保留一个窗口 (审查 L3), 再次点击复用并聚焦
  const scopedWindows = new Map(); // `${profileId}|${host}` -> BrowserWindow

  function openProfileScopedWindow(parentWin, profileId, url) {
    if (!parentWin || parentWin.isDestroyed()) return null;
    let reuseKey = null;
    try { reuseKey = `${profileId}|${new URL(url).hostname.toLowerCase()}`; } catch {}
    const existing = reuseKey ? scopedWindows.get(reuseKey) : null;
    if (existing && !existing.isDestroyed()) {
      existing.loadURL(url).catch((err) => console.warn('[AccountWindow] Failed to load:', url, err));
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const ses = parentWin.webContents.session; // 关键: 与当前账号同一 partition, Cookie/登录态一致
    let bounds = { width: 1100, height: 820 };
    try {
      const [pw, ph] = parentWin.getSize();
      bounds = { width: Math.max(800, Math.min(1200, pw)), height: Math.max(600, Math.min(900, ph)) };
    } catch {}
    const profName = (getProfileName && getProfileName(profileId)) || '';
    const child = new BrowserWindow({
      ...bounds,
      icon: iconPath,
      title: profName || 'Muse',
      autoHideMenuBar: true,
      backgroundColor: '#141414',
      show: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    trackChildWindow(profileId, child);
    if (reuseKey) {
      scopedWindows.set(reuseKey, child);
      child.on('closed', () => { if (scopedWindows.get(reuseKey) === child) scopedWindows.delete(reuseKey); });
    }
    if (userAgent) child.webContents.setUserAgent(userAgent);
    if (decorateWindow) decorateWindow(child, profileId);
    // 窗口标题带上账号名, 多账号同时打开时一眼区分是哪个账号的页面
    child.on('page-title-updated', (ev, title) => {
      if (!profName) return;
      ev.preventDefault();
      child.setTitle(title ? `${title} - ${profName}` : profName);
    });
    child.once('ready-to-show', () => { if (!child.isDestroyed()) child.show(); });
    // 兜底: 网络慢时 ready-to-show 可能迟迟不来, 2.5s 后强制显示, 避免"点了没反应"
    setTimeout(() => { if (!child.isDestroyed() && !child.isVisible()) child.show(); }, 2500);
    child.loadURL(url).catch((err) => console.warn('[AccountWindow] Failed to load:', url, err));
    console.log(`[AccountWindow] Opened ${url} for profile ${profileId}`);
    return child;
  }

  function openUrlForProfile(win, profileId, url) {
    if (!win || win.isDestroyed()) return;
    if (isDownloadLikeUrl(url)) {
      // 附件/导出直接用当前账号的 session 下载 (走已有的下载提示), 不弹空白窗口
      try { win.webContents.downloadURL(url); } catch (err) { console.warn('[AccountWindow] downloadURL failed:', url, err); }
      return;
    }
    openProfileScopedWindow(win, profileId, url);
  }

  return {
    childWindowsByProfile,
    trackChildWindow,
    setChildWindowsVisible,
    closeChildWindows,
    findChildOwner,
    openProfileScopedWindow,
    openUrlForProfile,
  };
}

module.exports = { createChildWindowManager };
