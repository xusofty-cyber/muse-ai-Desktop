const { app, BrowserWindow, Tray, Menu, MenuItem, globalShortcut, shell, nativeImage, clipboard, session, dialog, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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
};
const HOTKEY_LABELS = {
  quick: 'Quick chat popup',
  site: 'Switch Muse / Meta AI',
  export: 'Export this chat',
  mic: 'Mute / unmute microphone',
  speaker: 'Mute / unmute app sound',
  automation: 'Toggle automation (Auto-Allow)',
  metaAccount: 'Next account (Switch)',
};
const HOTKEY_ACTIONS = {
  quick: () => toggleQuickWindow(),
  site: () => toggleSite(),
  export: () => exportChat(),
  mic: () => toggleMic(),
  speaker: () => toggleSpeaker(),
  automation: () => toggleAutomationMaster(),
  metaAccount: () => nextAccount(),
};

let mainWindow = null;
let quickWindow = null;
let tray = null;
let updateDownloaded = false;
let pendingUpdate = null;

app.setName('Muse');
app.setAppUserModelId('ai.muse.desktop');

// Performance & Network flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
// 关键：禁用后量子密钥协商(Kyber)与ECH拓展，解决Clash/代理软件在TLS 1.3 ClientHello拆包时触发的 net_error -100 (ERR_CONNECTION_CLOSED)
app.commandLine.appendSwitch('disable-features', 'PostQuantumKeyAgreement,EncryptedClientHello');
app.commandLine.appendSwitch('ssl-version-min', 'tls1.2');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_UA;

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// ---- persisted state ----------------------------------------------------
const AVATAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

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

function defaultState() {
  return {
    window: {},
    site: 'muse',
    profiles: [{ id: 'default', name: '账号 1', color: AVATAR_COLORS[0] }],
    activeProfileId: 'default',
    hotkeys: { ...DEFAULT_HOTKEYS },
    automation: defaultAutomation(),
    proxy: defaultProxy(),
  };
}
const statePath = () => path.join(app.getPath('userData'), 'app-state.json');
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const merged = { ...defaultState(), ...raw };
    merged.hotkeys = { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) };
    merged.automation = {
      ...defaultAutomation(),
      ...(raw.automation || {}),
      actions: { ...defaultAutomation().actions, ...((raw.automation && raw.automation.actions) || {}) },
      sites: { ...((raw.automation && raw.automation.sites) || {}) },
      siteActions: { ...((raw.automation && raw.automation.siteActions) || {}) },
    };
    merged.proxy = { ...defaultProxy(), ...(raw.proxy || {}) };
    // 兼容历史老数据：若未显式指定 custom/direct，统一重置为 system 自适应模式
    if (merged.proxy.mode !== 'custom' && merged.proxy.mode !== 'direct') {
      merged.proxy.mode = 'system';
      merged.proxy.enabled = false;
    }
    if (Array.isArray(merged.profiles) && merged.profiles.length > 0) {
      merged.profiles = merged.profiles.map((p, idx) => ({
        ...p,
        color: p.color || AVATAR_COLORS[idx % AVATAR_COLORS.length],
      }));
    } else {
      merged.profiles = [{ id: 'default', name: '账号 1', color: AVATAR_COLORS[0] }];
    }
    return merged;
  } catch {
    return defaultState();
  }
}
let state = loadState();
if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
  state.activeProfileId = state.profiles[0].id;
}
function saveState() {
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}
saveState();

const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
const partitionFor = (profileId) => `persist:muse-${profileId}`;
const currentSite = () => SITES[state.site] || SITES.muse;

function notify(title, body, onClick) {
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
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

async function applyProxySettings() {
  await applyProxyToSession(session.defaultSession);
  for (const p of state.profiles) {
    const s = session.fromPartition(partitionFor(p.id));
    await applyProxyToSession(s);
  }
}

// ---- Multi-Window Tab Architecture (Zero-Reload Instant Switching) --------
const profileWindows = new Map(); // profileId -> BrowserWindow

function broadcastAccountChange() {
  const payload = {
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
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

function getOrCreateProfileWindow(profileId, targetBounds) {
  let win = profileWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    if (targetBounds) win.setBounds(targetBounds);
    return win;
  }

  // 确保新窗口的 Session 立即继承全局统一的网络代理配置
  const ses = session.fromPartition(partitionFor(profileId));
  applyProxyToSession(ses);

  const saved = targetBounds || state.window || {};
  win = new BrowserWindow({
    width: saved.width || 1200,
    height: saved.height || 800,
    x: typeof saved.x === 'number' ? saved.x : undefined,
    y: typeof saved.y === 'number' ? saved.y : undefined,
    title: `${currentSite().name} (Muse desktop)`,
    autoHideMenuBar: true,
    backgroundColor: '#141414',
    show: false,
    webPreferences: {
      ...webPrefs(),
      partition: partitionFor(profileId),
    },
  });

  win.webContents.setUserAgent(CHROME_UA);
  win.loadURL(currentSite().url);
  win.webContents.on('did-finish-load', () => {
    injectMicShim(win);
    broadcastAccountChange();
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

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    state.window = { width, height, x, y };
    saveState();
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  win.on('close', (e) => {
    if (!app.quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  profileWindows.set(profileId, win);
  return win;
}

function createMainWindow() {
  mainWindow = getOrCreateProfileWindow(state.activeProfileId);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 430,
    height: 600,
    title: `${currentSite().name} quick chat`,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    backgroundColor: '#141414',
    webPreferences: webPrefs(),
  });
  quickWindow.webContents.setUserAgent(CHROME_UA);
  quickWindow.loadURL(currentSite().url);
  attachContextMenu(quickWindow);
  // Spotlight-style: hide when focus is lost.
  quickWindow.on('blur', () => { if (quickWindow) quickWindow.hide(); });
  quickWindow.on('closed', () => { quickWindow = null; });
}

function closeWindows() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.removeAllListeners('closed');
    quickWindow.close();
    quickWindow = null;
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

function toggleQuickWindow() {
  if (!quickWindow) createQuickWindow();
  if (quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const [w, h] = quickWindow.getSize();
    quickWindow.setPosition(
      Math.round(display.bounds.x + (display.bounds.width - w) / 2),
      Math.round(display.bounds.y + (display.bounds.height - h) / 2)
    );
    quickWindow.show();
    quickWindow.focus();
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = getOrCreateProfileWindow(state.activeProfileId);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---- profiles & accounts (Zero-Reload Multi-Tab Switching) ---------------
function switchAccount(id) {
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

  targetWin.show();
  targetWin.focus();

  // 隐藏前一个窗口
  if (prevWin && prevWin !== targetWin && !prevWin.isDestroyed()) {
    prevWin.hide();
  }

  buildTrayMenu();
  broadcastAccountChange();
}

function switchProfile(id) {
  switchAccount(id);
}

function nextAccount() {
  if (!state.profiles || state.profiles.length <= 1) return;
  const idx = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const nextIdx = (idx + 1) % state.profiles.length;
  switchAccount(state.profiles[nextIdx].id);
}

function addProfile(customName) {
  const id = `acc_${Date.now()}`;
  const color = AVATAR_COLORS[state.profiles.length % AVATAR_COLORS.length];
  const name = (customName && customName.trim()) || `账号 ${state.profiles.length + 1}`;
  const profile = { id, name, color };
  state.profiles.push(profile);
  saveState();
  setupDownloadHandler(id);
  setupPermissions(id);
  applyProxyToSession(session.fromPartition(partitionFor(id)));
  switchAccount(id);
  notify('新增账号', `${profile.name} 已创建，已就绪独立会话环境。`);
}

async function signOut() {
  const ses = session.fromPartition(partitionFor(state.activeProfileId));
  await ses.clearStorageData();
  const curWin = profileWindows.get(state.activeProfileId);
  if (curWin && !curWin.isDestroyed()) {
    curWin.loadURL(currentSite().url);
  }
  notify('Signed out', `Signed out of ${currentSite().name} on ${activeProfile().name}.`);
}

function toggleSite() {
  state.site = state.site === 'muse' ? 'meta' : 'muse';
  saveState();
  // Reuse the existing window when possible. This keeps the switch feeling
  // like changing tabs instead of restarting the app.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`${currentSite().name} (Muse desktop)`);
    mainWindow.loadURL(currentSite().url);
    if (quickWindow && !quickWindow.isDestroyed()) {
      quickWindow.setTitle(`${currentSite().name} quick chat`);
      quickWindow.loadURL(currentSite().url);
    }
    showMainWindow();
  } else {
    createMainWindow();
    showMainWindow();
  }
  buildTrayMenu();
}

function switchNextMetaAccount() {
  if (!state.profiles.length) return;
  const current = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const next = state.profiles[(current + 1) % state.profiles.length];
  switchMetaAccount(next.id);
}

function addMetaAccount() {
  const id = `p${Date.now()}`;
  const profile = { id, name: `Meta AI Account ${state.profiles.length + 1}` };
  state.profiles.push(profile);
  state.activeProfileId = id;
  state.site = 'meta';
  saveState();
  setupDownloadHandler(id);
  setupPermissions(id);
  closeWindows();
  createMainWindow();
  showMainWindow();
  buildTrayMenu();
  notify('New Meta AI account', `${profile.name} created. Sign in to Meta AI. Your other saved sessions remain untouched.`);
}

function switchMetaAccount() {
  if (!state.profiles.length) return;
  const current = state.profiles.findIndex((p) => p.id === state.activeProfileId);
  const next = state.profiles[(current + 1) % state.profiles.length];
  switchMetaAccountById(next.id);
}

function switchMetaAccountById(id) {
  if (!state.profiles.some((p) => p.id === id)) return;
  if (id === state.activeProfileId) {
    if (state.site !== 'meta') {
      state.site = 'meta';
      saveState();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle(`${currentSite().name} (Muse desktop)`);
        mainWindow.loadURL(currentSite().url);
      } else {
        createMainWindow();
      }
      showMainWindow();
    }
    buildTrayMenu();
    return;
  }
  state.site = 'meta';
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
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    let url = '';
    try { url = webContents.getURL(); } catch { /* ignore */ }
    const ours = /^https:\/\/(www\.)?(muse\.ai|meta\.ai)(\/|$)/.test(url);

    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { /* ignore */ }

    // Mic for voice chat, clipboard for the site's own copy buttons.
    let allowed = permission === 'media' || permission === 'audioCapture' ||
      permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';

    if (state.automation.enabled && (permission === 'media' || permission === 'audioCapture')) {
      allowed = isAutomationActionAllowed('media_permissions', hostname);
    }

    callback(ours && allowed);
  });
}

// ---- microphone toggle ------------------------------------------------------
// The page owns its mic device, so the app can't pick it, but it can mute it:
// a tiny shim in the page's own JS world wraps getUserMedia, tracks the
// streams the site creates, and flips their audio tracks on/off.
const MIC_SHIM = `(() => {
  if (window.__museMic) return;
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
  window.__museMic = {
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
      '(() => { const m = window.__museMic; return m ? m.toggle() : null; })()'
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
  for (const [id, acc] of Object.entries(bindings)) {
    if (!HOTKEY_ACTIONS[id]) return { ok: false, error: `Unknown action: ${id}` };
    if (!acc || !String(acc).trim()) return { ok: false, error: `Empty hotkey for "${HOTKEY_LABELS[id]}"` };
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
  if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
    hotkeyWindow.focus();
    if (initialTab) hotkeyWindow.webContents.send('switch-tab', initialTab);
    return;
  }
  hotkeyWindow = new BrowserWindow({
    width: 480,
    height: 660,
    title: 'Customize hotkeys & settings',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js') },
  });
  hotkeyWindow.loadFile(path.join(__dirname, 'hotkeys.html'));
  hotkeyWindow.webContents.on('did-finish-load', () => {
    if (initialTab) hotkeyWindow.webContents.send('switch-tab', initialTab);
  });
  hotkeyWindow.on('closed', () => { hotkeyWindow = null; });
}

ipcMain.handle('hotkeys-get', () => ({
  bindings: { ...state.hotkeys },
  labels: { ...HOTKEY_LABELS },
  defaults: { ...DEFAULT_HOTKEYS },
}));
ipcMain.handle('hotkeys-set', (e, bindings) => applyHotkeys(bindings || {}));

// Automation IPC handlers
ipcMain.handle('automation-get', () => ({
  ...state.automation,
  currentSiteUrl: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '',
}));

ipcMain.handle('automation-set', (e, updates) => {
  if (!updates || typeof updates !== 'object') return { ok: false };
  if (typeof updates.enabled === 'boolean') state.automation.enabled = updates.enabled;
  if (typeof updates.autoAllowAll === 'boolean') state.automation.autoAllowAll = updates.autoAllowAll;
  if (typeof updates.showOnScreenWidget === 'boolean') state.automation.showOnScreenWidget = updates.showOnScreenWidget;
  if (updates.actions && typeof updates.actions === 'object') {
    state.automation.actions = { ...state.automation.actions, ...updates.actions };
  }
  if (updates.sites && typeof updates.sites === 'object') {
    state.automation.sites = { ...updates.sites };
  }
  if (updates.siteActions && typeof updates.siteActions === 'object') {
    state.automation.siteActions = { ...updates.siteActions };
  }
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, state: state.automation };
});

ipcMain.handle('automation-toggle', () => {
  toggleAutomationMaster();
  return { ok: true, enabled: state.automation.enabled };
});

ipcMain.handle('automation-toggle-site', (e, hostname, enabled) => {
  if (!hostname) return { ok: false, error: 'No hostname provided' };
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
  if (!hostname || state.automation.actions[actionKey] === undefined) return { ok: false, error: 'Unknown site or action' };
  const norm = String(hostname).toLowerCase();
  state.automation.siteActions[norm] = { ...(state.automation.siteActions[norm] || {}), [actionKey]: !!enabled };
  saveState();
  buildTrayMenu();
  notifyWebContentsAutomationChange();
  return { ok: true, siteActions: state.automation.siteActions };
});

ipcMain.handle('automation-set-action', (e, actionKey, enabled) => {
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
  openHotkeySettings(tab);
  return { ok: true };
});

// 多账号管理 IPC handlers
ipcMain.handle('account:get-state', () => ({
  profiles: state.profiles,
  activeProfileId: state.activeProfileId,
}));

ipcMain.handle('account:switch', (e, { id }) => {
  switchAccount(id);
  return { ok: true };
});

ipcMain.handle('account:add', (e, { name }) => {
  addProfile(name);
  return { ok: true };
});

ipcMain.handle('account:rename', (e, { id, name }) => {
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
  const targetId = id || state.activeProfileId;
  const targetSession = session.fromPartition(partitionFor(targetId));
  try {
    await targetSession.clearStorageData();
    console.log(`[Account] Signed out / cleared storage for ${targetId}`);
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
  if (state.profiles.length <= 1) {
    return { ok: false, error: '至少保留一个账号' };
  }
  const idx = state.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: '账号不存在' };

  // 销毁窗口
  const win = profileWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('close');
    win.close();
  }
  profileWindows.delete(id);

  try {
    await session.fromPartition(partitionFor(id)).clearStorageData();
  } catch {}

  state.profiles.splice(idx, 1);
  if (state.activeProfileId === id) {
    switchAccount(state.profiles[0].id);
  } else {
    saveState();
    buildTrayMenu();
    broadcastAccountChange();
  }
  return { ok: true };
});

// 网络与代理配置 IPC handlers
ipcMain.handle('proxy-get', () => {
  return state.proxy || defaultProxy();
});

ipcMain.handle('proxy-set', async (e, config) => {
  if (!config || typeof config !== 'object') return { ok: false, error: 'Invalid proxy configuration' };
  state.proxy = {
    ...defaultProxy(),
    ...config,
  };
  saveState();
  await applyProxySettings();
  // 全局刷新所有已实例化的账号标签窗口，确保代理立即在所有账号中生效
  for (const win of profileWindows.values()) {
    if (win && !win.isDestroyed()) {
      win.webContents.reload();
    }
  }
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.reload();
  }
  return { ok: true };
});

// Floating "Export chat" button in the page asks the main process to export.
ipcMain.on('muse-export-request', () => exportChat());

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
    item.on('done', (e, state) => {
      if (state === 'completed') {
        notify('Download complete', `${fileName} saved. Click to open the folder.`, () =>
          shell.showItemInFolder(item.getSavePath())
        );
      } else if (state !== 'cancelled') {
        notify(`Download ${state}`, fileName);
      }
    });
  });
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (e, params) => {
    const menu = new Menu();
    if (params.linkURL) {
      const url = params.linkURL;
      menu.append(new MenuItem({ label: 'Save link as…', click: () => win.webContents.downloadURL(url) }));
      menu.append(new MenuItem({ label: 'Copy link address', click: () => clipboard.writeText(url) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.hasImageContents && params.srcURL) {
      const src = params.srcURL;
      menu.append(new MenuItem({ label: 'Save image as…', click: () => win.webContents.downloadURL(src) }));
      menu.append(new MenuItem({ label: 'Copy image address', click: () => clipboard.writeText(src) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
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
</style></head><body><h1>${escapeHTML(data.title || 'Chat export')}</h1><div class="meta">Exported ${escapeHTML(data.scrapedAt)} from ${escapeHTML(data.url)} (${data.messages.length} messages)</div>${bubbles}</body></html>`;
}

async function exportChat() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) {
    notify('Nothing to export', 'Open Muse first, then export the chat.');
    return;
  }
  let data = null;
  try {
    data = await win.webContents.executeJavaScript(
      'window.museExport ? window.museExport.scrape() : null'
    );
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

// ---- portable self-update -----------------------------------------------------
// electron-updater doesn't support the portable target, so the portable build
// updates itself: check the GitHub releases feed, download the new portable
// exe in the background, and swap it in on restart via a tiny detached
// PowerShell helper. A .bak of the previous version is kept beside the exe.
const UPDATE_REPO = 'whxjwksjs/muse-windows';

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates(manual) {
  if (!app.isPackaged) return; // dev mode: never self-update
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'muse-windows', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`release feed returned ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    if (!latest || cmpVersions(latest, app.getVersion()) <= 0) {
      if (manual) notify('No updates', 'You are on the latest version.');
      return;
    }
    if (pendingUpdate && pendingUpdate.version === latest) return; // already downloaded
    const asset = (rel.assets || []).find((a) => /^Muse-Portable-.*\.exe$/i.test(a.name || ''));
    if (!asset) {
      if (manual) notify('Update found', `v${latest} is out, but the release has no portable exe attached.`);
      return;
    }
    notify('Downloading update', `Muse v${latest} is downloading in the background.`);
    const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'muse-windows' } });
    if (!dl.ok) throw new Error(`download returned ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length < 1024 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('downloaded file is not a valid exe');
    const dest = path.join(app.getPath('temp'), asset.name);
    await fs.promises.writeFile(dest, buf);
    pendingUpdate = { version: latest, filePath: dest };
    updateDownloaded = true;
    buildTrayMenu();
    notify('Update ready', `Muse v${latest} downloaded. Restart from the tray menu to install it.`);
  } catch (e) {
    if (manual) notify('Update check failed', String((e && e.message) || e));
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
  if (!canWriteBesideExe()) {
    notify('Update failed', 'The app folder is not writable. Download the new version from the GitHub releases page instead.');
    return;
  }
  const scriptPath = path.join(app.getPath('temp'), 'muse-update.ps1');
  try {
    fs.writeFileSync(scriptPath, buildUpdateScript(process.execPath, pendingUpdate.filePath));
  } catch (e) {
    notify('Update failed', 'Could not write the updater script: ' + String((e && e.message) || e));
    return;
  }
  try {
    require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true, stdio: 'ignore',
    }).unref();
  } catch (e) {
    notify('Update failed', String((e && e.message) || e));
    return;
  }
  app.quitting = true;
  app.quit();
}

function setupAutoUpdate() {
  // First check shortly after launch, then every 6 hours. Manual check lives in the tray menu.
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

  const metaAccounts = state.profiles.map((p) => ({
    label: p.name,
    type: 'radio',
    checked: p.id === state.activeProfileId && state.site === 'meta',
    click: () => switchMetaAccountById(p.id),
  }));

  const template = [
    { label: 'Open Muse', click: showMainWindow },
    { label: `Quick chat  (${prettyHotkey(state.hotkeys.quick)})`, click: toggleQuickWindow },
    { label: `Switch to ${otherSite.name}  (${prettyHotkey(state.hotkeys.site)})`, click: toggleSite },
    {
      label: 'Meta AI Accounts',
      submenu: [
        ...metaAccounts,
        { type: 'separator' },
        { label: `Next Meta AI account  (${prettyHotkey(state.hotkeys.metaAccount)})`, click: switchMetaAccount },
        { label: 'Add Meta AI account…', click: addMetaAccount },
      ],
    },
    { type: 'separator' },
    {
      label: 'Automation / Auto-Allow',
      submenu: [
        {
          label: `Master Automation (${prettyHotkey(state.hotkeys.automation)})`,
          type: 'checkbox',
          checked: state.automation.enabled,
          click: () => toggleAutomationMaster(),
        },
        {
          label: 'Allow all actions',
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
          label: 'This website',
          submenu: [
            {
              label: `Always allow on ${currentHostname}`,
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
              ['connectors', 'App / connector actions', 'Approve connection and integration prompts'],
              ['file_access', 'File and data access', 'Approve file, upload, download, and data-access prompts'],
              ['external_links', 'External navigation', 'Approve prompts to open links or navigate outside the chat'],
              ['code_execution', 'Code execution', 'Approve prompts to run code, scripts, or terminal actions'],
              ['media_permissions', 'Microphone and media', 'Approve microphone, camera, audio, and media permission requests'],
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
          label: 'What can be auto-approved?',
          submenu: [
            { label: 'App / connector actions', type: 'checkbox', checked: !!state.automation.actions.connectors, click: (item) => setGlobalAutomationAction('connectors', item.checked) },
            { label: 'File and data access', type: 'checkbox', checked: !!state.automation.actions.file_access, click: (item) => setGlobalAutomationAction('file_access', item.checked) },
            { label: 'External navigation', type: 'checkbox', checked: !!state.automation.actions.external_links, click: (item) => setGlobalAutomationAction('external_links', item.checked) },
            { label: 'Code execution', type: 'checkbox', checked: !!state.automation.actions.code_execution, click: (item) => setGlobalAutomationAction('code_execution', item.checked) },
            { label: 'Microphone and media', type: 'checkbox', checked: !!state.automation.actions.media_permissions, click: (item) => setGlobalAutomationAction('media_permissions', item.checked) },
          ],
        },
        { type: 'separator' },
        {
          label: 'Show On-Screen Widget',
          type: 'checkbox',
          checked: state.automation.showOnScreenWidget,
          click: (item) => {
            state.automation.showOnScreenWidget = item.checked;
            saveState();
            buildTrayMenu();
            notifyWebContentsAutomationChange();
          },
        },
        { label: 'Settings & Keybinds…', click: openHotkeySettings },
      ],
    },
    { type: 'separator' },
    {
      label: `Profile: ${activeProfile().name}`,
      submenu: [
        ...profileItems,
        { type: 'separator' },
        { label: 'Add profile…', click: addProfile },
        { label: `Sign out of ${currentSite().name}…`, click: signOut },
      ],
    },
    { label: 'Save clipboard text as .txt', click: saveClipboardAsFile },
    { label: `Export this chat as file…  (${prettyHotkey(state.hotkeys.export)})`, click: exportChat },
    { type: 'separator' },
    { label: `Mute / unmute microphone  (${prettyHotkey(state.hotkeys.mic)})`, click: toggleMic },
    { label: `Mute / unmute app sound  (${prettyHotkey(state.hotkeys.speaker)})`, click: toggleSpeaker },
    { label: 'Customize hotkeys & settings…', click: () => openHotkeySettings() },
    { label: 'Network & Proxy settings…', click: () => openHotkeySettings('tab-proxy') },
    { type: 'separator' },
    {
      label: 'Run on startup',
      type: 'checkbox',
      checked: loginSettings.openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    ...(updateDownloaded
      ? [{ label: 'Restart and install update', click: installUpdateAndRestart }]
      : []),
    { type: 'separator' },
    {
      label: 'Quit Muse',
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    console.log('[Init] Applying initial proxy settings...');
    await applyProxySettings();
    createMainWindow();
    createTray();
    registerHotkeys();
    state.profiles.forEach((p) => { setupDownloadHandler(p.id); setupPermissions(p.id); });
    setupAutoUpdate();
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray; quit explicitly from the tray menu.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
