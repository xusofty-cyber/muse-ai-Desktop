// src/state.js
// 应用状态的默认值、合法性清洗 (sanitizeAndMergeState)、从磁盘加载 (含 .bak / .bak2 代际恢复)
// 与原子写入。由 main.js 引用 (2026-11-22 main.js 拆分 第 2 步, 函数体原样迁移)。
//
// 状态对象只有一份: initState() 加载后返回它, main.js 保存同一个引用并直接读写字段。
// 需要整体替换 (如导入备份) 时必须调用 replaceState(next), 否则 saveState 会继续写旧对象。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { defaultFeishuConfig, formatDateTime } = require('../feishu-sync');
const { DEFAULT_CONTROLLER_PORT, DEFAULT_BASE_PROXY_PORT } = require('../mihomo-manager');
const { defaultExitMonitor, sanitizeExitMonitor } = require('./exit-monitor');

// 账号 id / 订阅源 id 会拼进会话分区名与磁盘路径 (Partitions/muse-<id>、sources/<id>.yaml),
// 只允许安全字符, 防止带 ..\ 的 id 越界读写或删除 (2026-11-22 审查 H2)
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

// ---- persisted state ----------------------------------------------------
const AVATAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#6366f1', '#14b8a6', '#f97316', '#d946ef',
  '#0284c7', '#16a34a', '#ea580c', '#9333ea',
];

// ---- 窗口几何安全 (Ubuntu 多账号窗口唤不回根治) --------------------------------
// 背景: 全部账号共用一份 state.window 且从不校验, 多窗口 resize/move 竞写、
// 最小化/隐藏瞬间或虚拟机分辨率变化都可能把屏幕外坐标/异常尺寸持久化,
// 之后 showMainWindow 只做 show/focus, 窗口逻辑上已显示、物理上永不可见。
// 因此: 加载时钳制 -> 落盘时过滤 -> 显示前按当前屏幕二次校验并居中兜底。
const MIN_WIN_WIDTH = 800;
const MIN_WIN_HEIGHT = 560;

function sanitizeWindowBounds(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const w = Number(raw.width);
  const h = Number(raw.height);
  if (Number.isFinite(w)) out.width = Math.min(Math.max(Math.round(w), MIN_WIN_WIDTH), 7680);
  if (Number.isFinite(h)) out.height = Math.min(Math.max(Math.round(h), MIN_WIN_HEIGHT), 4320);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (Number.isFinite(x) && Math.abs(x) < 20000) out.x = Math.round(x);
  if (Number.isFinite(y) && Math.abs(y) < 20000) out.y = Math.round(y);
  return out;
}

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

function defaultMihomoConfig() {
  return {
    enabled: false,
    subscriptionUrl: '',
    sources: [], // Array<{ id, type: 'url'|'file', name, target, enabled, nodeCount, updatedAt, cachedProxies, subscriptionUserinfo }>
    autoUpdateInterval: 24,
    lastUpdated: '',
    basePort: DEFAULT_BASE_PROXY_PORT,
    controllerPort: DEFAULT_CONTROLLER_PORT,
    customBinPath: '',
    cachedProxies: [],
    portByProfile: {}, // 账号 id -> 固定出口端口 (审查 H3)
    strictIsolation: false, // 严格隔离: 专属节点全挂时断网, 不回落到公共节点 (审查 M2)
  };
}

function defaultState() {
  return {
    window: {},
    windowByProfile: {},
    site: 'muse',
    profiles: [{
      id: 'default',
      name: '账号 1',
      color: AVATAR_COLORS[0],
      group: '默认群组',
      purpose: '',
      usagePercent: 0,
      usageText: '',
      tokenResetAt: '',
      status: 'normal',
      proxyQueue: [],
      proxyStrategy: 'fallback',
      proxyMode: 'inherit',
      proxyCustom: { type: 'http', host: '127.0.0.1', port: 7897 },
    }],
    activeProfileId: 'default',
    accountGroups: ['默认群组'],
    feishu: defaultFeishuConfig(),
    hotkeys: { ...DEFAULT_HOTKEYS },
    automation: defaultAutomation(),
    proxy: defaultProxy(),
    mihomo: defaultMihomoConfig(),
    theme: 'dark', // 'dark' | 'light' | 'system'
    locale: detectDefaultLocale(), // 'zh-CN' | 'en'
    ui: {
      autoHideButtons: true, // 自动隐藏右上角与右下角按钮
      dockPinned: true, // 账号栏是否固定常态展开 (默认 true: 常驻展示，方便多账号切换)
      webrtcProtection: true, // 阻止 WebRTC 绕过代理泄露真实 IP (2026-11-22)
    },
    lock: defaultLock(),
    exitMonitor: defaultExitMonitor(), // 定期出口检测 (2026-11-22)
  };
}
const statePath = () => path.join(app.getPath('userData'), 'app-state.json');
const stateBackupPath = () => path.join(app.getPath('userData'), 'app-state.json.bak');
const stateBackup2Path = () => path.join(app.getPath('userData'), 'app-state.json.bak2');

let isStateSafelyLoaded = false;
// 当前生效的状态对象。main.js 里的 state 变量与它是同一个对象 (引用相同),
// 因此 state.xxx 的读写两边都能看到; 只有整体替换时必须经过 replaceState。
let current = null;

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
  merged.exitMonitor = sanitizeExitMonitor(raw.exitMonitor, SAFE_ID_RE);
  // 兼容历史老数据：若未显式指定 custom/direct，统一重置为 system 自适应模式
  if (merged.proxy.mode !== 'custom' && merged.proxy.mode !== 'direct') {
    merged.proxy.mode = 'system';
    merged.proxy.enabled = false;
  }
  // 群组与飞书多维表格同步配置合并
  merged.accountGroups = Array.isArray(raw.accountGroups) && raw.accountGroups.length > 0
    ? [...new Set(raw.accountGroups.filter((g) => typeof g === 'string' && g.trim()))]
    : ['默认群组'];
  if (!merged.accountGroups.includes('默认群组')) {
    merged.accountGroups.unshift('默认群组');
  }

  merged.feishu = {
    ...defaultFeishuConfig(),
    ...(raw.feishu || {}),
    fieldMap: {
      ...defaultFeishuConfig().fieldMap,
      ...((raw.feishu && raw.feishu.fieldMap) || {}),
    },
  };

  const rawMihomo = (raw && raw.mihomo) || {};
  let rawSources = Array.isArray(rawMihomo.sources) ? rawMihomo.sources : [];
  // 兼容旧版单一 subscriptionUrl 自动平滑迁移至多源架构
  if (rawSources.length === 0 && typeof rawMihomo.subscriptionUrl === 'string' && rawMihomo.subscriptionUrl.trim()) {
    rawSources = [{
      id: 'src_default',
      type: 'url',
      name: '默认订阅',
      target: rawMihomo.subscriptionUrl.trim(),
      enabled: true,
      nodeCount: Array.isArray(rawMihomo.cachedProxies) ? rawMihomo.cachedProxies.length : 0,
      updatedAt: rawMihomo.lastUpdated || '',
      cachedProxies: Array.isArray(rawMihomo.cachedProxies) ? rawMihomo.cachedProxies : [],
      subscriptionUserinfo: '',
    }];
  }

  merged.mihomo = {
    ...defaultMihomoConfig(),
    ...rawMihomo,
    sources: rawSources.map((s) => ({
      id: (s && typeof s.id === 'string' && SAFE_ID_RE.test(s.id)) ? s.id : ('src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
      type: s && s.type === 'file' ? 'file' : 'url',
      name: (s && typeof s.name === 'string' && s.name.trim())
        ? s.name.trim()
        : (s && s.type === 'file' ? '本地 YAML 节点' : '机场订阅'),
      target: (s && typeof s.target === 'string') ? s.target.trim() : '',
      enabled: typeof (s && s.enabled) === 'boolean' ? s.enabled : true,
      nodeCount: typeof (s && s.nodeCount) === 'number' ? s.nodeCount : (Array.isArray(s && s.cachedProxies) ? s.cachedProxies.length : 0),
      updatedAt: (s && typeof s.updatedAt === 'string') ? s.updatedAt : '',
      cachedProxies: Array.isArray(s && s.cachedProxies) ? s.cachedProxies : [],
      subscriptionUserinfo: (s && s.subscriptionUserinfo) || '',
    })),
    cachedProxies: Array.isArray(rawMihomo.cachedProxies) ? rawMihomo.cachedProxies : [],
    portByProfile: sanitizePortMap(rawMihomo.portByProfile),
    strictIsolation: rawMihomo.strictIsolation === true,
  };

  // profiles 合法性校验 (v1.5.16, 评审 P2): 此前只补颜色, 不查 id。空/重复/
  // 非字符串 id 会让多个账号映射到同一 persist:muse-undefined 分区且不可拆分。
  // 现在过滤非法与重复 id (保留首个), 全部非法时回退默认账号。
  if (Array.isArray(merged.profiles) && merged.profiles.length > 0) {
    const seenIds = new Set();
    merged.profiles = merged.profiles
      .filter((prof) => {
        if (!prof || typeof prof.id !== 'string' || !prof.id.trim() || seenIds.has(prof.id)) return false;
        if (!SAFE_ID_RE.test(prof.id)) {
          console.warn('[State] Dropped profile with unsafe id:', JSON.stringify(prof.id).slice(0, 80));
          return false;
        }
        seenIds.add(prof.id);
        return true;
      })
      .map((prof, idx) => ({
        ...prof,
        color: prof.color || AVATAR_COLORS[idx % AVATAR_COLORS.length],
        group: typeof prof.group === 'string' && prof.group.trim() ? prof.group.trim() : '默认群组',
        purpose: typeof prof.purpose === 'string' ? prof.purpose : '',
        usagePercent: typeof prof.usagePercent === 'number' ? Math.max(0, Math.min(100, Math.round(prof.usagePercent))) : 0,
        usageText: typeof prof.usageText === 'string' ? prof.usageText : '',
        tokenResetAt: prof.tokenResetAt ? formatDateTime(prof.tokenResetAt) : '',
        status: ['normal', 'warning', 'exhausted', 'idle'].includes(prof.status) ? prof.status : 'normal',
        proxyQueue: Array.isArray(prof.proxyQueue) ? prof.proxyQueue.filter((n) => typeof n === 'string' && n.trim()) : [],
        proxyStrategy: ['fallback', 'url-test', 'load-balance', 'select'].includes(prof.proxyStrategy) ? prof.proxyStrategy : 'fallback',
        proxyMode: ['inherit', 'system', 'mihomo', 'direct', 'custom'].includes(prof.proxyMode) ? prof.proxyMode : 'inherit',
        proxyCustom: (prof.proxyCustom && typeof prof.proxyCustom === 'object') ? {
          type: ['http', 'socks5'].includes(prof.proxyCustom.type) ? prof.proxyCustom.type : 'http',
          host: typeof prof.proxyCustom.host === 'string' && prof.proxyCustom.host.trim() ? prof.proxyCustom.host.trim() : '127.0.0.1',
          port: parseInt(prof.proxyCustom.port, 10) || 7897,
        } : { type: 'http', host: '127.0.0.1', port: 7897 },
      }));
  }
  if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) {
    merged.profiles = [{
      id: 'default',
      name: '账号 1',
      color: AVATAR_COLORS[0],
      group: '默认群组',
      purpose: '',
      usagePercent: 0,
      usageText: '',
      tokenResetAt: '',
      status: 'normal',
      proxyQueue: [],
      proxyStrategy: 'fallback',
      proxyMode: 'inherit',
      proxyCustom: { type: 'http', host: '127.0.0.1', port: 7897 },
    }];
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

// 核心加固：原子写入与双备份，杜绝 0 字节截断损坏导致账号凭据与列表丢失
function saveState() {
  try {
    const filePath = statePath();
    const backupPath = stateBackupPath();
    const tmpPath = filePath + '.tmp';
    if (!current) return; // 尚未初始化时不写盘, 防止用空状态覆盖磁盘文件
    const content = JSON.stringify(current, null, 2);

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

// 端口分配表清洗: 只保留合法账号 id -> 合法端口 (审查 H3)
function sanitizePortMap(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [id, port] of Object.entries(raw)) {
      if (SAFE_ID_RE.test(id) && Number.isInteger(port) && port > 0 && port < 65536) out[id] = port;
    }
  }
  return out;
}

/** 启动时调用一次: 从磁盘加载 (失败则从备份恢复, 都没有则用默认值) 并设为当前状态 */
function initState() {
  current = loadState();
  return current;
}

/** 当前状态对象 */
function getState() {
  return current;
}

/** 整体替换当前状态 (导入备份等), 返回新对象; 调用方须把自己持有的引用也换成返回值 */
function replaceState(next) {
  if (!next || typeof next !== 'object') throw new Error('replaceState: invalid state');
  current = next;
  return current;
}

/** 本次启动的状态是否从磁盘文件安全读出 (决定是否允许首写覆盖) */
function wasStateSafelyLoaded() {
  return isStateSafelyLoaded;
}

module.exports = {
  SAFE_ID_RE,
  DEFAULT_HOTKEYS,
  AVATAR_COLORS,
  MIN_WIN_WIDTH,
  MIN_WIN_HEIGHT,
  sanitizeWindowBounds,
  sanitizePortMap,
  defaultProxy,
  defaultAutomation,
  detectDefaultLocale,
  defaultLock,
  defaultMihomoConfig,
  defaultState,
  sanitizeAndMergeState,
  statePath,
  stateBackupPath,
  stateBackup2Path,
  loadState,
  initState,
  getState,
  replaceState,
  saveState,
  saveStateDebounced,
  wasStateSafelyLoaded,
};
