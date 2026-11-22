// src/exit-isolation.js
// 出口 IP 隔离的纯计算部分 (不做任何网络请求, 可直接单元测试):
//   - 解析出口 IP 查询服务的返回
//   - 按"实测出口 IP"把节点分组 (机场节点上写的服务器地址往往只是中转入口, 不能代表出口)
//   - 标出共用同一出口的账号
//   - 生成"每个账号一个独立出口"的分配方案
// 2026-11-22 新增。
'use strict';

// 名字里带 0.1倍 / 0.5x 之类低倍率标记的节点: 通常多人共用、IP 质量差, 不适合做账号主出口
const LOW_TIER_RE = /(?:^|[^\d.])0\.\d+\s*(?:倍|x|×)/i;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9a-f:]{2,39}$/i;

function isValidIp(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim();
  return IPV4_RE.test(s) || (s.includes(':') && IPV6_RE.test(s));
}

/** 解析 ipinfo.io/json 或 api.ipify.org?format=json 的返回; 无效返回 null */
function parseIpResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const ip = typeof json.ip === 'string' ? json.ip.trim() : '';
  if (!isValidIp(ip)) return null;
  const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
  return { ip: ip.toLowerCase(), country: str(json.country).toUpperCase().slice(0, 2), city: str(json.city), org: str(json.org) };
}

function isLowTier(name) {
  return LOW_TIER_RE.test(String(name || ''));
}

/**
 * 按实测出口 IP 分组。
 * @param {Array<{name, ok, ip, country, city, org, ms}>} nodeResults
 * @returns {Map<string, {ip, country, city, org, nodes: Array<{name, ms, lowTier}>, lowTier: boolean, bestMs: number}>}
 *          组内节点按 (非低倍率优先, 延迟低优先, 名称) 排序
 */
function buildExitGroups(nodeResults) {
  const groups = new Map();
  for (const r of nodeResults || []) {
    if (!r || !r.ok || !isValidIp(r.ip) || typeof r.name !== 'string') continue;
    const ip = r.ip.toLowerCase();
    let g = groups.get(ip);
    if (!g) {
      g = { ip, country: r.country || '', city: r.city || '', org: r.org || '', nodes: [] };
      groups.set(ip, g);
    }
    g.nodes.push({ name: r.name, ms: Number.isFinite(r.ms) ? r.ms : Infinity, lowTier: isLowTier(r.name) });
  }
  for (const g of groups.values()) {
    g.nodes.sort((a, b) => (a.lowTier - b.lowTier) || (a.ms - b.ms) || a.name.localeCompare(b.name));
    g.lowTier = g.nodes.every((n) => n.lowTier);
    g.bestMs = g.nodes[0].ms;
  }
  return groups;
}

/**
 * 给账号出口检测结果标出"与哪些账号共用同一出口"。
 * @param {Array<{id, name, ok, ip}>} accountResults
 * @returns 同一数组的新副本, 每项多出 sharedWith: string[] (其他账号名)
 */
function markSharedExits(accountResults) {
  const byIp = new Map();
  for (const r of accountResults || []) {
    if (r && r.ok && isValidIp(r.ip)) {
      const k = r.ip.toLowerCase();
      if (!byIp.has(k)) byIp.set(k, []);
      byIp.get(k).push(r);
    }
  }
  return (accountResults || []).map((r) => {
    const same = r && r.ok && isValidIp(r.ip) ? byIp.get(r.ip.toLowerCase()) : [];
    return { ...r, sharedWith: (same || []).filter((x) => x !== r).map((x) => x.name || x.id) };
  });
}

/**
 * 生成独立出口分配方案。
 *
 * 规则 (按优先级):
 *   1. 每个账号的主出口 IP 互不相同。
 *   2. 尽量不换: 账号当前主节点可用、且它的出口 IP 还没被别的账号占用时, 保留不动
 *      (同一出口原本被多个账号共用时, 列表中靠前的账号保留, 其余重新分配)。
 *   3. 需要重新分配时, 优先选与它原来出口同一国家/地区的、非低倍率的、延迟低的出口。
 *   4. 备用节点优先选"同一出口 IP 的其他节点" (故障切换后 IP 不变);
 *      不够时再用没有任何账号使用的出口 (切换后 IP 会变, 但不会和别的账号撞)。
 *   5. 出口 IP 数量少于账号数时, 多出的账号不分配, 保留原队列, 并在结果里列出。
 *
 * @param {Object} p
 * @param {Array<{id, name, proxyQueue}>} p.accounts 参与分配的账号 (按显示顺序)
 * @param {Array} p.nodeResults 节点实测结果 (见 buildExitGroups)
 * @param {number} [p.backupsPerAccount=2]
 */
function planIsolation({ accounts, nodeResults, backupsPerAccount = 2 }) {
  const groups = buildExitGroups(nodeResults);
  const nodeToIp = new Map();
  for (const g of groups.values()) for (const n of g.nodes) nodeToIp.set(n.name, g.ip);
  const failedNodes = (nodeResults || []).filter((r) => r && !r.ok).map((r) => r.name);

  const takenPrimary = new Map(); // ip -> accountId
  const decided = new Map(); // accountId -> { ip, primary, kept, prevCountry }

  const firstUsable = (queue) => (Array.isArray(queue) ? queue : []).find((n) => nodeToIp.has(n)) || null;
  const prevCountryOf = (acct) => {
    const n = firstUsable(acct.proxyQueue);
    return n ? (groups.get(nodeToIp.get(n)).country || '') : '';
  };

  // 第 1 轮: 保留现状
  for (const acct of accounts || []) {
    const cur = Array.isArray(acct.proxyQueue) && acct.proxyQueue.length ? acct.proxyQueue[0] : null;
    if (!cur || !nodeToIp.has(cur)) continue; // 当前主节点不可用 -> 必须换
    const ip = nodeToIp.get(cur);
    if (takenPrimary.has(ip)) continue;
    takenPrimary.set(ip, acct.id);
    decided.set(acct.id, { ip, primary: cur, kept: true, prevCountry: groups.get(ip).country });
  }

  // 第 2 轮: 其余账号分配到空闲出口
  const free = () => [...groups.values()].filter((g) => !takenPrimary.has(g.ip));
  for (const acct of accounts || []) {
    if (decided.has(acct.id)) continue;
    const prevCountry = prevCountryOf(acct);
    const candidates = free().sort((a, b) =>
      ((b.country && b.country === prevCountry) - (a.country && a.country === prevCountry)) ||
      (a.lowTier - b.lowTier) ||
      (a.bestMs - b.bestMs) ||
      a.ip.localeCompare(b.ip));
    const g = candidates[0];
    if (!g) continue;
    takenPrimary.set(g.ip, acct.id);
    decided.set(acct.id, { ip: g.ip, primary: g.nodes[0].name, kept: false, prevCountry });
  }

  // 第 3 轮: 备用节点。先用同 IP 的其他节点, 再用完全没人用的出口 (每个出口只给一个账号)
  const usedAsBackup = new Set();
  const assignments = [];
  const unassigned = [];
  for (const acct of accounts || []) {
    const d = decided.get(acct.id);
    if (!d) {
      unassigned.push({ id: acct.id, name: acct.name || acct.id });
      continue;
    }
    const g = groups.get(d.ip);
    const queue = [d.primary];
    let sameIp = 0;
    for (const n of g.nodes) {
      if (queue.length > backupsPerAccount) break;
      if (!queue.includes(n.name)) { queue.push(n.name); sameIp++; }
    }
    let otherIp = 0;
    if (queue.length <= backupsPerAccount) {
      const spare = [...groups.values()]
        .filter((x) => !takenPrimary.has(x.ip) && !usedAsBackup.has(x.ip))
        .sort((a, b) =>
          ((b.country && b.country === g.country) - (a.country && a.country === g.country)) ||
          (a.lowTier - b.lowTier) || (a.bestMs - b.bestMs) || a.ip.localeCompare(b.ip));
      for (const x of spare) {
        if (queue.length > backupsPerAccount) break;
        usedAsBackup.add(x.ip);
        queue.push(x.nodes[0].name);
        otherIp++;
      }
    }
    const prevQueue = Array.isArray(acct.proxyQueue) ? acct.proxyQueue : [];
    assignments.push({
      id: acct.id,
      name: acct.name || acct.id,
      exitIp: g.ip,
      country: g.country,
      city: g.city,
      org: g.org,
      primary: d.primary,
      queue,
      kept: d.kept,
      changed: queue.length !== prevQueue.length || queue.some((n, i) => n !== prevQueue[i]),
      backupSameIp: sameIp,
      backupOtherIp: otherIp,
      lowTier: isLowTier(d.primary),
    });
  }

  return {
    assignments,
    unassigned,
    stats: {
      accounts: (accounts || []).length,
      usableNodes: [...groups.values()].reduce((s, g) => s + g.nodes.length, 0),
      failedNodes: failedNodes.length,
      exitIps: groups.size,
      changed: assignments.filter((a) => a.changed).length,
    },
  };
}

module.exports = { LOW_TIER_RE, isValidIp, isLowTier, parseIpResponse, buildExitGroups, markSharedExits, planIsolation };
