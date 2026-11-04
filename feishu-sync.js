// feishu-sync.js - 飞书多维表格 (Bitable) 账号元数据与用量定时同步服务 (OpenAPI + CLI 双模驱动)
const https = require('https');
const { URL } = require('url');
const { execFile } = require('child_process');

function defaultFeishuConfig() {
  return {
    enabled: false,
    syncMode: 'auto', // 'auto' (优先尝试CLI，未安装则无缝走OpenAPI) | 'api' (纯OpenAPI) | 'cli' (纯CLI)
    customCliPath: '',
    appId: '',
    appSecret: '',
    appToken: '',
    tableId: '',
    autoSync: false,
    syncIntervalMinutes: 30, // 默认 30 分钟同步一次
    lastSyncTime: null,
    lastSyncStatus: '',
    fieldMap: {
      name: '账号名称',
      purpose: '主要用途',
      usage: '当前用量',
      tokenReset: '重置时间',
      group: '所属群组',
    },
  };
}

// 探测系统飞书 CLI 是否安装并可用
function detectFeishuCli(customCliPath) {
  return new Promise((resolve) => {
    const candidates = customCliPath ? [customCliPath] : (process.platform === 'win32' ? ['feishu.cmd', 'feishu.exe', 'lark.cmd', 'lark.exe'] : ['feishu', 'lark']);
    let idx = 0;

    function tryNext() {
      if (idx >= candidates.length) {
        return resolve({ available: false, path: null, error: '未检测到系统安装的飞书 CLI 命令' });
      }
      const bin = candidates[idx++];
      execFile(bin, ['--version'], { timeout: 3000 }, (err, stdout) => {
        if (!err && stdout && stdout.trim()) {
          resolve({ available: true, path: bin, version: stdout.trim() });
        } else {
          tryNext();
        }
      });
    }
    tryNext();
  });
}

// 通过飞书 CLI 执行多维表格记录拉取
function fetchRecordsViaCli(cliPath, appToken, tableId) {
  return new Promise((resolve, reject) => {
    const bin = cliPath || (process.platform === 'win32' ? 'feishu.cmd' : 'feishu');
    const args = ['bitable', 'records', 'list', '--app-token', appToken.trim(), '--table-id', tableId.trim(), '--json'];
    execFile(bin, args, { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`飞书 CLI 运行异常: ${stderr ? stderr.trim() : err.message}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        const items = parsed.items || (parsed.data && parsed.data.items) || (Array.isArray(parsed) ? parsed : []);
        resolve(items);
      } catch (parseErr) {
        reject(new Error(`飞书 CLI 返回的 JSON 数据解析失败: ${parseErr.message}`));
      }
    });
  });
}

// 通用 HTTPS 请求封装
function requestJson(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const reqOptions = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Muse-Desktop-FeishuSync/1.0',
          ...(options.headers || {}),
        },
        timeout: 15000,
      };

      const req = https.request(reqOptions, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: rawData, error: e.message });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Feishu request timeout (15s)'));
      });

      if (postData) {
        req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// 1. 获取飞书自建应用的 tenant_access_token
async function fetchTenantAccessToken(appId, appSecret) {
  if (!appId || !appSecret) {
    throw new Error('缺少飞书 App ID 或 App Secret');
  }

  const endpoint = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const res = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }, { app_id: appId.trim(), app_secret: appSecret.trim() });

  if (res.data && res.data.code === 0 && res.data.tenant_access_token) {
    return res.data.tenant_access_token;
  }
  const msg = (res.data && (res.data.msg || res.data.error_description)) || `HTTP ${res.statusCode}`;
  throw new Error(`获取飞书访问凭据失败: ${msg}`);
}

// 2. 从多维表格分页拉取全部记录
async function fetchBitableRecords(token, appToken, tableId) {
  if (!appToken || !tableId) {
    throw new Error('缺少多维表格 Base App Token 或 Table ID');
  }

  let allRecords = [];
  let pageToken = '';
  let hasMore = true;
  let safetyCounter = 0;

  while (hasMore && safetyCounter < 10) {
    safetyCounter++;
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);

    const endpoint = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken.trim())}/tables/${encodeURIComponent(tableId.trim())}/records?${query.toString()}`;
    const res = await requestJson(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.data && res.data.code === 0 && res.data.data) {
      const items = res.data.data.items || [];
      allRecords.push(...items);
      hasMore = !!res.data.data.has_more;
      pageToken = res.data.data.page_token || '';
    } else {
      const msg = (res.data && res.data.msg) || `HTTP ${res.statusCode}`;
      throw new Error(`读取多维表格数据失败: ${msg}`);
    }
  }

  return allRecords;
}

// 辅助：从多维表格各种复杂字段类型提取纯文本或数字
function extractFieldValue(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  if (Array.isArray(raw)) {
    // 飞书文本/人员/标签类型常为数组 [{ text: '...' }]
    return raw.map((item) => {
      if (typeof item === 'string') return item;
      if (item && item.text) return item.text;
      if (item && item.name) return item.name;
      return JSON.stringify(item);
    }).join(', ');
  }
  if (typeof raw === 'object') {
    if (raw.text) return raw.text;
    if (raw.name) return raw.name;
    if (raw.value) return raw.value;
  }
  return String(raw);
}

// 辅助：智能解析用量百分比与明细文本
function parseUsageValue(raw) {
  if (raw === null || raw === undefined) return { percent: 0, text: '0%' };
  if (typeof raw === 'number') {
    const pct = Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)));
    return { percent: pct, text: `${pct}%` };
  }
  const str = String(raw).trim();
  if (!str) return { percent: 0, text: '0%' };

  // 1. 优先匹配明确的百分比，如 "75%"、"(75%)"
  const pctMatch = str.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const pct = Math.max(0, Math.min(100, Math.round(parseFloat(pctMatch[1]))));
    return { percent: pct, text: str };
  }
  // 2. 匹配分数/比例，如 "7500 / 10000"、"7,500/10,000"
  const ratioMatch = str.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (ratioMatch) {
    const num = parseFloat(ratioMatch[1]);
    const den = parseFloat(ratioMatch[2]);
    if (den > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((num / den) * 100)));
      return { percent: pct, text: str };
    }
  }
  // 3. 普通单一数值，如 "85" 或 "0.85"
  const singleMatch = str.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]);
    const pct = Math.max(0, Math.min(100, Math.round(val <= 1 ? val * 100 : val)));
    return { percent: pct, text: str };
  }
  return { percent: 0, text: str };
}

// 3. 执行单次同步，将飞书记录匹配更新至本地 profiles
async function executeFeishuSync(feishuConfig, currentProfiles, saveCallback) {
  if (!feishuConfig || !feishuConfig.appToken || !feishuConfig.tableId) {
    return { ok: false, error: '缺少飞书多维表格 Base Token 或 Table ID' };
  }

  const syncMode = feishuConfig.syncMode || 'auto';
  let records = [];
  let usedEngine = 'openapi';

  // 1. 如果配置了 CLI 模式或 auto 模式，尝试优先走 CLI
  if (syncMode === 'cli' || syncMode === 'auto') {
    const cliCheck = await detectFeishuCli(feishuConfig.customCliPath);
    if (cliCheck.available) {
      try {
        console.log(`[FeishuSync] Using Feishu CLI at ${cliCheck.path} (${cliCheck.version})`);
        records = await fetchRecordsViaCli(cliCheck.path, feishuConfig.appToken, feishuConfig.tableId);
        usedEngine = 'cli';
      } catch (cliErr) {
        console.warn(`[FeishuSync] CLI execution failed: ${cliErr.message}`);
        if (syncMode === 'cli') {
          return { ok: false, error: `飞书 CLI 执行失败: ${cliErr.message}` };
        }
      }
    } else if (syncMode === 'cli') {
      return { ok: false, error: `未找到飞书 CLI 命令，请先安装飞书开发者工具或切换为 OpenAPI 模式` };
    }
  }

  // 2. 如果 CLI 未获取到记录，且允许 API 模式，则走标准 OpenAPI
  if (records.length === 0 && (syncMode === 'api' || syncMode === 'auto')) {
    if (!feishuConfig.appId || !feishuConfig.appSecret) {
      return { ok: false, error: '飞书配置不完整，缺少自建应用的 App ID 或 App Secret' };
    }
    const token = await fetchTenantAccessToken(feishuConfig.appId, feishuConfig.appSecret);
    records = await fetchBitableRecords(token, feishuConfig.appToken, feishuConfig.tableId);
    usedEngine = 'openapi';
  }

  const fieldMap = {
    name: (feishuConfig.fieldMap && feishuConfig.fieldMap.name) || '账号名称',
    purpose: (feishuConfig.fieldMap && feishuConfig.fieldMap.purpose) || '主要用途',
    usage: (feishuConfig.fieldMap && feishuConfig.fieldMap.usage) || '当前用量',
    tokenReset: (feishuConfig.fieldMap && feishuConfig.fieldMap.tokenReset) || '重置时间',
    group: (feishuConfig.fieldMap && feishuConfig.fieldMap.group) || '所属群组',
  };

  let updatedCount = 0;
  const nameToRecordMap = new Map();

  for (const rec of records) {
    const fields = rec.fields || {};
    const rawName = extractFieldValue(fields[fieldMap.name]);
    const cleanName = String(rawName).trim();
    if (cleanName) {
      nameToRecordMap.set(cleanName.toLowerCase(), {
        recordId: rec.record_id,
        purpose: String(extractFieldValue(fields[fieldMap.purpose]) || '').trim(),
        usage: extractFieldValue(fields[fieldMap.usage]),
        tokenReset: String(extractFieldValue(fields[fieldMap.tokenReset]) || '').trim(),
        group: String(extractFieldValue(fields[fieldMap.group]) || '').trim(),
      });
    }
  }

  // 匹配并更新本地 profiles
  for (const prof of currentProfiles) {
    const targetKey = String(prof.name || '').trim().toLowerCase();
    const match = nameToRecordMap.get(targetKey);
    if (match) {
      updatedCount++;
      prof.feishuRecordId = match.recordId;
      if (match.purpose) prof.purpose = match.purpose;
      if (match.group) prof.group = match.group;
      if (match.tokenReset) prof.tokenResetAt = match.tokenReset;

      // 智能解析用量百分比与明细文本
      const parsedUsage = parseUsageValue(match.usage);
      prof.usagePercent = parsedUsage.percent;
      prof.usageText = parsedUsage.text;

      // 根据用量判定状态
      if (prof.usagePercent >= 95) {
        prof.status = 'exhausted';
      } else if (prof.usagePercent >= 75) {
        prof.status = 'warning';
      } else {
        prof.status = 'normal';
      }
      prof.updatedAt = Date.now();
    }
  }

  feishuConfig.lastSyncTime = new Date().toISOString();
  feishuConfig.lastSyncStatus = `成功通过 [${usedEngine === 'cli' ? '飞书 CLI' : '飞书 OpenAPI'}] 同步：共 ${records.length} 条记录，更新了 ${updatedCount} 个匹配账号`;

  if (typeof saveCallback === 'function') {
    saveCallback();
  }

  return {
    ok: true,
    engine: usedEngine,
    totalRecords: records.length,
    updatedProfiles: updatedCount,
    lastSyncTime: feishuConfig.lastSyncTime,
  };
}

// 飞书定时轮询器
let syncTimer = null;

function setupFeishuAutoSync(feishuConfig, getProfilesFn, onSaveAndBroadcast) {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  if (!feishuConfig || !feishuConfig.enabled || !feishuConfig.autoSync) {
    return;
  }

  const minutes = Math.max(5, feishuConfig.syncIntervalMinutes || 30);
  const intervalMs = minutes * 60 * 1000;

  console.log(`[FeishuSync] Auto sync scheduled every ${minutes} minutes.`);
  syncTimer = setInterval(async () => {
    try {
      const profiles = getProfilesFn();
      const res = await executeFeishuSync(feishuConfig, profiles, onSaveAndBroadcast);
      console.log(`[FeishuSync] Auto sync finished:`, res);
    } catch (err) {
      console.warn(`[FeishuSync] Auto sync error:`, err.message);
      feishuConfig.lastSyncStatus = `自动同步失败: ${err.message}`;
    }
  }, intervalMs);
}

module.exports = {
  defaultFeishuConfig,
  detectFeishuCli,
  fetchRecordsViaCli,
  fetchTenantAccessToken,
  fetchBitableRecords,
  parseUsageValue,
  executeFeishuSync,
  setupFeishuAutoSync,
};
