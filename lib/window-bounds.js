// Pure window-bounds helpers, extracted from main.js (pilot P1).
// No Electron dependency: ensureBoundsVisible only touches
// require('electron').screen when no displays list is injected,
// so tests always inject displays and never need Electron.

// ---- 窗口几何安全 (Ubuntu 多账号窗口唤不回根治) --------------------------------
// 背景: 全部账号共用一份 state.window 且从不校验, 多窗口 resize/move 竞写、
// 最小化/隐藏瞬间或虚拟机分辨率变化都可能把屏幕外坐标/异常尺寸持久化,
// 之后 showMainWindow 只做 show/focus, 窗口逻辑上已显示、物理上永不可见。
// 因此: 加载时钳制 -> 落盘时过滤 -> 显示前按当前屏幕二次校验并居中兜底。
const MIN_WIN_WIDTH = 800;
const MIN_WIN_HEIGHT = 560;

function sanitizeWindowBounds(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const w = Number(raw.width);
  const h = Number(raw.height);
  if (Number.isFinite(w)) out.width = Math.min(Math.max(Math.round(w), MIN_WIN_WIDTH), 7680);
  if (Number.isFinite(h)) out.height = Math.min(Math.max(Math.round(h), MIN_WIN_HEIGHT), 4320);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (Number.isFinite(x) && Math.abs(x) < 20000) out.x = Math.round(x);
  if (Number.isFinite(y) && Math.abs(y) < 20000) out.y = Math.round(y);
  return out;
}

// 确保 bounds 与至少一块显示器的可用区有足够交叠; 否则居中到主屏。
// displays 可注入 (display.bounds/workArea), 缺省实时读取 screen。
function ensureBoundsVisible(bounds, displays) {
  const b = sanitizeWindowBounds(bounds);
  let list = displays;
  if (!list) {
    try {
      const scr = require('electron').screen;
      const all = scr.getAllDisplays();
      const primary = scr.getPrimaryDisplay();
      // getAllDisplays()[0] 不保证是主屏; 居中兜底必须以主屏为基准并排在首位
      list = primary ? [primary, ...all.filter((d) => d.id !== primary.id)] : all;
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

module.exports = { sanitizeWindowBounds, ensureBoundsVisible };
