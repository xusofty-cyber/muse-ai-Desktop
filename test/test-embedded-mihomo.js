/**
 * test/test-embedded-mihomo.js (2026-11-22 自 scratch/ 移入, 纳入版本库)
 * 运行: npm run test:mihomo  (Test 6 会真实启动一次 Mihomo 内核, 端口在运行时自动挑选空闲的)
 * 针对内嵌 Mihomo 代理引擎与多账号分流功能的自动化验证自测脚本
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const net = require('net');
const yaml = require('js-yaml');
const { MihomoManager, DEFAULT_BASE_PROXY_PORT, DEFAULT_CONTROLLER_PORT } = require('../mihomo-manager');

// 向系统要一个空闲端口 (监听 0 端口由系统分配), 避免与本机已运行的程序冲突 (2026-11-22)
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 找一段连续 count 个都空闲的端口, 返回起始端口
async function getFreePortRange(count) {
  const probe = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await probe(base + i);
    if (ok) return base;
  }
  throw new Error('找不到连续空闲的测试端口');
}

async function runTests() {
  console.log('[Test] Starting Embedded Mihomo proxy engine self-tests...');

  const tmpDir = path.join(__dirname, '.tmp-mihomo-test');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const mm = new MihomoManager({
    dataDir: tmpDir,
    basePort: 18001,
    controllerPort: 19090,
    secret: 'test-secret-1234'
  });

  // ---- Test 1: generateConfig 动态合成与策略组测试 -----------------------------
  console.log('[Test 1] Testing generateConfig and fallback proxy-groups...');
  const mockProxies = [
    { name: 'HK-01', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'test-password-1' },
    { name: 'US-01', type: 'vmess', server: '5.6.7.8', port: 443, uuid: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d', alterId: 0, cipher: 'auto' },
    { name: 'JP-01', type: 'trojan', server: '9.10.11.12', port: 443, password: 'test-password-2' },
  ];

  const mockAccounts = [
    { id: 'acc_1', name: 'Profile 1', proxyQueue: ['HK-01', 'US-01'], proxyStrategy: 'fallback' },
    { id: 'acc_2', name: 'Profile 2', proxyQueue: ['JP-01'], proxyStrategy: 'url-test' },
    { id: 'acc_3', name: 'Profile 3', proxyQueue: [], proxyStrategy: 'fallback' },
  ];

  const { configYaml, configObj, portMap } = mm.generateConfig(mockAccounts, mockProxies);
  assert.strictEqual(typeof configYaml, 'string');
  assert.strictEqual(portMap['acc_1'], 18001);
  assert.strictEqual(portMap['acc_2'], 18002);
  assert.strictEqual(portMap['acc_3'], 18003);

  // 验证 Listeners 绑定
  assert.strictEqual(configObj.listeners.length, 3);
  assert.strictEqual(configObj.listeners[0].port, 18001);
  assert.strictEqual(configObj.listeners[0].listen, '127.0.0.1');
  assert.strictEqual(configObj.listeners[0].proxy, 'muse_group_acc_1');

  // 验证专属策略组 Fallback 及健康检查 URL
  // (2026-11-22 更新: 代码早已改为 https://www.google.com/generate_204, 且非严格模式下专属队列尾部
  //  会追加最多 5 个其他节点作为二级兜底, 无队列账号取前 10 个节点; 原断言与代码不一致)
  const group1 = configObj['proxy-groups'].find(g => g.name === 'muse_group_acc_1');
  assert.ok(group1, 'group_acc_1 exists');
  assert.strictEqual(group1.type, 'fallback');
  assert.strictEqual(group1.url, 'https://www.google.com/generate_204');
  assert.deepStrictEqual(group1.proxies, ['HK-01', 'US-01', 'JP-01'], 'own queue first, then fallback nodes');

  // 验证无队列账号自动回退到全量节点 (前 10 个)
  const group3 = configObj['proxy-groups'].find(g => g.name === 'muse_group_acc_3');
  assert.ok(group3, 'group_acc_3 exists');
  assert.deepStrictEqual(group3.proxies, ['HK-01', 'US-01', 'JP-01']);

  // 验证 Mihomo 只监听本机且控制接口带密钥
  assert.strictEqual(configObj['allow-lan'], false);
  assert.ok(configObj['external-controller'].startsWith('127.0.0.1:'), 'controller bound to localhost');
  assert.strictEqual(configObj.secret, 'test-secret-1234');

  console.log('  ✓ Test 1 PASSED: Config generation and fallback groups verified.');

  // ---- Test 1b: 账号出口端口按 id 固定, 不随排列顺序变化 (2026-11-22 审查 H3) ----
  console.log('[Test 1b] Testing fixed per-account ports across reordering...');
  const fixedPorts = { acc_1: 18001, acc_2: 18002, acc_3: 18003 };
  const pinnedMm = new MihomoManager({
    dataDir: tmpDir,
    basePort: 18001,
    controllerPort: 19090,
    portResolver: (acct) => fixedPorts[acct.id],
  });
  const before = pinnedMm.generateConfig(mockAccounts, mockProxies).portMap;
  const reordered = [mockAccounts[2], mockAccounts[0], mockAccounts[1]];
  const after = pinnedMm.generateConfig(reordered, mockProxies);
  assert.deepStrictEqual(after.portMap, before, 'ports must not change when accounts are reordered');
  const l3 = after.configObj.listeners.find(l => l.proxy === 'muse_group_acc_3');
  assert.strictEqual(l3.port, 18003, 'listener for acc_3 keeps its own port');
  // resolver 给出重复端口时, 后一个账号自动改派到空闲端口, 不允许两个账号共用一个出口
  const dupMm = new MihomoManager({ dataDir: tmpDir, basePort: 18001, controllerPort: 19090, portResolver: () => 18001 });
  const dup = dupMm.generateConfig(mockAccounts, mockProxies).portMap;
  assert.strictEqual(new Set(Object.values(dup)).size, 3, 'no two accounts share a port');
  console.log('  ✓ Test 1b PASSED: Ports are pinned per account id.');

  // ---- Test 1c: 严格出口隔离 (2026-11-22 审查 M2) ---------------------------------
  console.log('[Test 1c] Testing strict isolation mode...');
  let strict = false;
  const strictMm = new MihomoManager({ dataDir: tmpDir, basePort: 18001, controllerPort: 19090, isStrict: () => strict });
  const strictAccounts = [
    { id: 'acc_1', proxyQueue: ['HK-01'] },
    { id: 'acc_2', proxyQueue: ['GONE-NODE'] },
    { id: 'acc_3', proxyQueue: [] },
  ];
  const groupOf = (res, id) => res.configObj['proxy-groups'].find(g => g.name === 'muse_group_' + id).proxies;
  let res = strictMm.generateConfig(strictAccounts, mockProxies);
  assert.deepStrictEqual(groupOf(res, 'acc_1'), ['HK-01', 'US-01', 'JP-01'], 'non-strict: falls back to shared nodes');
  assert.deepStrictEqual(groupOf(res, 'acc_2'), ['HK-01', 'US-01', 'JP-01'], 'non-strict: dead queue -> shared nodes');
  strict = true;
  res = strictMm.generateConfig(strictAccounts, mockProxies);
  assert.deepStrictEqual(groupOf(res, 'acc_1'), ['HK-01'], 'strict: only own nodes');
  assert.deepStrictEqual(groupOf(res, 'acc_2'), ['REJECT'], 'strict: dead queue -> offline, never shared');
  assert.deepStrictEqual(groupOf(res, 'acc_3'), ['HK-01', 'US-01', 'JP-01'], 'strict: account without a queue still uses the shared pool');
  console.log('  ✓ Test 1c PASSED: Strict isolation never shares an exit.');

  // ---- Test 2: Gzip 数据解压缩与订阅解析 -------------------------------------
  console.log('[Test 2] Testing Gzip subscription decompression...');
  const sampleSubscription = `
proxies:
  - name: "Gzip-Node-1"
    type: ss
    server: 1.1.1.1
    port: 1000
  - name: "Gzip-Node-2"
    type: vmess
    server: 2.2.2.2
    port: 2000
`;
  const gzipped = zlib.gzipSync(Buffer.from(sampleSubscription, 'utf8'));
  const decompressed = zlib.gunzipSync(gzipped).toString('utf8');
  const parsed = yaml.load(decompressed);
  assert.strictEqual(parsed.proxies.length, 2);
  assert.strictEqual(parsed.proxies[0].name, 'Gzip-Node-1');
  console.log('  ✓ Test 2 PASSED: Gzip decompression and YAML parsing verified.');

  // ---- Test 3: 端口探针 _isPortInUse -----------------------------------------
  console.log('[Test 3] Testing port probe _isPortInUse...');
  const probePort = await getFreePort();
  const testServer = net.createServer();
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(probePort, '127.0.0.1', resolve);
  });

  const isBusy = await mm._isPortInUse(probePort);
  assert.strictEqual(isBusy, true, `Port ${probePort} should be detected as in use`);

  await new Promise(resolve => testServer.close(resolve));
  const isFree = await mm._isPortInUse(probePort);
  assert.strictEqual(isFree, false, `Port ${probePort} should now be detected as free`);
  console.log('  ✓ Test 3 PASSED: Port probe successfully detected busy and free states.');

  // ---- Test 4: 二进制探测 candidates 包含官方 release 命名 ---------------------
  console.log('[Test 4] Testing executable candidates matching...');
  const foundExe = mm.findExecutable();
  // (2026-11-22 更新: 仓库 bin/mihomo/ 里的内核文件名是 mihomo.exe, 原断言写死了 -amd64-v3 变体)
  const exePattern = process.platform === 'win32' ? /mihomo[^\\/]*\.exe$/i : /mihomo[^\\/]*$/i;
  assert.ok(foundExe && exePattern.test(foundExe), `Expected to find a mihomo kernel binary, got: ${foundExe}`);
  console.log(`  ✓ Test 4 PASSED: Detected executable: ${foundExe}`);

  // ---- Test 5: hotkeys.html 脚本语法与无 XSS 注入校验 ------------------------
  console.log('[Test 5] Verifying hotkeys.html & preload-chat-export DOM safety...');
  const hotkeysHtml = fs.readFileSync(path.join(__dirname, '..', 'hotkeys.html'), 'utf8');
  assert.ok(!hotkeysHtml.includes('}; } } catch (err)'), 'Redundant catch block must be eliminated');
  assert.ok(hotkeysHtml.includes('CONCURRENCY = 6'), 'Concurrency pool must be present');
  assert.ok(!hotkeysHtml.includes('title="${node.name}"'), 'Raw node.name interpolation in HTML title must be eliminated');

  const preloadChat = fs.readFileSync(path.join(__dirname, '..', 'preload-chat-export.js'), 'utf8');
  assert.ok(!preloadChat.includes('tag.innerHTML = `<span>${idx === 0'), 'tag.innerHTML raw nodeName interpolation eliminated');
  console.log('  ✓ Test 5 PASSED: DOM safety and syntax cleanliness verified.');

  // ---- Test 6: 真实 Mihomo 内核进程拉起、API 通信、空节点兼容、日志落盘与退出 ---
  console.log('[Test 6] Live testing mihomo-windows-amd64-v3.exe start, reload, and stop...');
  // 节点端口与控制端口都临时挑空闲的, 不与正在运行的 Muse / Clash 冲突
  const liveBase = await getFreePortRange(4);
  let liveCtrl = await getFreePort();
  while (liveCtrl >= liveBase && liveCtrl < liveBase + 4) liveCtrl = await getFreePort();
  console.log(`  (Test 6 使用端口 ${liveBase}-${liveBase + 3}, 控制端口 ${liveCtrl})`);
  const liveMm = new MihomoManager({
    dataDir: tmpDir,
    basePort: liveBase,
    controllerPort: liveCtrl,
    secret: 'live-test-secret'
  });

  try {
    // 6a. 空代理节点启动测试 (验证 ['DIRECT'] 放进 fallback 组是否被真实内核接受)
    const emptyStartRes = await liveMm.start(mockAccounts, []);
    assert.strictEqual(emptyStartRes.ok, true, `Live Mihomo start with empty proxies failed: ${emptyStartRes.error}`);
    assert.strictEqual(liveMm.isRunning, true);

    // 验证 /version 接口响应
    const verRes = await liveMm._controllerRequest('GET', '/version');
    assert.strictEqual(verRes.statusCode, 200);
    const verJson = JSON.parse(verRes.body);
    assert.ok(verJson.version, 'Controller /version returned version string');
    console.log(`  ✓ Test 6a PASSED: Live kernel booted (version: ${verJson.version}) even with empty proxy list.`);

    // 6b. 热重载带节点配置 + 动态新增第 4 个账号验证 listener 端口动态绑定
    const updatedAccounts = [
      ...mockAccounts,
      { id: 'acc_4', name: 'Profile 4', proxyQueue: ['US-01'], proxyStrategy: 'fallback' }
    ];
    const reloadRes = await liveMm.reload(updatedAccounts, mockProxies);
    assert.strictEqual(reloadRes.ok, true, `Live reload failed: ${reloadRes.error}`);
    assert.strictEqual(reloadRes.portMap['acc_4'], liveBase + 3);

    // 验证 /proxies 是否成功加载
    const proxiesRes = await liveMm.getProxiesStatus();
    assert.strictEqual(proxiesRes.ok, true);
    assert.ok(proxiesRes.proxies['muse_group_acc_1'], 'muse_group_acc_1 loaded in live kernel');
    assert.ok(proxiesRes.proxies['muse_group_acc_4'], 'muse_group_acc_4 loaded in live kernel');

    // 验证热重载后新增的第 4 个 listener 端口是否真实处于监听状态
    await new Promise(r => setTimeout(r, 200));
    const port4Listening = await liveMm._isPortInUse(liveBase + 3);
    assert.strictEqual(port4Listening, true, `Dynamic listener port ${liveBase + 3} must be actively listening after reload`);
    console.log(`  ✓ Test 6b PASSED: Hot-reload with mockProxies & dynamic listener port ${liveBase + 3} succeeded.`);

    // 验证 mihomo.log 已真实落盘
    const logPath = path.join(tmpDir, 'mihomo.log');
    assert.ok(fs.existsSync(logPath), 'mihomo.log must exist');
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('Mihomo Process Starting'), 'mihomo.log contains startup marker');
    console.log('  ✓ Test 6c PASSED: mihomo.log real-time disk logging verified.');
  } finally {
    liveMm.stop();
    // 等待文件句柄释放后清理临时目录
    await new Promise(r => setTimeout(r, 300));
  }

  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n[SUCCESS] All Embedded Mihomo self-tests (1, 1b, 1c, 2-6) PASSED successfully!');
}

runTests().catch(err => {
  console.error('[FAIL] Test failed:', err);
  process.exit(1);
});

