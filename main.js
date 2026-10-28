const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, shell, nativeImage, clipboard, session, dialog, Notification, ipcMain, net, powerMonitor, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
const DEFAULT_HOTKEYS = {
  quick: 'CommandOrControl+Shift+Space',
  site: 'CommandOrControl+Shift+M',
  export: 'CommandOrControl+Shift+E',
  mic: 'CommandOrControl+Shift+U',
  speaker: 'CommandOrControl+Shift+O',
  automation: 'CommandOrControl+Shift+A',
  metaAccount: 'CommandOrControl+Shift+N',
  lock: 'CommandOrControl+Shift+L',
};
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
    profileMenu: (name) => `Profile: ${name}`,
    addProfile: 'Add profile…',
    signOutFrom: (site) => `Sign out of ${site}…`,
    saveClipboard: 'Save clipboard text as .txt',
    exportChat: (hk) => `Export this chat as file…  (${hk})`,
    muteMic: (hk) => `Mute / unmute microphone  (${hk})`,
    muteSpeaker: (hk) => `Mute / unmute app sound  (${hk})`,
    customizeHotkeys: 'Customize hotkeys & settings…',
    networkProxy: 'Network & Proxy settings…',
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
    profileMenu: (name) => `当前账号: ${name}`,
    addProfile: '添加新账号…',
    signOutFrom: (site) => `退出 ${site} 登录…`,
    saveClipboard: '剪贴板内容另存为 .txt',
    exportChat: (hk) => `导出当前会话记录…  (${hk})`,
    muteMic: (hk) => `麦克风静音 / 开关  (${hk})`,
    muteSpeaker: (hk) => `应用声音静音 / 开关  (${hk})`,
    customizeHotkeys: '全局快捷键与高级偏好设置…',
    networkProxy: '网络代理配置 (TUN/系统)…',
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
let updateDownloaded = false;
let pendingUpdate = null;

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

// ---- persisted state ----------------------------------------------------
const AVATAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#6366f1', '#14b8a6', '#f97316', '#d946ef',
  '#0284c7', '#16a34a', '#ea580c', '#9333ea',
];

// 窗口几何安全 helpers 已抽到 lib/window-bounds.js (pilot P1);
// 行为不变, main.js 仍通过 module.exports 对外导出这两个函数。
const { sanitizeWindowBounds, ensureBoundsVisible } = require('./lib/window-bounds');

function defaultProxy() {
  return {
    mode: 'system', // 'system' (自适应系统/TUN网卡), 'custom' (手动指定覆盖), 'direct' (直连)
    enabled: false,  // 手动指定代理开关
    type: 'http',   // 'http' | 'socks5'
    host: '127.0.0.1',
    port: 7897,
    bypass: '<local>;localhost;127.0.0.1',
  };
}

function defaultAutomation() {
  return {
    enabled: false,
    autoAllowAll: false,
    showOnScreenWidget: true,
    actions: {
      connectors: true,
      file_access: true,
      external_links: true,
      media_permissions: true,
      code_execution: true,
    },
    sites: {},
    siteActions: {},
  };
}

function detectDefaultLocale() {
  try {
    const sys = app.getLocale() || '';
    if (sys.toLowerCase().startsWith('zh')) return 'zh-CN';
  } catch {}
  return 'en';
}

function defaultLock() {
  return {
    enabled: false,
    hash: '',
    salt: '',
    autoLockEnabled: false,
    idleMinutes: 15,
  };
}

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

function defaultState() {
  return {
    window: {},
    windowByProfile: {},
    site: 'muse',
    profiles: [{ id: 'default', name: '账号 1', color: AVATAR_COLORS[0] }],
    activeProfileId: 'default',
    hotkeys: { ...DEFAULT_HOTKEYS },
    automation: defaultAutomation(),
    proxy: defaultProxy(),
    theme: 'dark', // 'dark' | 'light' | 'system'
    locale: detectDefaultLocale(), // 'zh-CN' | 'en'
    ui: {
      autoHideButtons: true, // 自动隐藏右上角与右下角按钮
      dockPinned: false, // 账号栏是否固定常态展开 (默认 false: 鼠标移开后自动收起)
    },
    lock: defaultLock(),
  };
}
const statePath = () => path.join(app.getPath('userData'), 'app-state.json');
const stateBackupPath = () => path.join(app.getPath('userData'), 'app-state.json.bak');
const stateBackup2Path = () => path.join(app.getPath('userData'), 'app-state.json.bak2');

let isStateSafelyLoaded = false;

function sanitizeAndMergeState(raw) {
  const merged = { ...defaultState(), ...raw };
  merged.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) };
  merged.theme = raw.theme || 'dark';
  merged.locale = (raw.locale === 'zh-CN' || raw.locale === 'en') ? raw.locale : detectDefaultLocale();
  merged.ui = { ...defaultState().ui, ...(raw.ui || {}) };
  if (typeof merged.ui.dockPinned !== 'boolean') {
    merged.ui.dockPinned = false;
  }
  merged.automation = {
    ...defaultAutomation(),
    ...(raw.automation || {}),
    actions: { ...defaultAutomation().actions, ...((raw.automation && raw.automation.actions) || {}) },
    sites: { ...((raw.automation && raw.automation.sites) || {}) },
    siteActions: { ...((raw.automation && raw.automation.siteActions) || {}) },
  };
  merged.proxy = { ...defaultProxy(), ...(raw.proxy || {}) };
  const rawLock = (raw && raw.lock) || {};
  merged.lock = {
    enabled: typeof rawLock.enabled === 'boolean' ? rawLock.enabled : false,
    hash: typeof rawLock.hash === 'string' ? rawLock.hash : '',
    salt: typeof rawLock.salt === 'string' ? rawLock.salt : '',
    autoLockEnabled: typeof rawLock.autoLockEnabled === 'boolean' ? rawLock.autoLockEnabled : false,
    idleMinutes: (typeof rawLock.idleMinutes === 'number' && [1, 5, 15, 30, 60].includes(rawLock.idleMinutes)) ? rawLock.idleMinutes : 15,
  };
  // 窗口几何必须钳制后再用: 历史坏值 (屏幕外/负尺寸) 不得重放进新会话
  merged.window = sanitizeWindowBounds(raw.window || {});
  const wbp = {};
  if (raw.windowByProfile && typeof raw.windowByProfile === 'object') {
    for (const [pid, b] of Object.entries(raw.windowByProfile)) {
      if (b && typeof b === 'object') wbp[pid] = sanitizeWindowBounds(b);
    }
  }
  merged.windowByProfile = wbp;
  // 兼容历史老数据：若未显式指定 custom/direct，统一重置为 system 自适应模式
  if (merged.proxy.mode !== 'custom' && merged.proxy.mode !== 'direct') {
    merged.proxy.mode = 'system';
    merged.proxy.enabled = false;
  }
  // profiles 合法性校验 (v1.5.16, 评审 P2): 此前只补颜色, 不查 id。空/重复/
  // 非字符串 id 会让多个账号映射到同一 persist:muse-undefined 分区且不可拆分。
  // 现在过滤非法与重复 id (保留首个), 全部非法时回退默认账号。
  if (Array.isArray(merged.profiles) && merged.profiles.length > 0) {
    const seenIds = new Set();
    merged.profiles = merged.profiles
      .filter((prof) => {
        if (!prof || typeof prof.id !== 'string' || !prof.id.trim() || seenIds.has(prof.id)) return false;
        seenIds.add(prof.id);
        return true;
      })
      .map((prof, idx) => ({
        ...prof,
        color: prof.color || AVATAR_COLORS[idx % AVATAR_COLORS.length],
      }));
  }
  if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) {
    merged.profiles = [{ id: 'default', name: '账号 1', color: AVATAR_COLORS[0] }];
  }
  // windowByProfile 只保留现存账号的条目, 防已删账号的几何记录无限堆积
  {
    const validIds = new Set(merged.profiles.map((prof) => prof.id));
    for (const pid of Object.keys(merged.windowByProfile)) {
      if (!validIds.has(pid)) delete merged.windowByProfile[pid];
    }
  }
  return merged;
}

function loadState() {
  const primaryPath = statePath();
  const backupPath = stateBackupPath();

  // 1. 优先尝试读取主状态文件
  try {
    if (fs.existsSync(primaryPath)) {
      const content = fs.readFileSync(primaryPath, 'utf8');
      if (content && content.trim()) {
        const raw = JSON.parse(content);
        const parsed = sanitizeAndMergeState(raw);
        isStateSafelyLoaded = true;
        // 成功读取且包含 profiles，维护备份
        if (parsed.profiles && parsed.profiles.length > 0) {
          try { fs.copyFileSync(primaryPath, backupPath); } catch {}
        }
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[State] Main app-state.json corrupted or unreadable, attempting backup recovery:', err);
  }

  // 2. 主文件损坏或空文件时，依次尝试 .bak / .bak2 代际备份恢复，绝不直接抹空账号
  for (const candidate of [backupPath, stateBackup2Path()]) {
    try {
      if (fs.existsSync(candidate)) {
        const backupContent = fs.readFileSync(candidate, 'utf8');
        if (backupContent && backupContent.trim()) {
          const rawBackup = JSON.parse(backupContent);
          const parsedBackup = sanitizeAndMergeState(rawBackup);
          console.log('[State] Successfully restored profiles and settings from backup file:', candidate);
          isStateSafelyLoaded = true;
          try { fs.writeFileSync(primaryPath, JSON.stringify(parsedBackup, null, 2), 'utf8'); } catch {}
          return parsedBackup;
        }
      }
    } catch (backupErr) {
      console.error('[State] Backup recovery failed for', candidate, backupErr);
    }
  }

  // 3. 首次启动主备均无时，采用默认状态
  isStateSafelyLoaded = false;
  return defaultState();
}

let state = loadState();
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

// 核心加固：原子写入与双备份，杜绝 0 字节截断损坏导致账号凭据与列表丢失
function saveState() {
  try {
    const filePath = statePath();
    const backupPath = stateBackupPath();
    const tmpPath = filePath + '.tmp';
    const content = JSON.stringify(state, null, 2);

    // 1. 代际轮换 (v1.5.16, 评审 P2): 旧实现每次保存后立刻用新内容覆盖 .bak,
    // 内存中的 state 一旦被写坏, 主备会一起坏。改为覆盖主文件之前, 先把磁盘上
    // 当前主文件 (最后一个可解析的已知良好版本) 轮为 .bak, 旧 .bak 轮为
    // .bak2; 当前主文件不可解析时不轮转, 防止坏内容污染备份链。
    try {
      const currentOnDisk = fs.readFileSync(filePath, 'utf8');
      JSON.parse(currentOnDisk);
      try { if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, stateBackup2Path()); } catch {}
      try { fs.copyFileSync(filePath, backupPath); } catch {}
    } catch {}

    // 2. 先安全落盘至临时文件
    fs.writeFileSync(tmpPath, content, 'utf8');

    // 3. 原子重命名替换
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.copyFileSync(tmpPath, filePath);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch (err) {
    console.error('[State] Failed to save state atomically:', err);
  }
}

// 窗口 resize/move 等高频事件防抖版本，避免频繁磁盘 IO
let saveStateDebounceTimer = null;
function saveStateDebounced() {
  if (saveStateDebounceTimer) clearTimeout(saveStateDebounceTimer);
  saveStateDebounceTimer = setTimeout(() => {
    saveState();
  }, 300);
}

// 仅在明确安全加载或全新初始安装时执行首写，避免覆盖损坏现场
if (isStateSafelyLoaded || !fs.existsSync(statePath())) {
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
    if (!(input.control && !input.meta && !input.alt && input.type === 'keyDown')) return;
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

// ---- External links & navigation security (Open in system default browser) --
function extractExternalTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    // 只解包已知跳转站的重定向参数 (v1.5.17 加固, 评审 P2): 此前任意 URL 的
    // ?u=/?url= 参数都会被解包直达, 页面可借此绕过外链提示把用户带到钓鱼站
    const REDIRECTOR_HOSTS = new Set([
      'www.google.com', 'google.com', 'www.bing.com', 'bing.com',
      'duckduckgo.com', 'html.duckduckgo.com', 'l.facebook.com',
      'out.reddit.com', 'www.youtube.com',
    ]);
    if (!REDIRECTOR_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    // 识别常见重定向跳转参数
    const redirectKeys = ['u', 'url', 'target', 'dest', 'destination', 'link', 'href', 'q'];
    for (const key of redirectKeys) {
      const candidate = parsed.searchParams.get(key);
      if (candidate) {
        try {
          const candUrl = new URL(candidate);
          if (candUrl.protocol === 'http:' || candUrl.protocol === 'https:') {
            const candHost = candUrl.hostname.toLowerCase();
            const isInternal = candHost === 'muse.ai' || candHost.endsWith('.muse.ai') ||
                             candHost === 'meta.ai' || candHost.endsWith('.meta.ai');
            if (!isInternal) {
              return candidate;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

function isInternalSiteUrl(rawUrl) {
  try {
    // 若属于外部链接包装重定向，实质属于外链
    if (extractExternalTargetUrl(rawUrl)) return false;

    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'muse.ai' || host.endsWith('.muse.ai')) return true;
    if (host === 'meta.ai' || host.endsWith('.meta.ai')) return true;
    if (host === 'meta.com' || host.endsWith('.meta.com')) return true;
    // file: 不再归为内部站点 (v1.5.17, 评审 P2): 旧归类让任意本地 HTML 能在
    // 挂有特权 preload 的窗口内被当作内部页面放行导航。应用自身页面都由主
    // 进程直接 loadURL/loadFile 打开, 不经过链接/导航拦截, 不受此改动影响。
    return false;
  } catch {
    return false;
  }
}

function isAuthOrConnectorUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  // 关键：允许空白弹窗占位符（现代前端异步打开 OAuth 弹窗的通用标准模式）
  if (rawUrl === 'about:blank' || rawUrl === '' || rawUrl.startsWith('about:')) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // 1. Meta / Facebook / Instagram 家族认证域名及通用 OAuth 域名
    const authHosts = [
      'meta.com',
      'auth.meta.com',
      'account.meta.com',
      'family.meta.com',
      'work.meta.com',
      'facebook.com',
      'fb.com',
      'instagram.com',
      'accounts.google.com',
      'appleid.apple.com',
      'github.com',
      'spotify.com',
      'accounts.spotify.com',
      'dropbox.com',
      'zoom.us',
      'canva.com',
      'onepeloton.com',
      'peloton.com',
      'slack.com',
      'notion.so',
      'login.microsoftonline.com',
      'live.com',
      'login.live.com',
      'linkedin.com',
      'twitter.com',
      'x.com',
      'plaid.com',
      'functionhealth.com',
      'healthex.com',
    ];
    if (authHosts.some((h) => host === h || host.endsWith('.' + h))) {
      return true;
    }

    // 2. 内部站点的连接器中转授权与登录路由（含认证错误回调、状态码与授权换码）
    const isInternal = host === 'muse.ai' || host.endsWith('.muse.ai') ||
                       host === 'meta.ai' || host.endsWith('.meta.ai') ||
                       host === 'meta.com' || host.endsWith('.meta.com');
    if (isInternal) {
      if (
        pathname.includes('/connector') ||
        pathname.includes('/auth') ||
        pathname.includes('/oauth') ||
        pathname.includes('/login') ||
        pathname.includes('/signin') ||
        search.includes('connector') ||
        search.includes('error=') ||
        search.includes('code=') ||
        search.includes('state=') ||
        search.includes('token=')
      ) {
        return true;
      }
    }

    // 3. 通用 OAuth 特征（包含 client_id 以及 redirect_uri / response_type）
    if (
      (search.includes('client_id=') || search.includes('response_type=')) &&
      (search.includes('redirect_uri=') || pathname.includes('oauth') || pathname.includes('auth'))
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

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

function setupExternalLinkHandler(win, profileId) {
  if (!win || win.isDestroyed()) return;

  // 1. 拦截 window.open() 或带 target="_blank" 的链接
  win.webContents.setWindowOpenHandler((details) => {
    const { url, disposition, features } = details;

    // 允许身份验证、连接器弹窗以及所有显式弹窗（Popup）
    const isAuth = isAuthOrConnectorUrl(url);
    const isPopup = disposition === 'new-window' ||
                    (typeof features === 'string' && features.length > 0) ||
                    url === 'about:blank' || url === '';

    if (isAuth || isPopup) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
        },
      };
    }

    // 检查是否为外部链接或包装的外链重定向（由外部默认浏览器打开）
    const extracted = extractExternalTargetUrl(url);
    const finalExternalUrl = extracted || (!isInternalSiteUrl(url) ? url : null);

    if (finalExternalUrl && (finalExternalUrl.startsWith('http://') || finalExternalUrl.startsWith('https://') || finalExternalUrl.startsWith('mailto:'))) {
      shell.openExternal(finalExternalUrl).catch((err) => {
        console.warn('[ExternalLink] Failed to open external URL:', finalExternalUrl, err);
      });
      return { action: 'deny' };
    }

    // 内部站点链接：绝不直接在主窗口执行 win.loadURL(url) 以免冲毁当前正在聊天的会话
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
  const handleNavigation = (event, url) => {
    if (isAuthOrConnectorUrl(url)) {
      return;
    }
    const extracted = extractExternalTargetUrl(url);
    const finalExternalUrl = extracted || (!isInternalSiteUrl(url) ? url : null);

    if (finalExternalUrl) {
      event.preventDefault();
      if (finalExternalUrl.startsWith('http://') || finalExternalUrl.startsWith('https://') || finalExternalUrl.startsWith('mailto:')) {
        shell.openExternal(finalExternalUrl).catch((err) => {
          console.warn('[ExternalLink] Failed to open external URL on nav:', finalExternalUrl, err);
        });
      }
    }
  };

  win.webContents.on('will-navigate', handleNavigation);
  win.webContents.on('will-redirect', handleNavigation);
}

// ---- network & proxy settings ---------------------------------------------
async function applyProxyToSession(targetSession) {
  if (!targetSession) return;
  const p = state.proxy || defaultProxy();
  try {
    if (p.mode === 'custom' && p.enabled !== false) {
      const type = (p.type || 'http').toLowerCase();
      const host = (p.host || '127.0.0.1').trim();
      const port = parseInt(p.port, 10) || 7897;
      // 标准单代理规则语法：http://127.0.0.1:7897 或 socks5://127.0.0.1:7897
      const proxyRules = `${type}://${host}:${port}`;
      const proxyBypassRules = p.bypass || '<local>;localhost;127.0.0.1';
      await targetSession.setProxy({ proxyRules, proxyBypassRules });
      console.log(`[Proxy] Applied custom proxy to session: ${proxyRules}`);
    } else if (p.mode === 'direct') {
      await targetSession.setProxy({ mode: 'direct' });
      console.log('[Proxy] Applied direct connection mode to session');
    } else {
      // 默认自适应系统网络与TUN虚拟网卡（开箱即用，支持多机部署）
      await targetSession.setProxy({ mode: 'system' });
      console.log('[Proxy] Applied adaptive system/TUN proxy mode to session');
    }
  } catch (err) {
    console.error('[Proxy] Failed to apply proxy to session:', err);
  }
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

async function applyProxySettings() {
  await applyProxyToSession(session.defaultSession);
  for (const p of state.profiles) {
    const s = session.fromPartition(partitionFor(p.id));
    await applyProxyToSession(s);
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

function getOrCreateProfileWindow(profileId, targetBounds) {
  let win = profileWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    if (targetBounds) win.setBounds(ensureBoundsVisible(targetBounds));
    return win;
  }

  // 确保新窗口的 Session 立即继承全局统一的网络代理配置
  const ses = session.fromPartition(partitionFor(profileId));
  applyProxyToSession(ses);

  const saved = ensureBoundsVisible(
    targetBounds || (state.windowByProfile && state.windowByProfile[profileId]) || state.window || {}
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
  if (process.platform !== 'darwin' && fs.existsSync(APP_ICON_PATH)) {
    win.setIcon(APP_ICON_PATH);
  }

  win.webContents.setUserAgent(CHROME_UA);
  win.loadURL(currentSite().url);
  win.webContents.on('did-finish-load', () => {
    injectMicShim(win);
    broadcastAccountChange();
    broadcastThemeChange();
    broadcastUISettingsChange();
    broadcastLocaleChange();
  });

  // 网络错误处理：加载离线诊断页并自动弹出网络配置界面
  win.webContents.on('did-fail-load', async (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED 忽略
    console.warn(`[Network] Failed to load ${validatedURL}: [${errorCode}] ${errorDescription}`);
    if (validatedURL && validatedURL.includes('offline.html')) return;

    // 若发生连接失败且为严重网络阻断（代理故障/连接被拒/超时），主动唤出网络配置界面引导修复
    const isConnFailure = errorCode === -130 || errorCode === -100 || errorCode === -102 || errorCode === -7 || errorCode === -105;
    if (isConnFailure) {
      console.log(`[Network] Connection failed with [${errorCode}] ${errorDescription}, popping up proxy settings...`);
      openHotkeySettings('tab-proxy');
    }

    win.loadFile(path.join(__dirname, 'offline.html'), {
      query: {
        err: errorCode,
        desc: errorDescription,
        url: validatedURL || currentSite().url,
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

// 统一的窗口唤回动作: 先修几何 -> 恢复最小化 -> show -> 置顶聚焦,
// 并返回 show 后是否真的可见, 供调用方在楔死时走重建兜底。
function showWindowSafely(win) {
  if (!win || win.isDestroyed()) return false;
  if (isScreenLocked) return false;
  try { win.setBounds(ensureBoundsVisible(win.getBounds())); } catch {}
  if (win.isMinimized()) win.restore();
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

function switchAccount(id) {
  if (isScreenLocked) return;
  recordUserActivity();
  if (!state.profiles.some((p) => p.id === id)) return;
  if (id === state.activeProfileId && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return;

  const prevWin = mainWindow;
  let currentBounds = null;
  if (prevWin && !prevWin.isDestroyed()) {
    currentBounds = prevWin.getBounds();
  }

  state.activeProfileId = id;
  saveState();

  // 获取或复用目标账号的常驻窗口（零重载瞬切）
  const targetWin = getOrCreateProfileWindow(id, currentBounds);
  mainWindow = targetWin;

  showWindowSafely(targetWin);

  // 快捷窗的 partition 在创建时绑定, 切账号后必须销毁, 否则它会继续以
  // 上一个账号的登录态响应 (评审 P0-4); 下次打开时按新账号重建
  if (quickWindowProfileId !== id) destroyQuickWindow();

  // 子弹窗跟随账号可见性: 目标账号此前开着的弹窗恢复显示
  setChildWindowsVisible(id, true);

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

function addProfile(customName) {
  // 账号 id 必须全局唯一 (v1.5.16, 评审 P2): 此前用 acc_${Date.now()}, 托盘与
  // 页面两入口同毫秒各触发一次即撞号, 两账号共用同一 partition 完全串号,
  // 删其一还会清掉另一个。改用 randomUUID 并做唯一性兜底。
  let id = `acc_${require('crypto').randomUUID()}`;
  while (state.profiles.some((prof) => prof.id === id)) {
    id = `acc_${require('crypto').randomUUID()}`;
  }
  const color = AVATAR_COLORS[state.profiles.length % AVATAR_COLORS.length];
  const name = (customName && customName.trim()) || `账号 ${state.profiles.length + 1}`;
  const profile = { id, name, color };
  state.profiles.push(profile);
  saveState();
  setupDownloadHandler(id);
  setupPermissions(id);
  setupSessionPersistence(id);
  applyProxyToSession(session.fromPartition(partitionFor(id)));
  switchAccount(id);
  notify('新增账号', `${profile.name} 已创建，已就绪独立会话环境。`);
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
    width: 480,
    height: 660,
    icon: APP_ICON_PATH,
    title: 'Customize hotkeys & settings',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js') },
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

ipcMain.handle('automation-toggle', (e) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  toggleAutomationMaster();
  return { ok: true, enabled: state.automation.enabled };
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

ipcMain.handle('account:add', (e, { name }) => {
  if (denyUntrusted(e)) return { ok: false, error: 'untrusted sender' };
  addProfile(name);
  return { ok: true };
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
  if (wasActive) state.activeProfileId = state.profiles[0].id;
  saveState();
  buildTrayMenu();
  broadcastAccountChange();

  await clearWholeSession(session.fromPartition(partitionFor(id)));
  // partition 的磁盘目录一并删除, 不留孤儿会话残留 (失败忽略, 不阻塞结果)
  try {
    const partDir = path.join(
      app.getPath('userData'),
      'Partitions',
      partitionFor(id).replace(/^persist:/, '')
    );
    await fs.promises.rm(partDir, { recursive: true, force: true });
  } catch {}

  if (wasActive) {
    mainWindow = getOrCreateProfileWindow(state.activeProfileId);
    showWindowSafely(mainWindow);
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
    state.ui = { ...(state.ui || {}), ...newUI };
    saveState();
    buildTrayMenu();
    broadcastUISettingsChange();
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

// Floating "Export chat" button in the page asks the main process to export.
ipcMain.on('muse-export-request', (e) => { if (!denyUntrusted(e)) exportChat(); });

// 处理页面请求用系统默认浏览器打开外部链接
ipcMain.on('open-external-url', (e, rawUrl) => {
  if (denyUntrusted(e)) return;
  const target = extractExternalTargetUrl(rawUrl) || rawUrl;
  if (typeof target === 'string' && (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:'))) {
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
  const curSes = session.fromPartition(partitionFor(state.activeProfileId));
  const r1 = await clearGoogleAuthSession(curSes);
  return { ok: r1 };
});

// 下载文件交互与目录打开 IPC
ipcMain.handle('download:open-folder', (e, filePath) => {
  if (denyUntrusted(e)) return false;
  if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('download:open-file', async (e, filePath) => {
  if (denyUntrusted(e)) return false;
  if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
    await shell.openPath(filePath);
    return true;
  }
  return false;
});

// ---- downloads & right-click menu -------------------------------------------
// Electron shows no context menu on its own, so links can only be clicked
// (navigating to them) rather than saved. This adds Save link/image as,
// copy link, and the standard edit items, plus real download handling.
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

// ---- portable self-update -----------------------------------------------------
// electron-updater doesn't support the portable target, so the portable build
// updates itself: check the GitHub releases feed, download the new portable
// exe in the background, and swap it in on restart via a tiny detached
// PowerShell helper. A .bak of the previous version is kept beside the exe.
const UPDATE_REPO = 'xusofty-cyber/muse-ai-Desktop';

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

let isCheckingUpdate = false;

// 应用内自更新只适用于 Windows 便携版: 它替换的是 PORTABLE_EXECUTABLE_FILE
// 指向的单文件。此前无门控三平台都跑, Linux/mac 会下载 Windows exe 再调
// 不存在的 powershell; NSIS 安装版则会被便携版 exe 原地替换造成版本错位。
function isPortableWindowsBuild() {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
}

async function checkForUpdates(manual) {
  if (!isPortableWindowsBuild()) {
    if (manual) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '检查版本更新',
        message: '当前安装方式不支持应用内自动更新。',
        detail: '请前往 GitHub Releases 页面下载与您系统匹配的最新安装包。',
        buttons: ['前往 GitHub Releases', '取消'],
      });
      if (response === 0) shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`);
    }
    return;
  }
  if (isCheckingUpdate) {
    if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '正在检查版本更新，请稍候...',
      });
    }
    return;
  }
  isCheckingUpdate = true;

  try {
    const fetchFunc = (typeof net !== 'undefined' && net.fetch) ? net.fetch : fetch;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetchFunc(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'muse-windows', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    // 超时必须覆盖正文读取 (v1.5.16, 评审 P2): 旧实现响应头一到就 clearTimeout,
    // 正文滴流能让检查永久挂起且 isCheckingUpdate 永远为 true, 后续检查全灭
    const rel = await res.json();
    clearTimeout(timeoutId);
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    const current = app.getVersion();

    if (!latest || cmpVersions(latest, current) <= 0) {
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: '检查版本更新',
          message: `当前已是最新版本 (v${current})`,
          detail: '暂无可用更新。',
          buttons: ['确定'],
        });
      }
      return;
    }

    const releaseUrl = rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`;
    const asset = (rel.assets || []).find((a) => /^Muse-Portable-.*\.exe$/i.test(a.name || ''));

    if (manual) {
      const releaseNotes = (rel.body || '').trim();
      const detailMsg = releaseNotes ? `\n\n更新日志：\n${releaseNotes.slice(0, 300)}${releaseNotes.length > 300 ? '...' : ''}` : '';
      const buttons = asset ? ['前往 GitHub 下载', '后台下载便携版', '稍后再说'] : ['前往 GitHub 下载', '稍后再说'];
      
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${latest} (当前版本 v${current})`,
        detail: `有可用的新版本发布，建议及时更新。${detailMsg}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });

      if (response === 0) {
        shell.openExternal(releaseUrl);
        return;
      } else if (response === 1 && asset) {
        // 继续在后台下载便携版
      } else {
        return;
      }
    }

    if (!asset) {
      if (manual) {
        dialog.showMessageBox({
          type: 'warning',
          title: '更新提醒',
          message: `v${latest} 已发布，但未找到便携单文件 (Portable)。`,
          detail: '建议前往 GitHub Releases 页面下载安装包。',
          buttons: ['前往 GitHub', '取消'],
        }).then(({ response }) => {
          if (response === 0) shell.openExternal(releaseUrl);
        });
      }
      return;
    }

    if (pendingUpdate && pendingUpdate.version === latest) {
      if (manual) {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: '更新已就绪',
          message: `Muse v${latest} 安装文件已下载完成。`,
          detail: '是否立即重启应用以完成更新？',
          buttons: ['立即重启更新', '稍后手动重启'],
          defaultId: 0,
        });
        if (response === 0) {
          installUpdateAndRestart();
        }
      }
      return;
    }

    notify('正在下载更新', `Muse v${latest} 正在后台下载中...`);
    // 真实性校验前置 (v1.5.14): GitHub API 为每个资产提供 sha256 digest,
    // 缺失一律中止, 绝不进入待安装状态
    const expectedDigest = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('发布资产缺少 SHA-256 摘要, 已中止更新');
    // 流式下载 (v1.5.16, 评审 P2): 旧实现整包读入内存 (低配机峰值约两倍包体)
    // 且只有总时长上限。改为边下边落盘边算哈希, 超时改为 60 秒空闲超时
    // (持续有数据就一直下, 断流一分钟才放弃)
    const dlController = new AbortController();
    const dl = await fetchFunc(asset.browser_download_url, {
      headers: { 'User-Agent': 'muse-windows' },
      signal: dlController.signal,
    });
    if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
    // 文件名只取 basename, 防止资产名中的路径成分越出临时目录
    const dest = path.join(app.getPath('temp'), path.basename(String(asset.name || 'Muse-Portable.exe')));
    const hash = require('crypto').createHash('sha256');
    const outStream = fs.createWriteStream(dest);
    let received = 0;
    let headBuf = Buffer.alloc(0);
    let idleTimer = setTimeout(() => dlController.abort(), 60000);
    try {
      const reader = dl.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dlController.abort(), 60000);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (headBuf.length < 2) headBuf = Buffer.concat([headBuf, chunk.subarray(0, 2 - headBuf.length)]);
        hash.update(chunk);
        received += chunk.length;
        if (!outStream.write(chunk)) await new Promise((r) => outStream.once('drain', r));
      }
      clearTimeout(idleTimer);
      await new Promise((resolve, reject) => outStream.end((err) => (err ? reject(err) : resolve())));
    } catch (dlErr) {
      clearTimeout(idleTimer);
      try { outStream.destroy(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
      throw dlErr;
    }
    if (received < 1024 || headBuf[0] !== 0x4d || headBuf[1] !== 0x5a) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error('下载的文件不是合法的 Windows 可执行程序');
    }
    if (hash.digest('hex') !== expectedDigest) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error('更新文件 SHA-256 校验不通过, 已中止更新');
    }
    pendingUpdate = { version: latest, filePath: dest };
    updateDownloaded = true;
    buildTrayMenu();

    if (manual) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: '更新已就绪',
        message: `Muse v${latest} 下载完成！`,
        detail: '是否立即重启应用以完成更新？',
        buttons: ['立即重启', '稍后再说'],
        defaultId: 0,
      });
      if (response === 0) {
        installUpdateAndRestart();
      }
    } else {
      notify('更新已就绪', `Muse v${latest} 已下载完成，点击托盘菜单重启以安装。`, () => installUpdateAndRestart());
    }
  } catch (e) {
    const errMsg = String((e && e.message) || e);
    console.warn('[UpdateCheck] Failed:', errMsg);
    if (manual) {
      dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message: '无法连接到更新服务器或网络连接超时。',
        detail: `错误详情: ${errMsg}\n\n是否直接前往 GitHub Releases 页面查看并下载最新版本？`,
        buttons: ['前往 GitHub 查看', '取消'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
        }
      });
    }
  } finally {
    isCheckingUpdate = false;
  }
}

function buildUpdateScript(currentExe, newExe) {
  const q = (s) => s.replace(/'/g, "''");
  return [
    `$pidToWait = ${process.pid}`,
    `$current = '${q(currentExe)}'`,
    `$new = '${q(newExe)}'`,
    `try { Wait-Process -Id $pidToWait -ErrorAction Stop } catch {}`,
    `try {`,
    `  Copy-Item -LiteralPath $current -Destination ($current + '.bak') -Force`,
    `  Move-Item -LiteralPath $new -Destination $current -Force`,
    `  Start-Process -FilePath $current`,
    `} catch {}`,
  ].join('\r\n');
}

function canWriteBesideExe() {
  try {
    const probe = path.join(path.dirname(process.execPath), '.muse-write-test');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function installUpdateAndRestart() {
  if (!pendingUpdate) return;
  if (!isPortableWindowsBuild()) return;
  if (!canWriteBesideExe()) {
    dialog.showMessageBox({
      type: 'warning',
      title: '无法自动替换',
      message: '当前应用程序目录没有写入权限（可能属于只读或安装版目录）。',
      detail: '建议前往 GitHub Releases 页面下载安装包覆盖安装。',
      buttons: ['前往 GitHub', '取消'],
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
      }
    });
    return;
  }
  const scriptPath = path.join(app.getPath('temp'), 'muse-update.ps1');
  try {
    fs.writeFileSync(scriptPath, buildUpdateScript(process.execPath, pendingUpdate.filePath));
  } catch (e) {
    dialog.showErrorBox('更新失败', '无法写入更新执行脚本: ' + String((e && e.message) || e));
    return;
  }
  try {
    const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true, stdio: 'ignore',
    });
    // 未监听的 error 事件会以异常抛进主进程 (如 powershell 不存在时), 必须接住
    child.on('error', (err) => {
      dialog.showErrorBox('更新失败', String((err && err.message) || err));
    });
    child.unref();
  } catch (e) {
    dialog.showErrorBox('更新失败', String((e && e.message) || e));
    return;
  }
  app.quitting = true;
  app.quit();
}

function setupAutoUpdate() {
  // 仅 Windows 便携版有应用内自更新; 其他平台/安装形态不启动后台检查,
  // 手动检查走 checkForUpdates 内的 Releases 页引导。
  if (!isPortableWindowsBuild()) return;
  setTimeout(() => checkForUpdates(false), 30_000);
  setInterval(() => checkForUpdates(false), 6 * 3600_000);
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
    {
      label: t.multiAccounts,
      submenu: [
        ...profileItems,
        { type: 'separator' },
        { label: t.nextAccount(prettyHotkey(state.hotkeys.metaAccount)), click: nextAccount },
        { label: t.addAccount, click: () => addProfile() },
      ],
    },
    { type: 'separator' },
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
    { type: 'separator' },
    {
      label: t.profileMenu(activeProfile().name),
      submenu: [
        ...profileItems,
        { type: 'separator' },
        { label: t.addProfile, click: addProfile },
        { label: t.signOutFrom(currentSite().name), click: signOut },
      ],
    },
    { label: t.saveClipboard, click: saveClipboardAsFile },
    { label: t.exportChat(prettyHotkey(state.hotkeys.export)), click: exportChat },
    { type: 'separator' },
    { label: t.muteMic(prettyHotkey(state.hotkeys.mic)), click: toggleMic },
    { label: t.muteSpeaker(prettyHotkey(state.hotkeys.speaker)), click: toggleSpeaker },
    { label: t.customizeHotkeys, click: () => openHotkeySettings() },
    { label: t.networkProxy, click: () => openHotkeySettings('tab-proxy') },
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
    ...(updateDownloaded
      ? [{ label: t.restartInstall, click: installUpdateAndRestart }]
      : []),
    { type: 'separator' },
    {
      label: t.quitMuse,
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
  // 首屏优先 (v1.5.15, 评审 P1-8): 此前 await applyProxySettings 排在建窗之前,
  // 任一分区 setProxy 卡住即表现为进程在、无窗无托盘, 与窗口事故表型相同。
  // 现在先建窗/托盘, 代理异步补应用并加 5s 超时降级 (新窗口创建时各自还会
  // 按当前配置 applyProxyToSession, 不依赖这条全量应用完成)。
  createMainWindow();
  createTray();
  registerHotkeys();
  state.profiles.forEach((p) => {
    setupDownloadHandler(p.id);
    setupPermissions(p.id);
    setupSessionPersistence(p.id);
  });
  setupAutoUpdate();
  startAutoLockTimer();
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
  if (autoLockTimer) clearInterval(autoLockTimer);
  globalShortcut.unregisterAll();
});

// 仅供本地冒烟测试引用内部纯函数; Electron 运行时忽略该导出。
try { module.exports = { sanitizeWindowBounds, ensureBoundsVisible, isValidHostname, isTrustedIpcSender, isPortableWindowsBuild, childWindowsByProfile, pendingWindowNav, MAX_RESIDENT_PROFILE_WINDOWS, sanitizeAndMergeState, defaultLock, hashPassword, verifyPassword, unlockScreen, lockScreen, isScreenLocked: () => isScreenLocked, getInternalState: () => state }; } catch {}
