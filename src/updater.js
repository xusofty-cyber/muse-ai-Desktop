// src/updater.js
// Windows 便携版的应用内自动更新: 查询 GitHub Releases、流式下载并校验 SHA-256 与 PE 头、
// 重启时由分离的 PowerShell 脚本替换 exe (旧版本保留为 .bak)。
// 2026-11-22 main.js 拆分 第 6 步, 函数体原样迁移。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog, shell, net } = require('electron');

// ---- portable self-update -----------------------------------------------------
// electron-updater doesn't support the portable target, so the portable build
// updates itself: check the GitHub releases feed, download the new portable
// exe in the background, and swap it in on restart via a tiny detached
// PowerShell helper. A .bak of the previous version is kept beside the exe.
const UPDATE_REPO = 'xusofty-cyber/muse-ai-Desktop';

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 应用内自更新只适用于 Windows 便携版: 它替换的是 PORTABLE_EXECUTABLE_FILE
// 指向的单文件。此前无门控三平台都跑, Linux/mac 会下载 Windows exe 再调
// 不存在的 powershell; NSIS 安装版则会被便携版 exe 原地替换造成版本错位。
function isPortableWindowsBuild() {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
}

function buildUpdateScript(currentExe, newExe) {
  const q = (s) => s.replace(/'/g, "''");
  return [
    `$pidToWait = ${process.pid}`,
    `$current = '${q(currentExe)}'`,
    `$new = '${q(newExe)}'`,
    `try { Wait-Process -Id $pidToWait -ErrorAction Stop } catch {}`,
    `try {`,
    `  Copy-Item -LiteralPath $current -Destination ($current + '.bak') -Force`,
    `  Move-Item -LiteralPath $new -Destination $current -Force`,
    `  Start-Process -FilePath $current`,
    `} catch {}`,
  ].join('\r\n');
}

/**
 * @param {Object} deps
 * @param {(title: string, body: string, onClick?: Function) => void} deps.notify 系统通知
 * @param {() => void} deps.buildTrayMenu 更新下载完成后刷新托盘菜单 (出现"重启安装"项)
 */
function createUpdater({ notify, buildTrayMenu }) {
  // 下载完成、等待重启安装的更新 (只在本次运行内有效)
  let pendingUpdate = null;
  let updateDownloaded = false;
  let isCheckingUpdate = false;
  async function checkForUpdates(manual) {
    if (!isPortableWindowsBuild()) {
      if (manual) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: '检查版本更新',
          message: '当前安装方式不支持应用内自动更新。',
          detail: '请前往 GitHub Releases 页面下载与您系统匹配的最新安装包。',
          buttons: ['前往 GitHub Releases', '取消'],
        });
        if (response === 0) shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`);
      }
      return;
    }
    if (isCheckingUpdate) {
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: '检查更新',
          message: '正在检查版本更新，请稍候...',
        });
      }
      return;
    }
    isCheckingUpdate = true;

    try {
      const fetchFunc = (typeof net !== 'undefined' && net.fetch) ? net.fetch : fetch;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetchFunc(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'muse-windows', Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
      // 超时必须覆盖正文读取 (v1.5.16, 评审 P2): 旧实现响应头一到就 clearTimeout,
      // 正文滴流能让检查永久挂起且 isCheckingUpdate 永远为 true, 后续检查全灭
      const rel = await res.json();
      clearTimeout(timeoutId);
      const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
      const current = app.getVersion();

      if (!latest || cmpVersions(latest, current) <= 0) {
        if (manual) {
          dialog.showMessageBox({
            type: 'info',
            title: '检查版本更新',
            message: `当前已是最新版本 (v${current})`,
            detail: '暂无可用更新。',
            buttons: ['确定'],
          });
        }
        return;
      }

      const releaseUrl = rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`;
      const asset = (rel.assets || []).find((a) => /^Muse-Portable-.*\.exe$/i.test(a.name || ''));

      if (manual) {
        const releaseNotes = (rel.body || '').trim();
        const detailMsg = releaseNotes ? `\n\n更新日志：\n${releaseNotes.slice(0, 300)}${releaseNotes.length > 300 ? '...' : ''}` : '';
        const buttons = asset ? ['前往 GitHub 下载', '后台下载便携版', '稍后再说'] : ['前往 GitHub 下载', '稍后再说'];
      
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `发现新版本 v${latest} (当前版本 v${current})`,
          detail: `有可用的新版本发布，建议及时更新。${detailMsg}`,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
        });

        if (response === 0) {
          shell.openExternal(releaseUrl);
          return;
        } else if (response === 1 && asset) {
          // 继续在后台下载便携版
        } else {
          return;
        }
      }

      if (!asset) {
        if (manual) {
          dialog.showMessageBox({
            type: 'warning',
            title: '更新提醒',
            message: `v${latest} 已发布，但未找到便携单文件 (Portable)。`,
            detail: '建议前往 GitHub Releases 页面下载安装包。',
            buttons: ['前往 GitHub', '取消'],
          }).then(({ response }) => {
            if (response === 0) shell.openExternal(releaseUrl);
          });
        }
        return;
      }

      if (pendingUpdate && pendingUpdate.version === latest) {
        if (manual) {
          const { response } = await dialog.showMessageBox({
            type: 'question',
            title: '更新已就绪',
            message: `Muse v${latest} 安装文件已下载完成。`,
            detail: '是否立即重启应用以完成更新？',
            buttons: ['立即重启更新', '稍后手动重启'],
            defaultId: 0,
          });
          if (response === 0) {
            installUpdateAndRestart();
          }
        }
        return;
      }

      notify('正在下载更新', `Muse v${latest} 正在后台下载中...`);
      // 真实性校验前置 (v1.5.14): GitHub API 为每个资产提供 sha256 digest,
      // 缺失一律中止, 绝不进入待安装状态
      const expectedDigest = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('发布资产缺少 SHA-256 摘要, 已中止更新');
      // 流式下载 (v1.5.16, 评审 P2): 旧实现整包读入内存 (低配机峰值约两倍包体)
      // 且只有总时长上限。改为边下边落盘边算哈希, 超时改为 60 秒空闲超时
      // (持续有数据就一直下, 断流一分钟才放弃)
      const dlController = new AbortController();
      const dl = await fetchFunc(asset.browser_download_url, {
        headers: { 'User-Agent': 'muse-windows' },
        signal: dlController.signal,
      });
      if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
      // 文件名只取 basename, 防止资产名中的路径成分越出临时目录
      const dest = path.join(app.getPath('temp'), path.basename(String(asset.name || 'Muse-Portable.exe')));
      const hash = require('crypto').createHash('sha256');
      const outStream = fs.createWriteStream(dest);
      let received = 0;
      let headBuf = Buffer.alloc(0);
      let idleTimer = setTimeout(() => dlController.abort(), 60000);
      try {
        const reader = dl.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => dlController.abort(), 60000);
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (headBuf.length < 2) headBuf = Buffer.concat([headBuf, chunk.subarray(0, 2 - headBuf.length)]);
          hash.update(chunk);
          received += chunk.length;
          if (!outStream.write(chunk)) await new Promise((r) => outStream.once('drain', r));
        }
        clearTimeout(idleTimer);
        await new Promise((resolve, reject) => outStream.end((err) => (err ? reject(err) : resolve())));
      } catch (dlErr) {
        clearTimeout(idleTimer);
        try { outStream.destroy(); } catch {}
        try { fs.unlinkSync(dest); } catch {}
        throw dlErr;
      }
      if (received < 1024 || headBuf[0] !== 0x4d || headBuf[1] !== 0x5a) {
        try { fs.unlinkSync(dest); } catch {}
        throw new Error('下载的文件不是合法的 Windows 可执行程序');
      }
      if (hash.digest('hex') !== expectedDigest) {
        try { fs.unlinkSync(dest); } catch {}
        throw new Error('更新文件 SHA-256 校验不通过, 已中止更新');
      }
      pendingUpdate = { version: latest, filePath: dest };
      updateDownloaded = true;
      buildTrayMenu();

      if (manual) {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: '更新已就绪',
          message: `Muse v${latest} 下载完成！`,
          detail: '是否立即重启应用以完成更新？',
          buttons: ['立即重启', '稍后再说'],
          defaultId: 0,
        });
        if (response === 0) {
          installUpdateAndRestart();
        }
      } else {
        notify('更新已就绪', `Muse v${latest} 已下载完成，点击托盘菜单重启以安装。`, () => installUpdateAndRestart());
      }
    } catch (e) {
      const errMsg = String((e && e.message) || e);
      console.warn('[UpdateCheck] Failed:', errMsg);
      if (manual) {
        dialog.showMessageBox({
          type: 'error',
          title: '检查更新失败',
          message: '无法连接到更新服务器或网络连接超时。',
          detail: `错误详情: ${errMsg}\n\n是否直接前往 GitHub Releases 页面查看并下载最新版本？`,
          buttons: ['前往 GitHub 查看', '取消'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
          }
        });
      }
    } finally {
      isCheckingUpdate = false;
    }
  }


  function canWriteBesideExe() {
    try {
      const probe = path.join(path.dirname(process.execPath), '.muse-write-test');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  function installUpdateAndRestart() {
    if (!pendingUpdate) return;
    if (!isPortableWindowsBuild()) return;
    if (!canWriteBesideExe()) {
      dialog.showMessageBox({
        type: 'warning',
        title: '无法自动替换',
        message: '当前应用程序目录没有写入权限（可能属于只读或安装版目录）。',
        detail: '建议前往 GitHub Releases 页面下载安装包覆盖安装。',
        buttons: ['前往 GitHub', '取消'],
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
        }
      });
      return;
    }
    const scriptPath = path.join(app.getPath('temp'), 'muse-update.ps1');
    try {
      fs.writeFileSync(scriptPath, buildUpdateScript(process.execPath, pendingUpdate.filePath));
    } catch (e) {
      dialog.showErrorBox('更新失败', '无法写入更新执行脚本: ' + String((e && e.message) || e));
      return;
    }
    try {
      const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        detached: true, stdio: 'ignore',
      });
      // 未监听的 error 事件会以异常抛进主进程 (如 powershell 不存在时), 必须接住
      child.on('error', (err) => {
        dialog.showErrorBox('更新失败', String((err && err.message) || err));
      });
      child.unref();
    } catch (e) {
      dialog.showErrorBox('更新失败', String((e && e.message) || e));
      return;
    }
    app.quitting = true;
    app.quit();
  }

  function setupAutoUpdate() {
    // 仅 Windows 便携版有应用内自更新; 其他平台/安装形态不启动后台检查,
    // 手动检查走 checkForUpdates 内的 Releases 页引导。
    if (!isPortableWindowsBuild()) return;
    setTimeout(() => checkForUpdates(false), 30_000);
    setInterval(() => checkForUpdates(false), 6 * 3600_000);
  }

  return {
    checkForUpdates,
    installUpdateAndRestart,
    setupAutoUpdate,
    isUpdateDownloaded: () => updateDownloaded,
  };
}

module.exports = { UPDATE_REPO, cmpVersions, isPortableWindowsBuild, buildUpdateScript, createUpdater };
