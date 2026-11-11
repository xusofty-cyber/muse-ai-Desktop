/**
 * mihomo-manager.js
 * Muse Desktop - 内置 Mihomo 代理内核与多账号独立代理队列管理引擎
 * 
 * 职责：
 * 1. 机场订阅拉取、缓存与 YAML 解析（带自动 User-Agent 与重定向追踪）；
 * 2. 多账号独立 Inbound Listeners 与 Proxy Group (Fallback 故障转移) 配置动态合成；
 * 3. Mihomo 内核进程生命周期管理（发现、启动、优雅退出与异常防护）；
 * 4. External Controller REST API 客户端（热重载配置、节点健康状态与延迟测速）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const yaml = require('js-yaml');

const DEFAULT_CONTROLLER_PORT = 19090;
const DEFAULT_BASE_PROXY_PORT = 18001;
const DEFAULT_TEST_URL = 'https://muse.ai';
const SUB_USER_AGENT = 'clash-verge/v1.7.7 (Clash.Meta)';

class MihomoManager {
  /**
   * @param {Object} options
   * @param {string} options.dataDir 运行数据与配置文件存储目录
   * @param {string} [options.binPath] 自定义内核路径
   * @param {number} [options.basePort] 起始监听端口 (默认 18001)
   * @param {number} [options.controllerPort] External Controller 端口 (默认 19090)
   * @param {string} [options.secret] Controller Secret (留空自动生成)
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), '.mihomo-runtime');
    this.binPath = options.binPath || '';
    this.basePort = options.basePort || DEFAULT_BASE_PROXY_PORT;
    this.controllerPort = options.controllerPort || DEFAULT_CONTROLLER_PORT;
    this.secret = options.secret || crypto.randomBytes(16).toString('hex');

    this.process = null;
    this.isRunning = false;
    this.cachedProxies = [];
    this.portMap = {}; // { [profileId]: port }
    this.lastError = null;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * 自动探测可用内核二进制路径
   * @returns {string|null}
   */
  findExecutable() {
    const candidates = [];
    if (this.binPath && fs.existsSync(this.binPath)) {
      candidates.push(this.binPath);
    }

    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'mihomo.exe' : 'mihomo';

    // 1. 项目本地目录 bin/mihomo/
    candidates.push(path.join(__dirname, 'bin', 'mihomo', exeName));
    candidates.push(path.join(__dirname, 'bin', exeName));

    // 2. 常见系统安装路径
    if (!isWin) {
      candidates.push('/usr/bin/verge-mihomo');
      candidates.push('/usr/local/bin/mihomo');
      candidates.push('/usr/bin/mihomo');
    }

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          fs.accessSync(c, fs.constants.X_OK);
          return c;
        }
      } catch (_) {}
    }

    // 3. 从系统 PATH 中查找
    try {
      const cmd = isWin ? 'where mihomo' : 'which mihomo';
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      const firstLine = out.split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch (_) {}

    return null;
  }

  /**
   * 拉取机场订阅并解析其中的代理节点
   * @param {string} subUrl 订阅 URL
   * @returns {Promise<{ ok: boolean, proxies?: Array, rawYaml?: string, error?: string, subInfo?: Object }>}
   */
  async fetchSubscription(subUrl) {
    if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//i.test(subUrl.trim())) {
      return { ok: false, error: '无效的订阅链接，必须为 http:// 或 https:// 开头' };
    }

    const urlStr = subUrl.trim();
    try {
      const res = await this._httpGetWithRedirect(urlStr, {
        headers: {
          'User-Agent': SUB_USER_AGENT,
          Accept: '*/*'
        },
        timeout: 15000
      });

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return { ok: false, error: `下载订阅返回 HTTP ${res.statusCode}` };
      }

      const rawYaml = res.body;
      let parsed = null;
      try {
        parsed = yaml.load(rawYaml);
      } catch (e) {
        return { ok: false, error: `订阅内容非有效 YAML 格式: ${e.message}` };
      }

      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.proxies)) {
        return { ok: false, error: '订阅解析成功但未包含合法的 proxies 节点列表' };
      }

      // 提取节点关键字段
      const proxies = parsed.proxies.filter(p => p && typeof p === 'object' && p.name && p.type);
      this.cachedProxies = proxies;

      // 持久化缓存订阅
      const cachePath = path.join(this.dataDir, 'subscription.yaml');
      fs.writeFileSync(cachePath, rawYaml, 'utf8');

      const metaPath = path.join(this.dataDir, 'subscription.meta.json');
      const subInfo = {
        url: urlStr,
        updatedAt: new Date().toISOString(),
        nodeCount: proxies.length,
        subscriptionUserinfo: res.headers['subscription-userinfo'] || ''
      };
      fs.writeFileSync(metaPath, JSON.stringify(subInfo, null, 2), 'utf8');

      return {
        ok: true,
        proxies,
        rawYaml,
        subInfo
      };
    } catch (err) {
      return { ok: false, error: `请求订阅失败: ${err.message}` };
    }
  }

  /**
   * 读取本地缓存的订阅节点
   */
  loadCachedSubscription() {
    const cachePath = path.join(this.dataDir, 'subscription.yaml');
    if (!fs.existsSync(cachePath)) return [];
    try {
      const raw = fs.readFileSync(cachePath, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && Array.isArray(parsed.proxies)) {
        this.cachedProxies = parsed.proxies.filter(p => p && p.name && p.type);
        return this.cachedProxies;
      }
    } catch (_) {}
    return [];
  }

  /**
   * 生成 Mihomo 专属合成配置
   * @param {Array<Object>} accounts 账号列表 [{ id, name, proxyQueue, proxyStrategy }]
   * @param {Array<Object>} [proxies] 节点列表 (留空则用 cachedProxies)
   * @returns {{ configYaml: string, configObj: Object, portMap: Object }}
   */
  generateConfig(accounts = [], proxies = null) {
    const proxyList = Array.isArray(proxies) && proxies.length > 0 ? proxies : this.cachedProxies;
    const availableNames = new Set(proxyList.map(p => p.name));

    const listeners = [];
    const proxyGroups = [];
    const portMap = {};

    let currentPort = this.basePort;

    // 为每个账号建立专属 Listener 和 Proxy Group
    for (const acct of accounts) {
      if (!acct || !acct.id) continue;
      const port = currentPort++;
      portMap[acct.id] = port;

      const groupName = `muse_group_${acct.id}`;
      listeners.push({
        name: `listener_${acct.id}`,
        type: 'mixed',
        port: port,
        proxy: groupName
      });

      // 提取该账号配置的节点队列
      const rawQueue = Array.isArray(acct.proxyQueue) ? acct.proxyQueue : [];
      const validNodes = rawQueue.filter(n => availableNames.has(n));

      // 若未指定或节点失效，兜底使用全量节点中的前若干个，或使用 DIRECT
      const finalNodes = validNodes.length > 0 
        ? validNodes 
        : (proxyList.length > 0 ? [proxyList[0].name] : ['DIRECT']);

      proxyGroups.push({
        name: groupName,
        type: acct.proxyStrategy || 'fallback',
        url: DEFAULT_TEST_URL,
        interval: 300,
        proxies: finalNodes
      });
    }

    // 增加全局兜底默认组
    proxyGroups.push({
      name: 'GLOBAL',
      type: 'select',
      proxies: proxyList.length > 0 ? proxyList.map(p => p.name) : ['DIRECT']
    });

    const configObj = {
      port: 0,
      'socks-port': 0,
      'mixed-port': 0,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      'external-controller': `127.0.0.1:${this.controllerPort}`,
      secret: this.secret,
      listeners,
      'proxy-groups': proxyGroups,
      proxies: proxyList,
      rules: ['MATCH,DIRECT'] // 流量已通过各 listener 绑定至对应组，此处直接放行
    };

    const configYaml = yaml.dump(configObj, { lineWidth: -1 });
    this.portMap = portMap;

    return { configYaml, configObj, portMap };
  }

  /**
   * 启动 Mihomo 内核进程
   * @param {Array<Object>} accounts 账号配置列表
   * @param {Array<Object>} [proxies] 节点列表
   * @returns {Promise<{ ok: boolean, error?: string, portMap?: Object }>}
   */
  async start(accounts = [], proxies = null) {
    if (this.isRunning && this.process) {
      return { ok: true, portMap: this.portMap };
    }

    const exe = this.findExecutable();
    if (!exe) {
      return { ok: false, error: '未找到可用的 Mihomo 二进制内核，请确保已安装或放置于 bin/mihomo/' };
    }

    const { configYaml, portMap } = this.generateConfig(accounts, proxies);
    const configFile = path.join(this.dataDir, 'config.yaml');
    fs.writeFileSync(configFile, configYaml, 'utf8');

    try {
      const child = spawn(exe, ['-d', this.dataDir, '-f', configFile], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.process = child;
      this.isRunning = true;
      this.lastError = null;

      child.stdout.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('level=error') || msg.includes('level=fatal')) {
          console.error('[MihomoCore STDOUT]', msg.trim());
        }
      });

      child.stderr.on('data', (d) => {
        console.warn('[MihomoCore STDERR]', d.toString().trim());
      });

      child.on('exit', (code, sig) => {
        console.log(`[MihomoCore] Exited with code=${code}, signal=${sig}`);
        this.isRunning = false;
        this.process = null;
      });

      child.on('error', (err) => {
        console.error('[MihomoCore] Process error:', err);
        this.lastError = err.message;
        this.isRunning = false;
        this.process = null;
      });

      // 轮询等待 External Controller 就绪 (最多等 5 秒)
      const ready = await this._waitForController(5000);
      if (!ready) {
        this.stop();
        return { ok: false, error: 'Mihomo 启动超时或 External Controller 端口连接失败' };
      }

      console.log(`[MihomoCore] Started successfully. Controller on 127.0.0.1:${this.controllerPort}, Ports:`, portMap);
      return { ok: true, portMap };
    } catch (err) {
      this.isRunning = false;
      this.process = null;
      return { ok: false, error: `启动失败: ${err.message}` };
    }
  }

  /**
   * 停止 Mihomo 内核进程
   */
  stop() {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch (_) {
        try { this.process.kill('SIGKILL'); } catch (__) {}
      }
      this.process = null;
    }
    this.isRunning = false;
    console.log('[MihomoCore] Stopped.');
  }

  /**
   * 热重载配置 (无需杀死进程中断现有连接)
   * @param {Array<Object>} accounts 账号列表
   * @param {Array<Object>} [proxies] 节点列表
   */
  async reload(accounts = [], proxies = null) {
    if (!this.isRunning) {
      return this.start(accounts, proxies);
    }

    const { configYaml, portMap } = this.generateConfig(accounts, proxies);
    const configFile = path.join(this.dataDir, 'config.yaml');
    fs.writeFileSync(configFile, configYaml, 'utf8');

    try {
      const res = await this._controllerRequest('PUT', '/configs?force=true', {
        path: configFile
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true, portMap };
      }
      return { ok: false, error: `热重载配置返回 HTTP ${res.statusCode}: ${res.body}` };
    } catch (err) {
      // 若热重载失败，回退为硬重启
      console.warn('[MihomoCore] Hot-reload failed, falling back to restart:', err.message);
      this.stop();
      return this.start(accounts, proxies);
    }
  }

  /**
   * 测试指定节点的延迟
   * @param {string} proxyName 节点名称
   * @param {string} [testUrl] 测速目标网址
   * @param {number} [timeout] 超时毫秒 (默认 3000)
   * @returns {Promise<{ ok: boolean, delay?: number, error?: string }>}
   */
  async testNodeDelay(proxyName, testUrl = DEFAULT_TEST_URL, timeout = 3000) {
    if (!this.isRunning) {
      return { ok: false, error: 'Mihomo 内核未运行' };
    }

    const encName = encodeURIComponent(proxyName);
    const path = `/proxies/${encName}/delay?timeout=${timeout}&url=${encodeURIComponent(testUrl)}`;
    try {
      const res = await this._controllerRequest('GET', path);
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        return { ok: true, delay: data.delay };
      }
      return { ok: false, error: `测速返回 HTTP ${res.statusCode}: ${res.body}` };
    } catch (err) {
      return { ok: false, error: `测速超时或失败: ${err.message}` };
    }
  }

  /**
   * 获取当前全部节点状态
   */
  async getProxiesStatus() {
    if (!this.isRunning) {
      return { ok: false, error: 'Mihomo 内核未运行' };
    }
    try {
      const res = await this._controllerRequest('GET', '/proxies');
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        return { ok: true, proxies: data.proxies };
      }
      return { ok: false, error: `获取节点状态失败 HTTP ${res.statusCode}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // --- 内部 HTTP / Controller 请求工具方法 ------------------------------------

  _waitForController(timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = async () => {
        try {
          const res = await this._controllerRequest('GET', '/version');
          if (res.statusCode === 200) {
            return resolve(true);
          }
        } catch (_) {}
        if (Date.now() - start > timeoutMs) {
          return resolve(false);
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  _controllerRequest(method, reqPath, payload = null) {
    return new Promise((resolve, reject) => {
      const dataStr = payload ? JSON.stringify(payload) : '';
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.controllerPort,
        path: reqPath,
        method: method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr)
        },
        timeout: 4000
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Controller request timeout')); });
      if (dataStr) req.write(dataStr);
      req.end();
    });
  }

  _httpGetWithRedirect(urlStr, options = {}, redirectCount = 0) {
    if (redirectCount > 5) {
      return Promise.reject(new Error('Too many redirects (> 5)'));
    }

    return new Promise((resolve, reject) => {
      const urlObj = new URL(urlStr);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(urlStr, options, (res) => {
        // 处理 301 / 302 重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          return resolve(this._httpGetWithRedirect(nextUrl, options, redirectCount + 1));
        }

        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        }));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Subscription request timeout')); });
    });
  }
}

module.exports = {
  MihomoManager,
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_BASE_PROXY_PORT
};

