const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterPack hook
 * Cleans up unnecessary locale files and redundant binaries to slim down the final package.
 */
exports.default = async function (context) {
  const appOutDir = context.appOutDir;
  console.log(`\n[Slimming Hook] Running post-pack optimization on: ${appOutDir}`);

  // 1. Clean up unused language packs in locales/
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    const keepLocales = new Set(['zh-CN.pak', 'en-US.pak', 'zh-TW.pak']);
    const files = fs.readdirSync(localesDir);
    let removedCount = 0;
    let freedBytes = 0;

    for (const file of files) {
      if (file.endsWith('.pak') && !keepLocales.has(file)) {
        const filePath = path.join(localesDir, file);
        try {
          const stat = fs.statSync(filePath);
          freedBytes += stat.size;
          fs.unlinkSync(filePath);
          removedCount++;
        } catch (e) {
          console.warn(`[Slimming Hook] Failed to remove ${file}:`, e.message);
        }
      }
    }

    const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
    console.log(`[Slimming Hook] Cleaned up ${removedCount} unused locale .pak files. Freed approx ${freedMB} MB!`);
  } else {
    console.log('[Slimming Hook] No locales directory found at:', localesDir);
  }

  // 2. Clean up unnecessary files if present (e.g. LICENSE.electron.txt, LICENSES.chromium.html)
  const optionalRemovals = [
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'version'
  ];
  for (const name of optionalRemovals) {
    const p = path.join(appOutDir, name);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        console.log(`[Slimming Hook] Removed ${name}`);
      } catch {}
    }
  }

  console.log('[Slimming Hook] Post-pack optimization complete.\n');
};
