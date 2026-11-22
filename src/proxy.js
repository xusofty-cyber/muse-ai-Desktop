// src/proxy.js
// 各账号会话的代理设置 (system / direct / custom / mihomo / 跟随全局)、Mihomo 内核管理器的
// 创建与崩溃自动重启、按账号固定的出口端口分配, 以及订阅节点聚合后的热重载。
// 2026-11-22 main.js 拆分 第 4 步, 函数体原样迁移。
//
// state 通过 getState() 取: 导入备份会整体替换状态对象, 而 Mihomo 管理器上注册的回调
// (端口改派、严格模式判断) 会一直存活, 若捕获旧引用就会改到已被丢弃的对象上。
'use strict';

const path = require('path');
const { app, session } = require('electron');
const { MihomoManager, DEFAULT_CONTROLLER_PORT, DEFAULT_BASE_PROXY_PORT } = require('../mihomo-manager');
const {
  SAFE_ID_RE,
  defaultProxy,
  defaultMihomoConfig,
  getState,
  saveState,
  saveStateDebounced,
} = require('./state');

/**
 * @param {Object} deps
 * @param {(title: string, body: string, onClick?: Function) => void} deps.notify 系统通知
 * @param {(profileId: string) => string} deps.partitionFor 账号 id -> 会话分区名
 */
function createProxyController({ notify, partitionFor }) {
  // 用 getter 而不是局部常量, 让迁移过来的函数体里的 state.xxx 原样可用且永远指向当前状态
  const ctx = {};
  Object.defineProperty(ctx, 'state', { get: getState });
  return buildController(ctx, { notify, partitionFor });
}

function buildController(ctx, { notify, partitionFor }) {
  // 每次访问都取当前状态对象: 导入备份会整体替换 state, 不能捕获旧引用
  // ---- Mihomo 账号固定出口端口 (2026-11-22 审查 H3) ---------------------------
  // 此前端口按账号排列顺序 18001、18002… 分配, 飞书同步按重置时间重排后端口随之变化,
  // 而只有被修改的账号会重新应用代理, 其余账号会连到别人的出口。现在端口按账号 id 固定并持久化。
  function ensureProfilePort(profileId) {
    if (!profileId || !SAFE_ID_RE.test(profileId)) return null;
    if (!ctx.state.mihomo) ctx.state.mihomo = defaultMihomoConfig();
    if (!ctx.state.mihomo.portByProfile || typeof ctx.state.mihomo.portByProfile !== 'object') ctx.state.mihomo.portByProfile = {};
    const map = ctx.state.mihomo.portByProfile;
    const cur = map[profileId];
    if (Number.isInteger(cur) && cur > 0 && cur < 65536) return cur;
    const base = ctx.state.mihomo.basePort || DEFAULT_BASE_PROXY_PORT;
    const ctrl = ctx.state.mihomo.controllerPort || DEFAULT_CONTROLLER_PORT;
    const used = new Set(Object.values(map));
    let port = base;
    while (used.has(port) || port === ctrl) port++;
    map[profileId] = port;
    saveStateDebounced();
    return port;
  }

  function pruneProfilePorts() {
    if (!ctx.state.mihomo || !ctx.state.mihomo.portByProfile) return;
    const ids = new Set((ctx.state.profiles || []).map((p) => p && p.id));
    for (const id of Object.keys(ctx.state.mihomo.portByProfile)) {
      if (!ids.has(id)) delete ctx.state.mihomo.portByProfile[id];
    }
  }

  // ---- Mihomo 内核意外退出自动重启 (审查 M3) -------------------------------------
  let mihomoCrashTimes = [];
  let mihomoRestartTimer = null;
  function handleMihomoUnexpectedExit(info) {
    if (app.quitting || !ctx.state.mihomo || !ctx.state.mihomo.enabled) return;
    const isZh = ctx.state.locale !== 'en';
    const now = Date.now();
    mihomoCrashTimes = mihomoCrashTimes.filter((t) => now - t < 10 * 60 * 1000);
    mihomoCrashTimes.push(now);
    const n = mihomoCrashTimes.length;
    console.warn(`[Mihomo] Kernel exited unexpectedly (code=${info && info.code}, signal=${info && info.signal}), crash #${n} in 10 min`);
    if (n > 5) {
      notify(
        isZh ? 'Mihomo 内核反复崩溃' : 'Mihomo kernel keeps crashing',
        isZh ? '10 分钟内已崩溃 5 次，已停止自动重启。使用 Mihomo 的账号当前无法联网，请检查 mihomo.log 或节点配置。' : 'Crashed 5 times in 10 minutes; auto-restart stopped. Accounts using Mihomo are offline. Check mihomo.log or your nodes.'
      );
      return;
    }
    if (n === 1) {
      notify(
        isZh ? 'Mihomo 内核意外退出' : 'Mihomo kernel exited',
        isZh ? '正在自动重启，使用 Mihomo 的账号会短暂断网。' : 'Restarting automatically; accounts using Mihomo will be briefly offline.'
      );
    }
    const delay = Math.min(30000, 2000 * 2 ** (n - 1));
    clearTimeout(mihomoRestartTimer);
    mihomoRestartTimer = setTimeout(async () => {
      try {
        const mm = getMihomoManager();
        if (app.quitting || mm.isRunning || !ctx.state.mihomo || !ctx.state.mihomo.enabled) return;
        const res = await mm.start(ctx.state.profiles, ctx.state.mihomo.cachedProxies);
        if (res && res.ok) {
          await applyProxySettings();
          console.log('[Mihomo] Kernel restarted after crash');
        } else {
          notify(isZh ? 'Mihomo 内核重启失败' : 'Mihomo restart failed', (res && res.error) || 'mihomo.log');
        }
      } catch (err) {
        console.warn('[Mihomo] Auto-restart error:', err);
      }
    }, delay);
  }

  let mihomoManager = null;
  function getMihomoManager() {
    if (!mihomoManager) {
      const mihomoDataDir = path.join(app.getPath('userData'), 'mihomo');
      mihomoManager = new MihomoManager({
        dataDir: mihomoDataDir,
        binPath: ctx.state.mihomo && ctx.state.mihomo.customBinPath,
        basePort: (ctx.state.mihomo && ctx.state.mihomo.basePort) || DEFAULT_BASE_PROXY_PORT,
        controllerPort: (ctx.state.mihomo && ctx.state.mihomo.controllerPort) || DEFAULT_CONTROLLER_PORT,
        portResolver: (acct) => ensureProfilePort(acct && acct.id),
        onPortReassigned: (id, newPort, oldPort) => {
          if (!ctx.state.mihomo.portByProfile) ctx.state.mihomo.portByProfile = {};
          ctx.state.mihomo.portByProfile[id] = newPort;
          saveStateDebounced();
          const prof = (ctx.state.profiles || []).find((p) => p.id === id);
          const name = prof ? prof.name : id;
          const isZh = ctx.state.locale !== 'en';
          notify(
            isZh ? '代理端口已自动调整' : 'Proxy port reassigned',
            isZh ? `账号「${name}」的出口端口 ${oldPort} 被其他程序占用，已改用 ${newPort}` : `Port ${oldPort} for "${name}" was in use; switched to ${newPort}`
          );
        },
        isStrict: () => !!(ctx.state.mihomo && ctx.state.mihomo.strictIsolation),
        onUnexpectedExit: (info) => handleMihomoUnexpectedExit(info),
      });
      // 升级迁移: 首次按当前账号顺序固定端口, 结果与旧版顺序分配一致, 升级后各账号出口不变
      for (const p of ctx.state.profiles || []) ensureProfilePort(p && p.id);
    }
    return mihomoManager;
  }

  // ---- network & proxy settings ---------------------------------------------
  async function applyProxyToSession(targetSession, profileId = null) {
    if (!targetSession) return;

    const prof = profileId ? ctx.state.profiles.find((p) => p.id === profileId) : null;
    const acctMode = (prof && prof.proxyMode && prof.proxyMode !== 'inherit') ? prof.proxyMode : null;

    // 1. 若账号单独指定了代理模式（system / direct / custom）
    if (acctMode === 'system') {
      try {
        await targetSession.setProxy({ mode: 'system' });
        console.log(`[Proxy] Applied individual system/TUN mode to session for profile: ${profileId}`);
        return;
      } catch (err) {
        console.error(`[Proxy] Failed to apply system mode to profile ${profileId}:`, err);
      }
    } else if (acctMode === 'direct') {
      try {
        await targetSession.setProxy({ mode: 'direct' });
        console.log(`[Proxy] Applied individual direct mode to session for profile: ${profileId}`);
        return;
      } catch (err) {
        console.error(`[Proxy] Failed to apply direct mode to profile ${profileId}:`, err);
      }
    } else if (acctMode === 'custom') {
      const c = (prof && prof.proxyCustom) || { type: 'http', host: '127.0.0.1', port: 7897 };
      const type = (c.type || 'http').toLowerCase();
      const host = (c.host || '127.0.0.1').trim();
      const port = parseInt(c.port, 10) || 7897;
      const proxyRules = `${type}://${host}:${port}`;
      const proxyBypassRules = '<local>;localhost;127.0.0.1';
      try {
        await targetSession.setProxy({ proxyRules, proxyBypassRules });
        console.log(`[Proxy] Applied individual custom proxy (${proxyRules}) to session for profile: ${profileId}`);
        return;
      } catch (err) {
        console.error(`[Proxy] Failed to apply custom proxy to profile ${profileId}:`, err);
      }
    }

    // 2. 账号选了 mihomo 或跟随全局 (inherit):
    // 若开启了内置 Mihomo 智能分流（或账号显式选了 mihomo）
    if (acctMode === 'mihomo' || (ctx.state.mihomo && ctx.state.mihomo.enabled)) {
      const mm = getMihomoManager();
      // 优先从 portMap 中找该 profileId 对应的独立端口，没有则按账号索引确定推算
      // 端口只看按账号 id 固定的分配表 (审查 H3), 不再按账号排列顺序推算
      void mm;
      const basePort = (ctx.state.mihomo && ctx.state.mihomo.basePort) || DEFAULT_BASE_PROXY_PORT;
      const firstId = ctx.state.profiles && ctx.state.profiles[0] && ctx.state.profiles[0].id;
      const dedicatedPort = ensureProfilePort(profileId || firstId) || basePort;
      try {
        const proxyRules = `http=127.0.0.1:${dedicatedPort};https=127.0.0.1:${dedicatedPort}`;
        const proxyBypassRules = '<local>;localhost;127.0.0.1';
        await targetSession.setProxy({ proxyRules, proxyBypassRules });
        console.log(`[Proxy] Applied Mihomo dedicated port ${dedicatedPort} to session for profile: ${profileId || 'default'}`);
        return;
      } catch (err) {
        console.error(`[Proxy] Failed to apply Mihomo port ${dedicatedPort} to profile ${profileId}:`, err);
      }
      return;
    }

    // 3. 传统全局通用代理策略 (Custom / Direct / System 自适应)
    const p = ctx.state.proxy || defaultProxy();
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
    for (const p of ctx.state.profiles) {
      const s = session.fromPartition(partitionFor(p.id));
      await applyProxyToSession(s, p.id);
    }
  }

  // 内置 Mihomo 智能代理分流：重新聚合所有启用源并热重载内核
  async function refreshMihomoMergedProxiesAndReload(shouldReloadKernel = true) {
    const mm = getMihomoManager();
    const merged = mm.mergeSourceProxies(ctx.state.mihomo.sources);
    ctx.state.mihomo.cachedProxies = merged;
    ctx.state.mihomo.lastUpdated = new Date().toISOString();
    saveState();

    if (ctx.state.mihomo.enabled && shouldReloadKernel) {
      if (mm.isRunning) {
        await mm.reload(ctx.state.profiles, merged);
      } else {
        await mm.start(ctx.state.profiles, merged);
      }
      await applyProxySettings();
    }
    return merged;
  }

  /** 已创建的 Mihomo 管理器; 未创建时返回 null (退出时用, 不会为了停止而新建一个) */
  function peekMihomoManager() {
    return mihomoManager;
  }

  return {
    ensureProfilePort,
    pruneProfilePorts,
    getMihomoManager,
    peekMihomoManager,
    applyProxyToSession,
    applyProxySettings,
    refreshMihomoMergedProxiesAndReload,
  };
}

module.exports = { createProxyController };
