const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, shell, nativeImage, clipboard, session, dialog, Notification, ipcMain, powerMonitor, webContents, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { defaultFeishuConfig, executeFeishuSync, setupFeishuAutoSync, formatDateTime, sortProfilesByResetTime } = require('./feishu-sync');
// Mihomo 管理器的创建与调度已移到 src/proxy.js
// 备份加解密由 src/backup.js 调用
// 状态默认值、清洗、加载与原子写入 (2026-11-22 main.js 拆分 第 2 步)
const {
  SAFE_ID_RE,
  DEFAULT_HOTKEYS,
  AVATAR_COLORS,
  sanitizeWindowBounds,
  defaultProxy,
  defaultLock,
  defaultMihomoConfig,
  defaultState,
  sanitizeAndMergeState,
  statePath,
  initState,
  replaceState,
  saveState,
  saveStateDebounced,
  wasStateSafelyLoaded,
} = require('./src/state');
const { createChildWindowManager } = require('./src/child-windows');
const { ensureBoundsVisible, syncWindowStateAndBounds } = require('./src/window-geometry');
const { createProxyController } = require('./src/proxy');
const {
  FEISHU_SECRET_MASK,
  COOKIE_DOMAIN_RE,
  COOKIE_SAMESITE,
  pickImportedProxy,
  pickImportedFeishu,
  pickImportedSources,
  createBackupService,
} = require('./src/backup');
const { isPortableWindowsBuild, createUpdater } = require('./src/updater');
const { markSharedExits, buildExitGroups, planIsolation } = require('./src/exit-isolation');
const { checkSessionExit, probeNodeExits, mapLimit } = require('./src/exit-probe');
const { createExitMonitor } = require('./src/exit-monitor');
// 链接与导航判断规则 (纯函数, 无应用状态)。preload 在 sandbox 下无法 require 本地模块, 那边仍是一份拷贝,
// 两边一致性由 npm run check:links 校验 (2026-11-22 main.js 拆分 第 1 步)
const {
  extractExternalTargetUrl,
  isInternalSiteUrl,
  isAuthOrConnectorUrl,
  isTrackingOrAdUrl,
  isMetaAccountUrl,
  isMetaAccountCenterUrl,
  isProfileScopedUrl,
} = require('./src/link-rules');


// ---- 核心加固 1 & 2: 先定身份/UserData 再拿单例锁 + 统一 UserData 目录 -------------
// 顺序要点 (v1.5.15 修正评审 P1-11): Chromium 单例锁绑定获取时刻的 userData
// 目录。旧实现先拿锁、后改 userData, 便携版初始目录与目标目录不一致时, 安装版
// 与便携版可能各持一把不同的锁双双启动, 并发写同一 app-state.json 与 partition。
// 因此 setName 与 win32 的 setPath 必须在 requestSingleInstanceLock 之前完成;
// 锁本身仍在任何文件读写与业务初始化之前获取。
app.setName('Muse');
if (process.platform === 'linux') {
  // Linux 桌面身份 (v1.5.18): Wayland 下 GNOME 按 app_id 找 <app_id>.desktop
  // 归并窗口与图标; 不显式设置时 app_id 取 app 名 'Muse', 与 muse.desktop
  // 对不上 → Dock 齿轮图标。此处按 Electron 文档显式钉死为 'muse'。
  // (X11 侧 WM_CLASS class 实测为可执行名首字母大写 'Muse', 不受此 API
  // 影响, 由 package.json 中 desktop.entry.StartupWMClass='Muse' 对齐。)
  try { app.setDesktopName('muse'); } catch {}
}
if (process.platform === 'win32') {
  const fixedUserData = path.join(app.getPath('appData'), 'Muse');
  app.setPath('userData', fixedUserData);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const APP_ICON_PATH = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
if (process.platform === 'win32') {
  if (app.isPackaged) {
    app.setAppUserModelId('ai.muse.desktop');
  } else {
    // 开发模式下使用 process.execPath 避免 Windows Toast 点击触发裸 electron.exe
    app.setAppUserModelId(process.execPath);
  }

  // 修复便携版或旧版本在开始菜单残留的死链快捷方式（指向已删除的 Temp 目录），防止任务栏图标回退到通用空白图标
  try {
    const startMenuLnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Muse.lnk');
    if (fs.existsSync(startMenuLnk)) {
      const lnk = shell.readShortcutLink(startMenuLnk);
      if (lnk && lnk.target && !fs.existsSync(lnk.target)) {
        const realExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        if (realExe && fs.existsSync(realExe)) {
          shell.writeShortcutLink(startMenuLnk, 'update', {
            target: realExe,
            icon: realExe,
            iconIndex: 0,
            appUserModelId: 'ai.muse.desktop',
          });
        } else {
          fs.unlinkSync(startMenuLnk);
        }
      }
    }
  } catch (err) {
    // 忽略快捷方式容错异常
  }
}

const SITES = {
  muse: { name: 'Muse', url: 'https://muse.ai' },
  meta: { name: 'Meta AI', url: 'https://www.meta.ai/' },
};
// Global hotkeys, all user-remappable via the tray menu's "Customize hotkeys…".
const HOTKEY_LABELS = {
  en: {
    quick: 'Quick chat popup',
    site: 'Switch Muse / Meta AI',
    export: 'Export this chat',
    mic: 'Mute / unmute microphone',
    speaker: 'Mute / unmute app sound',
    automation: 'Toggle automation (Auto-Allow)',
    metaAccount: 'Next account (Switch)',
    lock: 'Lock screen (Require password)',
  },
  'zh-CN': {
    quick: '快捷会话窗口 (Quick chat)',
    site: '切换 Muse / Meta AI',
    export: '导出当前会话记录',
    mic: '麦克风静音 / 开关',
    speaker: '应用声音静音 / 开关',
    automation: '自动化授权开关 (Auto-Allow)',
    metaAccount: '切换下一个账号',
    lock: '锁定屏幕 (需要密码解锁)',
  },
};

const I18N_MAIN = {
  en: {
    openMuse: 'Open Muse',
    quickChat: (hk) => `Quick chat  (${hk})`,
    switchTo: (name, hk) => `Switch to ${name}  (${hk})`,
    metaAccounts: 'Accounts',
    multiAccounts: 'Accounts',
    nextMetaAccount: (hk) => `Next account  (${hk})`,
    nextAccount: (hk) => `Next account  (${hk})`,
    addMetaAccount: 'Add account…',
    addAccount: 'Add account…',
    automationMenu: 'Automation / Auto-Allow',
    masterAutomation: (hk) => `Master Automation  (${hk})`,
    allowAllActions: 'Allow all actions',
    thisWebsite: 'This website',
    alwaysAllowOn: (host) => `Always allow on ${host}`,
    whatCanBeAutoApproved: 'What can be auto-approved?',
    actConnectors: 'App / connector actions',
    actFile: 'File and data access',
    actLinks: 'External navigation',
    actCode: 'Code execution',
    actMedia: 'Microphone and media',
    hintConnectors: 'Approve connection and integration prompts',
    hintFile: 'Approve file, upload, download, and data-access prompts',
    hintLinks: 'Approve prompts to open links or navigate outside the chat',
    hintCode: 'Approve prompts to run code, scripts, or terminal actions',
    hintMedia: 'Approve microphone, camera, audio, and media permission requests',
    showOnScreenWidget: 'Show On-Screen Widget',
    settingsKeybinds: 'Settings & Keybinds…',
    openAccountHub: '⊞ Open Account Hub (Grid View)…',
    sessionTools: 'Session & Media Tools',
    preferencesMenu: 'Preferences & Settings',
    profileMenu: (name) => `Profile: ${name}`,
    addProfile: 'Add profile…',
    signOutFrom: (site) => `Sign out of ${site}…`,
    saveClipboard: 'Save clipboard text as .txt',
    exportChat: (hk) => `Export this chat as file…  (${hk})`,
    muteMic: (hk) => `Mute / unmute microphone  (${hk})`,
    muteSpeaker: (hk) => `Mute / unmute app sound  (${hk})`,
    customizeHotkeys: 'Customize hotkeys & settings…',
    networkProxy: 'Network & Proxy settings…',
    backupExport: 'Backup / Export all accounts & configs…',
    backupImport: 'Import config backup…',
    openDataDir: 'Open local data folder (%APPDATA%\\Muse)…',
    resetGoogleSession: 'Reset Google Sign-in & Security Cache…',
    appearance: (cur) => `Appearance: ${cur}`,
    darkMode: 'Dark mode 🌙',
    lightMode: 'Light mode ☀️',
    systemMode: 'Follow system 💻',
    language: 'Language / 界面语言',
    langEn: 'English (US)',
    langZh: '简体中文 (Chinese)',
    autoHideButtons: 'Auto-hide floating buttons (Top-Right / Bottom-Right)',
    runOnStartup: 'Run on startup',
    checkUpdates: 'Check for updates',
    restartInstall: 'Restart and install update',
    quitMuse: 'Quit Muse',
    saveLinkAs: 'Save link as…',
    copyLinkAddress: 'Copy link address',
    saveImageAs: 'Save image as…',
    copyImageAddress: 'Copy image address',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    downloadComplete: 'Download complete',
    downloadSaved: 'saved. Click to open the folder.',
    downloadFailed: 'Download failed',
  },
  'zh-CN': {
    openMuse: '打开 Muse 主窗口',
    quickChat: (hk) => `快捷会话窗口  (${hk})`,
    switchTo: (name, hk) => `切换至 ${name}  (${hk})`,
    metaAccounts: '多账号管理',
    multiAccounts: '多账号管理',
    nextMetaAccount: (hk) => `下一个账号  (${hk})`,
    nextAccount: (hk) => `下一个账号  (${hk})`,
    addMetaAccount: '添加新账号…',
    addAccount: '添加新账号…',
    automationMenu: '自动化审批 (Auto-Allow)',
    masterAutomation: (hk) => `总控开关  (${hk})`,
    allowAllActions: '一键允许所有行为',
    thisWebsite: '当前网站规则',
    alwaysAllowOn: (host) => `在 ${host} 始终自动同意`,
    whatCanBeAutoApproved: '全局动作授权范围',
    actConnectors: '应用集成 / 插件授权',
    actFile: '文件与数据访问',
    actLinks: '外部链接与窗口跳转',
    actCode: '代码执行与终端脚本',
    actMedia: '麦克风与多媒体',
    hintConnectors: '自动批准第三方应用与插件连接授权',
    hintFile: '自动批准文件读写、上传与下载访问提示',
    hintLinks: '自动批准跳转外部页面或新窗口打开链接',
    hintCode: '自动批准运行代码、命令与终端执行提示',
    hintMedia: '自动批准麦克风、摄像头与媒体访问权限',
    showOnScreenWidget: '显示屏幕悬浮组件',
    settingsKeybinds: '自动化与快捷键设置…',
    openAccountHub: '⊞ 打开账号总览看板 (九宫格全景)…',
    sessionTools: '会话与多媒体工具',
    preferencesMenu: '偏好与系统设置',
    profileMenu: (name) => `当前账号: ${name}`,
    addProfile: '添加新账号…',
    signOutFrom: (site) => `退出 ${site} 登录…`,
    saveClipboard: '剪贴板内容另存为 .txt',
    exportChat: (hk) => `导出当前会话记录…  (${hk})`,
    muteMic: (hk) => `麦克风静音 / 开关  (${hk})`,
    muteSpeaker: (hk) => `应用声音静音 / 开关  (${hk})`,
    customizeHotkeys: '全局快捷键与高级偏好设置…',
    networkProxy: '网络代理配置 (TUN/系统)…',
    backupExport: '备份 / 导出当前所有账号与代理配置…',
    backupImport: '导入配置备份 (.json)…',
    openDataDir: '打开本地数据与配置目录 (%APPDATA%\\Muse)…',
    resetGoogleSession: '重置 Google 登录与风控缓存…',
    appearance: (cur) => `主题外观: ${cur}`,
    darkMode: '深色模式 🌙',
    lightMode: '浅色模式 ☀️',
    systemMode: '跟随系统 💻',
    language: 'Language / 界面语言',
    langEn: 'English (US)',
    langZh: '简体中文 (Chinese)',
    autoHideButtons: '自动隐藏悬浮按钮 (右上/右下角)',
    runOnStartup: '开机自动启动',
    checkUpdates: '检查版本更新',
    restartInstall: '重启并安装更新',
    quitMuse: '彻底退出 Muse',
    saveLinkAs: '链接另存为…',
    copyLinkAddress: '复制链接地址',
    saveImageAs: '图片另存为…',
    copyImageAddress: '复制图片地址',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    downloadComplete: '下载完成',
    downloadSaved: '已保存，点击查看文件。',
    downloadFailed: '下载失败',
  },
};
const HOTKEY_ACTIONS = {
  quick: () => toggleQuickWindow(),
  site: () => toggleSite(),
  export: () => exportChat(),
  mic: () => toggleMic(),
  speaker: () => toggleSpeaker(),
  automation: () => toggleAutomationMaster(),
  metaAccount: () => nextAccount(),
  lock: () => lockScreen(),
};

let mainWindow = null;
let quickWindow = null;
let tray = null;

// Performance & Network flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-quic');
// 关键：禁用后量子密钥协商(Kyber)与ECH拓展，解决Clash/代理软件在TLS 1.3 ClientHello拆包时触发的 net_error -100 (ERR_CONNECTION_CLOSED)
app.commandLine.appendSwitch('disable-features', 'PostQuantumKeyAgreement,EncryptedClientHello');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('ssl-version-min', 'tls1.2');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
app.userAgentFallback = CHROME_UA;

// 安全 (v1.5.14): 已删除 ignore-certificate-errors 开关与 certificate-error
// 无条件放行回调。旧实现等于对所有域名废掉 TLS 校验, 承载 OAuth 登录与多账号
// 会话的客户端一旦走被劫持的代理/Wi-Fi 即可被中间人窃取全部 Cookie。
// 本地代理的证书问题应在系统信任库层面解决, 不在应用内全局关检。


function hashPassword(password, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const derivedKey = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return {
    hash: derivedKey.toString('hex'),
    salt: salt,
  };
}

function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (derivedKey.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derivedKey, storedBuf);
  } catch {
    return false;
  }
}


// state 与 src/state.js 持有的是同一个对象; 整体替换必须用 replaceState
let state = initState();
// 一次性迁移 (v1.5.18): 站点选择会随 app-state.json 跨版本保留, 旧版本里切到
// Meta AI 的用户升级后每次启动仍直达 meta.ai, 而 Muse AI 的登录地址只有
// https://muse.ai 。首次运行本版时把站点强制扳回 muse; 落盘交给下方既有的
// 守卫首写 (仅安全加载时), 状态损坏时不覆盖现场、下一启动重试迁移。迁移标记
// 置位后不再干预, 用户之后主动切换站点的选择照常保存。
if (state.siteResetV1518 !== true) {
  state.site = 'muse';
  state.siteResetV1518 = true;
}
const { nativeTheme } = require('electron');
try {
  nativeTheme.themeSource = state.theme || 'dark';
} catch {}
if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
  state.activeProfileId = state.profiles[0].id;
}


// 仅在明确安全加载或全新初始安装时执行首写，避免覆盖损坏现场
if (wasStateSafelyLoaded() || !fs.existsSync(statePath())) {
  saveState();
}

const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
const partitionFor = (profileId) => `persist:muse-${profileId}`;
const currentSite = () => SITES[state.site] || SITES.muse;

// ---- 核心加固 4 & 5: Session Cookie 强持久化与安全刷盘 -----------------------
let sessionFlushTimer = null;

function setupSessionPersistence(profileId) {
  if (!profileId) return;
  // 建立定时安全刷盘：每 5 分钟将持久分区的会话与认证 Cookie 落盘至 SQLite 存储
  // 严禁监听 cookies.on('changed') 篡改临时会话 Cookie 或 CSRF 令牌，避免破坏 OAuth 握手与被服务端踢出
  if (!sessionFlushTimer) {
    sessionFlushTimer = setInterval(() => {
      flushAllSessions().catch(() => {});
    }, 5 * 60 * 1000);
  }
}

async function flushAllSessions() {
  try {
    const promises = [];
    if (state && Array.isArray(state.profiles)) {
      for (const p of state.profiles) {
        try {
          const ses = session.fromPartition(partitionFor(p.id));
          if (ses && ses.cookies && typeof ses.cookies.flushStore === 'function') {
            promises.push(ses.cookies.flushStore().catch(() => {}));
          }
        } catch {}
      }
    }
    if (session.defaultSession && typeof session.defaultSession.cookies.flushStore === 'function') {
      promises.push(session.defaultSession.cookies.flushStore().catch(() => {}));
    }
    // 总超时兜底 (v1.5.15, 评审 P1-8): 任一分区存储层卡住时 Promise.all 永不
    // settle, before-quit 的 await 会让应用永远退不出 (只能强杀, 反而绕过刷盘)。
    await Promise.race([
      Promise.all(promises),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    console.log('[SessionFlush] All session cookies successfully flushed to disk.');
  } catch (err) {
    console.warn('[SessionFlush] Error flushing session cookies:', err);
  }
}

function notify(title, body, onClick) {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const n = new Notification({
      title,
      body,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
    });
    if (onClick) {
      n.on('click', () => {
        try {
          showMainWindow();
          onClick();
        } catch (err) {
          console.error('[Notify] click callback error:', err);
        }
      });
    }
    n.show();
  } catch (err) {
    console.error('[Notify] show notification error:', err);
  }
}

// ---- windows ------------------------------------------------------------
const webPrefs = () => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, 'preload-chat-export.js'),
  partition: partitionFor(state.activeProfileId),
});

function attachZoomShortcuts(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.key === 'q' || input.key === 'Q') && (input.control || input.meta) && !input.alt) {
      e.preventDefault();
      app.quitting = true;
      app.quit();
      return;
    }
    if (!(input.control && !input.meta && !input.alt)) return;
    const z = win.webContents.getZoomFactor();
    if (input.key === '=' || input.key === '+') {
      win.webContents.setZoomFactor(Math.min(2.0, +(z + 0.1).toFixed(2)));
      e.preventDefault();
    } else if (input.key === '-') {
      win.webContents.setZoomFactor(Math.max(0.5, +(z - 0.1).toFixed(2)));
      e.preventDefault();
    } else if (input.key === '0') {
      win.webContents.setZoomFactor(1.0);
      e.preventDefault();
    }
  });
}


// ---- 账号子窗口 (授权弹窗登记、账号页面窗口) -----------------------------------
// 实现在 src/child-windows.js (2026-11-22 main.js 拆分 第 3 步)。这里注入 main.js 才有的
// 装饰函数; 它们都是函数声明 (已提升), 且只在窗口真正创建时才被调用。
const childWindows = createChildWindowManager({
  getProfileName: (profileId) => {
    const prof = (state.profiles || []).find((p) => p.id === profileId);
    return prof && prof.name ? prof.name : '';
  },
  iconPath: APP_ICON_PATH,
  userAgent: CHROME_UA,
  decorateWindow: (win, profileId) => {
    attachZoomShortcuts(win);
    attachContextMenu(win);
    setupExternalLinkHandler(win, profileId);
  },
});
const {
  childWindowsByProfile,
  trackChildWindow,
  setChildWindowsVisible,
  closeChildWindows,
  openProfileScopedWindow,
  openUrlForProfile,
} = childWindows;

// ---- 代理与 Mihomo 调度 ----------------------------------------------------------
// 实现在 src/proxy.js (2026-11-22 main.js 拆分 第 4 步)。notify 是函数声明 (已提升),
// 只在内核崩溃或端口改派时才被调用。
const proxyController = createProxyController({ notify, partitionFor });
const {
  ensureProfilePort,
  pruneProfilePorts,
  getMihomoManager,
  applyProxyToSession,
  applyProxySettings,
  refreshMihomoMergedProxiesAndReload,
} = proxyController;

// ---- 配置备份 (密码窗口、导出、导入文件读取) -----------------------------------
// 实现在 src/backup.js (2026-11-22 main.js 拆分 第 5 步); 创建时注册 prompt:* IPC。
// mainWindow 用 getter 传入: 它在 main.js 里会被重新赋值。
const backupService = createBackupService({
  getMainWindow: () => mainWindow,
  partitionFor,
  flushAllSessions,
  iconPath: APP_ICON_PATH,
});
const { handleConfigExport } = backupService;

// ---- 便携版自动更新 -----------------------------------------------------------
// 实现在 src/updater.js (2026-11-22 main.js 拆分 第 6 步)。notify / buildTrayMenu 是函数声明 (已提升)。
const { checkForUpdates, installUpdateAndRestart, setupAutoUpdate, isUpdateDownloaded } = createUpdater({
  notify,
  buildTrayMenu,
});

// ---- WebRTC 真实 IP 泄露防护 (2026-11-22) ------------------------------------------
// 账号会话只为 http/https 设置了代理, WebRTC 走 UDP 会绕过代理直连, 网页一段脚本就能拿到
// 真实公网 IP, 所有账号拿到的都是同一个, 足以把它们关联起来。disable_non_proxied_udp 让
// WebRTC 只能经代理走 TCP。可能影响依赖 WebRTC 的语音/视频通话, 因此可在设置里关闭。
const WEBRTC_SAFE_POLICY = 'disable_non_proxied_udp';
const currentWebRTCPolicy = () => (state.ui && state.ui.webrtcProtection === false ? 'default' : WEBRTC_SAFE_POLICY);
function applyWebRTCPolicy(wc) {
  try {
    if (wc && !wc.isDestroyed() && typeof wc.setWebRTCIPHandlingPolicy === 'function') {
      wc.setWebRTCIPHandlingPolicy(currentWebRTCPolicy());
    }
  } catch (err) {
    console.warn('[WebRTC] Failed to set IP handling policy:', err);
  }
}
// 覆盖所有渲染进程: 账号主窗口、快捷窗口、授权弹窗、账号页面窗口; 在页面加载前生效
app.on('web-contents-created', (_e, wc) => applyWebRTCPolicy(wc));

// 根据发起请求的 webContents 反查所属账号 (主窗口 / 快捷窗口 / 子弹窗)
function findProfileForWebContents(wc) {
  if (!wc) return null;
  const same = (w) => w && !w.isDestroyed() && (w.webContents === wc || w.webContents.id === wc.id);
  for (const [pid, w] of profileWindows) if (same(w)) return { profileId: pid, win: w };
  if (same(quickWindow)) return { profileId: quickWindowProfileId, win: quickWindow };
  return childWindows.findChildOwner(wc);
}

// 取消主框架跳转后的白屏自愈 (2026-11-22)。只在页面确实没有任何可见内容时才重新加载, 避免误伤。
const BLANK_PAGE_PROBE = `(() => {
  const body = document.body;
  if (!body) return true;
  const ours = (el) => /^(acct-|muse-)/.test(el.id || '') || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK';
  for (const el of body.children) {
    if (ours(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 50 && r.height > 50 && (el.innerText || '').trim().length > 0) return false;
  }
  return true;
})()`;
const blankRecoveryAt = new WeakMap(); // webContents -> 上次自愈时间, 防止反复重载
function scheduleBlankPageRecovery(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  setTimeout(async () => {
    if (win.isDestroyed() || wc.isDestroyed() || wc.isLoading()) return;
    try {
      const blank = await wc.executeJavaScript(BLANK_PAGE_PROBE, true);
      const last = blankRecoveryAt.get(wc) || 0;
      if (blank && Date.now() - last > 30 * 1000) {
        blankRecoveryAt.set(wc, Date.now());
        const cur = wc.getURL();
        // 停在跳转中转页 (如 l.meta.ai/?u=...) 上时, 重新加载会再跳一次、再打开一次浏览器:
        // 改为返回上一页; 没有上一页就回到站点首页
        if (extractExternalTargetUrl(cur) || !isInternalSiteUrl(cur)) {
          const hist = wc.navigationHistory;
          const canBack = hist && typeof hist.canGoBack === 'function' ? hist.canGoBack() : (wc.canGoBack && wc.canGoBack());
          console.warn('[ExternalLink] Page went blank on a redirect page, going back:', cur);
          if (canBack) { if (hist && hist.goBack) hist.goBack(); else wc.goBack(); }
          else wc.loadURL(currentSite().url);
        } else {
          console.warn('[ExternalLink] Page went blank after a cancelled navigation, reloading:', cur);
          wc.reload();
        }
      }
    } catch (err) {
      console.warn('[ExternalLink] Blank-page check failed:', err && err.message);
    }
  }, 1500);
}

function setupExternalLinkHandler(win, profileId) {
  if (!win || win.isDestroyed()) return;

  // 1. 拦截 window.open() 或带 target="_blank" 的链接
  win.webContents.setWindowOpenHandler((details) => {
    const { url } = details;

    // 严禁向外部默认浏览器打开第三方统计、埋点与广告追踪链接
    if (isTrackingOrAdUrl(url)) {
      return { action: 'deny' };
    }

    // 允许身份验证、连接器弹窗（如 Google 登录、OAuth 授权弹窗）或空白占位弹窗在应用内完成
    const isAuth = isAuthOrConnectorUrl(url);
    const isBlank = url === 'about:blank' || url === '' || url.startsWith('about:');

    if (isAuth || isBlank) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          // 授权/连接器弹窗多为第三方页面 (Google/GitHub 等): 不再继承聊天页的
          // preload-chat-export.js (注入 UI、链接拦截、IPC 通道), 改用空的最小 preload。
          // session 仍自动继承打开者 (当前账号), 授权结果照常写回本账号。
          webPreferences: {
            preload: path.join(__dirname, 'preload-popup.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    // Meta 账户中心等账号页面: 在应用内用当前账号的 session 打开独立窗口
    if (isMetaAccountUrl(url) && !extractExternalTargetUrl(url)) {
      openProfileScopedWindow(win, profileId, url);
      return { action: 'deny' };
    }

    // 关键守卫：内部站点常规基础功能路由（如左侧栏的聊天 /chat、会话切换 /c/、设置等），绝不向外打开浏览器
    if (isInternalSiteUrl(url)) {
      try {
        // 此前只比较 pathname, 且 "/" 直接忽略: 指向首页、或同一路径不同参数 (如 /settings?tab=xx) 的链接
        // 点击后毫无反应。现在按完整地址 (忽略 #hash) 比较, 只要目标不同就在当前窗口跳转。
        const strip = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
        const curUrl = win.webContents.getURL() || '';
        if (strip(url) !== strip(curUrl)) {
          win.loadURL(url);
        }
      } catch {}
      return { action: 'deny' };
    }

    // 站内分享/文档/附件等链接: 用当前账号的登录态在应用内打开, 而不是没有登录态的系统浏览器
    if (isProfileScopedUrl(url)) {
      openUrlForProfile(win, profileId, url);
      return { action: 'deny' };
    }

    // 所有外部链接及独立文档/分享链接（如聊天内分享链接、文档、GitHub 仓库等）：
    // 统一交由系统默认浏览器打开，绝不无响应丢弃或弹空白无头窗口
    const extracted = extractExternalTargetUrl(url);
    const finalExternalUrl = (extracted || url).trim().replace(/[，。；、？！）》」"',;!]+$/, '');

    if (finalExternalUrl && (finalExternalUrl.startsWith('http://') || finalExternalUrl.startsWith('https://') || finalExternalUrl.startsWith('mailto:'))) {
      console.log('[ExternalLink window.open] Opening external URL in default browser:', finalExternalUrl);
      shell.openExternal(finalExternalUrl).catch((err) => {
        console.warn('[ExternalLink] Failed to open external URL:', finalExternalUrl, err);
      });
      return { action: 'deny' };
    }

    return { action: 'deny' };
  });

  // 监听创建子窗口：支持快捷缩放，并在 Google 认证页面智能注入指引横幅及操作拦截
  win.webContents.on('did-create-window', (childWin) => {
    try {
      if (childWin && !childWin.isDestroyed()) {
        trackChildWindow(profileId, childWin);
        attachZoomShortcuts(childWin);

        // 使用干净标准的原生 Chrome UA，消除指纹特征冲突
        childWin.webContents.setUserAgent(CHROME_UA);

        const checkAndInjectGoogleBanner = (targetUrl) => {
          if (!childWin || childWin.isDestroyed()) return;
          const urlStr = String(targetUrl || '');
          if (urlStr.includes('accounts.google.com') || urlStr.includes('myaccount.google.com')) {
            childWin.webContents.executeJavaScript(getGoogleAuthBannerScript(state.locale || 'en')).catch(() => {});
          }
        };

        childWin.webContents.on('did-navigate', (event, navUrl) => checkAndInjectGoogleBanner(navUrl));
        childWin.webContents.on('did-navigate-in-page', (event, navUrl) => checkAndInjectGoogleBanner(navUrl));
        childWin.webContents.on('dom-ready', () => checkAndInjectGoogleBanner(childWin.webContents.getURL()));
        checkAndInjectGoogleBanner(childWin.webContents.getURL());

        // 拦截横幅操作链接
        childWin.webContents.on('will-navigate', async (e, navUrl) => {
          if (navUrl.startsWith('muse-action://open-browser')) {
            e.preventDefault();
            shell.openExternal('https://muse.ai');
            return;
          }
          if (navUrl.startsWith('muse-action://clear-google-cache')) {
            e.preventDefault();
            const ses = childWin.webContents.session;
            await clearGoogleAuthSession(ses);
            childWin.webContents.reload();
            return;
          }
        });
      }
    } catch (e) {
      console.warn('[Window] Failed to setup child window:', e);
    }
  });

  // 2. 拦截在主窗口内的普通超链接跳转（如 <a href="...">）及 302 重定向，防止主聊天窗口被覆盖或因阻止导航挂起黑屏
  const handleNavigation = (event, url, isInPlace, isMainFrame, isRedirect = false) => {
    // 关键守卫：严格忽略子框架 (iframe/subframe) 的所有导航与 302 重定向！
    // 页面内的第三方统计埋点（Snapchat Pixel, DoubleClick, Facebook Pixel 等）及后台嵌入 iframe 频繁重定向，
    // 若拦截子框架会导致 Blink Mojo 报错并误唤起外部系统浏览器打开后台资源。
    if (isMainFrame === false || (event && event.isMainFrame === false)) {
      return;
    }
    // 忽略第三方统计埋点与广告跟踪 URL
    if (isTrackingOrAdUrl(url)) {
      return;
    }
    // 允许身份验证流程导航
    if (isAuthOrConnectorUrl(url)) {
      return;
    }
    // 主聊天窗口内直接跳转到 Meta 账户中心: 不覆盖聊天页, 改为弹出当前账号的独立窗口。
    // 若当前窗口本身已在 meta.com 页面内 (即账户窗口自身的站内跳转), 正常放行。
    // 服务端 302 重定向 (登录/切号链路) 一律不改道, 保持原有行为
    if (!isRedirect && isMetaAccountCenterUrl(url) && !extractExternalTargetUrl(url)) {
      let curIsMeta = false;
      try { curIsMeta = isMetaAccountUrl(win.webContents.getURL()); } catch {}
      if (!curIsMeta) {
        event.preventDefault();
        openProfileScopedWindow(win, profileId, url);
      }
      return;
    }
    // 内部站点链接：主框架正常导航
    if (isInternalSiteUrl(url)) {
      return;
    }

    // 站内分享/文档/附件等: 不覆盖主聊天窗口, 也不交给没有登录态的系统浏览器, 改为当前账号窗口打开
    if (!isRedirect && isProfileScopedUrl(url)) {
      event.preventDefault();
      openUrlForProfile(win, profileId, url);
      return;
    }

    // 主框架点击的真正外部网络链接 (如 https://ulife.vip/):
    // 阻止应用内导航并由系统默认浏览器打开，绝不覆盖主聊天窗口
    event.preventDefault();
    const extracted = extractExternalTargetUrl(url);
    const finalExternalUrl = (extracted || url).trim().replace(/[，。；、？！）》」"',;!]+$/, '');

    if (finalExternalUrl && (finalExternalUrl.startsWith('http://') || finalExternalUrl.startsWith('https://') || finalExternalUrl.startsWith('mailto:'))) {
      console.log('[ExternalLink Navigation] Opening in default browser:', finalExternalUrl);
      shell.openExternal(finalExternalUrl).catch((err) => {
        console.warn('[ExternalLink] Failed to open external URL on nav:', finalExternalUrl, err);
      });
    }
    // 兜底 (2026-11-22): 页面整体跳转被中途取消时, 网站可能已开始卸载页面, 窗口只剩空白和账号栏。
    // 1.5 秒后检查页面上除本应用注入的元素外是否还有可见内容, 没有就重新加载当前页面。
    scheduleBlankPageRecovery(win);
  };

  win.webContents.on('will-navigate', (ev, url, isInPlace, isMainFrame) => handleNavigation(ev, url, isInPlace, isMainFrame, false));
  win.webContents.on('will-redirect', (ev, url, isInPlace, isMainFrame) => handleNavigation(ev, url, isInPlace, isMainFrame, true));
}


// ---- Google OAuth / Connector Session Reset & Helper ------------------------
async function clearGoogleAuthSession(targetSession) {
  const ses = targetSession || session.fromPartition(partitionFor(state.activeProfileId));
  try {
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      if (cookie.domain && (cookie.domain.includes('google.com') || cookie.domain.includes('googleapis.com'))) {
        const protocol = cookie.secure ? 'https' : 'http';
        const host = cookie.domain.replace(/^\./, '');
        const cookieUrl = `${protocol}://${host}${cookie.path || '/'}`;
        await ses.cookies.remove(cookieUrl, cookie.name);
      }
    }
    await ses.clearStorageData({
      origins: [
        'https://accounts.google.com',
        'https://myaccount.google.com',
        'https://oauth2.googleapis.com',
      ],
      storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
    });
    console.log('[GoogleAuth] Google session cache successfully cleared.');
    return true;
  } catch (err) {
    console.error('[GoogleAuth] Failed to clear Google cache:', err);
    return false;
  }
}

function getGoogleAuthBannerScript(locale) {
  const isZh = locale === 'zh-CN';
  const title = isZh ? 'Google 账号连接与安全引导' : 'Google Account Connection & Security Guide';
  const tip = isZh
    ? 'Google 官方安全机制（RFC 8252）全面禁止在任何桌面客户端内嵌窗口中输入密码登录。'
    : 'Google security policy (RFC 8252) strictly blocks sign-in within embedded desktop windows.';
  const recommendation = isZh
    ? '官方推荐方案：在系统默认浏览器中登录 muse.ai 绑定 Google 账号，绑定后在客户端按 F5 刷新即可直接同步生效！'
    : 'Official Recommendation: Log in to muse.ai in your default browser to connect your Google account, then press F5 in Muse to sync!';
  const btnOpenBrowser = isZh ? '在默认浏览器打开 muse.ai' : 'Open muse.ai in Default Browser';
  const btnClearCache = isZh ? '重置 Google 登录缓存' : 'Reset Google Cache';
  const btnClose = isZh ? '关闭弹窗' : 'Close';

  return `(() => {
    if (document.getElementById('google-auth-guide')) return;
    const banner = document.createElement('div');
    banner.id = 'google-auth-guide';
    banner.innerHTML = \`
      <div style="display:flex;align-items:flex-start;gap:12px;max-width:980px;margin:0 auto;">
        <div style="font-size:20px;line-height:1;margin-top:2px;">⚠️</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;color:#f3f4f6;margin-bottom:3px;display:flex;align-items:center;gap:6px;">
            <span>\${${JSON.stringify(title)}}</span>
            <span style="font-size:10px;background:#374151;color:#9ca3af;padding:1px 6px;border-radius:4px;font-weight:normal;">RFC 8252 标准</span>
          </div>
          <div style="font-size:12px;color:#d1d5db;line-height:1.45;margin-bottom:4px;">
            \${${JSON.stringify(tip)}}
          </div>
          <div style="font-size:12px;color:#93c5fd;line-height:1.45;margin-bottom:8px;font-weight:500;">
            \${${JSON.stringify(recommendation)}}
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
            <a href="muse-action://open-browser" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;box-shadow:0 1px 2px rgba(0,0,0,0.2);">
              <span>🌐</span> \${${JSON.stringify(btnOpenBrowser)}}
            </a>
            <a href="muse-action://clear-google-cache" style="background:#374151;color:#e5e7eb;text-decoration:none;padding:5px 12px;border-radius:6px;font-size:12px;border:1px solid #4b5563;display:inline-flex;align-items:center;gap:4px;">
              <span>🧹</span> \${${JSON.stringify(btnClearCache)}}
            </a>
            <button onclick="window.close()" style="background:transparent;color:#9ca3af;border:none;padding:5px 8px;font-size:12px;cursor:pointer;text-decoration:underline;">
              \${${JSON.stringify(btnClose)}}
            </button>
          </div>
        </div>
      </div>
    \`;
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#18181b;color:#f3f4f6;padding:12px 16px;border-bottom:1px solid #3f3f46;box-shadow:0 4px 16px rgba(0,0,0,0.5);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-sizing:border-box;';
    
    const mountBanner = () => {
      if (document.body && !document.getElementById('google-auth-guide')) {
        document.body.prepend(banner);
        document.body.style.paddingTop = '110px';
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountBanner);
    } else {
      mountBanner();
    }
  })();`;
}

async function promptResetGoogleSession() {
  const isZh = state.locale === 'zh-CN';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: isZh ? '重置 Google 登录与风控缓存' : 'Reset Google Login Cache',
    message: isZh 
      ? '是否确认重置当前账号下的 Google 登录会话与风控缓存？'
      : 'Reset Google sign-in session and security cache for the current profile?',
    detail: isZh
      ? '此操作将清除所有 Google 域名的 Cookie 和本地存储，解除 Google 对此会话的风控锁定。'
      : 'This will clear all Google cookies and storage to unlock security flags on this session.',
    buttons: isZh ? ['立即重置', '取消'] : ['Reset Now', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    const curSes = session.fromPartition(partitionFor(state.activeProfileId));
    // 只清活动账号分区 (v1.5.17 一致性修正): defaultSession 不承载任何账号
    // 窗口, 此前顺带清它纯属无效动作, 还会误导「已重置」的判断
    await clearGoogleAuthSession(curSes);
    dialog.showMessageBox({
      type: 'info',
      title: isZh ? '重置完成' : 'Reset Completed',
      message: isZh ? 'Google 登录缓存与风控标记已成功重置。' : 'Google session cache and security flags have been successfully reset.',
      buttons: ['OK'],
    });
  }
}


// ---- 待生效导航 (v1.5.15, 评审 P1-12) ---------------------------------------
// 切站点/改代理此前对所有账号窗口无差别 loadURL/reload, 后台账号未发送的
// 输入、进行中的生成与 OAuth 流程被静默冲掉。改为: 可见窗口立即生效,
// 隐藏窗口只打脏标记, 等它下次被 show 时才真正导航/重载。
const pendingWindowNav = new Map(); // BrowserWindow -> 'site' | 'reload'

function markWindowNavPending(win, mode) {
  if (!win || win.isDestroyed()) return;
  if (mode === 'site') pendingWindowNav.set(win, 'site');
  else if (!pendingWindowNav.has(win)) pendingWindowNav.set(win, 'reload');
}

function applyPendingWindowNav(win) {
  if (!win || win.isDestroyed()) return;
  const mode = pendingWindowNav.get(win);
  if (!mode) return;
  pendingWindowNav.delete(win);
  try {
    if (mode === 'site') win.loadURL(currentSite().url);
    else win.webContents.reload();
  } catch {}
}

// ---- Multi-Window Tab Architecture (Zero-Reload Instant Switching) --------
const profileWindows = new Map(); // profileId -> BrowserWindow
const profileLastActive = new Map(); // profileId -> last shown timestamp
const rendererCrashLog = new Map(); // profileId -> [timestamps]
const MAX_RESIDENT_PROFILE_WINDOWS = 5;

// 渲染进程崩溃有界重建 (v1.5.15, 评审 P1-10): 此前 render-process-gone 零处理,
// renderer 被 OOM/GPU 崩溃杀掉后窗口对象还在、isVisible 仍为 true, 自愈永不
// 触发, 用户面对黑/白屏僵尸窗口。10 分钟内崩溃超过 3 次则停止自动重建并通知。
function handleProfileRendererGone(profileId, win, details) {
  const reason = (details && details.reason) || 'unknown';
  if (reason === 'clean-exit') return;
  console.warn(`[Renderer] profile ${profileId} renderer gone: ${reason}`);
  if (profileWindows.get(profileId) === win) profileWindows.delete(profileId);
  if (mainWindow === win) mainWindow = null;
  pendingWindowNav.delete(win);
  try { win.destroy(); } catch {}
  const now = Date.now();
  const recent = (rendererCrashLog.get(profileId) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  rendererCrashLog.set(profileId, recent);
  if (recent.length > 3) {
    notify('页面反复崩溃', '该账号页面短时间内多次崩溃, 已停止自动重建。请从托盘重新打开或切换账号。');
    return;
  }
  if (profileId === state.activeProfileId) {
    mainWindow = getOrCreateProfileWindow(profileId);
    showWindowSafely(mainWindow);
  }
}

// 常驻窗口 LRU 上限: 每个账号一个完整 Web 应用常驻, 账号越多内存线性增长。
// 超出上限时销毁最久未显示的隐藏窗口 (partition 在磁盘, 重建即恢复登录态)。
function enforceResidentWindowCap() {
  if (profileWindows.size <= MAX_RESIDENT_PROFILE_WINDOWS) return;
  const candidates = [...profileWindows.entries()]
    .filter(([id, w]) => id !== state.activeProfileId && w && !w.isDestroyed() && !w.isVisible())
    .sort((a, b) => (profileLastActive.get(a[0]) || 0) - (profileLastActive.get(b[0]) || 0));
  while (profileWindows.size > MAX_RESIDENT_PROFILE_WINDOWS && candidates.length) {
    const [id, w] = candidates.shift();
    profileWindows.delete(id);
    pendingWindowNav.delete(w);
    closeChildWindows(id);
    try { w.removeAllListeners('close'); w.destroy(); } catch {}
  }
}

function broadcastAccountChange() {
  const payload = {
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    dockPinned: !!(state.ui && state.ui.dockPinned),
    accountGroups: state.accountGroups || ['默认群组'],
    feishu: maskFeishuConfig(state.feishu),
  };
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('account:changed', payload);
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.send('account:changed', payload);
  }
}

function broadcastThemeChange() {
  const currentTheme = state.theme || 'dark';
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('theme:changed', currentTheme);
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.send('theme:changed', currentTheme);
  }
}

function broadcastUISettingsChange() {
  const currentUI = state.ui || { autoHideButtons: true };
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ui-settings:changed', currentUI);
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.send('ui-settings:changed', currentUI);
  }
}

function setAppTheme(theme) {
  state.theme = theme;
  try {
    nativeTheme.themeSource = theme;
  } catch {}
  saveState();
  buildTrayMenu();
  broadcastThemeChange();
}

function broadcastLocaleChange() {
  const currentLocale = state.locale || 'en';
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('locale:changed', currentLocale);
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.send('locale:changed', currentLocale);
  }
  if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
    hotkeyWindow.webContents.send('locale:changed', currentLocale);
  }
}

function setAppLocale(locale) {
  if (locale !== 'zh-CN' && locale !== 'en') return;
  state.locale = locale;
  saveState();
  buildTrayMenu();
  broadcastLocaleChange();
}

function setUIAutoHide(enabled) {
  state.ui = { ...(state.ui || {}), autoHideButtons: !!enabled };
  saveState();
  buildTrayMenu();
  broadcastUISettingsChange();
}


function getOrCreateProfileWindow(profileId, targetBounds, wasMaximized, targetDisplay) {
  let win = profileWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    if (wasMaximized !== undefined) {
      syncWindowStateAndBounds(win, targetBounds, wasMaximized, targetDisplay);
    } else if (targetBounds) {
      win.setBounds(ensureBoundsVisible(targetBounds, null, targetDisplay));
    }
    return win;
  }

  // 确保新窗口的 Session 立即继承全局统一的网络代理配置
  const ses = session.fromPartition(partitionFor(profileId));
  ensureSessionHandlers(profileId);
  applyProxyToSession(ses, profileId);

  const saved = ensureBoundsVisible(
    targetBounds || (state.windowByProfile && state.windowByProfile[profileId]) || state.window || {},
    null,
    targetDisplay
  );
  win = new BrowserWindow({
    width: saved.width || 1200,
    height: saved.height || 800,
    x: typeof saved.x === 'number' ? saved.x : undefined,
    y: typeof saved.y === 'number' ? saved.y : undefined,
    icon: APP_ICON_PATH,
    title: `${currentSite().name} (Muse desktop)`,
    autoHideMenuBar: true,
    backgroundColor: '#141414',
    show: false,
    webPreferences: {
      ...webPrefs(),
      partition: partitionFor(profileId),
    },
  });
  if (wasMaximized) {
    win.maximize();
  }
  if (process.platform !== 'darwin' && fs.existsSync(APP_ICON_PATH)) {
    win.setIcon(APP_ICON_PATH);
  }

  win.webContents.setUserAgent(CHROME_UA);
  win._isContentLoaded = false;
  win.webContents.on('dom-ready', () => {
    win._isContentLoaded = true;
  });
  win.loadURL(currentSite().url);
  win.webContents.on('did-finish-load', () => {
    win._failLoadRetries = 0;
    win._isContentLoaded = true;
    injectMicShim(win);
    broadcastAccountChange();
    broadcastThemeChange();
    broadcastUISettingsChange();
    broadcastLocaleChange();
  });

  // 网络错误处理：主框架加载失败时进行轻量重试并在必要时进入离线页（绝不静默弹窗扰民）
  win.webContents.on('did-fail-load', async (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // 仅在主框架（Main Frame）加载失败时触发诊断自愈，子框架/iframe/资源/第三方埋点失败绝不冲毁主界面
    if (isMainFrame === false) return;

    // 忽略 ERR_ABORTED (-3) 与 ERR_BLOCKED_BY_CSP (-30) 等无害或非致命错误
    if (errorCode === -3 || errorCode === -30) return;

    console.warn(`[Network] Main frame failed to load ${validatedURL}: [${errorCode}] ${errorDescription}`);
    if (validatedURL && validatedURL.includes('offline.html')) return;

    // 目标地址兜底：必须为内部合法站点（如 muse.ai / meta.ai），防止第三方外链或重定向劫持导致离线重试跳出客户端
    const safeTargetUrl = (validatedURL && isInternalSiteUrl(validatedURL)) ? validatedURL : currentSite().url;

    // 轻量瞬态容错重试：代理节点故障转移/网络抖动时会有毫秒级连接重置 (-100/-102/-7)
    // 自动重试 1 次 (延迟 1200ms 等待代理内核故障转移完成)，避免轻微波动直接将用户打入离线页
    win._failLoadRetries = (win._failLoadRetries || 0) + 1;
    if (win._failLoadRetries <= 1 && (errorCode === -100 || errorCode === -102 || errorCode === -7)) {
      console.log(`[Network] Transient connection drop [${errorCode}], retrying in 1200ms (${win._failLoadRetries}/1)...`);
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.loadURL(safeTargetUrl).catch(() => {});
        }
      }, 1200);
      return;
    }

    win.loadFile(path.join(__dirname, 'offline.html'), {
      query: {
        err: errorCode,
        desc: errorDescription,
        url: safeTargetUrl,
      },
    }).catch(() => {});
  });

  attachZoomShortcuts(win);
  attachContextMenu(win);
  setupExternalLinkHandler(win, profileId);

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    // 最小化/隐藏状态下的几何是假值 (合成器占位坐标), 绝不落盘;
    // 最大化时的尺寸也不是普通窗口几何, 一并跳过, 避免还原后得到近全屏窗口
    if (win.isMinimized() || !win.isVisible() || win.isMaximized()) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    // 落盘存用户真实尺寸 (仅做有限性/退化过滤); 尺寸钳制只在加载与显示校验时做,
    // 否则用户的小窗口会被越存越大 (v1.5.13 的副作用, 本版修正)
    if (!(width >= 50 && height >= 50) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const clean = { width: Math.round(width), height: Math.round(height), x: Math.round(x), y: Math.round(y) };
    state.window = clean;
    if (!state.windowByProfile || typeof state.windowByProfile !== 'object') state.windowByProfile = {};
    state.windowByProfile[profileId] = clean;
    saveStateDebounced();
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  win.on('close', (e) => {
    if (!app.quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    pendingWindowNav.delete(win);
    if (profileWindows.get(profileId) === win) profileWindows.delete(profileId);
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on('render-process-gone', (event, details) => {
    handleProfileRendererGone(profileId, win, details);
  });

  profileWindows.set(profileId, win);
  profileLastActive.set(profileId, Date.now());
  enforceResidentWindowCap();
  return win;
}

// 统一的窗口唤回动作: 同步几何/最大化 -> 恢复最小化 -> show -> 置顶聚焦
function showWindowSafely(win, shouldMaximize, targetDisplay) {
  if (!win || win.isDestroyed()) return false;
  if (isScreenLocked) return false;

  // 核心多屏保护：若窗口为最大化状态，严禁调用 setBounds 引入系统边框负坐标！
  if (shouldMaximize || win.isMaximized()) {
    if (win.isMinimized()) win.restore();
    if (!win.isMaximized()) win.maximize();
  } else {
    try { win.setBounds(ensureBoundsVisible(win.getBounds(), null, targetDisplay)); } catch {}
    if (win.isMinimized()) win.restore();
  }

  win.show();
  try { win.moveTop(); } catch {}
  win.focus();
  if (win.isVisible()) {
    for (const [id, w] of profileWindows.entries()) {
      if (w === win) profileLastActive.set(id, Date.now());
    }
    applyPendingWindowNav(win);
  }
  return win.isVisible();
}

function createMainWindow() {
  const win = getOrCreateProfileWindow(state.activeProfileId);
  mainWindow = win;
  // 注意: 必须捕获本次创建的 win 本身; 引用全局 mainWindow 会在首屏未加载完
  // 就切账号时把 ready-to-show 的 show() 打到错误窗口上。
  win.once('ready-to-show', () => {
    if (mainWindow === win) showWindowSafely(win);
  });
}

let quickWindowProfileId = null;
function destroyQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    try { quickWindow.removeAllListeners('closed'); } catch {}
    try { quickWindow.destroy(); } catch {}
  }
  quickWindow = null;
  quickWindowProfileId = null;
}

function createQuickWindow() {
  // partition 必须显式绑定创建瞬间的活动账号; 此前用 webPrefs() 的隐含值
  // 在创建后即冻结, 切账号后快捷窗仍以旧账号登录态工作 (串号, 评审 P0-4)
  quickWindowProfileId = state.activeProfileId;
  ensureSessionHandlers(quickWindowProfileId);
  quickWindow = new BrowserWindow({
    width: 430,
    height: 600,
    icon: APP_ICON_PATH,
    title: `${currentSite().name} quick chat`,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    backgroundColor: '#141414',
    webPreferences: { ...webPrefs(), partition: partitionFor(state.activeProfileId) },
  });
  quickWindow.webContents.setUserAgent(CHROME_UA);
  quickWindow.loadURL(currentSite().url);
  attachContextMenu(quickWindow);
  setupExternalLinkHandler(quickWindow, quickWindowProfileId);
  // Spotlight-style: hide when focus is lost.
  quickWindow.on('blur', () => { if (quickWindow) quickWindow.hide(); });
  quickWindow.on('closed', () => { quickWindow = null; quickWindowProfileId = null; });
}

function closeWindows() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.removeAllListeners('closed');
    quickWindow.close();
    quickWindow = null;
    quickWindowProfileId = null;
  }
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.removeAllListeners('close');
      win.close();
    }
  }
  profileWindows.clear();
  mainWindow = null;
}

let isScreenLocked = false;
let lockWindow = null;
let failedAttempts = 0;
let lockoutUntil = 0;
let lastUserActivityTime = Date.now();
let autoLockTimer = null;

function recordUserActivity() {
  lastUserActivityTime = Date.now();
}

function lockScreen() {
  if (!state.lock || !state.lock.enabled || !state.lock.hash) return;
  if (isScreenLocked) {
    if (lockWindow && !lockWindow.isDestroyed()) {
      lockWindow.show();
      lockWindow.focus();
    }
    return;
  }

  isScreenLocked = true;

  // 1. 隐藏快捷聊天浮窗
  if (quickWindow && !quickWindow.isDestroyed()) {
    try { quickWindow.hide(); } catch {}
  }

  // 2. 隐藏设置窗口
  if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
    try { hotkeyWindow.hide(); } catch {}
  }

  // 3. 无条件全量隐藏所有已有窗口与子窗口，彻底防止主界面被窥视或交互
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && win !== lockWindow && !win.isDestroyed()) {
        try { win.hide(); } catch {}
      }
    }
  } catch {}

  // 4. 更新托盘菜单为锁定保护模式
  buildTrayMenu();

  // 5. 弹出前置锁屏窗
  createLockWindow();
}

function createLockWindow() {
  if (lockWindow && !lockWindow.isDestroyed()) {
    lockWindow.show();
    lockWindow.focus();
    return;
  }

  let workArea = { width: 1280, height: 800 };
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    if (primaryDisplay && primaryDisplay.workAreaSize) {
      workArea = primaryDisplay.workAreaSize;
    }
  } catch {}

  lockWindow = new BrowserWindow({
    width: Math.min(420, workArea.width),
    height: Math.min(520, workArea.height),
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: false,
    center: true,
    show: false,
    icon: APP_ICON_PATH,
    title: 'Muse - 屏幕锁定',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-lock.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  if (process.platform !== 'darwin' && fs.existsSync(APP_ICON_PATH)) {
    lockWindow.setIcon(APP_ICON_PATH);
  }

  lockWindow.loadFile(path.join(__dirname, 'lock.html'));

  lockWindow.once('ready-to-show', () => {
    if (lockWindow && !lockWindow.isDestroyed()) {
      lockWindow.show();
      lockWindow.focus();
    }
  });

  lockWindow.on('close', (e) => {
    if (isScreenLocked && !app.quitting) {
      e.preventDefault();
    }
  });

  lockWindow.on('closed', () => {
    lockWindow = null;
  });
}

function unlockScreen(password) {
  if (!isScreenLocked) return { ok: true };

  const now = Date.now();
  if (lockoutUntil > now) {
    const remainingSec = Math.ceil((lockoutUntil - now) / 1000);
    return { ok: false, error: 'lockout', remainingSec };
  }

  const valid = verifyPassword(password, state.lock.salt, state.lock.hash);
  if (!valid) {
    failedAttempts += 1;
    if (failedAttempts >= 5) {
      lockoutUntil = Date.now() + 30000; // 冷却锁定 30 秒
      failedAttempts = 0;
      return { ok: false, error: 'lockout', remainingSec: 30 };
    }
    return { ok: false, error: 'invalid-password', attemptsLeft: 5 - failedAttempts };
  }

  // 密码正确，解除锁定
  failedAttempts = 0;
  lockoutUntil = 0;
  isScreenLocked = false;
  recordUserActivity();

  if (lockWindow && !lockWindow.isDestroyed()) {
    lockWindow.destroy();
    lockWindow = null;
  }

  showMainWindow();
  buildTrayMenu();
  return { ok: true };
}

function startAutoLockTimer() {
  if (autoLockTimer) clearInterval(autoLockTimer);
  autoLockTimer = setInterval(() => {
    if (isScreenLocked) return;
    if (!state.lock || !state.lock.enabled || !state.lock.autoLockEnabled || !state.lock.hash) return;
    const idleLimitSec = (state.lock.idleMinutes || 15) * 60;
    let systemIdleSec = 0;
    try {
      if (powerMonitor && typeof powerMonitor.getSystemIdleTime === 'function') {
        systemIdleSec = powerMonitor.getSystemIdleTime();
      }
    } catch {}
    const inAppIdleSec = Math.floor((Date.now() - lastUserActivityTime) / 1000);
    const effectiveIdleSec = Math.max(systemIdleSec, inAppIdleSec);
    if (effectiveIdleSec >= idleLimitSec) {
      lockScreen();
    }
  }, 10000);
}

function toggleQuickWindow() {
  if (isScreenLocked) {
    if (lockWindow && !lockWindow.isDestroyed()) {
      lockWindow.show();
      lockWindow.focus();
    }
    return;
  }
  recordUserActivity();
  // 绑定的账号与当前活动账号不一致时先销毁, 下一句按当前账号重建
  if (quickWindow && quickWindowProfileId !== state.activeProfileId) destroyQuickWindow();
  if (!quickWindow) createQuickWindow();
  if (quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const [w, h] = quickWindow.getSize();
    quickWindow.setPosition(
      Math.round(display.bounds.x + (display.bounds.width - w) / 2),
      Math.round(display.bounds.y + (display.bounds.height - h) / 2)
    );
    quickWindow.show();
    quickWindow.focus();
    applyPendingWindowNav(quickWindow);
  }
}

function showMainWindow() {
  if (isScreenLocked) {
    if (lockWindow && !lockWindow.isDestroyed()) {
      lockWindow.show();
      lockWindow.focus();
    } else {
      createLockWindow();
    }
    return;
  }
  recordUserActivity();
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = getOrCreateProfileWindow(state.activeProfileId);
  }
  if (showWindowSafely(mainWindow)) return;
  // 不能在 show() 的同一同步 tick 里以 isVisible() 判死: Wayland/VMware 合成器
  // 异步映射、窗口位于其他工作区时, 健康窗口也会短暂返回 false, 立即销毁会
  // 丢掉该账号未发送的输入 (v1.5.13 评审意见)。改为两段异步复查: 250ms 后
  // 仍不可见先居中重试, 再过 250ms 仍不可见才判定楔死并重建。
  const win = mainWindow;
  setTimeout(() => {
    if (isScreenLocked) return;
    if (!win || win.isDestroyed() || mainWindow !== win || win.isVisible()) return;
    try { win.setBounds(ensureBoundsVisible(win.getBounds())); } catch {}
    win.show();
    win.focus();
    setTimeout(() => {
      if (isScreenLocked) return;
      if (!win || win.isDestroyed() || mainWindow !== win || win.isVisible()) return;
      try {
        if (profileWindows.get(state.activeProfileId) === win) {
          profileWindows.delete(state.activeProfileId);
        }
        win.removeAllListeners('close');
        win.destroy();
      } catch {}
      if (mainWindow === win) mainWindow = null;
      mainWindow = getOrCreateProfileWindow(state.activeProfileId);
      showWindowSafely(mainWindow);
    }, 250);
  }, 250);
}

let currentSwitchTargetId = null;

function switchAccount(id) {
  if (isScreenLocked) return;
  recordUserActivity();
  if (!state.profiles.some((p) => p.id === id)) return;
  if (id === state.activeProfileId && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return;

  const prevWin = mainWindow;
  let wasMaximized = false;
  let targetDisplay = null;
  let normalBounds = null;

  if (prevWin && !prevWin.isDestroyed()) {
    wasMaximized = prevWin.isMaximized();
    try {
      const scr = require('electron').screen;
      targetDisplay = scr.getDisplayMatching(prevWin.getBounds());
    } catch {}
    if (!wasMaximized) {
      normalBounds = prevWin.getBounds();
    }
  }

  currentSwitchTargetId = id;
  state.activeProfileId = id;
  saveState();

  // 获取或复用目标账号的常驻窗口（零重载瞬切，同步多屏与最大化状态）
  const targetWin = getOrCreateProfileWindow(id, normalBounds, wasMaximized, targetDisplay);
  mainWindow = targetWin;

  // 快捷窗的 partition 在创建时绑定, 切账号后必须销毁, 否则它会继续以
  // 上一个账号的登录态响应 (评审 P0-4); 下次打开时按新账号重建
  if (quickWindowProfileId !== id) destroyQuickWindow();

  // 子弹窗跟随账号可见性: 目标账号此前开着的弹窗恢复显示
  setChildWindowsVisible(id, true);

  const applySwitchDone = () => {
    if (targetWin.isDestroyed()) return;
    showWindowSafely(targetWin, wasMaximized, targetDisplay);
    targetWin.focus();

    // 隐藏前一个窗口并强制落盘会话 Cookie; 其子弹窗一并隐藏 (防串号感知)
    if (prevWin && prevWin !== targetWin && !prevWin.isDestroyed()) {
      const prevProfile = state.profiles.find((p) => profileWindows.get(p.id) === prevWin);
      if (prevProfile) setChildWindowsVisible(prevProfile.id, false);
      prevWin.hide();
      try {
        const flushProfile = state.profiles.find((p) => profileWindows.get(p.id) === prevWin);
        if (flushProfile) {
          session.fromPartition(partitionFor(flushProfile.id)).cookies.flushStore().catch(() => {});
        }
      } catch {}
    }

    buildTrayMenu();
    broadcastAccountChange();
  };

  // 核心防黑屏保护：
  // 1. 若目标窗口内容已就绪（且没有在加载），立即完成无感瞬切
  // 2. 若目标窗口是新建或正在加载，先保持原窗口及 Dock 交互可见，
  //    目标窗口 DOM 准备好（dom-ready 或 did-finish-load / did-fail-load）后再平滑切入；
  //    设置 3.5 秒保底超时防止网络阻断一直卡住。
  const isTargetReady = targetWin._isContentLoaded && !targetWin.webContents.isLoading();
  if (isTargetReady || !prevWin || prevWin.isDestroyed() || !prevWin.isVisible()) {
    applySwitchDone();
  } else {
    // 广播正在切换至目标账号（在 Dock 上渲染脉冲/旋转指示）
    for (const w of profileWindows.values()) {
      if (w && !w.isDestroyed()) {
        w.webContents.send('account:switching', { targetProfileId: id });
      }
    }

    let finished = false;
    const onReady = () => {
      if (finished || currentSwitchTargetId !== id) return;
      finished = true;
      try {
        targetWin.webContents.removeListener('dom-ready', onReady);
        targetWin.webContents.removeListener('did-finish-load', onReady);
        targetWin.webContents.removeListener('did-fail-load', onReady);
      } catch {}
      applySwitchDone();
    };

    targetWin.webContents.once('dom-ready', onReady);
    targetWin.webContents.once('did-finish-load', onReady);
    targetWin.webContents.once('did-fail-load', onReady);
    setTimeout(onReady, 3500);
  }
}

function switchProfile(id) {
  switchAccount(id);
}

function nextAccount() {
  if (isScreenLocked) return;
  recordUserActivity();
  if (!state.profiles || state.profiles.length <= 1) return;
  const idx = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const nextIdx = (idx + 1) % state.profiles.length;
  switchAccount(state.profiles[nextIdx].id);
}

function addProfile(customName, customGroup, customPurpose) {
  // 账号 id 必须全局唯一 (v1.5.16, 评审 P2): 此前用 acc_${Date.now()}, 托盘与
  // 页面两入口同毫秒各触发一次即撞号, 两账号共用同一 partition 完全串号,
  // 删其一还会清掉另一个。改用 randomUUID 并做唯一性兜底。
  let id = `acc_${require('crypto').randomUUID()}`;
  while (state.profiles.some((prof) => prof.id === id)) {
    id = `acc_${require('crypto').randomUUID()}`;
  }
  const color = AVATAR_COLORS[state.profiles.length % AVATAR_COLORS.length];
  const name = (customName && customName.trim()) || `账号 ${state.profiles.length + 1}`;
  const group = (customGroup && customGroup.trim()) || (state.accountGroups && state.accountGroups[0]) || '默认群组';
  const purpose = (customPurpose && customPurpose.trim()) || '';
  const profile = {
    id,
    name,
    color,
    group,
    purpose,
    usagePercent: 0,
    usageText: '',
    tokenResetAt: '',
    status: 'normal',
    proxyQueue: [],
    proxyStrategy: 'fallback',
    proxyMode: 'inherit',
    proxyCustom: { type: 'http', host: '127.0.0.1', port: 7897 },
    updatedAt: Date.now(),
  };
  state.profiles.push(profile);
  if (state.accountGroups && !state.accountGroups.includes(group)) {
    state.accountGroups.push(group);
  }
  saveState();
  ensureSessionHandlers(id);

  if (state.mihomo && state.mihomo.enabled) {
    const mm = getMihomoManager();
    if (mm && mm.isRunning) {
      mm.reload(state.profiles, state.mihomo.cachedProxies)
        .then(() => applyProxySettings())
        .catch((e) => console.warn('[Mihomo] Reload on addProfile failed:', e));
    } else {
      applyProxyToSession(session.fromPartition(partitionFor(id)), id);
    }
  } else {
    applyProxyToSession(session.fromPartition(partitionFor(id)), id);
  }

  switchAccount(id);
  notify('新增账号', `${profile.name} 已创建，已就绪独立会话环境。`);
  return profile;
}

// ---- 会话清除工具 (v1.5.16, 评审 P1-13) -------------------------------------
// UI 文案承诺的是「退出当前站点登录」, 旧实现却对整个 partition 无范围
// clearStorageData, 同一账号在另一个站点的登录被一并销毁; 且三条清除路径
// 都漏了 clearCache/clearAuthCache, 缓存中的页面壳与接口响应在登出后仍存活。
async function clearSessionCaches(ses) {
  try { await ses.clearCache(); } catch {}
  try { await ses.clearAuthCache(); } catch {}
}

async function clearSiteSession(ses, site) {
  let origin = '';
  let host = '';
  try {
    const u = new URL(site.url);
    origin = u.origin;
    host = u.hostname.replace(/^www\./, '');
  } catch {}
  if (origin) {
    try { await ses.clearStorageData({ origin }); } catch {}
  }
  if (host) {
    try {
      const cookies = await ses.cookies.get({});
      for (const c of cookies) {
        const d = String(c.domain || '').replace(/^\./, '');
        if (d === host || d.endsWith('.' + host)) {
          await ses.cookies.remove(`https://${d}${c.path || '/'}`, c.name).catch(() => {});
        }
      }
    } catch {}
  }
  await clearSessionCaches(ses);
}

async function clearWholeSession(ses) {
  try { await ses.clearStorageData(); } catch {}
  await clearSessionCaches(ses);
}

async function signOut() {
  // 先关该账号全部子弹窗, 防止清除后弹窗回写 Cookie 让会话复活 (评审 P1-6)
  closeChildWindows(state.activeProfileId);
  const ses = session.fromPartition(partitionFor(state.activeProfileId));
  await clearSiteSession(ses, currentSite());
  const curWin = profileWindows.get(state.activeProfileId);
  if (curWin && !curWin.isDestroyed()) {
    curWin.loadURL(currentSite().url);
  }
  notify('Signed out', `Signed out of ${currentSite().name} on ${activeProfile().name}.`);
}

function toggleSite() {
  if (isScreenLocked) return;
  recordUserActivity();
  state.site = state.site === 'muse' ? 'meta' : 'muse';
  saveState();
  for (const [id, win] of profileWindows.entries()) {
    if (win && !win.isDestroyed()) {
      win.setTitle(`${currentSite().name} (Muse desktop)`);
      // 可见窗口立即切换; 隐藏窗口只打脏标记, 下次 show 时再导航,
      // 避免冲掉后台账号未发送的内容 (评审 P1-12)
      if (win.isVisible()) win.loadURL(currentSite().url);
      else markWindowNavPending(win, 'site');
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.setTitle(`${currentSite().name} quick chat`);
    if (quickWindow.isVisible()) quickWindow.loadURL(currentSite().url);
    else markWindowNavPending(quickWindow, 'site');
  }
  showMainWindow();
  buildTrayMenu();
  notify('切换站点', `已切换至 ${currentSite().name} (${currentSite().url})`);
}

function switchNextMetaAccount() {
  nextAccount();
}

function addMetaAccount() {
  addProfile();
}

function switchMetaAccount() {
  nextAccount();
}

function switchMetaAccountById(id) {
  switchProfile(id);
}

// ---- clipboard -> text file ----------------------------------------------
// Pasting a huge blob into chat can lock the renderer. This dumps the
// clipboard to a .txt instead, so it can be dragged into chat as a file.
function saveClipboardAsFile() {
  const text = clipboard.readText();
  if (!text) {
    notify('Clipboard is empty', 'Copy some text first, then use this again.');
    return;
  }
  const dir = path.join(app.getPath('documents'), 'Muse clips');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(dir, `clip-${stamp}.txt`);
  fs.writeFileSync(fp, text, 'utf8');
  const kb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  notify(
    'Saved clipboard as text file',
    `${path.basename(fp)} (${kb} KB). Click to open its folder, then drag it into chat.`,
    () => shell.showItemInFolder(fp)
  );
}

// ---- permissions ----------------------------------------------------------------
// meta.ai's voice chat needs the microphone. Electron denies permission
// requests by default, so grant audio capture, but only on our two sites.
function isSiteAutomationAllowed(hostname) {
  const auto = state.automation;
  if (!auto.enabled) return false;
  if (auto.autoAllowAll) return true;
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return auto.sites[normalized] === true;
}

function isAutomationActionAllowed(actionKey, hostname) {
  if (!state.automation.enabled) return false;
  if (state.automation.autoAllowAll) return true;
  if (!isSiteAutomationAllowed(hostname)) return false;
  const normalized = String(hostname || '').toLowerCase();
  const siteRules = state.automation.siteActions[normalized];
  if (siteRules && siteRules[actionKey] !== undefined) return !!siteRules[actionKey];
  return state.automation.actions[actionKey] === true;
}

function notifyWebContentsAutomationChange() {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('automation-changed', state.automation);
    }
  }
}

function toggleAutomationMaster(forcedValue) {
  state.automation.enabled = typeof forcedValue === 'boolean' ? forcedValue : !state.automation.enabled;
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  notify(
    state.automation.enabled ? 'Automation Active' : 'Automation Disabled',
    state.automation.enabled
      ? 'Auto-allow rules & shortcuts are active.'
      : 'Auto-allow features have been paused.'
  );
}

// 账号会话的权限拦截与下载处理 (2026-11-22 审查 M1): 此前只在启动时和"新增账号"时设置,
// 导入备份新增的账号在重启前没有权限拦截, Electron 默认会放行麦克风/摄像头/剪贴板/定位等请求。
// 现在任何窗口要用某个账号的会话前都先调用这里; 重复调用安全 (都是覆盖式设置)。
const sessionHandlersReady = new Set();
function ensureSessionHandlers(profileId) {
  if (!profileId || sessionHandlersReady.has(profileId)) return;
  setupDownloadHandler(profileId);
  setupPermissions(profileId);
  setupSessionPersistence(profileId);
  sessionHandlersReady.add(profileId);
}

function setupPermissions(profileId) {
  const ses = session.fromPartition(partitionFor(profileId));
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // 归因优先用请求方 frame 的 URL (评审 P1-14), 回退顶层页面 URL
    let url = '';
    try { url = (details && details.requestingUrl) || webContents.getURL(); } catch { /* ignore */ }
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { /* ignore */ }
    const ours = url.startsWith('https://') && /(^|\.)(muse\.ai|meta\.ai)$/.test(hostname);
    if (!ours) { callback(false); return; }

    // 剪贴板读取默认拒绝: 页面可在无用户手势时静默读取剪贴板内容
    if (permission === 'clipboard-read') { callback(false); return; }
    // 净化写入是站点自身的复制按钮所需, 保持放行
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }

    if (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture') {
      // 自动化规则已明确放行该站点媒体权限时直接通过
      if (state.automation.enabled && isAutomationActionAllowed('media_permissions', hostname)) {
        callback(true);
        return;
      }
      // 否则每次向用户询问, 不再默认放行音视频采集
      const kind = permission === 'videoCapture' ? '摄像头' : (permission === 'audioCapture' ? '麦克风' : '麦克风/摄像头');
      const win = BrowserWindow.fromWebContents(webContents);
      const opts = {
        type: 'question',
        title: '权限请求',
        message: `${hostname} 请求使用${kind}`,
        detail: '仅在使用语音/视频功能时需要。拒绝后该功能不可用, 其他功能不受影响。',
        buttons: ['拒绝', '允许'],
        defaultId: 0,
        cancelId: 0,
      };
      const ask = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
      ask.then(({ response }) => callback(response === 1)).catch(() => callback(false));
      return;
    }

    callback(false);
  });
}

// ---- microphone toggle ------------------------------------------------------
// The page owns its mic device, so the app can't pick it, but it can mute it:
// a tiny shim in the page's own JS world wraps getUserMedia, tracks the
// streams the site creates, and flips their audio tracks on/off.
const MIC_SHIM = `(() => {
  if (window.__micCtl) return;
  const st = { muted: false, streams: new Set() };
  const apply = () => st.streams.forEach((s) => {
    try { s.getAudioTracks().forEach((t) => { t.enabled = !st.muted; }); } catch {}
  });
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (...args) => {
      const stream = await orig(...args);
      st.streams.add(stream);
      stream.getAudioTracks().forEach((t) => { t.enabled = !st.muted; });
      stream.addEventListener('inactive', () => st.streams.delete(stream));
      return stream;
    };
  }
  window.__micCtl = {
    toggle: () => { st.muted = !st.muted; apply(); return st.muted; },
    get: () => st.muted,
  };
})();`;

function injectMicShim(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(MIC_SHIM).catch(() => {});
}

async function toggleMic() {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return;
  try {
    const muted = await w.webContents.executeJavaScript(
      '(() => { const m = window.__micCtl; return m ? m.toggle() : null; })()'
    );
    if (muted === null || muted === undefined) {
      notify('Mic control not ready', 'The page is still loading. Try again in a moment.');
      return;
    }
    notify(muted ? 'Microphone muted' : 'Microphone live', muted ? 'Voice chat cannot hear you.' : 'Voice chat can hear you.');
  } catch (e) {
    notify('Mic toggle failed', String((e && e.message) || e));
  }
}

function toggleSpeaker() {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return;
  const muted = !w.webContents.isAudioMuted();
  w.webContents.setAudioMuted(muted);
  notify(muted ? 'App sound muted' : 'App sound on', muted ? 'You will not hear replies.' : 'You will hear replies.');
}

// ---- hotkey registration & settings -----------------------------------------
function registerHotkeys() {
  for (const [id, acc] of Object.entries(state.hotkeys)) {
    const handler = HOTKEY_ACTIONS[id];
    if (!handler || !acc) continue;
    try {
      if (!globalShortcut.register(acc, handler)) console.warn('hotkey register failed:', id, acc);
    } catch (e) { console.warn('hotkey register threw:', id, acc, e.message); }
  }
}

// Applies a new binding map from the settings window. Returns {ok} or {ok, error}.
function applyHotkeys(bindings) {
  const seen = {};
  const currentLabels = HOTKEY_LABELS[state.locale] || HOTKEY_LABELS.en;
  for (const [id, acc] of Object.entries(bindings)) {
    if (!HOTKEY_ACTIONS[id]) return { ok: false, error: `Unknown action: ${id}` };
    if (!acc || !String(acc).trim()) return { ok: false, error: `Empty hotkey for "${currentLabels[id] || id}"` };
    const norm = String(acc).toLowerCase();
    if (seen[norm]) return { ok: false, error: `Duplicate hotkey: ${acc}` };
    seen[norm] = id;
  }
  globalShortcut.unregisterAll();
  for (const [id, acc] of Object.entries(bindings)) {
    let ok = false;
    try { ok = globalShortcut.register(acc, HOTKEY_ACTIONS[id]); } catch { ok = false; }
    if (!ok) {
      globalShortcut.unregisterAll();
      registerHotkeys(); // roll back to the previous working set
      return { ok: false, error: `Could not register ${acc} (taken by Windows or another app?)` };
    }
  }
  state.hotkeys = { ...bindings };
  saveState();
  buildTrayMenu();
  return { ok: true };
}

let hotkeyWindow = null;
function openHotkeySettings(initialTab) {
  if (isScreenLocked) return;
  recordUserActivity();
  if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
    hotkeyWindow.focus();
    if (initialTab) hotkeyWindow.webContents.send('switch-tab', initialTab);
    return;
  }
  hotkeyWindow = new BrowserWindow({
    width: 650,
    height: 750,
    icon: APP_ICON_PATH,
    title: 'Customize hotkeys & settings',
    resizable: true,
    minWidth: 540,
    minHeight: 640,
    maximizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      // 显式写明, 不依赖 Electron 默认值 (2026-11-22 审查 L4)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform !== 'darwin' && fs.existsSync(APP_ICON_PATH)) {
    hotkeyWindow.setIcon(APP_ICON_PATH);
  }
  hotkeyWindow.loadFile(path.join(__dirname, 'hotkeys.html'));
  hotkeyWindow.webContents.on('did-finish-load', () => {
    if (initialTab) hotkeyWindow.webContents.send('switch-tab', initialTab);
  });
  hotkeyWindow.on('closed', () => { hotkeyWindow = null; });
}

// ---- IPC 来源校验 (v1.5.14, 评审 P0-3) --------------------------------------
// 此前全部 ipcMain 通道零 sender 校验, 且聊天 preload 把 automationAPI 等桥
// 暴露给网页主世界: 任何进入窗口的页面 (含弹窗放行的第三方站点) 都能调用
// 改代理/删账号/全开 Auto-Allow 等特权通道。现在统一门禁: 只接受本应用自有
// 窗口 (账号窗/快捷窗/设置窗, 不含 OAuth 等子弹窗) 的主 frame, 且页面必须是
// https 的 muse.ai/meta.ai 或本地 file:// 页面 (离线页/设置页)。
function isValidHostname(name) {
  if (!name || typeof name !== 'string') return false;
  const h = name.trim().toLowerCase();
  return h.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h);
}

function isTrustedIpcSender(e) {
  try {
    if (!e || !e.sender || (typeof e.sender.isDestroyed === 'function' && e.sender.isDestroyed())) return false;
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) return false;
    const owned = [mainWindow, quickWindow, hotkeyWindow, lockWindow, ...profileWindows.values()];
    if (!owned.some((w) => w && !w.isDestroyed() && w.webContents === e.sender)) return false;
    const raw = frame.url || '';
    if (raw.startsWith('file://')) return true;
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'muse.ai' || h.endsWith('.muse.ai') || h === 'meta.ai' || h.endsWith('.meta.ai');
  } catch { return false; }
}

const denyUntrusted = (e) => !isTrustedIpcSender(e);

ipcMain.handle('hotkeys-get', (e) => {
  if (denyUntrusted(e)) return undefined;
  const currentLabels = HOTKEY_LABELS[state.locale] || HOTKEY_LABELS.en;
  return {
    bindings: { ...state.hotkeys },
    labels: { ...currentLabels },
    defaults: { ...DEFAULT_HOTKEYS },
  };
});
ipcMain.handle('hotkeys-set', (e, bindings) => (denyUntrusted(e) ? { ok: false, error: 'untrusted sender' } : applyHotkeys(bindings || {})));

// Automation IPC handlers
ipcMain.handle('automation-get', (e) => (denyUntrusted(e) ? undefined : ({
  ...state.automation,
  currentSiteUrl: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '',
})));

ipcMain.handle('automation-set', (e, updates) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!updates || typeof updates !== 'object') return { ok: false };
  if (typeof updates.enabled === 'boolean') state.automation.enabled = updates.enabled;
  if (typeof updates.autoAllowAll === 'boolean') state.automation.autoAllowAll = updates.autoAllowAll;
  if (typeof updates.showOnScreenWidget === 'boolean') state.automation.showOnScreenWidget = updates.showOnScreenWidget;
  if (updates.actions && typeof updates.actions === 'object') {
    state.automation.actions = { ...state.automation.actions, ...updates.actions };
  }
  if (updates.sites && typeof updates.sites === 'object') {
    // 站点键必须是合法 hostname: 脏键会被持久化并在设置页渲染 (评审 P0-3 的 XSS 链)
    state.automation.sites = Object.fromEntries(
      Object.entries(updates.sites).filter(([k]) => isValidHostname(k)).map(([k, v]) => [k.toLowerCase(), !!v])
    );
  }
  if (updates.siteActions && typeof updates.siteActions === 'object') {
    state.automation.siteActions = Object.fromEntries(
      Object.entries(updates.siteActions).filter(([k]) => isValidHostname(k)).map(([k, v]) => [k.toLowerCase(), (v && typeof v === 'object') ? v : {}])
    );
  }
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, state: state.automation };
});

ipcMain.handle('automation-toggle-site', (e, hostname, enabled) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!isValidHostname(hostname)) return { ok: false, error: 'Invalid hostname' };
  const norm = hostname.toLowerCase();
  if (typeof enabled === 'boolean') {
    state.automation.sites[norm] = enabled;
  } else {
    const current = isSiteAutomationAllowed(norm);
    state.automation.sites[norm] = !current;
  }
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, allowed: isSiteAutomationAllowed(norm), sites: state.automation.sites };
});

ipcMain.handle('automation-set-site-action', (e, hostname, actionKey, enabled) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!isValidHostname(hostname) || state.automation.actions[actionKey] === undefined) return { ok: false, error: 'Unknown site or action' };
  const norm = String(hostname).toLowerCase();
  state.automation.siteActions[norm] = { ...(state.automation.siteActions[norm] || {}), [actionKey]: !!enabled };
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, siteActions: state.automation.siteActions };
});

ipcMain.handle('automation-set-action', (e, actionKey, enabled) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (state.automation.actions[actionKey] !== undefined) {
    state.automation.actions[actionKey] = !!enabled;
    saveState();
    buildTrayMenu();
    notifyWebContentsAutomationChange();
    return { ok: true, actions: state.automation.actions };
  }
  return { ok: false, error: 'Unknown action' };
});

ipcMain.handle('open-settings', (e, tab) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  openHotkeySettings(tab);
  return { ok: true };
});

// 多账号管理 IPC handlers
ipcMain.handle('account:get-state', (e) => (denyUntrusted(e) ? undefined : ({
  profiles: state.profiles,
  activeProfileId: state.activeProfileId,
  dockPinned: !!(state.ui && state.ui.dockPinned),
  accountGroups: state.accountGroups || ['默认群组'],
  feishu: maskFeishuConfig(state.feishu),
})));

ipcMain.handle('dock:set-pinned', (e, { pinned }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!state.ui) state.ui = { autoHideButtons: true, dockPinned: false };
  state.ui.dockPinned = !!pinned;
  saveState();
  broadcastAccountChange();
  return { ok: true, pinned: state.ui.dockPinned };
});

ipcMain.handle('account:switch', (e, { id }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  switchAccount(id);
  return { ok: true };
});

ipcMain.handle('account:add', (e, { name, group, purpose }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const prof = addProfile(name, group, purpose);
  return { ok: true, profile: prof };
});

ipcMain.handle('account:update-meta', (e, { id, name, group, purpose, usagePercent, usageText, tokenResetAt, status }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const p = state.profiles.find((item) => item.id === id);
  if (!p) return { ok: false, error: 'Account not found' };

  if (typeof name === 'string' && name.trim()) p.name = name.trim();
  if (typeof group === 'string' && group.trim()) {
    p.group = group.trim();
    if (!state.accountGroups.includes(p.group)) {
      state.accountGroups.push(p.group);
    }
  }
  if (typeof purpose === 'string') p.purpose = purpose.trim();
  if (typeof usagePercent === 'number') {
    p.usagePercent = Math.max(0, Math.min(100, Math.round(usagePercent)));
  }
  if (typeof usageText === 'string') p.usageText = usageText.trim();
  if (typeof tokenResetAt === 'string') p.tokenResetAt = formatDateTime(tokenResetAt.trim());
  if (['normal', 'warning', 'exhausted', 'idle'].includes(status)) {
    p.status = status;
  }
  p.updatedAt = Date.now();

  saveState();
  buildTrayMenu();
  broadcastAccountChange();
  return { ok: true, profile: p };
});

// 飞书配置发给页面前把 App Secret 换成占位符 (审查 M5)
function maskFeishuConfig(cfg) {
  const c = cfg || defaultFeishuConfig();
  return { ...c, appSecret: c.appSecret ? FEISHU_SECRET_MASK : '', hasAppSecret: !!c.appSecret };
}

ipcMain.handle('feishu:get-config', (e) => {
  if (denyUntrusted(e)) return undefined;
  return maskFeishuConfig(state.feishu);
});

ipcMain.handle('feishu:save-config', (e, config) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!config || typeof config !== 'object') return { ok: false, error: 'Invalid config' };

  // 页面回传占位符或未传时保留原 Secret; 传空字符串表示用户主动清除
  const incoming = { ...config };
  if (typeof incoming.appSecret !== 'string' || incoming.appSecret === FEISHU_SECRET_MASK) delete incoming.appSecret;
  delete incoming.hasAppSecret;
  // 外部 CLI 路径会被当作程序执行, 不接受页面传入 (审查 M2); 设置页本来也不传这个字段
  delete incoming.customCliPath;

  state.feishu = {
    ...defaultFeishuConfig(),
    ...(state.feishu || {}),
    ...incoming,
    fieldMap: {
      ...defaultFeishuConfig().fieldMap,
      ...((state.feishu && state.feishu.fieldMap) || {}),
      ...(incoming.fieldMap || {}),
    },
  };

  saveState();
  setupFeishuAutoSync(state.feishu, () => state.profiles, () => {
    saveState();
    buildTrayMenu();
    broadcastAccountChange();
  });
  broadcastAccountChange();
  return { ok: true, feishu: maskFeishuConfig(state.feishu) };
});

ipcMain.handle('feishu:sync-now', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  try {
    const res = await executeFeishuSync(state.feishu, state.profiles, () => {
      saveState();
      buildTrayMenu();
      broadcastAccountChange();
    });
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('account:rename', (e, { id, name }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const p = state.profiles.find((item) => item.id === id);
  if (p) {
    p.name = (name && name.trim()) || p.name;
    saveState();
    buildTrayMenu();
    broadcastAccountChange();
    return { ok: true };
  }
  return { ok: false, error: 'Account not found' };
});

ipcMain.handle('account:reorder', (e, { orderedIds }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!Array.isArray(orderedIds)) return { ok: false, error: 'orderedIds must be an array' };
  if (!Array.isArray(state.profiles) || state.profiles.length === 0) {
    return { ok: false, error: 'No profiles' };
  }

  const profileMap = new Map(state.profiles.map((p) => [p.id, p]));
  // 必须数量一致且包含全部现有 id，防止数据丢失或注入
  if (orderedIds.length !== state.profiles.length || !orderedIds.every((id) => profileMap.has(id))) {
    return { ok: false, error: 'Profiles mismatch or invalid ids' };
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, error: 'Duplicate ids in orderedIds' };
  }

  state.profiles = orderedIds.map((id) => profileMap.get(id));
  saveState();
  buildTrayMenu();
  broadcastAccountChange();

  if (state.mihomo && state.mihomo.enabled) {
    const mm = getMihomoManager();
    if (mm && mm.isRunning) {
      mm.reload(state.profiles, state.mihomo.cachedProxies)
        .then(() => applyProxySettings())
        .catch((e) => console.warn('[Mihomo] Reload on account reorder failed:', e));
    }
  }

  return { ok: true };
});

ipcMain.handle('account:sort-by-reset-time', (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!Array.isArray(state.profiles) || state.profiles.length === 0) {
    return { ok: false, error: 'No profiles' };
  }
  sortProfilesByResetTime(state.profiles);
  saveState();
  buildTrayMenu();
  broadcastAccountChange();

  if (state.mihomo && state.mihomo.enabled) {
    const mm = getMihomoManager();
    if (mm && mm.isRunning) {
      mm.reload(state.profiles, state.mihomo.cachedProxies)
        .then(() => applyProxySettings())
        .catch((err) => console.warn('[Mihomo] Reload on reset-time sort failed:', err));
    }
  }

  return { ok: true, profiles: state.profiles };
});

ipcMain.handle('account:sign-out', async (e, { id }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const targetId = id || state.activeProfileId;
  closeChildWindows(targetId);
  const targetSession = session.fromPartition(partitionFor(targetId));
  try {
    await clearSiteSession(targetSession, currentSite());
    console.log(`[Account] Signed out of ${currentSite().name} for ${targetId}`);
  } catch (err) {
    console.warn('[Account] Sign-out clear error:', err);
  }
  const targetWin = profileWindows.get(targetId);
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.loadURL(currentSite().url);
  }
  return { ok: true };
});

ipcMain.handle('account:delete', async (e, { id }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (state.profiles.length <= 1) {
    return { ok: false, error: '至少保留一个账号' };
  }
  const idx = state.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: '账号不存在' };

  // 原子化删除 (v1.5.16, 评审 P2): 旧顺序先清数据、最后才从 profiles 摘除,
  // await 期间该账号仍可被切回使用并与清除竞态。改为先关弹窗与窗口, 立刻
  // 从状态中摘除并落盘 (账号即刻不可见、不可切回), 之后再清会话与磁盘目录。
  closeChildWindows(id);
  const win = profileWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('close');
    win.close();
  }
  profileWindows.delete(id);
  pendingWindowNav.delete(win);

  const wasActive = state.activeProfileId === id;
  state.profiles.splice(idx, 1);
  if (state.windowByProfile) delete state.windowByProfile[id];
  pruneProfilePorts();
  if (wasActive) state.activeProfileId = state.profiles[0].id;
  saveState();
  buildTrayMenu();
  broadcastAccountChange();

  await clearWholeSession(session.fromPartition(partitionFor(id)));
  // partition 的磁盘目录一并删除, 不留孤儿会话残留 (失败忽略, 不阻塞结果)
  try {
    const partRoot = path.resolve(app.getPath('userData'), 'Partitions');
    const partDir = path.resolve(partRoot, partitionFor(id).replace(/^persist:/, ''));
    // 只删 Partitions 目录下的直接子目录, 防止异常 id 让递归删除越界 (审查 H2)
    if (SAFE_ID_RE.test(id) && path.dirname(partDir) === partRoot) {
      await fs.promises.rm(partDir, { recursive: true, force: true });
    }
  } catch {}

  if (wasActive) {
    mainWindow = getOrCreateProfileWindow(state.activeProfileId);
    showWindowSafely(mainWindow);
  }

  if (state.mihomo && state.mihomo.enabled) {
    const mm = getMihomoManager();
    if (mm && mm.isRunning) {
      mm.reload(state.profiles, state.mihomo.cachedProxies)
        .then(() => applyProxySettings())
        .catch((e) => console.warn('[Mihomo] Reload on account delete failed:', e));
    }
  }

  return { ok: true };
});

// 网络与代理配置 IPC handlers
ipcMain.handle('proxy-get', (e) => {
  if (denyUntrusted(e)) return undefined;
  return state.proxy || defaultProxy();
});

ipcMain.handle('proxy-set', async (e, config) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!config || typeof config !== 'object') return { ok: false, error: 'Invalid proxy configuration' };
  // 字段级校验: host/type/port 将被拼进 proxyRules, 脏值可注入额外代理规则 (评审 P2)
  if (config.mode === 'custom') {
    if (!['http', 'https', 'socks5'].includes(String(config.type || 'http'))) return { ok: false, error: 'Invalid proxy type' };
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Invalid proxy port' };
    const host = String(config.host || '');
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
    if (!isIp && !isValidHostname(host) && host !== 'localhost') return { ok: false, error: 'Invalid proxy host' };
    config = { ...config, port };
  }
  state.proxy = {
    ...defaultProxy(),
    ...config,
  };
  saveState();
  await applyProxySettings();
  // 可见窗口立即重载生效; 隐藏窗口打脏标记, 下次 show 时再重载 (评审 P1-12)
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) win.webContents.reload();
      else markWindowNavPending(win, 'reload');
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    if (quickWindow.isVisible()) quickWindow.webContents.reload();
    else markWindowNavPending(quickWindow, 'reload');
  }
  return { ok: true };
});


// 内置 Mihomo 智能代理分流 IPC handlers
ipcMain.handle('mihomo:get-config', (e) => {
  if (denyUntrusted(e)) return undefined;
  const mm = getMihomoManager();
  return {
    ...(state.mihomo || defaultMihomoConfig()),
    isRunning: mm ? mm.isRunning : false,
    portMap: mm ? mm.portMap : {},
    executablePath: mm ? mm.findExecutable() : null,
    nodeCount: (state.mihomo && Array.isArray(state.mihomo.cachedProxies)) ? state.mihomo.cachedProxies.length : 0,
  };
});

ipcMain.handle('mihomo:choose-local-yaml', async (e) => {
  if (denyUntrusted(e)) return { canceled: true };
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(senderWin || hotkeyWindow || mainWindow, {
    title: '选择 Clash / Mihomo 本地 YAML 节点文件',
    filters: [
      { name: 'Clash YAML 配置文件 (*.yaml;*.yml)', extensions: ['yaml', 'yml'] },
      { name: '所有文件 (*.*)', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return { canceled: true };
  }
  const filePath = res.filePaths[0];
  const defaultName = path.basename(filePath, path.extname(filePath));
  return { canceled: false, filePath, defaultName };
});

ipcMain.handle('mihomo:choose-custom-bin', async (e) => {
  if (denyUntrusted(e)) return { canceled: true };
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  const isWin = process.platform === 'win32';
  const res = await dialog.showOpenDialog(senderWin || hotkeyWindow || mainWindow, {
    title: '选择 Mihomo 二进制内核可执行文件',
    filters: [
      { name: 'Mihomo 可执行程序', extensions: isWin ? ['exe'] : ['*'] },
      { name: '所有文件 (*.*)', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return { canceled: true };
  }
  const chosenPath = res.filePaths[0];
  state.mihomo = state.mihomo || defaultMihomoConfig();
  state.mihomo.customBinPath = chosenPath;
  saveState();
  const mm = getMihomoManager();
  mm.binPath = chosenPath;
  return { ok: true, path: chosenPath };
});

ipcMain.handle('mihomo:clear-custom-bin', async (e) => {
  if (denyUntrusted(e)) return { ok: false };
  state.mihomo = state.mihomo || defaultMihomoConfig();
  state.mihomo.customBinPath = '';
  saveState();
  const mm = getMihomoManager();
  mm.binPath = '';
  return { ok: true };
});

ipcMain.handle('mihomo:add-source', async (e, payload) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const { type, name, target } = payload || {};
  if (!target || typeof target !== 'string' || !target.trim()) {
    return { ok: false, error: '目标链接或文件路径不能为空' };
  }
  const cleanTarget = target.trim();
  const cleanType = type === 'file' ? 'file' : 'url';
  const cleanName = (typeof name === 'string' && name.trim())
    ? name.trim()
    : (cleanType === 'file' ? path.basename(cleanTarget, path.extname(cleanTarget)) : '新订阅');

  const mm = getMihomoManager();
  const sourceId = 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  let initialProxies = [];
  let nodeCount = 0;
  let subInfo = null;

  if (cleanType === 'file') {
    const parsed = mm.parseLocalYaml(cleanTarget);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    initialProxies = parsed.proxies || [];
    nodeCount = parsed.nodeCount || 0;
  } else {
    const subRes = await mm.fetchSubscription(cleanTarget, sourceId);
    if (!subRes.ok) {
      return { ok: false, error: subRes.error };
    }
    initialProxies = subRes.proxies || [];
    nodeCount = subRes.nodeCount || 0;
    subInfo = subRes.subInfo;
  }

  const newSource = {
    id: sourceId,
    type: cleanType,
    name: cleanName,
    target: cleanTarget,
    enabled: true,
    nodeCount,
    updatedAt: new Date().toISOString(),
    cachedProxies: initialProxies,
    subscriptionUserinfo: (subInfo && subInfo.subscriptionUserinfo) || '',
  };

  if (!Array.isArray(state.mihomo.sources)) {
    state.mihomo.sources = [];
  }
  state.mihomo.sources.push(newSource);
  const merged = await refreshMihomoMergedProxiesAndReload(true);

  return {
    ok: true,
    source: newSource,
    totalNodes: merged.length,
    portMap: mm.portMap,
  };
});

ipcMain.handle('mihomo:update-source', async (e, payload) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const { sourceId, updates } = payload || {};
  if (!sourceId || !Array.isArray(state.mihomo.sources)) {
    return { ok: false, error: '未找到指定源' };
  }
  const idx = state.mihomo.sources.findIndex(s => s && s.id === sourceId);
  if (idx === -1) return { ok: false, error: '指定源不存在' };

  const src = state.mihomo.sources[idx];
  if (updates) {
    if (typeof updates.name === 'string' && updates.name.trim()) {
      src.name = updates.name.trim();
    }
    if (typeof updates.enabled === 'boolean') {
      src.enabled = updates.enabled;
    }
    if (typeof updates.target === 'string' && updates.target.trim() && updates.target.trim() !== src.target) {
      src.target = updates.target.trim();
      const mm = getMihomoManager();
      if (src.type === 'file') {
        const parsed = mm.parseLocalYaml(src.target);
        if (parsed.ok) {
          src.cachedProxies = parsed.proxies || [];
          src.nodeCount = parsed.nodeCount || 0;
          src.updatedAt = new Date().toISOString();
        }
      } else {
        const subRes = await mm.fetchSubscription(src.target, src.id);
        if (subRes.ok) {
          src.cachedProxies = subRes.proxies || [];
          src.nodeCount = subRes.nodeCount || 0;
          src.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  const merged = await refreshMihomoMergedProxiesAndReload(true);
  const mm = getMihomoManager();
  return { ok: true, source: src, totalNodes: merged.length, portMap: mm.portMap };
});

ipcMain.handle('mihomo:remove-source', async (e, sourceId) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!sourceId || !Array.isArray(state.mihomo.sources)) {
    return { ok: false, error: '未找到指定源' };
  }
  const idx = state.mihomo.sources.findIndex(s => s && s.id === sourceId);
  if (idx === -1) return { ok: false, error: '指定源不存在' };

  state.mihomo.sources.splice(idx, 1);
  const merged = await refreshMihomoMergedProxiesAndReload(true);
  const mm = getMihomoManager();
  return { ok: true, totalNodes: merged.length, portMap: mm.portMap };
});

ipcMain.handle('mihomo:sync-source', async (e, sourceId) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!sourceId || !Array.isArray(state.mihomo.sources)) {
    return { ok: false, error: '未找到指定源' };
  }
  const src = state.mihomo.sources.find(s => s && s.id === sourceId);
  if (!src) return { ok: false, error: '指定源不存在' };

  const mm = getMihomoManager();
  if (src.type === 'file') {
    const parsed = mm.parseLocalYaml(src.target);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    src.cachedProxies = parsed.proxies || [];
    src.nodeCount = parsed.nodeCount || 0;
    src.updatedAt = new Date().toISOString();
  } else {
    const subRes = await mm.fetchSubscription(src.target, src.id);
    if (!subRes.ok) {
      return { ok: false, error: subRes.error };
    }
    src.cachedProxies = subRes.proxies || [];
    src.nodeCount = subRes.nodeCount || 0;
    src.updatedAt = new Date().toISOString();
    if (subRes.subInfo && subRes.subInfo.subscriptionUserinfo) {
      src.subscriptionUserinfo = subRes.subInfo.subscriptionUserinfo;
    }
  }

  const merged = await refreshMihomoMergedProxiesAndReload(true);
  const mm2 = getMihomoManager();
  return { ok: true, source: src, totalNodes: merged.length, portMap: mm2.portMap };
});

ipcMain.handle('mihomo:sync-all-sources', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!Array.isArray(state.mihomo.sources) || state.mihomo.sources.length === 0) {
    return { ok: false, error: '尚未添加任何订阅或本地 YAML 源' };
  }

  const mm = getMihomoManager();
  const errors = [];
  let updatedCount = 0;

  for (const src of state.mihomo.sources) {
    if (!src || src.enabled === false) continue;
    try {
      if (src.type === 'file') {
        const parsed = mm.parseLocalYaml(src.target);
        if (parsed.ok) {
          src.cachedProxies = parsed.proxies || [];
          src.nodeCount = parsed.nodeCount || 0;
          src.updatedAt = new Date().toISOString();
          updatedCount++;
        } else {
          errors.push(`[${src.name}]: ${parsed.error}`);
        }
      } else {
        const subRes = await mm.fetchSubscription(src.target, src.id);
        if (subRes.ok) {
          src.cachedProxies = subRes.proxies || [];
          src.nodeCount = subRes.nodeCount || 0;
          src.updatedAt = new Date().toISOString();
          if (subRes.subInfo && subRes.subInfo.subscriptionUserinfo) {
            src.subscriptionUserinfo = subRes.subInfo.subscriptionUserinfo;
          }
          updatedCount++;
        } else {
          errors.push(`[${src.name}]: ${subRes.error}`);
        }
      }
    } catch (err) {
      errors.push(`[${src.name}]: ${err.message}`);
    }
  }

  const merged = await refreshMihomoMergedProxiesAndReload(true);
  return {
    ok: errors.length === 0 || updatedCount > 0,
    updatedCount,
    totalNodes: merged.length,
    errors: errors.length > 0 ? errors : null,
    sources: state.mihomo.sources,
    portMap: mm.portMap,
  };
});

ipcMain.handle('mihomo:set-config', async (e, cfg) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'Invalid configuration' };

  const prevState = state.mihomo ? { ...state.mihomo } : defaultMihomoConfig();
  const prevEnabled = !!prevState.enabled;
  // 只接受页面真正需要修改的字段 (2026-11-22 审查 M2): 内核路径只能经"指定内核"对话框设置,
  // 端口分配表只由主进程维护, 订阅源走各自的接口; 其余字段一律忽略
  const safeCfg = {};
  if (typeof cfg.enabled === 'boolean') safeCfg.enabled = cfg.enabled;
  if (typeof cfg.strictIsolation === 'boolean') safeCfg.strictIsolation = cfg.strictIsolation;
  const autoUpd = parseInt(cfg.autoUpdateInterval, 10);
  if (autoUpd >= 1 && autoUpd <= 720) safeCfg.autoUpdateInterval = autoUpd;
  const basePort = parseInt(cfg.basePort, 10);
  if (basePort >= 1024 && basePort <= 65000) safeCfg.basePort = basePort;
  state.mihomo = {
    ...defaultMihomoConfig(),
    ...prevState,
    ...safeCfg,
    portByProfile: prevState.portByProfile || {},
  };
  if (typeof safeCfg.strictIsolation !== 'undefined') state.mihomo.strictIsolation = safeCfg.strictIsolation === true;
  if (safeCfg.basePort !== undefined && safeCfg.basePort !== prevState.basePort) {
    // 起始端口改了: 按当前账号顺序重新固定一遍
    state.mihomo.portByProfile = {};
    for (const p of state.profiles || []) ensureProfilePort(p.id);
  }

  const mm = getMihomoManager();
  if (state.mihomo.enabled) {
    // 确保使用最新合并的源节点
    const merged = mm.mergeSourceProxies(state.mihomo.sources);
    if (merged && merged.length > 0) {
      state.mihomo.cachedProxies = merged;
    }
    let coreRes = null;
    if (!mm.isRunning) {
      coreRes = await mm.start(state.profiles, state.mihomo.cachedProxies);
    } else {
      coreRes = await mm.reload(state.profiles, state.mihomo.cachedProxies);
    }
    if (!coreRes || !coreRes.ok) {
      // 启动/重载失败时不保存假启用状态，直接回滚并透传真实错误
      state.mihomo.enabled = prevEnabled;
      saveState();
      return {
        ok: false,
        error: (coreRes && coreRes.error) || 'Mihomo 内核启动失败，请检查 mihomo.log',
        isRunning: mm.isRunning,
        portMap: mm.portMap,
      };
    }
  } else if (prevEnabled && !state.mihomo.enabled) {
    mm.stop();
  }

  saveState();
  await applyProxySettings();

  // 同步重载可见窗口（隐藏窗口打脏标记），确保网页即时切至独立 Mihomo 端口或恢复常规代理
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) win.webContents.reload();
      else markWindowNavPending(win, 'reload');
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    if (quickWindow.isVisible()) quickWindow.webContents.reload();
    else markWindowNavPending(quickWindow, 'reload');
  }

  return { ok: true, isRunning: mm.isRunning, portMap: mm.portMap };
});

ipcMain.handle('mihomo:sync-subscription', async (e, urlToSync) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const targetUrl = typeof urlToSync === 'string' && urlToSync.trim() ? urlToSync.trim() : (state.mihomo && state.mihomo.subscriptionUrl);
  if (!targetUrl) return { ok: false, error: '请先填写有效的机场订阅 URL' };

  const mm = getMihomoManager();
  const subRes = await mm.fetchSubscription(targetUrl);
  if (!subRes.ok) {
    return { ok: false, error: subRes.error };
  }

  state.mihomo = {
    ...defaultMihomoConfig(),
    ...(state.mihomo || {}),
    subscriptionUrl: targetUrl,
    lastUpdated: new Date().toISOString(),
    cachedProxies: subRes.proxies || [],
  };
  saveState();

  // 若已开启，自动热更新内核配置
  if (state.mihomo.enabled) {
    if (mm.isRunning) {
      await mm.reload(state.profiles, state.mihomo.cachedProxies);
    } else {
      await mm.start(state.profiles, state.mihomo.cachedProxies);
    }
    await applyProxySettings();
  }

  return {
    ok: true,
    nodeCount: subRes.proxies.length,
    proxies: subRes.proxies,
    subInfo: subRes.subInfo
  };
});

ipcMain.handle('mihomo:get-nodes', (e) => {
  if (denyUntrusted(e)) return undefined;
  return (state.mihomo && Array.isArray(state.mihomo.cachedProxies)) ? state.mihomo.cachedProxies : [];
});

ipcMain.handle('mihomo:test-delay', async (e, proxyName) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const mm = getMihomoManager();
  if (!mm || !mm.isRunning) return { ok: false, error: 'Mihomo 内核未运行' };
  return mm.testNodeDelay(proxyName);
});

ipcMain.handle('mihomo:restart-kernel', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const mm = getMihomoManager();
  if (!mm) return { ok: false, error: 'Mihomo 管理器未初始化' };
  const res = await mm.restart(state.profiles, (state.mihomo && state.mihomo.cachedProxies) || []);
  if (res && res.ok) {
    await applyProxySettings();
  }
  return res;
});

ipcMain.handle('mihomo:stop-kernel', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const mm = getMihomoManager();
  if (!mm) return { ok: false, error: 'Mihomo 管理器未初始化' };
  mm.stop();
  if (state.mihomo) state.mihomo.enabled = false;
  saveState();
  await applyProxySettings();
  return { ok: true };
});

ipcMain.handle('mihomo:start-kernel', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const mm = getMihomoManager();
  if (!mm) return { ok: false, error: 'Mihomo 管理器未初始化' };
  if (state.mihomo) state.mihomo.enabled = true;
  saveState();
  const res = await mm.start(state.profiles, (state.mihomo && state.mihomo.cachedProxies) || []);
  if (res && res.ok) {
    await applyProxySettings();
  }
  return res;
});

ipcMain.handle('account:set-proxy-queue', async (e, payload) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const { profileId, proxyQueue, proxyStrategy, proxyMode, proxyCustom } = payload || {};
  if (!profileId || typeof profileId !== 'string') return { ok: false, error: 'Invalid profileId' };

  const targetProf = state.profiles.find((p) => p.id === profileId);
  if (!targetProf) return { ok: false, error: 'Profile not found' };

  targetProf.proxyQueue = Array.isArray(proxyQueue) ? proxyQueue.filter((n) => typeof n === 'string' && n.trim()) : [];
  if (['fallback', 'url-test', 'load-balance', 'select'].includes(proxyStrategy)) {
    targetProf.proxyStrategy = proxyStrategy;
  }
  if (['inherit', 'system', 'mihomo', 'direct', 'custom'].includes(proxyMode)) {
    targetProf.proxyMode = proxyMode;
  }
  if (proxyCustom && typeof proxyCustom === 'object') {
    targetProf.proxyCustom = {
      type: ['http', 'socks5'].includes(proxyCustom.type) ? proxyCustom.type : 'http',
      host: typeof proxyCustom.host === 'string' && proxyCustom.host.trim() ? proxyCustom.host.trim() : '127.0.0.1',
      port: parseInt(proxyCustom.port, 10) || 7897,
    };
  }
  saveState();

  const mm = getMihomoManager();
  if (state.mihomo && state.mihomo.enabled && mm && mm.isRunning) {
    await mm.reload(state.profiles, state.mihomo.cachedProxies);
  }

  // 重新应用该账号的分区代理
  const s = session.fromPartition(partitionFor(profileId));
  await applyProxyToSession(s, profileId);

  broadcastAccountChange();
  return { ok: true, profile: targetProf };
});

async function importConfigFromFile(filePath, parentWin = null) {
  try {
    // 读取、校验大小、解析与解密在 src/backup.js (2026-11-22 main.js 拆分 第 5 步)
    const read = await backupService.readBackupFile(filePath, parentWin);
    if (!read.parsed) return read.result;
    const { parsed, wasEncrypted } = read;

    // 账号 id 只接受安全字符并去重 (审查 H2)
    const seenIds = new Set();
    let skippedProfiles = 0;
    const importedProfiles = (Array.isArray(parsed.profiles) ? parsed.profiles : []).filter((p) => {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !SAFE_ID_RE.test(p.id) || seenIds.has(p.id)) {
        skippedProfiles++;
        return false;
      }
      seenIds.add(p.id);
      return true;
    });
    if (importedProfiles.length === 0) {
      return { ok: false, error: '文件中未检测到有效的 profiles 账号列表' };
    }

    // 导入前为当前已有 state 文件做安全备份
    try {
      const curStatePath = statePath();
      if (fs.existsSync(curStatePath)) {
        fs.copyFileSync(curStatePath, path.join(app.getPath('userData'), `app-state.pre-import-${Date.now()}.bak`));
      }
    } catch (bakErr) {
      console.warn('[Config] Failed to create pre-import backup:', bakErr);
    }

    // 审查 M6: 记下导入前的账号与当前窗口所属账号, 导入后据此收尾
    const previousIds = new Set((state.profiles || []).map((p) => p && p.id).filter(Boolean));
    let mainWinProfileId = null;
    for (const [pid, w] of profileWindows) if (w === mainWindow) mainWinProfileId = pid;

    // 1. 恢复 profiles
    state.profiles = importedProfiles;

    // 2. 恢复 accountGroups
    if (Array.isArray(parsed.accountGroups)) {
      const groups = parsed.accountGroups
        .filter((g) => typeof g === 'string' && g.trim() && g.length <= 64)
        .map((g) => g.trim());
      if (groups.length > 0) state.accountGroups = groups;
    }

    // 3. Mihomo: 只接受开关、轮询间隔、严格隔离与订阅源; 内核路径与端口保留本机值
    const localMihomo = { ...defaultMihomoConfig(), ...(state.mihomo || {}) };
    const rawMihomo = (parsed.mihomo && typeof parsed.mihomo === 'object') ? parsed.mihomo : {};
    const importedSources = pickImportedSources(
      Array.isArray(parsed.mihomoSources) ? parsed.mihomoSources : rawMihomo.sources,
      localMihomo.sources
    );
    state.mihomo = localMihomo;
    if (typeof rawMihomo.enabled === 'boolean') state.mihomo.enabled = rawMihomo.enabled;
    if (typeof rawMihomo.strictIsolation === 'boolean') state.mihomo.strictIsolation = rawMihomo.strictIsolation;
    const autoUpd = parseInt(rawMihomo.autoUpdateInterval, 10);
    if (autoUpd >= 1 && autoUpd <= 720) state.mihomo.autoUpdateInterval = autoUpd;
    if (importedSources) state.mihomo.sources = importedSources;

    // 若 profiles 包含使用 mihomo 代理模式的账号或包含 sources，自动确保 mihomo 开关就绪
    const hasMihomoProfile = importedProfiles.some((p) => p && p.proxyMode === 'mihomo');
    if (hasMihomoProfile || (importedSources && importedSources.length > 0)) {
      state.mihomo.enabled = true;
    }

    // 4. 恢复全局 proxy
    const pickedProxy = pickImportedProxy(parsed.proxy);
    if (pickedProxy) state.proxy = { ...defaultProxy(), ...(state.proxy || {}), ...pickedProxy };

    // 5. 恢复飞书多维表格同步配置 (不导入本机 CLI 路径)
    if (parsed.feishu && typeof parsed.feishu === 'object') {
      state.feishu = pickImportedFeishu(parsed.feishu, state.feishu);
      setupFeishuAutoSync(state.feishu, () => state.profiles, () => {
        saveState();
        buildTrayMenu();
        broadcastAccountChange();
      });
    }

    // 6. 恢复外观与语言偏好（若存在）; ui 只接受已知字段且类型一致
    if (typeof parsed.theme === 'string' && ['dark', 'light'].includes(parsed.theme)) {
      state.theme = parsed.theme;
    }
    if (typeof parsed.locale === 'string' && ['zh-CN', 'en'].includes(parsed.locale)) {
      state.locale = parsed.locale;
    }
    if (parsed.ui && typeof parsed.ui === 'object') {
      const defUi = defaultState().ui || {};
      const nextUi = { ...(state.ui || {}) };
      for (const [k, v] of Object.entries(parsed.ui)) {
        if (Object.prototype.hasOwnProperty.call(defUi, k) && typeof v === typeof defUi[k]) nextUi[k] = v;
      }
      state.ui = nextUi;
    }

    // 7. 恢复或校验 activeProfileId
    if (parsed.activeProfileId && state.profiles.some((p) => p && p.id === parsed.activeProfileId)) {
      state.activeProfileId = parsed.activeProfileId;
    } else if (!state.profiles.some((p) => p && p.id === state.activeProfileId)) {
      state.activeProfileId = state.profiles[0] ? state.profiles[0].id : 'default';
    }

    state = replaceState(sanitizeAndMergeState(state));
    // 导入新增的账号立即挂上权限拦截与下载处理 (审查 M1)
    for (const p of state.profiles) ensureSessionHandlers(p.id);
    pruneProfilePorts();
    for (const p of state.profiles) ensureProfilePort(p.id);
    saveState();

    // 8. 审查 M6: 导入后不再存在的账号, 关闭其窗口、弹窗与快捷窗口。
    // 其会话数据目录保留在磁盘上 (重新导入旧备份时可恢复), 不自动删除。
    const currentIds = new Set(state.profiles.map((p) => p.id));
    const removedIds = [...previousIds].filter((id) => !currentIds.has(id));
    for (const id of removedIds) {
      closeChildWindows(id);
      const w = profileWindows.get(id);
      if (w && !w.isDestroyed()) {
        w.removeAllListeners('close');
        w.close();
      }
      profileWindows.delete(id);
      if (w) pendingWindowNav.delete(w);
    }
    if (quickWindowProfileId && !currentIds.has(quickWindowProfileId)) destroyQuickWindow();

    // 9. 恢复各账号会话 Cookie: 只写入导入后仍存在的账号, 并校验每条 Cookie
    let restoredSessionCount = 0;
    let totalCookiesInjected = 0;
    if (parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [profId, cookies] of Object.entries(parsed.sessions)) {
        if (!currentIds.has(profId) || !Array.isArray(cookies) || cookies.length === 0) continue;
        try {
          const ses = session.fromPartition(partitionFor(profId));
          for (const c of cookies.slice(0, 5000)) {
            if (!c || typeof c.name !== 'string' || !c.name || c.name.length > 4096) continue;
            if (typeof c.value !== 'string' || c.value.length > 16384) continue;
            const domain = String(c.domain || '');
            if (!COOKIE_DOMAIN_RE.test(domain)) continue;
            const cookiePath = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/';
            try {
              const protocol = c.secure ? 'https' : 'http';
              const url = `${protocol}://${domain.replace(/^\./, '')}${cookiePath}`;
              await ses.cookies.set({
                url,
                name: c.name,
                value: c.value,
                domain,
                path: cookiePath,
                secure: !!c.secure,
                httpOnly: !!c.httpOnly,
                expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
                sameSite: COOKIE_SAMESITE.includes(c.sameSite) ? c.sameSite : 'unspecified',
              });
              totalCookiesInjected++;
            } catch (_) {}
          }
          await ses.cookies.flushStore().catch(() => {});
          restoredSessionCount++;
        } catch (sErr) {
          console.warn(`[ConfigImport] Failed to restore cookies for profile ${profId}:`, sErr);
        }
      }
    }

    // 10. 重新聚合节点池并热载 Mihomo 内核 (合并各订阅源及本地 YAML 节点)
    try {
      if (state.mihomo && Array.isArray(state.mihomo.sources) && state.mihomo.sources.length > 0) {
        await refreshMihomoMergedProxiesAndReload(true);
      }
    } catch (reloadErr) {
      console.warn('[Config] Error refreshing mihomo proxies after import:', reloadErr);
    }

    // 11. 重新应用各账号代理
    for (const prof of state.profiles) {
      try {
        const ses = session.fromPartition(partitionFor(prof.id));
        applyProxyToSession(ses, prof.id);
      } catch {}
    }

    buildTrayMenu();
    broadcastAccountChange();
    broadcastThemeChange();

    // 12. 让前台窗口与导入后的活动账号一致 (此前可能仍显示旧账号的窗口)
    const targetId = state.activeProfileId;
    if (!mainWindow || mainWindow.isDestroyed() || removedIds.includes(mainWinProfileId)) {
      mainWindow = getOrCreateProfileWindow(targetId);
      showWindowSafely(mainWindow);
    } else if (mainWinProfileId && mainWinProfileId !== targetId) {
      // switchAccount 在"目标即活动账号且窗口可见"时会直接返回, 先把活动账号还原成当前窗口所属账号
      state.activeProfileId = mainWinProfileId;
      switchAccount(targetId);
    }
    if (restoredSessionCount > 0 && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.loadURL(currentSite().url);
      } catch (_) {}
    }

    return {
      ok: true,
      canceled: false,
      filePath,
      encrypted: wasEncrypted,
      profileCount: state.profiles.length,
      skippedProfiles,
      removedProfiles: removedIds.length,
      restoredSessionCount,
      totalCookiesInjected,
      sourceCount: (state.mihomo && state.mihomo.sources && state.mihomo.sources.length) || 0,
      nodeCount: (state.mihomo && state.mihomo.cachedProxies && state.mihomo.cachedProxies.length) || 0,
    };
  } catch (err) {
    console.error('[Config] Import failed:', err);
    return { ok: false, error: '导入失败: ' + (err.message || String(err)) };
  }
}

async function handleConfigImport(parentWin) {
  const targetWin = (parentWin && !parentWin.isDestroyed()) ? parentWin : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  const openOpts = {
    title: '导入账号与代理配置备份',
    filters: [
      { name: 'JSON 配置文件 (*.json)', extensions: ['json'] },
      { name: '所有文件 (*.*)', extensions: ['*'] },
    ],
    properties: ['openFile'],
  };
  const res = targetWin
    ? await dialog.showOpenDialog(targetWin, openOpts)
    : await dialog.showOpenDialog(openOpts);

  if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return { canceled: true };
  }

  return await importConfigFromFile(res.filePaths[0], targetWin);
}

ipcMain.handle('config:export', async (e, opts) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  return await handleConfigExport(senderWin, opts);
});

ipcMain.handle('config:import', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  return await handleConfigImport(senderWin);
});

ipcMain.handle('config:open-data-dir', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  try {
    const dir = app.getPath('userData');
    await shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 主题与外观配置 IPC handlers
ipcMain.handle('theme-get', (e) => {
  if (denyUntrusted(e)) return undefined;
  return state.theme || 'dark';
});

ipcMain.handle('theme-set', (e, newTheme) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (['dark', 'light', 'system'].includes(newTheme)) {
    setAppTheme(newTheme);
    return { ok: true, theme: state.theme };
  }
  return { ok: false, error: 'Invalid theme' };
});

ipcMain.handle('ui-settings-get', (e) => {
  if (denyUntrusted(e)) return undefined;
  return state.ui || { autoHideButtons: true };
});

ipcMain.handle('ui-settings-set', (e, newUI) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (newUI && typeof newUI === 'object') {
    const webrtcChanged = Object.prototype.hasOwnProperty.call(newUI, 'webrtcProtection');
    state.ui = { ...(state.ui || {}), ...newUI };
    if (webrtcChanged) state.ui.webrtcProtection = newUI.webrtcProtection !== false;
    saveState();
    buildTrayMenu();
    broadcastUISettingsChange();
    // 对已打开的页面立即生效 (新建的 WebRTC 连接起作用; 已建立的通话需重新发起)
    if (webrtcChanged) for (const wc of webContents.getAllWebContents()) applyWebRTCPolicy(wc);
    return { ok: true, ui: state.ui };
  }
  return { ok: false, error: 'Invalid UI settings' };
});

ipcMain.handle('locale-get', (e) => {
  if (denyUntrusted(e)) return undefined;
  return state.locale || 'en';
});

// ---- Lock screen IPC handlers ------------------------------------------------
ipcMain.handle('lock:get-status', (e) => {
  if (denyUntrusted(e)) return undefined;
  recordUserActivity();
  const now = Date.now();
  const remainingSec = lockoutUntil > now ? Math.ceil((lockoutUntil - now) / 1000) : 0;
  return {
    enabled: !!(state.lock && state.lock.enabled && state.lock.hash),
    autoLockEnabled: !!(state.lock && state.lock.autoLockEnabled),
    idleMinutes: (state.lock && state.lock.idleMinutes) || 15,
    isLocked: isScreenLocked,
    lockoutRemainingSec: remainingSec,
    shortcut: state.hotkeys.lock || DEFAULT_HOTKEYS.lock,
  };
});

ipcMain.handle('lock:set-password', (e, pwd) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  recordUserActivity();
  if (!pwd || typeof pwd !== 'string' || pwd.length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters' };
  }
  const { hash, salt } = hashPassword(pwd);
  state.lock = {
    ...(state.lock || defaultLock()),
    enabled: true,
    hash,
    salt,
  };
  saveState();
  buildTrayMenu();
  return { ok: true };
});

ipcMain.handle('lock:change-password', (e, oldPwd, newPwd) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  recordUserActivity();
  if (!state.lock || !state.lock.enabled || !state.lock.hash) {
    return { ok: false, error: 'Lock not enabled' };
  }
  const valid = verifyPassword(oldPwd, state.lock.salt, state.lock.hash);
  if (!valid) {
    return { ok: false, error: 'Current password incorrect' };
  }
  if (!newPwd || typeof newPwd !== 'string' || newPwd.length < 4) {
    return { ok: false, error: 'New password must be at least 4 characters' };
  }
  const { hash, salt } = hashPassword(newPwd);
  state.lock.hash = hash;
  state.lock.salt = salt;
  saveState();
  return { ok: true };
});

ipcMain.handle('lock:disable', (e, pwd) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  recordUserActivity();
  if (!state.lock || !state.lock.enabled) return { ok: true };
  const valid = verifyPassword(pwd, state.lock.salt, state.lock.hash);
  if (!valid) {
    return { ok: false, error: 'Password incorrect' };
  }
  state.lock.enabled = false;
  state.lock.hash = '';
  state.lock.salt = '';
  saveState();
  buildTrayMenu();
  return { ok: true };
});

ipcMain.handle('lock:update-config', (e, cfg) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  recordUserActivity();
  if (!state.lock) state.lock = defaultLock();
  if (cfg && typeof cfg.autoLockEnabled === 'boolean') {
    state.lock.autoLockEnabled = cfg.autoLockEnabled;
  }
  if (cfg && typeof cfg.idleMinutes === 'number' && [1, 5, 15, 30, 60].includes(cfg.idleMinutes)) {
    state.lock.idleMinutes = cfg.idleMinutes;
  }
  saveState();
  return { ok: true };
});

ipcMain.handle('lock:lock-now', (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  lockScreen();
  return { ok: true };
});

ipcMain.handle('lock:unlock', (e, pwd) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  return unlockScreen(pwd);
});

ipcMain.handle('locale-set', (e, newLocale) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (['en', 'zh-CN'].includes(newLocale)) {
    setAppLocale(newLocale);
    return { ok: true, locale: state.locale };
  }
  return { ok: false, error: 'Invalid locale' };
});

// 处理页面请求用系统默认浏览器打开外部链接
ipcMain.on('open-external-url', (e, rawUrl) => {
  if (typeof rawUrl !== 'string') return;
  // 安全校验：发送者必须属于本应用纳管窗口
  const senderWin = BrowserWindow.fromWebContents(e.sender);
  // 子弹窗不在名单内 (审查 L4): 授权弹窗用空 preload、账号页面窗口无 preload, 都不会发此 IPC;
  // 放进名单只会让第三方页面多一条唤起系统浏览器的通道
  const owned = [mainWindow, quickWindow, hotkeyWindow, lockWindow, ...profileWindows.values()];
  const isOwned = (senderWin && owned.includes(senderWin)) ||
                  owned.some((w) => w && !w.isDestroyed() && (w.webContents === e.sender || w.webContents.id === e.sender.id));
  if (!isOwned) {
    console.warn('[ExternalLink IPC] Rejected call from unowned webContents id:', e.sender && e.sender.id);
    return;
  }

  let trimmed = rawUrl.trim().replace(/[，。；、？！）》」"',;!]+$/, '');
  // 站内分享/文档/附件、Meta 账户页面: 用发起方所属账号的登录态在应用内打开
  if (isProfileScopedUrl(trimmed)) {
    const owner = findProfileForWebContents(e.sender);
    if (owner && owner.win) {
      openUrlForProfile(owner.win, owner.profileId, trimmed);
      return;
    }
  }
  const target = extractExternalTargetUrl(trimmed) || trimmed;
  // 严格白名单协议：仅放行普通网页外链（http/https/mailto），杜绝 file: 或危险 scheme
  if (typeof target === 'string' && (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:'))) {
    console.log('[ExternalLink IPC] Opening external URL in default browser:', target);
    shell.openExternal(target).catch((err) => {
      console.warn('[ExternalLink] Failed to open external URL from IPC:', target, err);
    });
  }
});

// 第三方连接器引导与 Google 会话重置 IPC
ipcMain.handle('connector-open-muse', (e) => {
  if (denyUntrusted(e)) return undefined;
  return shell.openExternal('https://muse.ai');
});

ipcMain.handle('google-session-reset', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  // 优先清发起请求的窗口所属账号; 设置页等非账号窗口回退到活动账号 (审查 L2)
  const owner = findProfileForWebContents(e.sender);
  const targetId = (owner && owner.profileId) || state.activeProfileId;
  const curSes = session.fromPartition(partitionFor(targetId));
  const r1 = await clearGoogleAuthSession(curSes);
  return { ok: r1 };
});

// ---- 出口 IP 检测与独立出口分配 (2026-11-22) -------------------------------------
// 计算逻辑在 src/exit-isolation.js, 网络实测在 src/exit-probe.js。
let lastNodeProbe = null; // { at, results } 仅保存在内存, 用于生成分配方案
let lastIsolationPlan = null; // { at, plan }
let exitProbeRunning = false;
const NODE_PROBE_MAX_AGE_MS = 30 * 60 * 1000;

// 参与出口分配的账号: 显式选了 mihomo, 或跟随全局且全局开启了 Mihomo
function isMihomoRoutedProfile(p) {
  if (!p) return false;
  if (p.proxyMode === 'mihomo') return true;
  return (!p.proxyMode || p.proxyMode === 'inherit') && !!(state.mihomo && state.mihomo.enabled);
}

// 检测所有账号的当前出口 (设置页手动检测与定期自动检测共用)
async function runAccountExitCheck() {
  if (exitProbeRunning) return { ok: false, busy: true, error: '正在检测中，请稍候' };
  exitProbeRunning = true;
  try {
    const profiles = (state.profiles || []).slice();
    const results = await mapLimit(profiles, 4, async (p) => {
      const r = await checkSessionExit(session.fromPartition(partitionFor(p.id)));
      return { id: p.id, name: p.name || p.id, mode: p.proxyMode || 'inherit', viaMihomo: isMihomoRoutedProfile(p), ...r };
    });
    const marked = markSharedExits(results);
    const okOnes = marked.filter((r) => r.ok);
    return {
      ok: true,
      results: marked,
      summary: {
        accounts: marked.length,
        reachable: okOnes.length,
        distinctIps: new Set(okOnes.map((r) => r.ip)).size,
        sharing: okOnes.filter((r) => r.sharedWith.length > 0).length,
      },
    };
  } finally {
    exitProbeRunning = false;
  }
}

// ---- 定期自动检测 (实现在 src/exit-monitor.js) ----------------------------------
// 启动 2 分钟后首次检测, 之后按设置的间隔; 只在出现新问题时通知, 点击通知打开设置页。
const exitMonitor = createExitMonitor({
  getState: () => state,
  saveState: saveStateDebounced,
  runCheck: runAccountExitCheck,
  notify,
  onOpen: () => openHotkeySettings('tab-mihomo'),
});

ipcMain.handle('exit:check-accounts', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  const r = await runAccountExitCheck();
  // 手动检测的结果也计入监控记录 (不通知): 用户已经看到的问题, 之后不会再重复提醒
  if (r && r.ok) exitMonitor.record(r.results, { silent: true });
  return r;
});

ipcMain.handle('exit:monitor-get', (e) => (denyUntrusted(e) ? undefined : exitMonitor.getConfig()));

ipcMain.handle('exit:monitor-set', (e, patch) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid settings' };
  return { ok: true, monitor: exitMonitor.update(patch) };
});

ipcMain.handle('exit:probe-nodes', async (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (exitProbeRunning) return { ok: false, error: '正在检测中，请稍候' };
  const nodes = (state.mihomo && Array.isArray(state.mihomo.cachedProxies)) ? state.mihomo.cachedProxies : [];
  if (!nodes.length) return { ok: false, error: '节点池为空，请先同步订阅' };
  exitProbeRunning = true;
  const sender = e.sender;
  try {
    const res = await probeNodeExits({
      nodes,
      dataDir: path.join(app.getPath('userData'), 'mihomo-probe'),
      binPath: state.mihomo && state.mihomo.customBinPath,
      controllerPort: ((state.mihomo && state.mihomo.controllerPort) || 19090) + 100,
      onProgress: (done, total) => {
        try { if (!sender.isDestroyed()) sender.send('exit:progress', { done, total }); } catch (_) {}
      },
    });
    if (!res.ok) return res;
    lastNodeProbe = { at: Date.now(), results: res.results };
    lastIsolationPlan = null;
    const groups = buildExitGroups(res.results);
    return {
      ok: true,
      results: res.results,
      summary: {
        nodes: res.results.length,
        usable: res.results.filter((r) => r.ok).length,
        exitIps: groups.size,
        eligibleAccounts: (state.profiles || []).filter(isMihomoRoutedProfile).length,
      },
    };
  } finally {
    exitProbeRunning = false;
  }
});

ipcMain.handle('exit:plan', (e, opts) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!lastNodeProbe || Date.now() - lastNodeProbe.at > NODE_PROBE_MAX_AGE_MS) {
    return { ok: false, error: '请先测试全部节点的出口 IP（结果 30 分钟内有效）' };
  }
  const accounts = (state.profiles || []).filter(isMihomoRoutedProfile).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    proxyQueue: Array.isArray(p.proxyQueue) ? p.proxyQueue : [],
  }));
  if (!accounts.length) return { ok: false, error: '没有使用 Mihomo 的账号' };
  const backups = Math.max(0, Math.min(5, parseInt(opts && opts.backupsPerAccount, 10) || 2));
  const plan = planIsolation({ accounts, nodeResults: lastNodeProbe.results, backupsPerAccount: backups });
  lastIsolationPlan = { at: Date.now(), plan };
  return { ok: true, plan };
});

ipcMain.handle('exit:apply', async (e, opts) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  if (!lastIsolationPlan || Date.now() - lastIsolationPlan.at > NODE_PROBE_MAX_AGE_MS) {
    return { ok: false, error: '方案已过期，请重新生成' };
  }
  const pool = new Set(((state.mihomo && state.mihomo.cachedProxies) || []).map((n) => n && n.name));
  const changedIds = [];
  for (const a of lastIsolationPlan.plan.assignments) {
    const prof = (state.profiles || []).find((p) => p.id === a.id);
    if (!prof || !a.changed) continue;
    // 生成方案后节点池可能已更新: 只写入仍然存在的节点
    const queue = a.queue.filter((n) => pool.has(n));
    if (!queue.length) continue;
    prof.proxyQueue = queue;
    prof.proxyStrategy = 'fallback'; // 始终用队列里第一个可用节点, 出口稳定
    changedIds.push(prof.id);
  }
  const enableStrict = !!(opts && opts.enableStrict);
  if (enableStrict && state.mihomo) state.mihomo.strictIsolation = true;
  saveState();

  const mm = getMihomoManager();
  if (state.mihomo && state.mihomo.enabled && mm && mm.isRunning) {
    const r = await mm.reload(state.profiles, state.mihomo.cachedProxies);
    if (!r || !r.ok) return { ok: false, error: '已保存，但 Mihomo 重载失败: ' + ((r && r.error) || '未知错误') };
  }
  await applyProxySettings();
  // 断开已有连接并刷新页面, 让新出口立即生效 (隐藏窗口等下次显示时再刷新)
  for (const id of changedIds) {
    const ses = session.fromPartition(partitionFor(id));
    if (typeof ses.closeAllConnections === 'function') { try { await ses.closeAllConnections(); } catch (_) {} }
    const w = profileWindows.get(id);
    if (w && !w.isDestroyed()) {
      if (w.isVisible()) w.webContents.reload();
      else markWindowNavPending(w, 'reload');
    }
  }
  // 这些账号的出口是有意更换的, 清掉旧记录, 避免下次定期检测报"出口变化"
  if (state.exitMonitor && state.exitMonitor.exits) {
    for (const id of changedIds) delete state.exitMonitor.exits[id];
    saveStateDebounced();
  }
  // 正在进行中的定期检测是改动前发起的, 结果作废, 避免下一次误报"出口变化" (审查 L5)
  exitMonitor.invalidate();
  lastIsolationPlan = null;
  broadcastAccountChange();
  return { ok: true, changed: changedIds.length, strictIsolation: !!(state.mihomo && state.mihomo.strictIsolation) };
});

// 下载文件交互与目录打开 IPC
ipcMain.handle('download:open-folder', (e, filePath) => {
  if (denyUntrusted(e)) return false;
  if (isKnownDownload(filePath) && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('download:open-file', async (e, filePath) => {
  if (denyUntrusted(e)) return false;
  if (isKnownDownload(filePath) && fs.existsSync(filePath)) {
    await shell.openPath(filePath);
    return true;
  }
  return false;
});

// ---- downloads & right-click menu -------------------------------------------
// Electron shows no context menu on its own, so links can only be clicked
// (navigating to them) rather than saved. This adds Save link/image as,
// copy link, and the standard edit items, plus real download handling.
// 本次运行中实际完成下载的文件路径 (审查 L1): download:open-* 只放行这些路径
const completedDownloads = new Set();
const isKnownDownload = (p) => typeof p === 'string' && completedDownloads.has(path.resolve(p));

function setupDownloadHandler(profileId) {
  const ses = session.fromPartition(partitionFor(profileId));
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event, item) => {
    const fileName = item.getFilename() || 'download';
    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath: path.join(app.getPath('downloads'), fileName),
    });
    item.on('done', (e, downloadState) => {
      const savePath = item.getSavePath();
      const fileSize = item.getTotalBytes();
      const isSuccess = downloadState === 'completed';
      if (isSuccess && savePath) completedDownloads.add(path.resolve(savePath));
      const isForeground = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();

      if (isForeground) {
        // 方案A：主窗口在前台且可见时，直接通过应用内精致 Toast 呈现，不打扰系统桌面
        mainWindow.webContents.send('download:completed', {
          state: downloadState,
          fileName,
          savePath,
          fileSize,
        });
      } else {
        // 方案A：主窗口处于后台或最小化到托盘时，使用 Windows 系统通知兜底
        const t = I18N_MAIN[state.locale] || I18N_MAIN['zh-CN'] || I18N_MAIN.en;
        if (isSuccess) {
          notify(
            t.downloadComplete,
            `${fileName} ${t.downloadSaved}`,
            () => {
              if (savePath && fs.existsSync(savePath)) {
                shell.showItemInFolder(savePath);
              }
            }
          );
        } else if (downloadState !== 'cancelled') {
          notify(
            t.downloadFailed,
            `${fileName} (${downloadState})`
          );
        }
      }
    });
  });
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (e, params) => {
    const t = I18N_MAIN[state.locale] || I18N_MAIN.en;
    const menu = new Menu();
    if (params.linkURL) {
      const url = params.linkURL;
      menu.append(new MenuItem({ label: t.saveLinkAs, click: () => win.webContents.downloadURL(url) }));
      menu.append(new MenuItem({ label: t.copyLinkAddress, click: () => clipboard.writeText(url) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.hasImageContents && params.srcURL) {
      const src = params.srcURL;
      menu.append(new MenuItem({ label: t.saveImageAs, click: () => win.webContents.downloadURL(src) }));
      menu.append(new MenuItem({ label: t.copyImageAddress, click: () => clipboard.writeText(src) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: t.cut, role: 'cut' }));
      menu.append(new MenuItem({ label: t.copy, role: 'copy' }));
      menu.append(new MenuItem({ label: t.paste, role: 'paste' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: t.copy, role: 'copy' }));
    }
    if (menu.items.length > 0) menu.popup({ window: win });
  });
}

// ---- chat export ------------------------------------------------------------
// Reads the open conversation out of the page (user's own chat, saved to
// their own disk). Markdown is the primary format: every AI reads it and it
// stays human-readable. JSON for structured use, HTML for visual fidelity.
function roleLabel(role) {
  return role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : 'Unknown';
}

// 导出完整性告警 (v1.5.17): 虚拟列表可能丢早期消息、发言人可能为推算,
// 这些不确定性必须写进导出文件本身, 而不是静默产出「看似完整」的数据
function exportWarnings(data) {
  const warnings = [];
  const stats = data && data.stats;
  if (stats) {
    if (stats.reachedTop === false) {
      warnings.push('未能确认已滚动到对话顶部, 早期消息可能缺失 (虚拟列表限制)。');
    }
    if (stats.guessedRoles > 0) {
      warnings.push(`有 ${stats.guessedRoles} 条消息的发言人是按对话交替规律推算的, 可能不准确。`);
    }
  }
  return warnings;
}

function exportMarkdown(data) {
  const lines = [
    `# ${data.title || 'Chat export'}`,
    '',
    `- Exported: ${data.scrapedAt}`,
    `- Site: ${data.url}`,
    `- Profile: ${activeProfile().name}`,
    `- Messages: ${data.messages.length}`,
    '',
    '---',
    '',
  ];
  for (const w of exportWarnings(data)) lines.push(`> ⚠ ${w}`, '');
  for (const m of data.messages) {
    lines.push(`## ${roleLabel(m.role)}${m.timestamp ? ` (${m.timestamp})` : ''}`, '', m.text, '');
  }
  return lines.join('\n');
}

function exportJSON(data) {
  return JSON.stringify(
    {
      meta: {
        title: data.title,
        url: data.url,
        profile: activeProfile().name,
        scrapedAt: data.scrapedAt,
        messageCount: data.messages.length,
        stats: data.stats || null,
        warnings: exportWarnings(data),
      },
      messages: data.messages,
    },
    null,
    2
  );
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function exportHTML(data) {
  const bubbles = data.messages
    .map((m) => {
      const cls = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'unknown';
      return `<div class="msg ${cls}"><div class="role">${roleLabel(m.role)}${m.timestamp ? ` <span class="ts">${escapeHTML(m.timestamp)}</span>` : ''}</div><div class="text">${escapeHTML(m.text).replace(/\n/g, '<br>')}</div></div>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHTML(data.title || 'Chat export')}</title><style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;background:#141414;color:#e8e8e8}
.msg{margin:1rem 0;padding:.75rem 1rem;border-radius:12px;white-space:normal}
.msg.user{background:#1e3a5f;margin-left:15%}
.msg.assistant{background:#242424;margin-right:15%}
.msg.unknown{background:#2a2a2a}
.role{font-size:.75rem;opacity:.7;margin-bottom:.4rem}
.ts{opacity:.6}
.text{line-height:1.5;overflow-wrap:anywhere}
.meta{opacity:.6;font-size:.8rem;margin-bottom:2rem}
</style></head><body><h1>${escapeHTML(data.title || 'Chat export')}</h1><div class="meta">Exported ${escapeHTML(data.scrapedAt)} from ${escapeHTML(data.url)} (${data.messages.length} messages)</div>${exportWarnings(data).map((w) => `<div class="meta">\u26a0 ${escapeHTML(w)}</div>`).join('')}${bubbles}</body></html>`;
}

async function exportChat() {
  if (isScreenLocked) return;
  recordUserActivity();
  // 永远导出活动账号的主窗口 (v1.5.17, 评审 P2): 旧实现取焦点窗口, 焦点在
  // 快速窗/设置窗时会导错会话或静默无结果且不给提示
  const win = profileWindows.get(state.activeProfileId);
  if (!win || win.isDestroyed()) {
    notify('Nothing to export', 'Open Muse first, then export the chat.');
    return;
  }
  const pageUrl = (() => { try { return win.webContents.getURL(); } catch { return ''; } })();
  if (!/^https:\/\/(.+\.)?(muse\.ai|meta\.ai)(\/|$)/.test(pageUrl)) {
    notify('当前页面不是聊天页', '活动账号窗口当前不在 Muse / Meta AI 聊天页面, 无法导出。');
    return;
  }
  let data = null;
  try {
    data = await scrapeChatViaPreload(win);
  } catch {
    data = null;
  }
  if (!data || !data.ok || !data.messages || !data.messages.length) {
    notify(
      'Export found no messages',
      'Could not detect chat messages on this page. Scroll the chat into view and try again.'
    );
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Export chat',
    defaultPath: `muse-chat-${stamp}.md`,
    filters: [
      { name: 'Markdown (best for sharing with AIs)', extensions: ['md'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'HTML', extensions: ['html'] },
    ],
  });
  if (canceled || !filePath) return;
  const ext = path.extname(filePath).toLowerCase();
  const content =
    ext === '.json' ? exportJSON(data) : ext === '.html' ? exportHTML(data) : exportMarkdown(data);
  fs.writeFileSync(filePath, content, 'utf8');
  notify(
    'Chat exported',
    `${data.messages.length} messages saved to ${path.basename(filePath)}. Click to open the folder.`,
    () => shell.showItemInFolder(filePath)
  );
}

// 经 preload 隔离世界执行聊天抓取 (v1.5.14): 此前主进程用 executeJavaScript
// 调主世界的 window.museExport, 等于必须把抓取桥暴露给网页主世界, 页面脚本
// 可见可调用。现在桥已删除, 改为主进程发请求、preload 在隔离世界抓取后回传。
function scrapeChatViaPreload(win, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const wc = win.webContents;
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('muse-export:result', onResult);
      resolve(val);
    };
    const onResult = (e, payload) => {
      if (e.sender !== wc) return;
      done(payload && payload.ok ? payload.data : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ipcMain.on('muse-export:result', onResult);
    wc.send('muse-export:scrape');
  });
}

// ---- tray -----------------------------------------------------------------
const prettyHotkey = (acc) => String(acc || '').replace('CommandOrControl', 'Ctrl');
function setGlobalAutomationAction(actionKey, enabled) {
  if (state.automation.actions[actionKey] === undefined) return;
  state.automation.actions[actionKey] = !!enabled;
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
}

function buildTrayMenu() {
  if (!tray) return;
  const lang = state.locale || 'en';
  const t = I18N_MAIN[lang] || I18N_MAIN.en;

  if (isScreenLocked) {
    const templateLocked = [
      {
        label: lang === 'zh-CN' ? '🔒 解锁 Muse 客户端...' : '🔒 Unlock Muse Client...',
        click: () => {
          if (lockWindow && !lockWindow.isDestroyed()) {
            lockWindow.show();
            lockWindow.focus();
          } else {
            createLockWindow();
          }
        },
      },
      { type: 'separator' },
      {
        label: t.quitMuse || '退出',
        click: () => {
          app.quitting = true;
          app.quit();
        },
      },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(templateLocked));
    return;
  }

  const otherSite = state.site === 'muse' ? SITES.meta : SITES.muse;
  const loginSettings = app.getLoginItemSettings();

  const profileItems = state.profiles.map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.id === state.activeProfileId,
    click: () => switchProfile(p.id),
  }));

  let currentHostname = 'muse.ai';
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      currentHostname = new URL(mainWindow.webContents.getURL()).hostname;
    }
  } catch { /* ignore */ }

  const template = [
    { label: t.openMuse, click: showMainWindow },
    { label: t.quickChat(prettyHotkey(state.hotkeys.quick)), click: toggleQuickWindow },
    { label: t.switchTo(otherSite.name, prettyHotkey(state.hotkeys.site)), click: toggleSite },
    ...(state.lock && state.lock.enabled ? [{
      label: lang === 'zh-CN' ? `🔒 锁定客户端  (${prettyHotkey(state.hotkeys.lock)})` : `🔒 Lock Client  (${prettyHotkey(state.hotkeys.lock)})`,
      click: () => lockScreen(),
    }] : []),
    { type: 'separator' },
    {
      label: lang === 'zh-CN' ? `账号管理 (当前: ${activeProfile().name})` : `Accounts (Current: ${activeProfile().name})`,
      submenu: [
        {
          label: t.openAccountHub,
          click: () => {
            showMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('account:open-hub');
            }
          },
        },
        { type: 'separator' },
        ...profileItems,
        { type: 'separator' },
        { label: t.nextAccount(prettyHotkey(state.hotkeys.metaAccount)), click: nextAccount },
        { label: t.addAccount, click: () => addProfile() },
        { label: t.signOutFrom(currentSite().name), click: signOut },
      ],
    },
    {
      label: t.automationMenu,
      submenu: [
        {
          label: t.masterAutomation(prettyHotkey(state.hotkeys.automation)),
          type: 'checkbox',
          checked: state.automation.enabled,
          click: () => toggleAutomationMaster(),
        },
        {
          label: t.allowAllActions,
          type: 'checkbox',
          checked: state.automation.autoAllowAll,
          click: (item) => {
            state.automation.autoAllowAll = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        {
          label: t.thisWebsite,
          submenu: [
            {
              label: t.alwaysAllowOn(currentHostname),
              type: 'checkbox',
              checked: !!state.automation.sites[currentHostname.toLowerCase()],
              click: (item) => {
                state.automation.sites[currentHostname.toLowerCase()] = item.checked;
                saveState();
                buildTrayMenu();
                notifyWebContentsAutomationChange();
              },
            },
            { type: 'separator' },
            ...[
              ['connectors', t.actConnectors, t.hintConnectors],
              ['file_access', t.actFile, t.hintFile],
              ['external_links', t.actLinks, t.hintLinks],
              ['code_execution', t.actCode, t.hintCode],
              ['media_permissions', t.actMedia, t.hintMedia],
            ].map(([key, label, hint]) => ({
              label,
              type: 'checkbox',
              checked: state.automation.siteActions[currentHostname.toLowerCase()]?.[key] !== undefined
                ? !!state.automation.siteActions[currentHostname.toLowerCase()][key]
                : state.automation.actions[key] === true,
              toolTip: hint,
              click: (item) => {
                const host = currentHostname.toLowerCase();
                state.automation.siteActions[host] = { ...(state.automation.siteActions[host] || {}), [key]: item.checked };
                saveState();
                buildTrayMenu();
                notifyWebContentsAutomationChange();
              },
            })),
          ],
        },
        {
          label: t.whatCanBeAutoApproved,
          submenu: [
            { label: t.actConnectors, type: 'checkbox', checked: !!state.automation.actions.connectors, click: (item) => setGlobalAutomationAction('connectors', item.checked) },
            { label: t.actFile, type: 'checkbox', checked: !!state.automation.actions.file_access, click: (item) => setGlobalAutomationAction('file_access', item.checked) },
            { label: t.actLinks, type: 'checkbox', checked: !!state.automation.actions.external_links, click: (item) => setGlobalAutomationAction('external_links', item.checked) },
            { label: t.actCode, type: 'checkbox', checked: !!state.automation.actions.code_execution, click: (item) => setGlobalAutomationAction('code_execution', item.checked) },
            { label: t.actMedia, type: 'checkbox', checked: !!state.automation.actions.media_permissions, click: (item) => setGlobalAutomationAction('media_permissions', item.checked) },
          ],
        },
        { type: 'separator' },
        {
          label: t.showOnScreenWidget,
          type: 'checkbox',
          checked: state.automation.showOnScreenWidget,
          click: (item) => {
            state.automation.showOnScreenWidget = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        { label: t.settingsKeybinds, click: openHotkeySettings },
      ],
    },
    {
      label: t.sessionTools,
      submenu: [
        { label: t.saveClipboard, click: saveClipboardAsFile },
        { label: t.exportChat(prettyHotkey(state.hotkeys.export)), click: exportChat },
        { type: 'separator' },
        { label: t.muteMic(prettyHotkey(state.hotkeys.mic)), click: toggleMic },
        { label: t.muteSpeaker(prettyHotkey(state.hotkeys.speaker)), click: toggleSpeaker },
      ],
    },
    { type: 'separator' },
    {
      label: t.preferencesMenu,
      submenu: [
        { label: t.customizeHotkeys, click: () => openHotkeySettings() },
        { label: t.networkProxy, click: () => openHotkeySettings('tab-proxy') },
        { label: t.backupExport, click: () => handleConfigExport() },
        { label: t.backupImport, click: () => handleConfigImport() },
        { label: t.openDataDir, click: () => shell.openPath(app.getPath('userData')) },
        { label: t.resetGoogleSession, click: promptResetGoogleSession },
        { type: 'separator' },
        {
          label: t.appearance(state.theme === 'light' ? t.lightMode : state.theme === 'system' ? t.systemMode : t.darkMode),
          submenu: [
            { label: t.darkMode, type: 'radio', checked: state.theme === 'dark', click: () => setAppTheme('dark') },
            { label: t.lightMode, type: 'radio', checked: state.theme === 'light', click: () => setAppTheme('light') },
            { label: t.systemMode, type: 'radio', checked: state.theme === 'system', click: () => setAppTheme('system') },
          ],
        },
        {
          label: t.language,
          submenu: [
            { label: t.langEn, type: 'radio', checked: (state.locale || 'en') === 'en', click: () => setAppLocale('en') },
            { label: t.langZh, type: 'radio', checked: state.locale === 'zh-CN', click: () => setAppLocale('zh-CN') },
          ],
        },
        {
          label: t.autoHideButtons,
          type: 'checkbox',
          checked: !!(state.ui && state.ui.autoHideButtons),
          click: (item) => setUIAutoHide(item.checked),
        },
        { type: 'separator' },
        {
          label: t.runOnStartup,
          type: 'checkbox',
          checked: loginSettings.openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { label: t.checkUpdates, click: () => checkForUpdates(true) },
        ...(isUpdateDownloaded()
          ? [{ label: t.restartInstall, click: installUpdateAndRestart }]
          : []),
      ],
    },
    { type: 'separator' },
    {
      label: t.quitMuse,
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        app.quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    icon = undefined;
  }
  tray = new Tray(icon);
  tray.setToolTip('Muse');
  buildTrayMenu();
  tray.on('click', showMainWindow);
}

// ---- app lifecycle ----------------------------------------------------------
app.on('second-instance', showMainWindow);

app.whenReady().then(async () => {
  // 1. 若开启内置 Mihomo 智能分流，启动前优先就绪内核进程与端口映射，彻底消除冷启动无代理直连导致的握手失败 (-100)
  if (state.mihomo && state.mihomo.enabled) {
    const mm = getMihomoManager();
    const merged = mm.loadCachedSubscription(state.mihomo.sources);
    if (Array.isArray(merged) && merged.length > 0) {
      state.mihomo.cachedProxies = merged;
    }
    try {
      mm.generateConfig(state.profiles, state.mihomo.cachedProxies);
    } catch (_) {}
    try {
      console.log('[Mihomo] Boot: starting Mihomo kernel before window creation...');
      const res = await Promise.race([
        mm.start(state.profiles, state.mihomo.cachedProxies),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'startup timeout' }), 2500))
      ]);
      if (res && res.ok) {
        console.log('[Mihomo] Kernel ready on boot.');
      } else {
        console.warn('[Mihomo] Boot start warning:', res && res.error);
      }
    } catch (err) {
      console.error('[Mihomo] Boot start error:', err);
    }
  }

  // 2. 预先应用当前活动账号与 defaultSession 代理，保证首屏 loadURL 必定走专属代理端口
  try {
    const initialSes = session.fromPartition(partitionFor(state.activeProfileId));
    await applyProxyToSession(initialSes, state.activeProfileId);
    await applyProxyToSession(session.defaultSession);
  } catch (err) {
    console.warn('[Proxy] Initial active session proxy error:', err);
  }

  createMainWindow();
  createTray();
  registerHotkeys();
  state.profiles.forEach((p) => ensureSessionHandlers(p.id));
  setupAutoUpdate();
  exitMonitor.start(); // 定期出口检测 (未开启时不做任何事)
  startAutoLockTimer();
  if (state.feishu && state.feishu.enabled && state.feishu.autoSync) {
    setupFeishuAutoSync(state.feishu, () => state.profiles, () => {
      saveState();
      buildTrayMenu();
      broadcastAccountChange();
    });
  }
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('resume', () => {
      console.log('[System] Power resumed, checking Feishu auto sync status...');
      if (state.feishu && state.feishu.enabled && state.feishu.autoSync) {
        const lastSync = state.feishu.lastSyncTime ? new Date(state.feishu.lastSyncTime).getTime() : 0;
        const intervalMs = Math.max(1, parseInt(state.feishu.syncIntervalMinutes, 10) || 5) * 60 * 1000;
        if (!lastSync || (Date.now() - lastSync >= intervalMs)) {
          console.log('[FeishuSync] Interval elapsed during sleep, triggering catch-up sync.');
          executeFeishuSync(state.feishu, state.profiles, () => {
            saveState();
            buildTrayMenu();
            broadcastAccountChange();
          }).catch((e) => console.warn('[FeishuSync] Resume sync failed:', e.message));
        }
      }
    });
  }
  app.on('browser-window-focus', () => recordUserActivity());
  if (state.lock && state.lock.enabled && state.lock.hash) {
    lockScreen();
  }
  Promise.race([
    applyProxySettings(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
    .then(() => console.log('[Init] Initial proxy settings applied.'))
    .catch((err) => console.warn('[Init] Failed to apply initial proxy settings:', err));
});

app.on('window-all-closed', () => {
  // Keep running in the tray; quit explicitly from the tray menu.
});

let isFlushingOnQuit = false;
app.on('before-quit', async (e) => {
  const runningMihomo = proxyController.peekMihomoManager();
  if (runningMihomo) {
    try { runningMihomo.stop(); } catch (_) {}
  }
  if (!isFlushingOnQuit) {
    e.preventDefault();
    isFlushingOnQuit = true;
    console.log('[App] Flushing state and session cookies before exit...');
    saveState();
    await flushAllSessions();
    app.quitting = true;
    app.quit();
  }
});

app.on('will-quit', () => {
  exitMonitor.stop();
  const runningMihomo = proxyController.peekMihomoManager();
  if (runningMihomo) {
    try { runningMihomo.stop(); } catch (_) {}
  }
  if (autoLockTimer) clearInterval(autoLockTimer);
  globalShortcut.unregisterAll();
});

process.on('exit', () => {
  const runningMihomo = proxyController.peekMihomoManager();
  if (runningMihomo) {
    try { runningMihomo.stop(); } catch (_) {}
  }
});

// 仅供本地冒烟测试引用内部纯函数; Electron 运行时忽略该导出。
try { module.exports = { sanitizeWindowBounds, ensureBoundsVisible, isValidHostname, isTrustedIpcSender, isPortableWindowsBuild, childWindowsByProfile, pendingWindowNav, MAX_RESIDENT_PROFILE_WINDOWS, sanitizeAndMergeState, defaultLock, hashPassword, verifyPassword, unlockScreen, lockScreen, isScreenLocked: () => isScreenLocked, getInternalState: () => state, importConfigFromFile, handleConfigExport }; } catch {}
