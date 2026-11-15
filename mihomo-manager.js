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
const zlib = require('zlib');
const net = require('net');
const yaml = require('js-yaml');

const DEFAULT_CONTROLLER_PORT = 19090;
const DEFAULT_BASE_PROXY_PORT = 18001;
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
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
    const opts = typeof options === 'string' ? { dataDir: options } : (options || {});
    this.dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), '.mihomo-runtime'));
    this.binPath = opts.binPath || '';
    this.basePort = opts.basePort || DEFAULT_BASE_PROXY_PORT;
    this.controllerPort = opts.controllerPort || DEFAULT_CONTROLLER_PORT;
    this.secret = opts.secret || crypto.randomBytes(16).toString('hex');

    this.process = null;
    this.logStream = null;
    this.isRunning = false;
    this.cachedProxies = [];
    this.portMap = {}; // { [profileId]: port }
    this.lastError = null;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const sourcesDir = path.join(this.dataDir, 'sources');
    if (!fs.existsSync(sourcesDir)) {
      fs.mkdirSync(sourcesDir, { recursive: true });
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
    const exeNames = isWin
      ? [
          'mihomo.exe',
          'mihomo-windows-amd64.exe',
          'mihomo-windows-amd64-v3.exe',
          'mihomo-windows-amd64-v2.exe',
          'mihomo-windows-amd64-v1.exe',
          'mihomo-windows-amd64-compatible.exe',
          'mihomo-windows-arm64.exe'
        ]
      : [
          'mihomo',
          'mihomo-linux-amd64',
          'mihomo-linux-amd64-v3',
          'mihomo-linux-arm64',
          'mihomo-darwin-universal',
          'mihomo-darwin-arm64'
        ];

    // 处理 Electron asar 打包后的 unpacked 目录优先权 (asar 内不可 spawn 执行)
    const unpackedBase = __dirname.includes('app.asar')
      ? __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1')
      : null;

    const searchDirs = [
      ...(unpackedBase ? [path.join(unpackedBase, 'bin', 'mihomo'), path.join(unpackedBase, 'bin')] : []),
      path.join(__dirname, 'bin', 'mihomo'),
      path.join(__dirname, 'bin'),
      this.dataDir,
      path.join(this.dataDir, '..', 'bin', 'mihomo'),
      path.join(this.dataDir, '..', 'bin'),
      path.join(this.dataDir, '..', 'mihomo'),
      ...(process.resourcesPath ? [path.join(process.resourcesPath, 'bin', 'mihomo'), path.join(process.resourcesPath, 'bin')] : []),
    ];

    // 1. 精确文件名优先级探测
    for (const dir of searchDirs) {
      for (const name of exeNames) {
        candidates.push(path.join(dir, name));
      }
    }

    // 2. 动态通配扫描目录内的任意 mihomo 官方命名变体 (如 v3/alpha/compatible 等)
    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (isWin) {
            if (/^mihomo.*\.exe$/i.test(f)) candidates.push(path.join(dir, f));
          } else {
            if (/^mihomo/i.test(f) && !/\.(gitkeep|log|ya?ml|json|txt|db|mmdb|dat|gz|zip|tar)$/i.test(f)) {
              candidates.push(path.join(dir, f));
            }
          }
        }
      } catch (_) {}
    }

    // 3. 常见系统安装路径
    if (!isWin) {
      candidates.push('/usr/bin/verge-mihomo');
      candidates.push('/usr/local/bin/mihomo');
      candidates.push('/usr/bin/mihomo');
    }

    for (const c of candidates) {
      try {
        // 避免返回 app.asar 内部的虚拟路径 (无法 spawn)
        if (c.includes('app.asar') && !c.includes('app.asar.unpacked')) continue;
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          fs.accessSync(c, fs.constants.X_OK);
          return c;
        }
      } catch (_) {}
    }

    // 4. 从系统 PATH 中查找
    try {
      const cmd = isWin ? 'where mihomo' : 'which mihomo';
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      const firstLine = out.split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch (_) {}

    return null;
  }

  /**
   * 解析本地 Clash / Mihomo YAML 文件并提取 proxies 节点
   * @param {string} filePath 本地 YAML 文件绝对路径
   * @returns {{ ok: boolean, proxies?: Array, nodeCount?: number, rawYaml?: string, error?: string }}
   */
  parseLocalYaml(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: '未提供有效的本地文件路径' };
    }
    const cleanPath = path.resolve(filePath.trim());
    if (!fs.existsSync(cleanPath)) {
      return { ok: false, error: `本地 YAML 文件不存在: ${cleanPath}` };
    }

    try {
      const rawYaml = fs.readFileSync(cleanPath, 'utf8');
      let parsed = null;
      try {
        parsed = yaml.load(rawYaml);
      } catch (e) {
        return { ok: false, error: `YAML 解析语法错误: ${e.message}` };
      }

      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.proxies)) {
        return { ok: false, error: '本地 YAML 文件中未找到合法的 proxies 节点数组' };
      }

      const proxies = parsed.proxies.filter(p => p && typeof p === 'object' && p.name && p.type);
      return {
        ok: true,
        proxies,
        nodeCount: proxies.length,
        rawYaml
      };
    } catch (err) {
      return { ok: false, error: `读取本地 YAML 失败: ${err.message}` };
    }
  }

  /**
   * 拉取机场订阅并解析其中的代理节点
   * @param {string} subUrl 订阅 URL
   * @param {string} [sourceId] 订阅源唯一标识 (用于独立落盘缓存)
   * @returns {Promise<{ ok: boolean, proxies?: Array, rawYaml?: string, error?: string, subInfo?: Object }>}
   */
  async fetchSubscription(subUrl, sourceId = null) {
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

      // 持久化缓存订阅 (包含旧兼容路径和独立 sourceId 路径)
      const cachePath = path.join(this.dataDir, 'subscription.yaml');
      fs.writeFileSync(cachePath, rawYaml, 'utf8');

      if (sourceId && typeof sourceId === 'string') {
        const sourceFile = path.join(this.dataDir, 'sources', `${sourceId}.yaml`);
        fs.writeFileSync(sourceFile, rawYaml, 'utf8');
      }

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
   * 将多个订阅源及本地 YAML 源的节点进行聚合与防冲突合并
   * @param {Array<Object>} sources 源列表 [{ id, type, name, target, enabled, cachedProxies }]
   * @returns {Array<Object>} 合并后的全量代理节点列表
   */
  mergeSourceProxies(sources = []) {
    const activeSources = (Array.isArray(sources) ? sources : []).filter(s => s && s.enabled !== false);
    if (activeSources.length === 0) {
      this.cachedProxies = [];
      return [];
    }

    const merged = [];
    const seenNames = new Set();
    const isMultiSource = activeSources.length > 1;

    for (const src of activeSources) {
      let list = Array.isArray(src.cachedProxies) ? src.cachedProxies : [];
      // 若内存中暂无缓存节点，尝试从磁盘加载
      if (list.length === 0) {
        if (src.type === 'file' && src.target) {
          const parsed = this.parseLocalYaml(src.target);
          if (parsed.ok && parsed.proxies) {
            list = parsed.proxies;
            src.cachedProxies = list;
            src.nodeCount = list.length;
          }
        } else if (src.type === 'url') {
          const subFile = path.join(this.dataDir, 'sources', `${src.id}.yaml`);
          if (fs.existsSync(subFile)) {
            try {
              const content = fs.readFileSync(subFile, 'utf8');
              const obj = yaml.load(content);
              if (obj && Array.isArray(obj.proxies)) {
                list = obj.proxies.filter(p => p && p.name && p.type);
                src.cachedProxies = list;
                src.nodeCount = list.length;
              }
            } catch (_) {}
          }
        }
      }

      const srcTag = (src.name || (src.type === 'file' ? '本地' : '订阅')).trim();
      for (const p of list) {
        if (!p || typeof p !== 'object' || !p.name || !p.type) continue;
        let finalName = p.name;
        // 若重名，添加源标签进行隔离区分，确保 Mihomo 节点名称全局唯一
        if (seenNames.has(finalName)) {
          finalName = `[${srcTag}] ${p.name}`;
          let counter = 2;
          while (seenNames.has(finalName)) {
            finalName = `[${srcTag}] ${p.name} (${counter++})`;
          }
        }
        seenNames.add(finalName);
        merged.push({ ...p, name: finalName });
      }
    }

    this.cachedProxies = merged;
    return merged;
  }

  /**
   * 读取本地缓存的订阅与节点列表
   * @param {Array<Object>} [sources] 传入源列表时合并全部已启用源
   */
  loadCachedSubscription(sources = null) {
    if (Array.isArray(sources) && sources.length > 0) {
      return this.mergeSourceProxies(sources);
    }

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
   * 规范化代理节点属性，规避内核兼容性缺陷
   * @param {Object} p 节点对象
   * @returns {Object} 规范化后的节点
   */
  _sanitizeProxyNode(p) {
    if (!p || typeof p !== 'object') return p;
    const clean = { ...p };
    // 规范化 uTLS 浏览器指纹：Mihomo 中 fingerprint 专用于 TLS 证书固定 (hex sha256)
    // 模拟浏览器 TLS ClientHello 必须配置为 client-fingerprint。旧版 Clash 订阅常见 fingerprint: chrome/safari
    const browserFingerprints = ['chrome', 'firefox', 'safari', 'ios', 'edge', 'random', 'randomized', '360', 'qq', 'android'];
    if (clean.fingerprint && typeof clean.fingerprint === 'string') {
      const fpLower = clean.fingerprint.trim().toLowerCase();
      if (browserFingerprints.includes(fpLower)) {
        if (!clean['client-fingerprint']) {
          clean['client-fingerprint'] = fpLower;
        }
        delete clean.fingerprint;
      }
    }
    return clean;
  }

  /**
   * 生成 Mihomo 专属合成配置
   * @param {Array<Object>} accounts 账号列表 [{ id, name, proxyQueue, proxyStrategy }]
   * @param {Array<Object>} [proxies] 节点列表 (留空则用 cachedProxies)
   * @returns {{ configYaml: string, configObj: Object, portMap: Object }}
   */
  generateConfig(accounts = [], proxies = null) {
    const rawList = Array.isArray(proxies) && proxies.length > 0 ? proxies : this.cachedProxies;
    const proxyList = rawList.map(p => this._sanitizeProxyNode(p));
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
        listen: '127.0.0.1',
        proxy: groupName
      });

      // 提取该账号配置的节点队列
      const rawQueue = Array.isArray(acct.proxyQueue) ? acct.proxyQueue : [];
      const validNodes = rawQueue.filter(n => availableNames.has(n));

      // 若未指定或节点失效，兜底使用全量节点中的前若干个，或使用 DIRECT
      let finalNodes = [];
      if (validNodes.length > 0) {
        finalNodes = [...validNodes];
        // 关键兜底防雪崩：如果账号配置的专属队列（如大阪节点服务器临时宕机/超时），
        // 在 fallback 队列尾部自动追加全局其他可用节点作为二级兜底，防止全部节点宕机导致直接连接重置 (-100)
        const backupNodes = proxyList.map(p => p.name).filter(n => !validNodes.includes(n));
        if (backupNodes.length > 0) {
          finalNodes.push(...backupNodes.slice(0, 5));
        }
      } else {
        finalNodes = proxyList.length > 0 ? proxyList.slice(0, 10).map(p => p.name) : ['DIRECT'];
      }

      proxyGroups.push({
        name: groupName,
        type: acct.proxyStrategy || 'fallback',
        url: 'https://www.google.com/generate_204',
        interval: 60,
        lazy: false,
        timeout: 2500,
        'max-failed-times': 1,
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
      dns: {
        enable: true,
        listen: '127.0.0.1:0',
        ipv6: false,
        'enhanced-mode': 'redir-host',
        nameserver: [
          '223.5.5.5',
          '119.29.29.29',
          'https://doh.pub/dns-query'
        ],
        fallback: [
          'https://1.1.1.1/dns-query',
          'https://dns.google/dns-query',
          '8.8.8.8'
        ]
      },
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

    // 启动前探针: 检测 Controller 端口是否已被旧残留进程霸占
    let ctrlBusy = await this._isPortInUse(this.controllerPort);
    if (ctrlBusy) {
      console.warn(`[MihomoCore] Controller port ${this.controllerPort} is already in use, clearing orphaned process...`);
      try {
        if (process.platform === 'win32') {
          const exeName = path.basename(exe);
          execSync(`taskkill /F /IM "${exeName}"`, { stdio: 'ignore' });
        }
        await new Promise((r) => setTimeout(r, 400));
        ctrlBusy = await this._isPortInUse(this.controllerPort);
      } catch (_) {}
    }

    const { configYaml, portMap } = this.generateConfig(accounts, proxies);
    const configFile = path.join(this.dataDir, 'config.yaml');
    fs.writeFileSync(configFile, configYaml, 'utf8');

    try {
      const logFile = path.join(this.dataDir, 'mihomo.log');
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      this.logStream = logStream;
      logStream.write(`\n=== [${new Date().toISOString()}] Mihomo Process Starting ===\n`);

      const child = spawn(exe, ['-d', this.dataDir, '-f', configFile], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.process = child;
      this.isRunning = true;
      this.lastError = null;

      child.stdout.on('data', (d) => {
        if (this.logStream) this.logStream.write(d);
        const msg = d.toString();
        if (msg.includes('level=error') || msg.includes('level=fatal')) {
          console.error('[MihomoCore STDOUT]', msg.trim());
        }
      });

      child.stderr.on('data', (d) => {
        if (this.logStream) this.logStream.write(d);
        console.warn('[MihomoCore STDERR]', d.toString().trim());
      });

      child.on('exit', (code, sig) => {
        if (this.logStream) this.logStream.write(`[MihomoCore] Exited with code=${code}, signal=${sig}\n`);
        console.log(`[MihomoCore] Exited with code=${code}, signal=${sig}`);
        this.isRunning = false;
        this.process = null;
      });

      child.on('error', (err) => {
        if (this.logStream) this.logStream.write(`[MihomoCore] Error: ${err.message}\n`);
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
      const pid = this.process.pid;
      try {
        this.process.kill('SIGTERM');
      } catch (_) {
        try { this.process.kill('SIGKILL'); } catch (__) {}
      }
      if (process.platform === 'win32' && pid) {
        try {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
        } catch (_) {}
      }
      this.process = null;
    }
    if (this.logStream) {
      try { this.logStream.end(); } catch (_) {}
      this.logStream = null;
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
        // 若子进程已经退出或崩溃，不再空等直接失败退出
        if (!this.process || !this.isRunning) {
          return resolve(false);
        }
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

  _isPortInUse(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err) => {
        resolve(err.code === 'EADDRINUSE');
      });
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '127.0.0.1');
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
        timeout: 6000
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
          try { res.resume(); } catch (_) {} // 显式消耗流，释放底层 Socket 句柄防泄漏
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          return resolve(this._httpGetWithRedirect(nextUrl, options, redirectCount + 1));
        }

        const chunks = [];
        res.on('data', chunk => { chunks.push(chunk); });
        res.on('end', () => {
          try {
            let buffer = Buffer.concat(chunks);
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            if (encoding.includes('gzip')) {
              buffer = zlib.gunzipSync(buffer);
            } else if (encoding.includes('deflate')) {
              buffer = zlib.inflateSync(buffer);
            }
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: buffer.toString('utf8')
            });
          } catch (decodeErr) {
            reject(new Error(`订阅数据解压缩或解码失败: ${decodeErr.message}`));
          }
        });
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

