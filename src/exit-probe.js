// src/exit-probe.js
// 出口 IP 实测 (需要网络):
//   - checkSessionExit: 用账号自己的会话 (含它当前的代理设置) 请求出口 IP 查询服务, 得到该账号的真实出口
//   - probeNodeExits:   另起一个临时 Mihomo 进程, 每个节点开一个本地端口, 逐个经由节点请求查询服务,
//                       得到每个节点的真实出口 IP。临时进程用独立的数据目录、控制端口和端口段,
//                       不会影响正在运行的账号代理; 测完立即停止。
// 2026-11-22 新增。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { MihomoManager } = require('../mihomo-manager');
const { parseIpResponse } = require('./exit-isolation');

// 依次尝试, 第一个成功的为准。ipinfo 带国家/城市/运营商, ipify 只有 IP, 作为兜底。
const IP_SERVICES = [
  { host: 'ipinfo.io', path: '/json' },
  { host: 'api.ipify.org', path: '/?format=json' },
];
const MAX_BODY = 64 * 1024;

/** 用 Electron 会话请求 (走该会话当前的代理设置) */
async function checkSessionExit(ses, { timeoutMs = 10000 } = {}) {
  const started = Date.now();
  if (ses && typeof ses.closeAllConnections === 'function') {
    // 丢掉旧的长连接, 否则刚改过的代理/节点可能还在复用之前的隧道, 测到旧出口
    try { await ses.closeAllConnections(); } catch (_) {}
  }
  let lastErr = null;
  for (const svc of IP_SERVICES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await ses.fetch(`https://${svc.host}${svc.path}`, {
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY) throw new Error('响应过大');
      const info = parseIpResponse(JSON.parse(text));
      if (!info) throw new Error('返回的不是有效 IP');
      return { ok: true, ...info, ms: Date.now() - started };
    } catch (err) {
      lastErr = err && err.name === 'AbortError' ? new Error('超时') : err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || '失败'), ms: Date.now() - started };
}

/** 经本地 HTTP 代理端口 (Mihomo mixed 监听) 用 CONNECT 隧道请求一个 HTTPS 地址 */
function fetchViaLocalProxy(port, host, reqPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inner = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (inner) inner.destroy(); } catch (_) {}
      try { req.destroy(); } catch (_) {}
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('超时')), timeoutMs);
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
    req.on('error', (e) => finish(reject, e));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(reject, new Error(`节点拒绝连接 (CONNECT ${res.statusCode})`));
      }
      inner = https.get({
        host,
        path: reqPath,
        agent: false,
        headers: { 'User-Agent': 'curl/8.4.0', Accept: 'application/json', Connection: 'close' },
        createConnection: () => tls.connect({ socket, servername: host }),
      }, (resp) => {
        let body = '';
        resp.setEncoding('utf8');
        resp.on('data', (c) => {
          body += c;
          if (body.length > MAX_BODY) finish(reject, new Error('响应过大'));
        });
        resp.on('end', () => finish(resolve, { status: resp.statusCode, body }));
        resp.on('error', (e) => finish(reject, e));
      });
      inner.on('error', (e) => finish(reject, e));
    });
    req.end();
  });
}

async function probeOnePort(port, timeoutMs) {
  const started = Date.now();
  let lastErr = null;
  for (const svc of IP_SERVICES) {
    try {
      const { status, body } = await fetchViaLocalProxy(port, svc.host, svc.path, timeoutMs);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const info = parseIpResponse(JSON.parse(body));
      if (!info) throw new Error('返回的不是有效 IP');
      return { ok: true, ...info, ms: Date.now() - started };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || '失败'), ms: Date.now() - started };
}

// 临时内核的配置里有全部节点的服务器地址与密码, 测完立即删掉 (2026-11-22 审查 L3)
function removeProbeConfig(dataDir) {
  try { fs.unlinkSync(path.join(dataDir, 'config.yaml')); } catch (_) {}
}

/** 并发执行, 结果顺序与输入一致 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 实测每个节点的出口 IP。
 * @param {Object} p
 * @param {Array<Object>} p.nodes Mihomo 节点 (state.mihomo.cachedProxies)
 * @param {string} p.dataDir 临时 Mihomo 数据目录 (与正式内核分开)
 * @param {string} [p.binPath] 自定义内核路径
 * @param {number} [p.controllerPort] 临时内核控制端口 (被占用时自动换空闲端口)
 * @param {number} [p.basePort] 临时内核的节点端口起点
 * @param {(done: number, total: number) => void} [p.onProgress]
 */
async function probeNodeExits({ nodes, dataDir, binPath, controllerPort = 19190, basePort = 28001, concurrency = 8, timeoutMs = 8000, onProgress }) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && typeof n.name === 'string' && n.type);
  if (!list.length) return { ok: false, error: '节点池为空，请先同步订阅' };

  // 每个节点当作一个"账号": 严格模式下它的分组里只有这一个节点, 不会回落到别的节点
  const fakeAccounts = list.map((n, i) => ({ id: `probe_${i}`, proxyQueue: [n.name], proxyStrategy: 'fallback' }));
  const portOf = {};
  fakeAccounts.forEach((a, i) => { portOf[a.id] = basePort + i; });
  const mm = new MihomoManager({
    dataDir,
    binPath,
    basePort,
    controllerPort,
    portResolver: (a) => portOf[a.id],
    onPortReassigned: (id, newPort) => { portOf[id] = newPort; },
    isStrict: () => true,
  });

  const startRes = await mm.start(fakeAccounts, list);
  if (!startRes || !startRes.ok) {
    try { mm.stop(); } catch (_) {}
    removeProbeConfig(dataDir);
    return { ok: false, error: (startRes && startRes.error) || '临时 Mihomo 内核启动失败' };
  }
  try {
    const portMap = startRes.portMap || {};
    let done = 0;
    const results = await mapLimit(fakeAccounts, concurrency, async (a, i) => {
      const r = await probeOnePort(portMap[a.id], timeoutMs);
      done++;
      if (onProgress) { try { onProgress(done, fakeAccounts.length); } catch (_) {} }
      return { name: list[i].name, ...r };
    });
    return { ok: true, results };
  } finally {
    try { mm.stop(); } catch (_) {}
    removeProbeConfig(dataDir);
  }
}

module.exports = { IP_SERVICES, checkSessionExit, probeNodeExits, mapLimit };
