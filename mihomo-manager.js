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
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204'; // 审查 L1: 测速改用 https
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // 审查 H2: 源 id 会拼进文件路径, 必须是安全字符
const MAX_SUB_BYTES = 20 * 1024 * 1024; // 审查 L1: 订阅下载体积上限
const MAX_SUB_DECODED_BYTES = 50 * 1024 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 审查 L2: 日志超过 5MB 时轮转
const SUB_USER_AGENT = 'clash-verge/v1.7.7 (Clash.Meta)';

class MihomoManager {
  /**
   * @param {Object} options
   * @param {string} options.dataDir 运行数据与配置文件存储目录
   * @param {string} [options.binPath] 自定义内核路径
   * @param {number} [options.basePort] 起始监听端口 (默认 18001)
   * @param {number} [options.controllerPort] External Controller 端口 (默认 19090)
   * @param {string} [options.secret] Controller Secret (留空自动生成)
   * @param {(acct: Object) => number} [options.portResolver] 返回账号的固定出口端口 (审查 H3)
   * @param {(id: string, newPort: number, oldPort: number) => void} [options.onPortReassigned] 端口被占用改派后回调 (审查 M4)
   * @param {() => boolean} [options.isStrict] 是否严格隔离: 专属节点全挂时不回落到公共节点 (审查 M2)
   * @param {(info: {code: number, signal: string}) => void} [options.onUnexpectedExit] 内核意外退出回调 (审查 M3)
   */
  constructor(options = {}) {
    const opts = typeof options === 'string' ? { dataDir: options } : (options || {});
    this.dataDir = path.resolve(opts.dataDir || path.join(process.cwd(), '.mihomo-runtime'));
    this.binPath = opts.binPath || '';
    this.basePort = opts.basePort || DEFAULT_BASE_PROXY_PORT;
    this.controllerPort = opts.controllerPort || DEFAULT_CONTROLLER_PORT;
    this.secret = opts.secret || crypto.randomBytes(16).toString('hex');

    this.portResolver = typeof opts.portResolver === 'function' ? opts.portResolver : null;
    this.onPortReassigned = typeof opts.onPortReassigned === 'function' ? opts.onPortReassigned : null;
    this.isStrict = typeof opts.isStrict === 'function' ? opts.isStrict : () => false;
    this.onUnexpectedExit = typeof opts.onUnexpectedExit === 'function' ? opts.onUnexpectedExit : null;
    this._stopping = false;

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

    // 便携版实际启动目录 (PORTABLE_EXECUTABLE_DIR) 与可执行文件所在目录 (开发与打包态兼容)
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;
    const execDir = process.execPath ? path.dirname(process.execPath) : null;
    const cwd = process.cwd();

    const searchDirs = [
      ...(unpackedBase ? [path.join(unpackedBase, 'bin', 'mihomo'), path.join(unpackedBase, 'bin')] : []),
      // 便携版真实工作目录（用户放置 Muse.exe 的目录及其子目录）
      ...(portableDir ? [
        path.join(portableDir, 'bin', 'mihomo'),
        path.join(portableDir, 'mihomo'),
        path.join(portableDir, 'bin'),
        portableDir,
        path.join(portableDir, '..', 'bin', 'mihomo'),
        path.join(portableDir, '..', 'mihomo'),
      ] : []),
      // 主程序 EXE 所在目录（安装版或绿色解压版）
      ...(execDir ? [
        path.join(execDir, 'bin', 'mihomo'),
        path.join(execDir, 'mihomo'),
        path.join(execDir, 'bin'),
        execDir,
        path.join(execDir, '..', 'bin', 'mihomo'),
        path.join(execDir, '..', 'mihomo'),
      ] : []),
      path.join(__dirname, 'bin', 'mihomo'),
      path.join(__dirname, 'bin'),
      path.join(cwd, 'bin', 'mihomo'),
      path.join(cwd, 'mihomo'),
      path.join(cwd, 'bin'),
      cwd,
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

      if (sourceId && typeof sourceId === 'string' && SAFE_ID_RE.test(sourceId)) {
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
        } else if (src.type === 'url' && SAFE_ID_RE.test(String(src.id || ''))) {
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
    const usedPorts = new Set();
    const strict = !!this.isStrict();

    // 为每个账号建立专属 Listener 和 Proxy Group
    for (const acct of accounts) {
      if (!acct || !acct.id) continue;
      // 端口按账号固定 (审查 H3): 此前按排列顺序递增分配, 账号重新排序后端口跟着变,
      // 未重新应用代理的账号会连到别人的出口。无 resolver 时保留旧的顺序分配作为兼容。
      let port = this.portResolver ? this.portResolver(acct) : null;
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || usedPorts.has(port)) {
        while (usedPorts.has(currentPort) || currentPort === this.controllerPort) currentPort++;
        port = currentPort++;
      }
      usedPorts.add(port);
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
      }
      if (validNodes.length > 0 && strict) {
        // 严格隔离 (审查 M2): 只用账号专属节点, 全挂时断网而不是和别的账号共用出口
      } else if (validNodes.length > 0) {
        // 关键兜底防雪崩：如果账号配置的专属队列（如大阪节点服务器临时宕机/超时），
        // 在 fallback 队列尾部自动追加全局其他可用节点作为二级兜底，防止全部节点宕机导致直接连接重置 (-100)
        const backupNodes = proxyList.map(p => p.name).filter(n => !validNodes.includes(n));
        if (backupNodes.length > 0) {
          finalNodes.push(...backupNodes.slice(0, 5));
        }
      } else if (strict && rawQueue.length > 0) {
        // 严格隔离下配置过专属队列但节点已全部失效: 拒绝连接, 不悄悄换成公共节点
        finalNodes = ['REJECT'];
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
      'geo-auto-update': false,
      dns: {
        enable: true,
        listen: '127.0.0.1:0',
        ipv6: false,
        'enhanced-mode': 'redir-host',
        nameserver: [
          '223.5.5.5',
          '119.29.29.29',
          'https://doh.pub/dns-query',
          'https://1.1.1.1/dns-query',
          'https://dns.google/dns-query'
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

    this._stopping = false;
    const assignedPorts = new Set(
      (accounts || []).filter((a) => a && a.id && this.portResolver).map((a) => this.portResolver(a)).filter(Number.isInteger)
    );

    // 启动前探针: 检测 Controller 端口是否已被旧残留进程霸占
    // 审查 M1: 此前按进程名 taskkill /IM 强杀, 会误杀用户另外运行的 Mihomo / Clash。
    // 现在只结束本应用记录在 pid 文件里的上次残留进程; 仍被占用说明是别的程序, 改用空闲控制端口。
    let ctrlBusy = await this._isPortInUse(this.controllerPort);
    if (ctrlBusy) {
      console.warn(`[MihomoCore] Controller port ${this.controllerPort} is already in use, checking for our own orphaned process...`);
      if (this._killOwnOrphan(exe)) {
        await new Promise((r) => setTimeout(r, 400));
        ctrlBusy = await this._isPortInUse(this.controllerPort);
      }
      if (ctrlBusy) {
        let p = this.controllerPort + 1;
        while (assignedPorts.has(p) || await this._isPortInUse(p)) p++;
        console.warn(`[MihomoCore] Controller port ${this.controllerPort} is held by another program, using ${p} instead`);
        this.controllerPort = p;
      }
    }

    // 审查 M4: 账号出口端口被其他程序占用时改派到空闲端口, 并通知主进程持久化
    const reassignedPorts = [];
    if (this.portResolver) {
      const taken = new Set();
      for (const acct of accounts || []) {
        if (!acct || !acct.id) continue;
        const port = this.portResolver(acct);
        if (!Number.isInteger(port)) continue;
        if (taken.has(port) || await this._isPortInUse(port)) {
          let next = port + 1;
          while (taken.has(next) || assignedPorts.has(next) || next === this.controllerPort || await this._isPortInUse(next)) next++;
          assignedPorts.add(next);
          reassignedPorts.push({ id: acct.id, from: port, to: next });
          if (this.onPortReassigned) {
            try { this.onPortReassigned(acct.id, next, port); } catch (_) {}
          }
          taken.add(next);
        } else {
          taken.add(port);
        }
      }
    }

    const { configYaml, portMap } = this.generateConfig(accounts, proxies);
    const configFile = path.join(this.dataDir, 'config.yaml');
    fs.writeFileSync(configFile, configYaml, 'utf8');

    try {
      const logFile = path.join(this.dataDir, 'mihomo.log');
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
          const rotated = `${logFile}.1`;
          try { fs.unlinkSync(rotated); } catch (_) {}
          fs.renameSync(logFile, rotated);
        }
      } catch (_) {}
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
      try { if (child.pid) fs.writeFileSync(this._pidFile(), String(child.pid), 'utf8'); } catch (_) {}

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
        // 只处理当前进程: restart 时旧进程的 exit 晚于新进程启动, 不能把新进程的状态清掉
        if (this.process !== child) return;
        this.isRunning = false;
        this.process = null;
        try { fs.unlinkSync(this._pidFile()); } catch (_) {}
        if (!this._stopping && this.onUnexpectedExit) {
          try { this.onUnexpectedExit({ code, signal: sig }); } catch (_) {}
        }
      });

      child.on('error', (err) => {
        if (this.logStream) this.logStream.write(`[MihomoCore] Error: ${err.message}\n`);
        console.error('[MihomoCore] Process error:', err);
        this.lastError = err.message;
        if (this.process !== child) return;
        this.isRunning = false;
        this.process = null;
      });

      // 轮询等待 External Controller 就绪 (最多等 8 秒)
      const ready = await this._waitForController(8000);
      if (!ready) {
        this.stop();
        return { ok: false, error: 'Mihomo 启动超时或 External Controller 端口连接失败' };
      }

      console.log(`[MihomoCore] Started successfully. Controller on 127.0.0.1:${this.controllerPort}, Ports:`, portMap);
      return { ok: true, portMap, reassignedPorts, controllerPort: this.controllerPort };
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
    this._stopping = true;
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
      try { fs.unlinkSync(this._pidFile()); } catch (_) {}
    }
    if (this.logStream) {
      try { this.logStream.end(); } catch (_) {}
      this.logStream = null;
    }
    this.isRunning = false;
    console.log('[MihomoCore] Stopped.');
  }

  /**
   * 重启 Mihomo 内核进程
   * @param {Array<Object>} accounts 账号列表
   * @param {Array<Object>} [proxies] 节点列表
   */
  async restart(accounts = [], proxies = null) {
    this.stop();
    await new Promise((r) => setTimeout(r, 600));
    return this.start(accounts, proxies);
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

  _pidFile() {
    return path.join(this.dataDir, 'mihomo.pid');
  }

  /** 只结束本应用上次启动、记录在 pid 文件里的残留内核进程 (审查 M1) */
  _killOwnOrphan(exe) {
    let pid = null;
    try { pid = parseInt(fs.readFileSync(this._pidFile(), 'utf8').trim(), 10); } catch (_) { return false; }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      if (process.platform === 'win32') {
        // 核对该 pid 当前确实是同名内核, 防止 pid 已被系统复用给别的程序
        const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (!out.toLowerCase().includes(path.basename(exe).toLowerCase())) return false;
        execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
      } else {
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) {
          try { cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }); } catch (__) { return false; }
        }
        if (!cmd.includes(this.dataDir)) return false;
        process.kill(pid, 'SIGKILL');
      }
      try { fs.unlinkSync(this._pidFile()); } catch (_) {}
      console.warn(`[MihomoCore] Killed own orphaned kernel process pid=${pid}`);
      return true;
    } catch (_) {
      return false;
    }
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
          // 审查 L1: 不允许从 https 降级跳转到 http (订阅地址里的 token 会明文传输)
          if (isHttps && !/^https:/i.test(nextUrl)) {
            return reject(new Error('订阅地址试图从 HTTPS 跳转到不安全的 HTTP，已拒绝'));
          }
          return resolve(this._httpGetWithRedirect(nextUrl, options, redirectCount + 1));
        }

        const declared = parseInt(res.headers['content-length'], 10);
        if (Number.isFinite(declared) && declared > MAX_SUB_BYTES) {
          req.destroy(new Error('订阅内容超过 20MB 上限'));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_SUB_BYTES) {
            req.destroy(new Error('订阅内容超过 20MB 上限'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            let buffer = Buffer.concat(chunks);
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            if (encoding.includes('gzip')) {
              buffer = zlib.gunzipSync(buffer, { maxOutputLength: MAX_SUB_DECODED_BYTES });
            } else if (encoding.includes('deflate')) {
              buffer = zlib.inflateSync(buffer, { maxOutputLength: MAX_SUB_DECODED_BYTES });
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

