// src/backup.js
// 配置备份: 备份密码输入窗口、导出 (设置备份 / 加密完整备份)、导入时的文件读取与解密,
// 以及导入字段白名单 (pickImported*)。2026-11-22 main.js 拆分 第 5 步, 函数体原样迁移。
//
// importConfigFromFile 的"应用到当前状态"部分仍在 main.js: 它要整体替换 state 并重新
// 指定 mainWindow, 这两个变量属于 main.js (见 PROJECT_CONTEXT 主窗口拆分说明)。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { isEncryptedBackup, encryptBackup, decryptBackup } = require('../backup-crypto');
const { defaultFeishuConfig } = require('../feishu-sync');
const { SAFE_ID_RE, defaultProxy, defaultMihomoConfig, getState } = require('./state');

// 飞书 App Secret 发给页面时的占位符; 保存时收到占位符表示"未修改" (审查 M5)
const FEISHU_SECRET_MASK = '••••••••';

// ---- 导入字段白名单 (审查 H2) --------------------------------------------------
// 备份文件可能来自他人或被篡改: 程序路径 (customBinPath / customCliPath)、端口与端口表
// 一律不导入; 其余字段逐个校验类型与范围后才写入。
function pickImportedProxy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (['system', 'custom', 'direct'].includes(raw.mode)) out.mode = raw.mode;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (['http', 'socks5'].includes(raw.type)) out.type = raw.type;
  if (typeof raw.host === 'string' && /^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(raw.host.trim())) out.host = raw.host.trim();
  const port = parseInt(raw.port, 10);
  if (port >= 1 && port <= 65535) out.port = port;
  if (typeof raw.bypass === 'string' && raw.bypass.length <= 2000) out.bypass = raw.bypass;
  return out;
}

function pickImportedFeishu(raw, local) {
  const base = { ...defaultFeishuConfig(), ...(local || {}) };
  if (!raw || typeof raw !== 'object') return base;
  const str = (v, max = 512) => (typeof v === 'string' && v.length <= max ? v.trim() : undefined);
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
  if (['auto', 'embedded', 'api', 'cli'].includes(raw.syncMode)) base.syncMode = raw.syncMode;
  for (const k of ['appId', 'appToken', 'tableId']) {
    const v = str(raw[k]);
    if (v !== undefined) base[k] = v;
  }
  const secret = str(raw.appSecret);
  if (secret && secret !== FEISHU_SECRET_MASK) base.appSecret = secret;
  for (const k of ['autoSync', 'sortByResetTime']) {
    if (typeof raw[k] === 'boolean') base[k] = raw[k];
  }
  const iv = parseInt(raw.syncIntervalMinutes, 10);
  if (iv >= 1 && iv <= 1440) base.syncIntervalMinutes = iv;
  if (raw.fieldMap && typeof raw.fieldMap === 'object') {
    const fm = { ...defaultFeishuConfig().fieldMap, ...(base.fieldMap || {}) };
    for (const k of Object.keys(defaultFeishuConfig().fieldMap)) {
      const v = str(raw.fieldMap[k], 128);
      if (v) fm[k] = v;
    }
    base.fieldMap = fm;
  }
  base.customCliPath = (local && local.customCliPath) || '';
  return base;
}

function pickImportedSources(rawList, localSources) {
  if (!Array.isArray(rawList)) return null;
  const localById = new Map((localSources || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const out = [];
  const seen = new Set();
  const newId = () => `src_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  for (const src of rawList) {
    if (!src || typeof src !== 'object') continue;
    let id = (typeof src.id === 'string' && SAFE_ID_RE.test(src.id)) ? src.id : newId();
    while (seen.has(id)) id = newId();
    const type = src.type === 'file' ? 'file' : 'url';
    let target = typeof src.target === 'string' ? src.target.trim() : '';
    let cachedProxies = Array.isArray(src.cachedProxies)
      ? src.cachedProxies.filter((p) => p && typeof p === 'object' && typeof p.name === 'string' && typeof p.type === 'string')
      : [];
    if (type === 'url' && !target) {
      // 设置备份里订阅地址已脱敏: 本机有同 id 的源就沿用本机地址与节点, 否则跳过
      const local = localById.get(src.id);
      if (!local || !local.target) continue;
      target = local.target;
      cachedProxies = Array.isArray(local.cachedProxies) ? local.cachedProxies : [];
    }
    if (!target || (type === 'url' && !/^https?:\/\//i.test(target))) continue;
    seen.add(id);
    out.push({
      id,
      type,
      name: typeof src.name === 'string' ? src.name.trim().slice(0, 100) : '',
      target,
      enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
      nodeCount: cachedProxies.length,
      updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : '',
      cachedProxies,
      subscriptionUserinfo: typeof src.subscriptionUserinfo === 'string' ? src.subscriptionUserinfo : '',
    });
  }
  return out;
}

const COOKIE_DOMAIN_RE = /^\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
const COOKIE_SAMESITE = ['unspecified', 'no_restriction', 'lax', 'strict'];

/**
 * @param {Object} deps
 * @param {() => BrowserWindow|null} deps.getMainWindow 当前前台账号窗口 (对话框父窗口兜底)
 * @param {(profileId: string) => string} deps.partitionFor
 * @param {() => Promise<void>} deps.flushAllSessions 导出前把会话 Cookie 落盘
 * @param {string} deps.iconPath
 */
function createBackupService({ getMainWindow, partitionFor, flushAllSessions, iconPath }) {
  // state / mainWindow 每次访问时取最新值: 两者在 main.js 里都会被整体替换
  const ctx = {};
  Object.defineProperty(ctx, 'state', { get: getState });
  Object.defineProperty(ctx, 'mainWindow', { get: getMainWindow });
  const APP_ICON_PATH = iconPath;

  // ---- 备份密码输入窗口 (审查 H1) ----------------------------------------------
  const pendingPrompts = new Map(); // webContents.id -> { options, finish }

  function promptPassword(parentWin, options = {}) {
    return new Promise((resolve) => {
      const parent = parentWin && !parentWin.isDestroyed() ? parentWin : undefined;
      const win = new BrowserWindow({
        parent,
        modal: !!parent,
        width: 440,
        height: options.confirm ? 310 : 260,
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#1b1e25',
        title: options.title || 'Muse',
        icon: APP_ICON_PATH,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload-prompt.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const id = win.webContents.id;
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        pendingPrompts.delete(id);
        resolve(typeof val === 'string' && val.length > 0 ? val : null);
        if (!win.isDestroyed()) win.destroy();
      };
      pendingPrompts.set(id, { options, finish });
      win.on('closed', () => finish(null));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (ev) => ev.preventDefault());
      win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
      win.loadFile(path.join(__dirname, '..', 'password-prompt.html')).catch(() => finish(null));
    });
  }

  ipcMain.handle('prompt:get-options', (e) => {
    const p = pendingPrompts.get(e.sender.id);
    if (!p) return null;
    const { title, message, confirm, minLength } = p.options || {};
    return { title, message, confirm: !!confirm, minLength: minLength || 0, locale: ctx.state.locale };
  });

  ipcMain.on('prompt:submit', (e, value) => {
    const p = pendingPrompts.get(e.sender.id);
    if (p) p.finish(value);
  });

  // 审查 H1: 默认导出"设置备份", 不含任何凭据 (登录会话、飞书 App Secret、订阅地址、节点密码);
  // 只有显式勾选完整备份才包含这些内容, 且必须设置密码, 以 scrypt + AES-256-GCM 加密后落盘。
  async function handleConfigExport(parentWin, opts = {}) {
    const targetWin = (parentWin && !parentWin.isDestroyed()) ? parentWin : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null);
    const isZh = ctx.state.locale !== 'en';
    const fullBackup = !!(opts && (opts.includeSessions === true || opts.full === true));

    let password = null;
    if (fullBackup) {
      password = await promptPassword(targetWin, {
        title: isZh ? '设置备份密码' : 'Set backup password',
        message: isZh
          ? '完整备份包含所有账号的登录会话、飞书 App Secret 与订阅地址，将用此密码加密。密码遗失后备份无法恢复。'
          : "A full backup contains every account's login session, the Feishu App Secret and subscription URLs. It is encrypted with this password, which cannot be recovered if lost.",
        confirm: true,
        minLength: 8,
      });
      if (!password) return { canceled: true };
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const saveOpts = {
      title: fullBackup ? '导出完整加密备份 (含登录会话)' : '导出账号与代理设置 (不含登录信息与密钥)',
      defaultPath: fullBackup ? `muse-backup-full-${dateStr}.json` : `muse-backup-${dateStr}.json`,
      filters: [
        { name: 'JSON 配置文件 (*.json)', extensions: ['json'] },
        { name: '所有文件 (*.*)', extensions: ['*'] },
      ],
    };
    const res = targetWin
      ? await dialog.showSaveDialog(targetWin, saveOpts)
      : await dialog.showSaveDialog(saveOpts);

    if (res.canceled || !res.filePath) {
      return { canceled: true };
    }

    const profileSessions = {};
    if (fullBackup && Array.isArray(ctx.state.profiles)) {
      // 导出前强制将会话持久化落盘
      try {
        await flushAllSessions();
      } catch (_) {}

      for (const p of ctx.state.profiles) {
        if (!p || !p.id) continue;
        try {
          const ses = session.fromPartition(partitionFor(p.id));
          if (ses && ses.cookies) {
            const cookies = await ses.cookies.get({});
            profileSessions[p.id] = (cookies || []).map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              secure: !!c.secure,
              httpOnly: !!c.httpOnly,
              expirationDate: c.expirationDate,
              sameSite: c.sameSite,
            }));
          }
        } catch (err) {
          console.warn(`[ConfigExport] Failed to export cookies for profile ${p.id}:`, err);
        }
      }
    }
    const sessionProfileCount = Object.keys(profileSessions).length;

    const mihomoCfg = ctx.state.mihomo || defaultMihomoConfig();
    const sources = Array.isArray(mihomoCfg.sources) ? mihomoCfg.sources : [];
    // 设置备份: 订阅地址 (含 token) 与节点缓存 (含节点密码/UUID) 一律不导出; 本地 YAML 只保留路径
    const exportedSources = fullBackup ? sources : sources.map((src) => ({
      id: src.id,
      type: src.type,
      name: src.name,
      enabled: src.enabled,
      target: src.type === 'file' ? src.target : '',
      targetRedacted: src.type !== 'file',
      nodeCount: 0,
      updatedAt: '',
      cachedProxies: [],
      subscriptionUserinfo: '',
    }));
    const feishuCfg = { ...(ctx.state.feishu || defaultFeishuConfig()) };
    delete feishuCfg.customCliPath; // 本机程序路径不随备份迁移
    if (!fullBackup) feishuCfg.appSecret = '';

    const backupData = {
      _meta: {
        app: 'Muse',
        version: app.getVersion(),
        exportedAt: now.toISOString(),
        kind: fullBackup ? 'full' : 'settings',
        profileCount: (ctx.state.profiles || []).length,
        includesAuthSessions: fullBackup,
        sessionProfileCount,
      },
      profiles: ctx.state.profiles || [],
      activeProfileId: ctx.state.activeProfileId,
      sessions: profileSessions,
      accountGroups: ctx.state.accountGroups || ['默认群组'],
      mihomoSources: exportedSources,
      mihomo: {
        enabled: !!mihomoCfg.enabled,
        autoUpdateInterval: mihomoCfg.autoUpdateInterval,
        strictIsolation: !!mihomoCfg.strictIsolation,
        ...(fullBackup ? { cachedProxies: mihomoCfg.cachedProxies || [] } : {}),
      },
      proxy: ctx.state.proxy || defaultProxy(),
      feishu: feishuCfg,
      theme: ctx.state.theme || 'dark',
      locale: ctx.state.locale || 'zh-CN',
      ui: ctx.state.ui || {},
    };

    const output = fullBackup
      ? { ...encryptBackup(backupData, password), app: 'Muse', exportedAt: now.toISOString() }
      : backupData;
    fs.writeFileSync(res.filePath, JSON.stringify(output, null, 2), { encoding: 'utf8', mode: 0o600 });
    return {
      ok: true,
      canceled: false,
      filePath: res.filePath,
      encrypted: fullBackup,
      profileCount: (ctx.state.profiles || []).length,
      sessionCount: sessionProfileCount,
      sourceCount: exportedSources.length,
    };
  }

  // 读取备份文件: 大小与格式校验, 加密备份弹窗输入密码 (最多 3 次) 后解密。
  // 成功返回 { parsed, wasEncrypted }; 失败或取消返回 { result } (调用方把 result 原样返回给页面)。
  async function readBackupFile(filePath, parentWin = null) {
    const done = (result) => ({ result });
    try {
      if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
        return done({ ok: false, error: '指定备份文件不存在' });
      }
      if (fs.statSync(filePath).size > 200 * 1024 * 1024) {
        return done({ ok: false, error: '备份文件超过 200MB，已拒绝导入' });
      }

      let parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        return done({ ok: false, error: '无效的 JSON 配置文件' });
      }

      // 加密的完整备份: 最多输错 3 次密码
      const isZh = ctx.state.locale !== 'en';
      let wasEncrypted = false;
      if (isEncryptedBackup(parsed)) {
        wasEncrypted = true;
        let decrypted = null;
        for (let attempt = 1; attempt <= 3 && !decrypted; attempt++) {
          const pwd = await promptPassword(parentWin, {
            title: isZh ? '输入备份密码' : 'Enter backup password',
            message: attempt === 1
              ? (isZh ? '该备份已加密，请输入导出时设置的密码。' : 'This backup is encrypted. Enter the password set when it was exported.')
              : (isZh ? `密码错误，请重试（还剩 ${4 - attempt} 次）。` : `Wrong password, try again (${4 - attempt} left).`),
            confirm: false,
          });
          if (!pwd) return done({ canceled: true });
          try {
            decrypted = decryptBackup(parsed, pwd);
          } catch (err) {
            if (err && err.code === 'WRONG_PASSWORD') continue;
            return done({ ok: false, error: '备份解密失败: ' + (err && err.message) });
          }
        }
        if (!decrypted) return done({ ok: false, error: '密码错误次数过多，已取消导入' });
        parsed = decrypted;
        if (!parsed || typeof parsed !== 'object') return done({ ok: false, error: '备份内容无效' });
      }
      return { parsed, wasEncrypted };
    } catch (err) {
      console.error('[Config] Reading backup failed:', err);
      return done({ ok: false, error: '导入失败: ' + (err.message || String(err)) });
    }
  }

  return { promptPassword, handleConfigExport, readBackupFile };
}

module.exports = {
  FEISHU_SECRET_MASK,
  COOKIE_DOMAIN_RE,
  COOKIE_SAMESITE,
  pickImportedProxy,
  pickImportedFeishu,
  pickImportedSources,
  createBackupService,
};
