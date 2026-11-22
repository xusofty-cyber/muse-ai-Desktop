// src/exit-monitor.js
// 定期自动检测各账号出口 IP, 出现以下情况时发系统通知 (2026-11-22 新增):
//   - 多个账号共用同一出口 IP
//   - 某个账号的出口 IP 和上次不同 (主节点故障切换, 或节点被机场换了 IP)
//   - 走 Mihomo 的账号检测失败 (节点全挂、严格隔离下已断网)
//   - 所有账号都检测失败 (通常是本机断网), 只报一条
// 同一个问题只通知一次, 解决后再出现才会再次通知。
// 只检测账号出口 (每个账号一次请求), 不做全部节点测试, 后台运行开销很小。
'use strict';

const { isValidIp } = require('./exit-isolation');

const MONITOR_INTERVALS = [15, 30, 60, 180, 360, 720]; // 分钟
const DEFAULT_INTERVAL = 60;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // 启动后等 Mihomo 与各账号代理就绪
const ENABLE_RUN_DELAY_MS = 10 * 1000; // 刚打开开关时尽快跑一次

function defaultExitMonitor() {
  return { enabled: false, intervalMinutes: DEFAULT_INTERVAL, lastRunAt: 0, lastSummary: null, exits: {}, activeIssues: [] };
}

/** 清洗持久化的监控配置; safeIdRe 由 state.js 传入 (避免循环引用) */
function sanitizeExitMonitor(raw, safeIdRe) {
  const d = defaultExitMonitor();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  out.enabled = raw.enabled === true;
  out.intervalMinutes = MONITOR_INTERVALS.includes(raw.intervalMinutes) ? raw.intervalMinutes : DEFAULT_INTERVAL;
  out.lastRunAt = Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0 ? raw.lastRunAt : 0;
  if (raw.lastSummary && typeof raw.lastSummary === 'object') {
    const n = (v) => (Number.isInteger(v) && v >= 0 && v < 100000 ? v : 0);
    out.lastSummary = {
      accounts: n(raw.lastSummary.accounts),
      reachable: n(raw.lastSummary.reachable),
      distinctIps: n(raw.lastSummary.distinctIps),
      issues: n(raw.lastSummary.issues),
    };
  }
  if (raw.exits && typeof raw.exits === 'object') {
    for (const [id, ip] of Object.entries(raw.exits)) {
      if ((!safeIdRe || safeIdRe.test(id)) && isValidIp(ip)) out.exits[id] = ip.toLowerCase();
    }
  }
  if (Array.isArray(raw.activeIssues)) {
    out.activeIssues = raw.activeIssues.filter((k) => typeof k === 'string' && k.length <= 2000).slice(0, 500);
  }
  return out;
}

/**
 * 比较本次检测结果与上次记录, 找出问题。纯函数。
 * @param {Object<string,string>} prevExits 账号 id -> 上次出口 IP
 * @param {Array<{id, name, ok, ip, viaMihomo}>} results
 * @returns {{ issues: Array<{key, kind, names, ip?}>, exits: Object, allFailed: boolean }}
 */
function evaluateExitResults(prevExits, results) {
  const prev = prevExits || {};
  const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r.id === 'string');
  const okList = list.filter((r) => r.ok && isValidIp(r.ip));
  const issues = [];

  if (list.length > 0 && okList.length === 0) {
    // 全部失败多半是本机断网: 只报一条, 且不改动出口记录 (恢复后不会误报"出口变化")
    return { issues: [{ key: 'offline', kind: 'offline', names: [] }], exits: { ...prev }, allFailed: true };
  }

  const byIp = new Map();
  for (const r of okList) {
    const ip = r.ip.toLowerCase();
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(r);
  }
  for (const [ip, group] of byIp) {
    if (group.length < 2) continue;
    const ids = group.map((r) => r.id).sort();
    issues.push({ key: `share:${ids.join(',')}`, kind: 'shared', ip, names: group.map((r) => r.name || r.id) });
  }
  for (const r of okList) {
    const ip = r.ip.toLowerCase();
    if (prev[r.id] && prev[r.id] !== ip) {
      issues.push({ key: `chg:${r.id}:${ip}`, kind: 'changed', ip, from: prev[r.id], names: [r.name || r.id] });
    }
  }
  for (const r of list) {
    if (!r.ok && r.viaMihomo) issues.push({ key: `fail:${r.id}`, kind: 'failed', names: [r.name || r.id] });
  }

  // 出口记录只保留当前账号; 检测失败的账号保留上次的值
  const exits = {};
  for (const r of list) {
    if (r.ok && isValidIp(r.ip)) exits[r.id] = r.ip.toLowerCase();
    else if (prev[r.id]) exits[r.id] = prev[r.id];
  }
  return { issues, exits, allFailed: false };
}

/** 把新出现的问题拼成一条通知 (不含 IP, 只含账号名) */
function formatIssueNotification(issues, locale) {
  const zh = locale !== 'en';
  const join = (names) => names.join(zh ? '、' : ', ');
  const lines = [];
  for (const i of issues) {
    if (i.kind === 'offline') lines.push(zh ? '所有账号都检测失败，可能是本机断网或 Mihomo 未运行' : 'All accounts failed the check — offline or Mihomo not running');
    else if (i.kind === 'shared') lines.push(zh ? `${i.names.length} 个账号共用同一出口：${join(i.names)}` : `${i.names.length} accounts share one exit: ${join(i.names)}`);
    else if (i.kind === 'changed') lines.push(zh ? `「${i.names[0]}」的出口 IP 变了` : `Exit IP changed for "${i.names[0]}"`);
    else if (i.kind === 'failed') lines.push(zh ? `「${i.names[0]}」无法联网` : `"${i.names[0]}" cannot connect`);
  }
  let body = lines.slice(0, 4).join(zh ? '；' : '; ');
  if (lines.length > 4) body += zh ? `；另有 ${lines.length - 4} 项` : `; +${lines.length - 4} more`;
  if (body.length > 220) body = body.slice(0, 219) + '…';
  return { title: zh ? '出口 IP 检测发现问题' : 'Exit IP check found issues', body };
}

/**
 * @param {Object} deps
 * @param {() => Object} deps.getState
 * @param {() => void} deps.saveState
 * @param {() => Promise<{ok, results?, busy?, error?}>} deps.runCheck 执行一次账号出口检测
 * @param {(title, body, onClick?) => void} deps.notify
 * @param {() => void} [deps.onOpen] 点击通知时打开设置页
 * @param {{setTimeout, clearTimeout}} [deps.timers]
 * @param {() => number} [deps.now]
 */
function createExitMonitor({ getState, saveState, runCheck, notify, onOpen, timers, now }) {
  const T = timers || { setTimeout, clearTimeout };
  const clock = now || Date.now;
  let timer = null;
  let nextRunAt = 0;
  let running = false;
  // 每次有意更换出口时加一; 检测结果回来时若已变化, 说明它是改动前发起的, 丢弃 (审查 L5)
  let generation = 0;

  function cfg() {
    const st = getState();
    if (!st.exitMonitor || typeof st.exitMonitor !== 'object') st.exitMonitor = defaultExitMonitor();
    return st.exitMonitor;
  }

  function clear() {
    if (timer) T.clearTimeout(timer);
    timer = null;
    nextRunAt = 0;
  }

  function schedule(delayMs) {
    clear();
    const c = cfg();
    if (!c.enabled) return;
    const ms = Number.isFinite(delayMs) ? delayMs : c.intervalMinutes * 60 * 1000;
    nextRunAt = clock() + ms;
    timer = T.setTimeout(tick, ms);
  }

  /** 记录一次检测结果 (自动检测和设置页手动检测共用); silent 时只更新记录不通知 */
  function record(results, { silent = false } = {}) {
    const c = cfg();
    const ev = evaluateExitResults(c.exits, results);
    const prevKeys = new Set(c.activeIssues || []);
    const fresh = ev.issues.filter((i) => !prevKeys.has(i.key));
    c.exits = ev.exits;
    // "出口变化"只报一次 (记录已更新为新 IP), 其余问题持续存在期间不重复通知。
    // 断网期间保留之前已提醒过的问题, 恢复联网后不会把老问题再提醒一遍
    const current = ev.issues.filter((i) => i.kind !== 'changed').map((i) => i.key);
    c.activeIssues = ev.allFailed ? [...new Set([...prevKeys].concat(current))] : current;
    const okOnes = (results || []).filter((r) => r && r.ok);
    c.lastRunAt = clock();
    c.lastSummary = {
      accounts: (results || []).length,
      reachable: okOnes.length,
      distinctIps: new Set(okOnes.map((r) => String(r.ip).toLowerCase())).size,
      issues: ev.issues.length,
    };
    saveState();
    if (!silent && fresh.length) {
      const { title, body } = formatIssueNotification(fresh, getState().locale);
      try { notify(title, body, onOpen); } catch (_) {}
    }
    return { issues: ev.issues, fresh };
  }

  async function tick() {
    timer = null;
    nextRunAt = 0;
    if (!cfg().enabled) return;
    if (running) return schedule();
    running = true;
    const startedGen = generation;
    try {
      const r = await runCheck();
      if (r && r.ok && startedGen !== generation) return; // 期间应用了新的出口方案, 结果作废
      if (r && r.ok) record(r.results, { silent: false });
      else if (r && r.busy) return; // 用户正在手动检测, finally 里按正常间隔重排
      else console.warn('[ExitMonitor] Check failed:', r && r.error);
    } catch (err) {
      console.warn('[ExitMonitor] Check error:', err);
    } finally {
      running = false;
      if (!timer) schedule();
    }
  }

  function getConfig() {
    const c = cfg();
    return {
      enabled: c.enabled,
      intervalMinutes: c.intervalMinutes,
      intervals: MONITOR_INTERVALS.slice(),
      lastRunAt: c.lastRunAt || 0,
      lastSummary: c.lastSummary || null,
      activeIssueCount: (c.activeIssues || []).length,
      nextRunAt,
    };
  }

  function update(patch) {
    const c = cfg();
    const wasEnabled = c.enabled;
    const prevInterval = c.intervalMinutes;
    if (patch && typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
    if (patch && MONITOR_INTERVALS.includes(patch.intervalMinutes)) c.intervalMinutes = patch.intervalMinutes;
    saveState();
    if (!c.enabled) clear();
    else if (!wasEnabled) schedule(ENABLE_RUN_DELAY_MS);
    else if (c.intervalMinutes !== prevInterval) schedule();
    return getConfig();
  }

  return {
    start: () => schedule(FIRST_RUN_DELAY_MS),
    stop: clear,
    invalidate: () => { generation++; },
    update,
    getConfig,
    record,
    _tick: tick, // 测试用
  };
}

module.exports = {
  MONITOR_INTERVALS,
  defaultExitMonitor,
  sanitizeExitMonitor,
  evaluateExitResults,
  formatIssueNotification,
  createExitMonitor,
};
