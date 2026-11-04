#!/usr/bin/env node
/**
 * Muse Desktop 内置飞书 CLI (Embedded Feishu CLI Engine)
 * 具备独立命令行执行与模块导出双模能力，完全解耦对宿主系统全局 CLI 的依赖。
 *
 * 命令行用法：
 *   node bin/feishu-cli.js --version
 *   node bin/feishu-cli.js bitable records list --app-token <appToken> --table-id <tableId> [--app-id <appId>] [--app-secret <secret>] [--json]
 */

const https = require('https');
const { URL, URLSearchParams } = require('url');

const VERSION = '1.0.0 (Muse Built-in Feishu CLI)';

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
          'User-Agent': 'Muse-Embedded-Feishu-CLI/1.0',
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

// 获取自建应用 tenant_access_token
async function getTenantAccessToken(appId, appSecret) {
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

// 分页拉取全部多维表格记录
async function getBitableRecords({ appToken, tableId, token, appId, appSecret }) {
  if (!appToken || !tableId) {
    throw new Error('缺少多维表格 Base App Token 或 Table ID');
  }

  let finalToken = token;
  if (!finalToken && appId && appSecret) {
    finalToken = await getTenantAccessToken(appId, appSecret);
  }
  if (!finalToken) {
    throw new Error('缺少有效的访问凭据 (Token 或 App ID/Secret)');
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
        Authorization: `Bearer ${finalToken}`,
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

// 简易 CLI 参数解析
function parseArgs(args) {
  const options = {
    positionals: [],
    appToken: process.env.FEISHU_APP_TOKEN || '',
    tableId: process.env.FEISHU_TABLE_ID || '',
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    token: process.env.FEISHU_TOKEN || '',
    json: false,
    version: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--app-token' && args[i + 1]) {
      options.appToken = args[++i];
    } else if (arg === '--table-id' && args[i + 1]) {
      options.tableId = args[++i];
    } else if (arg === '--app-id' && args[i + 1]) {
      options.appId = args[++i];
    } else if (arg === '--app-secret' && args[i + 1]) {
      options.appSecret = args[++i];
    } else if (arg === '--token' && args[i + 1]) {
      options.token = args[++i];
    } else if (!arg.startsWith('-')) {
      options.positionals.push(arg);
    }
  }
  return options;
}

// CLI 主入口
async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (options.help) {
    console.log(`Muse 内置飞书 CLI - 版本 ${VERSION}`);
    console.log(`用法:`);
    console.log(`  node feishu-cli.js bitable records list --app-token <token> --table-id <tableId> [options]`);
    console.log(`选项:`);
    console.log(`  --app-token <token>    多维表格 Base App Token`);
    console.log(`  --table-id <id>        多维表格 Table ID`);
    console.log(`  --app-id <id>          飞书应用 App ID`);
    console.log(`  --app-secret <secret>  飞书应用 App Secret`);
    console.log(`  --token <token>        直接指定 access_token`);
    console.log(`  --json                 以标准 JSON 格式输出记录`);
    console.log(`  --version, -v          打印版本号`);
    process.exit(0);
  }

  const isBitableRecords = (
    options.positionals[0] === 'bitable' &&
    options.positionals[1] === 'records' &&
    (options.positionals[2] === 'list' || !options.positionals[2])
  );

  if (isBitableRecords) {
    try {
      const items = await getBitableRecords(options);
      if (options.json) {
        console.log(JSON.stringify({ code: 0, msg: 'success', data: { items } }));
      } else {
        console.log(JSON.stringify(items, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(JSON.stringify({ code: 1, msg: err.message }));
      process.exit(1);
    }
  } else {
    console.error(`未知命令或参数: ${options.positionals.join(' ')}。请使用 --help 查看用法。`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  VERSION,
  getTenantAccessToken,
  getBitableRecords,
};
