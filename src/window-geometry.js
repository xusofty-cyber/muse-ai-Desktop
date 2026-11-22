// src/window-geometry.js
// 窗口几何: 保证窗口落在可见的显示器区域内, 以及切换账号时同步多屏位置与最大化状态。
// 2026-11-22 main.js 拆分 第 3b 步, 函数体原样迁移。
// 屏幕信息在调用时才从 electron.screen 获取 (需 app ready 之后); 测试时可直接传入 displays / targetDisplay。
'use strict';

const { sanitizeWindowBounds } = require('./state');

// 确保 bounds 与至少一块显示器的可用区有足够交叠; 否则居中兜底。
// displays 可注入 (display.bounds/workArea), preferredDisplay 可指定优先显示器 (如多屏下当前正在操作的副屏)。
function ensureBoundsVisible(bounds, displays, preferredDisplay) {
  const b = sanitizeWindowBounds(bounds);
  let list = displays;
  if (!list) {
    try {
      const scr = require('electron').screen;
      const all = scr.getAllDisplays();
      const primary = scr.getPrimaryDisplay();
      const pref = preferredDisplay || (scr.getDisplayMatching ? scr.getDisplayMatching(b) : primary);
      const prefId = pref && pref.id;
      list = pref ? [pref, ...all.filter((d) => d.id !== prefId)] : (primary ? [primary, ...all.filter((d) => d.id !== primary.id)] : all);
    } catch { list = []; }
  }
  if (!list || !list.length) return b;
  const width = b.width || 1200;
  const height = b.height || 800;
  if (typeof b.x === 'number' && typeof b.y === 'number') {
    const visible = list.some((d) => {
      const wa = (d && (d.workArea || d.bounds)) || null;
      if (!wa) return false;
      const overlapX = Math.min(b.x + width, wa.x + wa.width) - Math.max(b.x, wa.x);
      const overlapY = Math.min(b.y + height, wa.y + wa.height) - Math.max(b.y, wa.y);
      if (overlapX <= 0 || overlapY <= 0) return false;
      // 标题栏 (顶部 40px) 必须落在可用区内, 且交叠面积 >= 窗口的 30%:
      // 只剩一条边在屏内的窗口对用户等于不存在, 不能判为可见
      const titleVisible = (b.y + 40 > wa.y) && (b.y < wa.y + wa.height) && overlapX >= 120;
      const areaRatio = (overlapX * overlapY) / (width * height);
      return titleVisible && areaRatio >= 0.3;
    });
    if (visible) { b.width = width; b.height = height; return b; }
  }
  const wa = (list[0] && (list[0].workArea || list[0].bounds)) || { x: 0, y: 0, width: 1920, height: 1080 };
  b.width = Math.min(width, wa.width);
  b.height = Math.min(height, wa.height);
  b.x = Math.round(wa.x + (wa.width - b.width) / 2);
  b.y = Math.round(wa.y + (wa.height - b.height) / 2);
  return b;
}

// 同步多屏与最大化状态，杜绝跨屏溢出与位置跳跃
function syncWindowStateAndBounds(targetWin, normalBounds, wasMaximized, targetDisplay) {
  if (!targetWin || targetWin.isDestroyed()) return;
  let disp = targetDisplay;
  if (!disp) {
    try {
      const scr = require('electron').screen;
      disp = (normalBounds && scr.getDisplayMatching ? scr.getDisplayMatching(normalBounds) : scr.getPrimaryDisplay());
    } catch { disp = null; }
  }
  const wa = (disp && (disp.workArea || disp.bounds)) || { x: 0, y: 0, width: 1920, height: 1080 };

  if (wasMaximized) {
    // 若原窗口最大化，确保目标窗口先定位在当前屏幕的工作区再最大化，防止多屏下最大化错屏或被设为超出边界的伪尺寸
    if (!targetWin.isMaximized()) {
      try {
        targetWin.setBounds({
          x: wa.x + Math.max(0, Math.round((wa.width - 1200) / 2)),
          y: wa.y + Math.max(0, Math.round((wa.height - 800) / 2)),
          width: Math.min(1200, wa.width),
          height: Math.min(800, wa.height),
        });
      } catch {}
      targetWin.maximize();
    }
  } else {
    // 若原窗口是普通窗口，目标窗口若是最大化先解除最大化
    if (targetWin.isMaximized()) {
      targetWin.unmaximize();
    }
    if (normalBounds) {
      // 严格限制在当前显示器的工作区内，杜绝多屏边界溢出
      const w = Math.min(normalBounds.width || 1200, wa.width);
      const h = Math.min(normalBounds.height || 800, wa.height);
      const x = Math.max(wa.x, Math.min(typeof normalBounds.x === 'number' ? normalBounds.x : wa.x, wa.x + wa.width - w));
      const y = Math.max(wa.y, Math.min(typeof normalBounds.y === 'number' ? normalBounds.y : wa.y, wa.y + wa.height - h));
      try { targetWin.setBounds({ x, y, width: w, height: h }); } catch {}
    }
  }
}

module.exports = { ensureBoundsVisible, syncWindowStateAndBounds };
