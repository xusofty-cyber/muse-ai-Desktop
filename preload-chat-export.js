// Runs in an isolated world with full DOM access. Exposes a single chat
// scraper to the main process via contextBridge, plus a small floating
// "Export chat" button that asks the main process to run the export.
// It never touches the network and never modifies the page content,
// except for the floating button and a brief scroll used to coax
// paginated history into the DOM (restored afterwards).
const { contextBridge, ipcRenderer } = require('electron');

// 桥暴露最小化 (v1.5.14, 评审 P0-3): offlineAPI 只供本地离线页 (file://)
// 使用; 远程页面 (muse.ai/meta.ai 及其子 frame) 零暴露, 页面主世界脚本
// 不应能触达任何应用控制通道。
if (window.location && window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('offlineAPI', {
    selfHealToSystem: () => ipcRenderer.invoke('proxy-set', { mode: 'system', enabled: false }),
    openProxySettings: () => ipcRenderer.invoke('open-settings', 'tab-proxy'),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Theme & AutoHide Engine (Dark / Light + Corner Auto-Fade) --------------
let currentTheme = 'dark';
let currentLocale = 'en';
let uiSettings = { autoHideButtons: true };

const I18N_RENDERER = {
  en: {
    expandDock: 'Expand accounts dock',
    collapseDock: 'Collapse accounts dock',
    pinDock: 'Pin dock (Keep open)',
    unpinDock: 'Unpin dock (Auto-collapse on leave)',
    myAccount: 'My account',
    currentAccountBadge: 'Current',
    clickToSwitch: 'Click to switch (Drag to reorder)',
    addAccountPromptTitle: 'Add New Account',
    addAccountPlaceholder: 'Enter profile nickname...',
    addAccountDefaultName: (n) => `Account ${n}`,
    addAccountTooltip: 'Add new account (multi-session)',
    themeLightTooltip: 'Current: Light mode (Click to switch to Dark mode)',
    themeDarkTooltip: 'Current: Dark mode (Click to switch to Light mode)',
    settingsCenterTooltip: 'Control Center & Settings (Auto-Allow & Preferences)',
    renameAccount: 'Rename account',
    renamePromptTitle: (name) => `Rename account (${name})`,
    signOutAccount: 'Sign out this account',
    signOutConfirm: (name) => `Are you sure you want to sign out [${name}]? Session credentials will be cleared.`,
    deleteAccount: 'Delete this account',
    deleteConfirm: (name) => `Are you sure you want to delete [${name}]? All associated local data will be deleted.`,
    networkProxy: 'Network & Proxy settings…',
    cancel: 'Cancel',
    confirm: 'Confirm',
    popoverTitle: '⚙ Control Center & Auto-Allow',
    autoAllowTitle: 'Auto-Approval (Auto-Allow)',
    masterSwitch: 'Master Switch',
    allowAll: 'Allow All Actions',
    enableOnSite: (host) => `Enable on this site (${host})`,
    actionScope: 'Allowed action scope:',
    actConnectors: 'App / Connector Integrations (Connectors)',
    actFile: 'File & Data Access (File Access)',
    actLinks: 'External Links & Navigation (External Links)',
    actCode: 'Code Execution & Scripts (Code Execution)',
    themeBtnLight: '☀️ Light',
    themeBtnDark: '🌙 Dark',
    proxyBtn: '🌐 Proxy',
    langBtn: '🌐 EN / 中文',
    fullSettingsBtn: '⚙ Open Full Settings & Hotkeys…',
    badgeOff: '⚡ Auto Allow: OFF',
    badgeAll: '⚡ Auto Allow: ALL',
    badgeOn: '⚡ Auto Allow: ON',
    badgePaused: '⚡ Auto Allow: PAUSED',
    downloadCompleteTitle: 'Download Completed',
    downloadFailedTitle: 'Download Failed',
    openFolder: 'Open Folder',
    openFile: 'Open File',
    closeToast: 'Close',
  },
  'zh-CN': {
    expandDock: '展开多账号栏',
    collapseDock: '收起多账号栏',
    pinDock: '固定侧边栏 (保持展开)',
    unpinDock: '取消固定 (移开后自动收起)',
    myAccount: '我的账号',
    currentAccountBadge: '当前账号',
    clickToSwitch: '点击切换 (可上下拖动排序)',
    addAccountPromptTitle: '添加新账号',
    addAccountPlaceholder: '输入账号备注昵称...',
    addAccountDefaultName: (n) => `账号 ${n}`,
    addAccountTooltip: '添加新账号（家庭成员/多会话）',
    themeLightTooltip: '当前：浅色模式（点击切换为深色模式）',
    themeDarkTooltip: '当前：深色模式（点击切换为浅色模式）',
    settingsCenterTooltip: '设置与自动化控制中心 (Auto-Allow & Settings)',
    renameAccount: '修改备注名称',
    renamePromptTitle: (name) => `修改账号名称 (${name})`,
    signOutAccount: '退出此账号登录',
    signOutConfirm: (name) => `确定要退出账号 [${name}] 的登录状态吗？将清除此账号的登录凭据。`,
    deleteAccount: '删除此账号',
    deleteConfirm: (name) => `确定要删除账号 [${name}] 吗？该账号的所有独立本地数据将被清理。`,
    networkProxy: '网络代理设置…',
    cancel: '取消',
    confirm: '确定',
    popoverTitle: '⚙ 控制中心 & 自动化',
    autoAllowTitle: '自动审批授权 (Auto-Allow)',
    masterSwitch: '启用自动同意 (Master Switch)',
    allowAll: '一键允许所有行为 (Allow All)',
    enableOnSite: (host) => `在此网站启用 (${host})`,
    actionScope: '细分动作允许范围：',
    actConnectors: '应用集成 / 插件授权 (Connectors)',
    actFile: '文件与数据访问 (File Access)',
    actLinks: '外部链接与窗口跳转 (External Links)',
    actCode: '代码执行与脚本运行 (Code Execution)',
    themeBtnLight: '☀️ 浅色',
    themeBtnDark: '🌙 深色',
    proxyBtn: '🌐 网络代理',
    langBtn: '🌐 中文 / EN',
    fullSettingsBtn: '⚙ 打开完整设置与快捷键…',
    badgeOff: '⚡ 自动同意: 关闭',
    badgeAll: '⚡ 自动同意: 全部',
    badgeOn: '⚡ 自动同意: 开启',
    badgePaused: '⚡ 自动同意: 暂停',
    downloadCompleteTitle: '下载已完成',
    downloadFailedTitle: '下载失败',
    openFolder: '打开所在文件夹',
    openFile: '打开文件',
    closeToast: '关闭',
  },
};

function getT() {
  return I18N_RENDERER[currentLocale] || I18N_RENDERER.en;
}

function applyLocale(locale) {
  if (locale === 'zh-CN' || locale === 'en') {
    currentLocale = locale;
    if (typeof window.__museRenderDock === 'function') {
      window.__museRenderDock();
    }
    const pop = document.getElementById('acct-settings-pop');
    if (pop && pop.style.display === 'flex' && typeof window.__museRenderSettingsPopoverContent === 'function') {
      window.__museRenderSettingsPopoverContent();
    }
  }
}


function injectThemeStyles() {
  if (document.getElementById('ui-autohide-styles')) return;
  const style = document.createElement('style');
  style.id = 'ui-autohide-styles';
  style.textContent = `
    /* Left-Bottom Integrated Settings Popover & Controls */
    #acct-settings-pop {
      position: fixed;
      left: 56px;
      bottom: 14px;
      z-index: 2147483646;
      width: 295px;
      background: rgba(24, 26, 33, 0.96);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
      color: #e8eaf0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px;
      user-select: none;
      display: none;
      flex-direction: column;
      gap: 10px;
      animation: musePopoverFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes musePopoverFadeIn {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .acct-popover-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 8px;
    }
    .acct-popover-title {
      font-weight: 700;
      font-size: 13.5px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .acct-popover-close {
      background: none;
      border: none;
      color: #8a909d;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .acct-popover-close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .acct-pop-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .acct-pop-badge.on {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.3);
    }
    .acct-pop-badge.paused {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }
    .acct-pop-badge.off {
      background: rgba(107, 114, 128, 0.15);
      color: #9ca3af;
      border-color: rgba(107, 114, 128, 0.3);
    }
    .acct-pop-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
    }
    .acct-pop-row label {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .acct-pop-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .acct-pop-btn {
      width: 100%;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e5e7eb;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s;
    }
    .acct-pop-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      color: #fff;
    }
    .acct-pop-btn.primary {
      background: #3b5bfd;
      border-color: #3b5bfd;
      color: #fff;
    }
    .acct-pop-btn.primary:hover {
      background: #2b49e0;
    }

    /* Light Mode Theme Overrides */
    [data-ui-theme="light"] #acct-settings-pop {
      background: rgba(255, 255, 255, 0.98) !important;
      color: #1e293b !important;
      border-color: rgba(0, 0, 0, 0.14) !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05) !important;
    }
    [data-ui-theme="light"] .acct-popover-header {
      border-bottom-color: rgba(0, 0, 0, 0.08) !important;
    }
    [data-ui-theme="light"] .acct-popover-title {
      color: #0f172a !important;
    }
    [data-ui-theme="light"] .acct-popover-close {
      color: #64748b !important;
    }
    [data-ui-theme="light"] .acct-popover-close:hover {
      background: rgba(0, 0, 0, 0.06) !important;
      color: #0f172a !important;
    }
    [data-ui-theme="light"] .acct-pop-card {
      background: #f8fafc !important;
      border-color: #e2e8f0 !important;
    }
    [data-ui-theme="light"] .acct-pop-row label {
      color: #334155 !important;
    }
    [data-ui-theme="light"] .acct-pop-btn {
      background: #f1f5f9 !important;
      border-color: #cbd5e1 !important;
      color: #1e293b !important;
    }
    [data-ui-theme="light"] .acct-pop-btn:hover {
      background: #e2e8f0 !important;
      color: #0f172a !important;
    }
    [data-ui-theme="light"] #acct-dock {
      background: rgba(255, 255, 255, 0.94) !important;
      border-color: rgba(0, 0, 0, 0.1) !important;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1) !important;
    }
    [data-ui-theme="light"] .acct-dock-collapse-btn {
      color: #64748b !important;
    }
    [data-ui-theme="light"] .acct-dock-collapse-btn:hover {
      color: #0f172a !important;
      background: rgba(0, 0, 0, 0.06) !important;
    }
    [data-ui-theme="light"] .acct-dock-pin-btn {
      color: #64748b !important;
    }
    [data-ui-theme="light"] .acct-dock-pin-btn:hover {
      color: #0f172a !important;
      background: rgba(0, 0, 0, 0.06) !important;
    }
    [data-ui-theme="light"] .acct-dock-pin-btn.pinned {
      color: #2563eb !important;
      background: rgba(37, 99, 235, 0.14) !important;
    }
    [data-ui-theme="light"] .acct-dock-list {
      scrollbar-color: rgba(0, 0, 0, 0.22) transparent !important;
    }
    [data-ui-theme="light"] .acct-dock-list::-webkit-scrollbar-thumb {
      background: rgba(0, 0, 0, 0.18) !important;
    }
    [data-ui-theme="light"] .acct-dock-list::-webkit-scrollbar-thumb:hover {
      background: rgba(0, 0, 0, 0.35) !important;
    }
    [data-ui-theme="light"] .acct-dock-add-btn {
      background: rgba(0, 0, 0, 0.06) !important;
      border-color: rgba(0, 0, 0, 0.1) !important;
      color: #334155 !important;
    }
    [data-ui-theme="light"] .acct-dock-add-btn:hover {
      background: rgba(0, 0, 0, 0.1) !important;
      color: #0f172a !important;
    }
    [data-ui-theme="light"] .acct-context-menu {
      background: #ffffff !important;
      border-color: #e2e8f0 !important;
      color: #1e293b !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important;
    }
    [data-ui-theme="light"] .acct-context-item {
      color: #334155 !important;
    }
    [data-ui-theme="light"] .acct-context-item:hover {
      background: #f1f5f9 !important;
      color: #0f172a !important;
    }
    [data-ui-theme="light"] .acct-modal-card {
      background: #ffffff !important;
      border-color: #e2e8f0 !important;
      color: #0f172a !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.15) !important;
    }
    [data-ui-theme="light"] .acct-modal-input {
      background: #f8fafc !important;
      border-color: #cbd5e1 !important;
      color: #0f172a !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function applyTheme(theme) {
  currentTheme = (theme === 'light') ? 'light' : 'dark';
  const root = document.documentElement || document.body;
  if (root) {
    root.setAttribute('data-ui-theme', currentTheme);
  }
  const themeBtn = document.getElementById('acct-dock-theme-toggle');
  if (themeBtn) {
    const t = getT();
    themeBtn.innerHTML = currentTheme === 'light' ? '☀️' : '🌙';
    themeBtn.title = currentTheme === 'light' ? t.themeLightTooltip : t.themeDarkTooltip;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectThemeStyles);
} else {
  injectThemeStyles();
}

ipcRenderer.invoke('theme-get').then((theme) => {
  applyTheme(theme);
}).catch(() => {});

ipcRenderer.on('theme:changed', (e, theme) => {
  applyTheme(theme);
});

ipcRenderer.invoke('locale-get').then((loc) => {
  applyLocale(loc);
}).catch(() => {});

ipcRenderer.on('locale:changed', (e, loc) => {
  applyLocale(loc);
});

// Floating widgets have been relocated to the unified left-bottom settings center.

// ---- light HTML -> Markdown ------------------------------------------------
function nodeToMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (['script', 'style', 'svg', 'button', 'noscript'].includes(tag)) return '';
  if (tag === 'pre') {
    const code = node.querySelector('code');
    const cls = (code && code.className) || '';
    const lang = (cls.match(/language-([\w+-]+)/) || [])[1] || '';
    const text = ((code || node).innerText || '').replace(/\n+$/, '');
    return `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
  }
  const inner = Array.from(node.childNodes).map(nodeToMarkdown).join('');
  switch (tag) {
    case 'code': return `\`${(node.innerText || '').replace(/\n/g, ' ')}\``;
    case 'strong':
    case 'b': return `**${inner}**`;
    case 'em':
    case 'i': return `*${inner}*`;
    case 'a': {
      const href = node.getAttribute('href') || '';
      const t = inner.trim();
      return href && href !== t ? `[${t}](${href})` : t;
    }
    case 'h1': return `\n# ${inner.trim()}\n`;
    case 'h2': return `\n## ${inner.trim()}\n`;
    case 'h3': return `\n### ${inner.trim()}\n`;
    case 'h4': return `\n#### ${inner.trim()}\n`;
    case 'li': return `\n- ${inner.trim()}`;
    case 'ul':
    case 'ol': return `\n${inner}\n`;
    case 'blockquote': {
      return inner.split('\n').map((l) => (l.trim() ? `> ${l}` : '')).join('\n') + '\n';
    }
    case 'br': return '\n';
    case 'p':
    case 'div':
    case 'section':
    case 'article': return `${inner}\n\n`;
    case 'img': {
      const alt = node.getAttribute('alt');
      return alt ? ` [image: ${alt}] ` : ' [image] ';
    }
    case 'hr': return '\n---\n';
    default: return inner;
  }
}

function cleanMarkdown(md) {
  return md
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\*\*|__)\s+(\S)/g, '$1$2')
    .trim();
}

// ---- message detection ------------------------------------------------------
const ATTRIBUTE_SELECTORS = [
  '[data-message-author-role]',
  '[data-testid*="conversation-turn"]',
  '[data-testid*="message"]',
  '[data-message-id]',
  '[data-hatch-message]',
];

function classifyRole(el) {
  const attr =
    el.getAttribute('data-message-author-role') ||
    el.getAttribute('data-role') ||
    '';
  const a = attr.toLowerCase();
  if (a.includes('user') || a === 'human') return 'user';
  if (a.includes('assistant') || a.includes('bot') || a.includes('ai')) return 'assistant';

  const label = (el.getAttribute('aria-label') || '').toLowerCase().trim();
  if (/^(you|user)$/.test(label)) return 'user';
  if (/muse|meta ai|assistant/.test(label)) return 'assistant';

  const img = el.querySelector('img[alt]');
  if (img) {
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    if (/muse|meta ai|assistant/.test(alt)) return 'assistant';
    if (/^(you|user)$/.test(alt.trim())) return 'user';
  }

  const firstLine = (el.innerText || '').split('\n')[0].trim().toLowerCase();
  if (/^(you|user)$/.test(firstLine)) return 'user';
  if (/^(muse|meta ai|assistant)$/.test(firstLine)) return 'assistant';

  return 'unknown';
}

function timestampOf(el) {
  const t = el.querySelector('time[datetime]');
  return t ? t.getAttribute('datetime') : null;
}

function dedupeNested(els) {
  const set = new Set(els);
  return els.filter((el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}

function attributeMessages() {
  for (const sel of ATTRIBUTE_SELECTORS) {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    els = dedupeNested(els).filter((el) => (el.innerText || '').trim().length > 0);
    if (els.length >= 2) return els;
  }
  return [];
}

// Structural fallback: descend into the content area looking for a run of
// sibling blocks that look like messages (same tag + class family).
function structuralMessages(root) {
  let node = root;
  for (let depth = 0; depth < 10; depth++) {
    const kids = Array.from(node.children).filter(
      (el) => (el.innerText || '').trim().length > 5
    );
    if (kids.length >= 2 && kids.length <= 300) {
      const key = (k) => `${k.tagName}|${(k.className || '').split(' ')[0]}`;
      const groups = {};
      for (const k of kids) {
        const kk = key(k);
        (groups[kk] = groups[kk] || []).push(k);
      }
      const best = Object.values(groups).sort((a, b) => b.length - a.length)[0];
      if (best && best.length >= 2) return dedupeNested(best);
    }
    if (!kids.length) break;
    kids.sort((x, y) => y.innerText.length - x.innerText.length);
    if (kids[0] === node) break;
    node = kids[0];
  }
  return [];
}

function fixRoles(messages) {
  // Chats alternate user/assistant. Fill 'unknown' from neighbours; a chat
  // almost always opens with the user.
  const out = messages.map((m) => ({ ...m }));
  const beforeRoles = messages.map((m) => m.role);
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== 'unknown') continue;
    const prev = i > 0 ? out[i - 1].role : null;
    if (prev === 'user') out[i].role = 'assistant';
    else if (prev === 'assistant') out[i].role = 'user';
    else {
      const nextKnown = out.slice(i + 1).find((m) => m.role !== 'unknown');
      if (nextKnown) {
        // walk backwards from the next known role
        let r = nextKnown.role;
        for (let j = out.indexOf(nextKnown) - 1; j >= i; j--) {
          r = r === 'user' ? 'assistant' : 'user';
          if (out[j].role === 'unknown') out[j].role = r;
        }
      } else {
        out[i].role = i === 0 ? 'user' : out[i - 1].role === 'user' ? 'assistant' : 'user';
      }
    }
  }
  // 被交替规律填充的发言人打上 guessed 标记, 导出时如实标注 (v1.5.17)
  out.forEach((m, i) => {
    if (beforeRoles[i] === 'unknown' && m.role !== 'unknown') m.guessed = true;
  });
  return out;
}

function findScroller() {
  const candidates = [document.scrollingElement, ...document.querySelectorAll('main div')];
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    if (!el || el === document.body) continue;
    try {
      if (el.scrollHeight > el.clientHeight + 200 && el.innerText.length > bestScore) {
        bestScore = el.innerText.length;
        best = el;
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

async function scrapeChat() {
  // Coax paginated history into the DOM, then restore the view.
  // 增量收集 (v1.5.17, 评审 P2): 聊天是虚拟列表, 屏外消息会被卸载出 DOM。
  // 旧实现上滚几下后只读一次最终 DOM, 被卸载的早期消息静默丢失且导出无
  // 任何提示。现在边滚边收集去重, 并记录是否真正到达顶部以便如实标注。
  const collected = new Map();
  let method = 'attributes';
  let reachedTop = false;
  const collectNow = () => {
    const rootEl = document.querySelector('main') || document.body;
    let els = attributeMessages();
    if (!els.length) {
      els = structuralMessages(rootEl);
      if (els.length) method = 'structural';
    }
    for (const el of els) {
      const text = cleanMarkdown(nodeToMarkdown(el));
      if (!text) continue;
      const key = `${text.length}|${text.slice(0, 200)}`;
      if (!collected.has(key)) {
        collected.set(key, { role: classifyRole(el), text, timestamp: timestampOf(el) });
      }
    }
  };

  const scroller = findScroller();
  if (scroller) {
    try {
      let lastH = scroller.scrollHeight;
      let stableTop = 0;
      for (let i = 0; i < 12; i++) {
        scroller.scrollTop = 0;
        await sleep(500);
        collectNow();
        if (scroller.scrollHeight <= lastH + 50) {
          if (++stableTop >= 2) { reachedTop = true; break; }
        } else {
          stableTop = 0;
        }
        lastH = scroller.scrollHeight;
      }
      if (scroller.scrollTop <= 0) reachedTop = true;
      let lastTop = -1;
      for (let i = 0; i < 80; i++) {
        collectNow();
        if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 5) break;
        scroller.scrollTop = Math.min(
          scroller.scrollTop + Math.floor(scroller.clientHeight * 0.9),
          scroller.scrollHeight
        );
        await sleep(250);
        if (scroller.scrollTop === lastTop) break;
        lastTop = scroller.scrollTop;
      }
      collectNow();
      scroller.scrollTop = scroller.scrollHeight;
    } catch {
      /* scrolling is best-effort */
    }
  } else {
    collectNow();
  }

  let messages = [...collected.values()];

  if (!messages.length) {
    const root = document.querySelector('main') || document.body;
    // Last resort: whole readable text of the content area.
    const text = cleanMarkdown(nodeToMarkdown(root)).slice(0, 500000);
    if (text.length > 100) {
      messages = [{ role: 'unknown', text, timestamp: null }];
      method = 'fulltext-fallback';
    }
  }

  messages = fixRoles(messages);

  return {
    ok: true,
    method,
    url: location.href,
    title: document.title,
    scrapedAt: new Date().toISOString(),
    stats: {
      reachedTop,
      guessedRoles: messages.filter((mm) => mm.guessed).length,
      total: messages.length,
    },
    messages,
  };
}

// v1.5.14 (评审 P0-3): museExport 与 automationAPI 桥已整体删除。
// 此前它们把聊天抓取与 Auto-Allow 最高敏感开关暴露给网页主世界, 任意页面
// 脚本一行调用即可全开自动审批。本 preload 自身的功能全部走隔离世界的
// ipcRenderer 直连 (Dock/Popover/自动化引擎均是), 无需向主世界暴露任何 API。
// 聊天抓取改由主进程经 IPC 点名触发, 在本隔离世界执行后回传结果:
ipcRenderer.on('muse-export:scrape', async () => {
  try {
    const data = await scrapeChat();
    ipcRenderer.send('muse-export:result', { ok: true, data });
  } catch (err) {
    ipcRenderer.send('muse-export:result', { ok: false, error: String((err && err.message) || err) });
  }
});

// ---- Automation On-Screen Widget & Auto-Approval Engine --------------------
(function initAutomationEngine() {
  if (window.__museAutomationInjected) return;
  window.__museAutomationInjected = true;

  let autoState = {
    enabled: false,
    autoAllowAll: false,
    showOnScreenWidget: true,
    actions: {
      connectors: true,
      file_access: true,
      external_links: true,
      media_permissions: true,
      code_execution: true,
    },
    sites: {},
    siteActions: {},
  };

  function isCurrentSiteAllowed() {
    if (!autoState.enabled) return false;
    const hostname = location.hostname.toLowerCase();
    // autoAllowAll 只覆盖 Muse / Meta AI 自家站点 (加固): 「全部放行」若对
    // 任意站点生效, 任何第三方页面 (含 OAuth 同意屏) 的按钮都可能被代点;
    // 其他站点仍可通过每站点开关单独启用
    if (autoState.autoAllowAll) return /^(?:.+\.)?(muse\.ai|meta\.ai)$/.test(hostname);
    return autoState.sites[hostname] === true;
  }

  function isActionAllowed(actionKey) {
    if (!autoState.enabled) return false;
    if (autoState.autoAllowAll) return true;
    if (!isCurrentSiteAllowed()) return false;
    const hostname = location.hostname.toLowerCase();
    const siteRules = autoState.siteActions && autoState.siteActions[hostname];
    if (siteRules && siteRules[actionKey] !== undefined) return !!siteRules[actionKey];
    return autoState.actions[actionKey] === true;
  }

  // --- UI Widget ---
  let widgetContainer = null;
  let panelContainer = null;

  function showToast(text) {
    let toast = document.getElementById('acct-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'acct-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '999999',
        backgroundColor: 'rgba(20, 24, 33, 0.92)',
        color: '#7ee2a8',
        border: '1px solid #3b5bfd',
        borderRadius: '8px',
        padding: '10px 16px',
        fontSize: '13px',
        fontWeight: '600',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        opacity: '0',
        transform: 'translateY(10px)',
        pointerEvents: 'none',
      });
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 3000);
  }

  // --- Integrated Settings & Auto-Allow Center ---
  let popoverContainer = null;

  function ensureSettingsPopover() {
    if (popoverContainer && popoverContainer.parentNode) return popoverContainer;
    const parent = document.body || document.documentElement;
    if (!parent) return null;

    popoverContainer = document.createElement('div');
    popoverContainer.id = 'acct-settings-pop';
    parent.appendChild(popoverContainer);

    document.addEventListener('click', (e) => {
      const settingsBtn = document.getElementById('acct-dock-settings-btn');
      if (popoverContainer && !popoverContainer.contains(e.target) && (!settingsBtn || !settingsBtn.contains(e.target))) {
        popoverContainer.style.display = 'none';
      }
    });

    return popoverContainer;
  }

  function toggleSettingsPopover() {
    const pop = ensureSettingsPopover();
    if (!pop) return;
    if (pop.style.display === 'flex') {
      pop.style.display = 'none';
    } else {
      renderSettingsPopoverContent();
      pop.style.display = 'flex';
    }
  }

  // Expose toggle to dock button
  window.__museToggleSettingsPopover = toggleSettingsPopover;

  function getAutoBadgeMeta() {
    const t = getT();
    if (!autoState.enabled) {
      return { cls: 'off', text: t.badgeOff, borderColor: '#6b7280' };
    }
    if (autoState.autoAllowAll) {
      return { cls: 'on', text: t.badgeAll, borderColor: '#3b82f6' };
    }
    if (isCurrentSiteAllowed()) {
      return { cls: 'on', text: t.badgeOn, borderColor: '#10b981' };
    }
    return { cls: 'paused', text: t.badgePaused, borderColor: '#f59e0b' };
  }

  function renderSettingsPopoverContent() {
    const pop = ensureSettingsPopover();
    if (!pop) return;
    const t = getT();
    const hostname = location.hostname || (currentLocale === 'zh-CN' ? '当前网站' : 'Current Site');
    const siteAllowed = isCurrentSiteAllowed();
    const meta = getAutoBadgeMeta();

    pop.innerHTML = `
      <div class="acct-popover-header">
        <div class="acct-popover-title">
          <span>${t.popoverTitle}</span>
        </div>
        <button class="acct-popover-close" id="acct-pop-close-btn" title="Close">✕</button>
      </div>

      <!-- 自动化审批区块 -->
      <div class="acct-pop-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-weight:600; font-size:12px;">${t.autoAllowTitle}</span>
          <span class="acct-pop-badge ${meta.cls}">${meta.text}</span>
        </div>

        <div class="acct-pop-row">
          <label>
            <input type="checkbox" id="acct-pop-chk-master" ${autoState.enabled ? 'checked' : ''}>
            <span>${t.masterSwitch}</span>
          </label>
        </div>

        <div class="acct-pop-row">
          <label>
            <input type="checkbox" id="acct-pop-chk-allowall" ${autoState.autoAllowAll ? 'checked' : ''}>
            <span>${t.allowAll}</span>
          </label>
        </div>

        <div class="acct-pop-row">
          <label>
            <input type="checkbox" id="acct-pop-chk-site" ${siteAllowed ? 'checked' : ''}>
            <span>${t.enableOnSite(hostname)}</span>
          </label>
        </div>

        <!-- 细分行为授权 -->
        <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.1); display:flex; flex-direction:column; gap:4px;">
          <div style="font-size:11px; color:#8a909d; font-weight:600;">${t.actionScope}</div>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="acct-pop-act-connectors" ${isActionAllowed('connectors') ? 'checked' : ''}>
            <span>${t.actConnectors}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="acct-pop-act-file" ${isActionAllowed('file_access') ? 'checked' : ''}>
            <span>${t.actFile}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="acct-pop-act-links" ${isActionAllowed('external_links') ? 'checked' : ''}>
            <span>${t.actLinks}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="acct-pop-act-code" ${isActionAllowed('code_execution') ? 'checked' : ''}>
            <span>${t.actCode}</span>
          </label>
        </div>
      </div>

      <!-- 外观与快捷入口区块 -->
      <div style="display:flex; gap:6px;">
        <button class="acct-pop-btn" id="acct-pop-theme-btn" style="flex:1;">
          <span>${currentTheme === 'light' ? t.themeBtnLight : t.themeBtnDark}</span>
        </button>
        <button class="acct-pop-btn" id="acct-pop-proxy-btn" style="flex:1;">
          <span>${t.proxyBtn}</span>
        </button>
        <button class="acct-pop-btn" id="acct-pop-lang-btn" style="flex:1;">
          <span>${currentLocale === 'zh-CN' ? '🌐 EN' : '🌐 中文'}</span>
        </button>
      </div>

      <!-- 打开完整设置 -->
      <button class="acct-pop-btn primary" id="acct-pop-full-settings">
        <span>${t.fullSettingsBtn}</span>
      </button>
    `;

    // 绑定事件
    pop.querySelector('#acct-pop-close-btn').onclick = () => { pop.style.display = 'none'; };

    pop.querySelector('#acct-pop-chk-master').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { enabled: e.target.checked });
    };

    pop.querySelector('#acct-pop-chk-allowall').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { autoAllowAll: e.target.checked });
    };

    pop.querySelector('#acct-pop-chk-site').onchange = (e) => {
      ipcRenderer.invoke('automation-toggle-site', hostname, e.target.checked);
    };

    pop.querySelector('#acct-pop-act-connectors').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'connectors', e.target.checked);
    };
    pop.querySelector('#acct-pop-act-file').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'file_access', e.target.checked);
    };
    pop.querySelector('#acct-pop-act-links').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'external_links', e.target.checked);
    };
    pop.querySelector('#acct-pop-act-code').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'code_execution', e.target.checked);
    };

    pop.querySelector('#acct-pop-theme-btn').onclick = () => {
      const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
      ipcRenderer.invoke('theme-set', nextTheme).catch(() => {});
      pop.style.display = 'none';
    };

    pop.querySelector('#acct-pop-proxy-btn').onclick = () => {
      ipcRenderer.invoke('open-settings', 'tab-proxy');
      pop.style.display = 'none';
    };

    pop.querySelector('#acct-pop-lang-btn').onclick = () => {
      const nextLocale = currentLocale === 'zh-CN' ? 'en' : 'zh-CN';
      ipcRenderer.invoke('locale-set', nextLocale).catch(() => {});
      pop.style.display = 'none';
    };

    pop.querySelector('#acct-pop-full-settings').onclick = () => {
      ipcRenderer.invoke('open-settings');
      pop.style.display = 'none';
    };
  }

  window.__museRenderSettingsPopoverContent = renderSettingsPopoverContent;

  function updateWidgetUI() {
    // 同步 Dock 上设置按钮的指示点
    const dot = document.getElementById('acct-dock-settings-dot');
    if (dot) {
      const meta = getAutoBadgeMeta();
      dot.style.background = meta.borderColor;
      dot.title = meta.text;
    }
    // 如果 Popover 处于打开状态，同步更新内容
    if (popoverContainer && popoverContainer.style.display === 'flex') {
      renderSettingsPopoverContent();
    }
  }

  // --- DOM Auto-Approval Observer ---
  const CLICK_KEYWORDS = [
    'allow', 'approve', 'confirm', 'connect', 'authorize', 'accept',
    'grant access', 'run code', 'proceed'
    // 注意: 不含裸 'continue' —— 普通流程按钮遍地都是 Continue, 曾靠正文
    // 关键词兜底被误点; 同意类对话框几乎都同时带 Allow/Authorize 等词
  ];

  const CONNECTOR_CONTAINER_SELECTORS = [
    '[role="dialog"]', '.modal', '[data-testid*="modal"]',
    '[class*="confirm"]', '[class*="authorize"]', '[class*="connector"]',
    '[class*="permission"]', '[class*="approval"]'
  ];

  function matchesActionCategory(text, containerText) {
    if (!autoState.enabled || !isCurrentSiteAllowed()) return false;
    const combined = (text + ' ' + containerText).toLowerCase();

    // Match explicit approval/permission context instead of broad words such as
    // "account", "read", or "run". Those words occur in ordinary chat UI too.
    const strongConnector = /(?:connect|authorize|authorise|grant access|allow access|approve access|link account|sign in with|oauth|integration|connector|plugin)/.test(combined);
    const strongFile = /(?:file access|folder access|access (?:your )?(?:files|documents|drive)|read (?:your )?(?:files|documents)|write to (?:your )?(?:files|documents)|upload (?:a |the )?file|download (?:a |the )?file)/.test(combined);
    const strongLink = /(?:open (?:this )?(?:link|url)|open in (?:a )?new (?:tab|window)|external (?:link|site)|navigate to|leave (?:this )?site|open website)/.test(combined);
    const strongCode = /(?:run|execute) (?:code|script|command)|code execution|terminal command|python code|shell command|bash command|run in terminal/.test(combined);
    const strongMedia = /(?:microphone|mic|camera|audio|media) (?:access|permission)|allow (?:microphone|camera|audio|media)|grant (?:microphone|camera|audio|media) access|use (?:your )?(?:microphone|camera)/.test(combined);

    if (strongConnector) return isActionAllowed('connectors');
    if (strongFile) return isActionAllowed('file_access');
    if (strongLink) return isActionAllowed('external_links');
    if (strongCode) return isActionAllowed('code_execution');
    if (strongMedia) return isActionAllowed('media_permissions');
    return false;
  }

  function checkAndAutoApprove() {
    if (!autoState.enabled) return;
    // 只在顶层页面运行: 子框架 (第三方嵌入/OAuth iframe) 一律不代点
    if (window.top !== window) return;
    if (!isCurrentSiteAllowed()) return;

    // Search for interactive confirmation buttons (每轮扫描设上限, 防病态页面)
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]')).slice(0, 200);

    for (const btn of buttons) {
      if (btn.__museAutoHandled) continue;
      if (btn.offsetWidth === 0 || btn.offsetHeight === 0 || btn.disabled) continue;

      // 用 textContent 而非 innerText: 不触发强制同步布局 (流式输出时尤甚)
      const txt = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().toLowerCase().slice(0, 120);
      if (!txt) continue;

      const isMatch = CLICK_KEYWORDS.some((kw) => {
        if (txt === kw) return true;
        if (txt.startsWith(kw + ' ') || txt.endsWith(' ' + kw)) return true;
        return false;
      });

      if (!isMatch) continue;

      // 类别判定只认按钮自身文本与其确认类容器文本; 找不到容器时不再兜底
      // 读取整页正文前 1000 字 (曾导致普通按钮被正文关键词误判代点)
      const container = btn.closest(CONNECTOR_CONTAINER_SELECTORS.join(', '));
      const containerText = container ? (container.textContent || '').slice(0, 600) : '';

      if (matchesActionCategory(txt, containerText)) {
        btn.__museAutoHandled = true;
        try {
          btn.click();
          showToast(`⚡ Auto-approved action: "${txt}"`);
        } catch (e) {
          /* ignore click failure */
        }
      }
    }
  }

  // Sync state
  ipcRenderer.invoke('automation-get').then((res) => {
    if (res) {
      autoState = { ...autoState, ...res };
      updateWidgetUI();
    }
  }).catch(() => {});

  ipcRenderer.on('automation-changed', (e, newState) => {
    if (newState) {
      autoState = { ...autoState, ...newState };
      updateWidgetUI();
    }
  });

  // Observe page changes —— 节流 (加固): 流式输出时 MutationObserver 每秒
  // 可触发上千次, 旧实现每次都全文档扫描 + 逐按钮读文本, 常驻占用主线程。
  // 改为 300ms 防抖合并 + 扫描重入保护
  let scanTimer = null;
  let scanRunning = false;
  function scheduleAutoApproveScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (scanRunning) return;
      scanRunning = true;
      try { checkAndAutoApprove(); } finally { scanRunning = false; }
    }, 300);
  }

  const observer = new MutationObserver(() => {
    scheduleAutoApproveScan();
  });

  function startObserver() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      checkAndAutoApprove();
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();

// Floating export button removed per user request to free up page space.
function injectExportButton() {}

// ---- Multi-Account Quick Dock -----------------------------------------------
(function initAccountDock() {
  let isPinned = false;
  try {
    isPinned = localStorage.getItem('acct_dock_pinned') === '1';
  } catch {}

  let dockState = {
    profiles: [],
    activeProfileId: 'default',
    pinned: isPinned,
    collapsed: !isPinned,
  };

  let dockContainer = null;
  let activeContextMenu = null;
  let activeModal = null;
  let collapseTimer = null;
  let isDraggingAccount = false;
  let draggedAccountId = null;
  let dragJustEndedAt = 0;

  function scheduleAutoCollapse(delay = 250) {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      if (!dockState.pinned && !activeContextMenu && !activeModal && !isDraggingAccount && dockContainer) {
        dockState.collapsed = true;
        dockContainer.classList.add('collapsed');
        updateHeaderButtons();
      }
    }, delay);
  }

  function cancelAutoCollapse() {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  function updateHeaderButtons() {
    if (!dockContainer) return;
    const t = getT();
    const collapseBtn = dockContainer.querySelector('.acct-dock-collapse-btn');
    if (collapseBtn) {
      collapseBtn.title = dockState.collapsed ? t.expandDock : t.collapseDock;
      collapseBtn.innerHTML = dockState.collapsed ? '▶' : '◀';
    }
    const pinBtn = dockContainer.querySelector('.acct-dock-pin-btn');
    if (pinBtn) {
      pinBtn.title = dockState.pinned ? t.unpinDock : t.pinDock;
      if (dockState.pinned) {
        pinBtn.classList.add('pinned');
      } else {
        pinBtn.classList.remove('pinned');
      }
    }
  }

  function closeContextMenu() {
    if (activeContextMenu && activeContextMenu.parentNode) {
      activeContextMenu.parentNode.removeChild(activeContextMenu);
    }
    activeContextMenu = null;
  }

  function closeModal() {
    if (activeModal && activeModal.parentNode) {
      activeModal.parentNode.removeChild(activeModal);
    }
    activeModal = null;
  }

  function getInitials(name) {
    if (!name) return 'A';
    const trimmed = name.trim();
    const numMatch = trimmed.match(/(?:账号|profile|account)\s*(\d+)/i);
    if (numMatch) return numMatch[1];
    if (/^[\u4e00-\u9fa5]/.test(trimmed)) {
      return trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed;
    }
    return trimmed.slice(0, 2).toUpperCase();
  }

  function injectDockStyles() {
    if (document.getElementById('acct-dock-styles')) return;
    const style = document.createElement('style');
    style.id = 'acct-dock-styles';
    style.textContent = `
      #acct-dock {
        position: fixed;
        left: 10px;
        bottom: 14px;
        max-height: calc(100vh - 28px);
        box-sizing: border-box;
        overflow: visible;
        z-index: 2147483640;
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(18, 18, 22, 0.88);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 8px 6px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
        user-select: none;
        transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #acct-dock.collapsed {
        transform: translateX(-38px);
        opacity: 0.55;
      }
      #acct-dock.collapsed:hover {
        transform: translateX(0);
        opacity: 1;
      }
      .acct-dock-header {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        width: 100%;
        margin-bottom: 6px;
        flex-shrink: 0;
      }
      .acct-dock-collapse-btn {
        width: 17px;
        height: 17px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.45);
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
        font-size: 10px;
        flex-shrink: 0;
      }
      .acct-dock-collapse-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
      }
      .acct-dock-pin-btn {
        width: 17px;
        height: 17px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.45);
        border-radius: 4px;
        transition: color 0.15s, background 0.15s, transform 0.15s;
        font-size: 11px;
        flex-shrink: 0;
      }
      .acct-dock-pin-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
      }
      .acct-dock-pin-btn.pinned {
        color: #60a5fa;
        background: rgba(59, 130, 246, 0.25);
      }
      .acct-dock-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: min(520px, calc(100vh - 210px));
        overflow-y: auto;
        overflow-x: hidden;
        padding: 2px 3px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
        flex: 1 1 auto;
        min-height: 0;
      }
      .acct-dock-list::-webkit-scrollbar {
        width: 4px;
        display: block;
      }
      .acct-dock-list::-webkit-scrollbar-track {
        background: transparent;
      }
      .acct-dock-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.22);
        border-radius: 4px;
      }
      .acct-dock-list::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.45);
      }
      .acct-dock-item {
        position: relative;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
        flex-shrink: 0;
        user-select: none;
        -webkit-user-drag: element;
      }
      .acct-dock-item:active {
        cursor: grabbing;
      }
      .acct-dock-item.dragging {
        opacity: 0.35;
        transform: scale(0.9);
        cursor: grabbing;
      }
      .acct-dock-drop-indicator {
        position: absolute;
        left: -3px;
        right: -3px;
        height: 3px;
        background: #3b82f6;
        border-radius: 2px;
        box-shadow: 0 0 8px rgba(59, 130, 246, 0.9);
        display: none;
        pointer-events: none;
        z-index: 2147483646;
      }
      .acct-dock-drop-indicator.top {
        top: -5px;
      }
      .acct-dock-drop-indicator.bottom {
        bottom: -5px;
      }
      .acct-dock-item.drop-target-before > .acct-dock-drop-indicator.top {
        display: block;
      }
      .acct-dock-item.drop-target-after > .acct-dock-drop-indicator.bottom {
        display: block;
      }
      .acct-dock-item:hover {
        transform: scale(1.1);
      }
      .acct-dock-item.active {
        box-shadow: 0 0 0 2.5px #fff, 0 4px 12px rgba(0, 0, 0, 0.4);
      }
      .acct-dock-item.active::after {
        content: '';
        position: absolute;
        right: -2px;
        bottom: -2px;
        width: 8px;
        height: 8px;
        background: #10b981;
        border: 2px solid #141416;
        border-radius: 50%;
      }
      .acct-dock-tooltip {
        position: absolute;
        left: calc(100% + 10px);
        top: 50%;
        transform: translateY(-50%) translateX(-4px);
        background: rgba(24, 24, 28, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        padding: 6px 10px;
        border-radius: 8px;
        color: #fff;
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        gap: 6px;
        z-index: 2147483645;
      }
      .acct-dock-item:hover .acct-dock-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateY(-50%) translateX(0);
      }
      .acct-dock-tooltip-badge {
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 4px;
        background: rgba(16, 185, 129, 0.25);
        color: #34d399;
        font-weight: 500;
      }
      .acct-dock-tooltip-hint {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
      }
      .acct-dock-add-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1px dashed rgba(255, 255, 255, 0.28);
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        cursor: pointer;
        margin-top: 6px;
        transition: all 0.2s;
        flex-shrink: 0;
      }
      .acct-dock-add-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border-color: rgba(255, 255, 255, 0.5);
        transform: scale(1.08);
      }
      .acct-context-menu {
        position: fixed;
        z-index: 2147483647;
        background: rgba(28, 28, 34, 0.96);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        padding: 6px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
        min-width: 140px;
        color: #eee;
        font-size: 13px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .acct-context-item {
        padding: 7px 10px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background 0.15s;
      }
      .acct-context-item:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .acct-context-item.danger {
        color: #f87171;
      }
      .acct-context-item.danger:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
      }
      .acct-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .acct-modal-card {
        background: #1c1c22;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 16px;
        padding: 20px;
        width: 320px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .acct-modal-title {
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 12px;
      }
      .acct-modal-input {
        width: 100%;
        box-sizing: border-box;
        padding: 9px 12px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #fff;
        font-size: 14px;
        outline: none;
        margin-bottom: 16px;
      }
      .acct-modal-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
      }
      .acct-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .acct-modal-btn {
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid transparent;
        font-weight: 500;
        transition: all 0.15s;
      }
      .acct-modal-btn.cancel {
        background: transparent;
        border-color: rgba(255, 255, 255, 0.15);
        color: #ccc;
      }
      .acct-modal-btn.cancel:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }
      .acct-modal-btn.confirm {
        background: #3b82f6;
        color: #fff;
      }
      .acct-modal-btn.confirm:hover {
        background: #2563eb;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showPromptModal(title, initialValue, onConfirm) {
    closeModal();
    const t = getT();
    const overlay = document.createElement('div');
    overlay.className = 'acct-modal-overlay';

    const card = document.createElement('div');
    card.className = 'acct-modal-card';

    const titleEl = document.createElement('div');
    titleEl.className = 'acct-modal-title';
    titleEl.textContent = title;

    const input = document.createElement('input');
    input.className = 'acct-modal-input';
    input.value = initialValue || '';
    input.placeholder = t.addAccountPlaceholder;

    const actions = document.createElement('div');
    actions.className = 'acct-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'acct-modal-btn cancel';
    cancelBtn.textContent = t.cancel;
    cancelBtn.onclick = closeModal;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'acct-modal-btn confirm';
    confirmBtn.textContent = t.confirm;
    confirmBtn.onclick = () => {
      const val = input.value.trim();
      closeModal();
      onConfirm(val);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') closeModal();
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(titleEl);
    card.appendChild(input);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    activeModal = overlay;

    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  }

  function openItemContextMenu(e, profile) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    const t = getT();

    const menu = document.createElement('div');
    menu.className = 'acct-context-menu';

    // 1. 修改备注
    const renameItem = document.createElement('div');
    renameItem.className = 'acct-context-item';
    renameItem.innerHTML = `<span>✏️</span><span>${t.renameAccount}</span>`;
    renameItem.onclick = () => {
      closeContextMenu();
      showPromptModal(t.renamePromptTitle(profile.name), profile.name, (newName) => {
        if (newName && newName !== profile.name) {
          ipcRenderer.invoke('account:rename', { id: profile.id, name: newName });
        }
      });
    };
    menu.appendChild(renameItem);

    // 2. 退出登录
    const signOutItem = document.createElement('div');
    signOutItem.className = 'acct-context-item';
    signOutItem.innerHTML = `<span>🚪</span><span>${t.signOutAccount}</span>`;
    signOutItem.onclick = () => {
      closeContextMenu();
      if (confirm(t.signOutConfirm(profile.name))) {
        ipcRenderer.invoke('account:sign-out', { id: profile.id });
      }
    };
    menu.appendChild(signOutItem);

    // 3. 删除账号
    if (dockState.profiles.length > 1) {
      const deleteItem = document.createElement('div');
      deleteItem.className = 'acct-context-item danger';
      deleteItem.innerHTML = `<span>🗑️</span><span>${t.deleteAccount}</span>`;
      deleteItem.onclick = () => {
        closeContextMenu();
        if (confirm(t.deleteConfirm(profile.name))) {
          ipcRenderer.invoke('account:delete', { id: profile.id });
        }
      };
      menu.appendChild(deleteItem);
    }

    // 4. 网络代理设置
    const proxyItem = document.createElement('div');
    proxyItem.className = 'acct-context-item';
    proxyItem.innerHTML = `<span>🌐</span><span>${t.networkProxy}</span>`;
    proxyItem.onclick = () => {
      closeContextMenu();
      ipcRenderer.invoke('open-settings', 'tab-proxy');
    };
    menu.appendChild(proxyItem);

    menu.style.left = `${Math.min(e.clientX + 5, window.innerWidth - 160)}px`;
    menu.style.top = `${Math.min(e.clientY - 20, window.innerHeight - 150)}px`;
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function renderDock() {
    const parent = document.body || document.documentElement;
    if (!parent) return;
    const t = getT();

    if (!dockContainer) {
      dockContainer = document.createElement('div');
      dockContainer.id = 'acct-dock';
      dockContainer.addEventListener('mouseenter', () => {
        cancelAutoCollapse();
        if (!dockState.pinned) {
          dockState.collapsed = false;
          dockContainer.classList.remove('collapsed');
          updateHeaderButtons();
        }
      });
      dockContainer.addEventListener('mouseleave', () => {
        if (!dockState.pinned && !isDraggingAccount) {
          scheduleAutoCollapse(250);
        }
      });
      parent.appendChild(dockContainer);
    } else if (!dockContainer.parentNode) {
      parent.appendChild(dockContainer);
    }

    if (dockState.pinned) {
      dockState.collapsed = false;
      dockContainer.classList.remove('collapsed');
      dockContainer.classList.add('pinned');
    } else if (dockState.collapsed) {
      dockContainer.classList.add('collapsed');
      dockContainer.classList.remove('pinned');
    } else {
      dockContainer.classList.remove('collapsed');
      dockContainer.classList.remove('pinned');
    }

    dockContainer.innerHTML = '';

    // 顶部操作区 (折叠与固定)
    const header = document.createElement('div');
    header.className = 'acct-dock-header';

    const collapseBtn = document.createElement('div');
    collapseBtn.className = 'acct-dock-collapse-btn';
    collapseBtn.title = dockState.collapsed ? t.expandDock : t.collapseDock;
    collapseBtn.innerHTML = dockState.collapsed ? '▶' : '◀';
    collapseBtn.onclick = (e) => {
      e.stopPropagation();
      if (dockState.collapsed) {
        dockState.collapsed = false;
        dockContainer.classList.remove('collapsed');
      } else {
        dockState.collapsed = true;
        dockContainer.classList.add('collapsed');
        if (dockState.pinned) {
          dockState.pinned = false;
          try { localStorage.setItem('acct_dock_pinned', '0'); } catch {}
          ipcRenderer.invoke('dock:set-pinned', { pinned: false }).catch(() => {});
        }
      }
      updateHeaderButtons();
    };
    header.appendChild(collapseBtn);

    const pinBtn = document.createElement('div');
    pinBtn.className = 'acct-dock-pin-btn' + (dockState.pinned ? ' pinned' : '');
    pinBtn.title = dockState.pinned ? t.unpinDock : t.pinDock;
    pinBtn.innerHTML = '📌';
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      dockState.pinned = !dockState.pinned;
      try { localStorage.setItem('acct_dock_pinned', dockState.pinned ? '1' : '0'); } catch {}
      ipcRenderer.invoke('dock:set-pinned', { pinned: dockState.pinned }).catch(() => {});
      if (dockState.pinned) {
        cancelAutoCollapse();
        dockState.collapsed = false;
        dockContainer.classList.remove('collapsed');
        dockContainer.classList.add('pinned');
      } else {
        dockContainer.classList.remove('pinned');
        scheduleAutoCollapse(350);
      }
      renderDock();
    };
    header.appendChild(pinBtn);
    dockContainer.appendChild(header);

    // 账号列表
    const list = document.createElement('div');
    list.className = 'acct-dock-list';

    // 保底至少渲染一个当前账号徽章
    const profilesToRender = (dockState.profiles && dockState.profiles.length > 0)
      ? dockState.profiles
      : [{ id: dockState.activeProfileId || 'default', name: t.myAccount, color: '#3b82f6' }];

    const canDrag = profilesToRender.length > 1;

    const cleanupAllDropIndicators = () => {
      list.querySelectorAll('.acct-dock-item').forEach((el) => {
        el.classList.remove('drop-target-before', 'drop-target-after');
      });
    };

    profilesToRender.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'acct-dock-item';
      if (p.id === dockState.activeProfileId) {
        item.classList.add('active');
        setTimeout(() => {
          try { item.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
        }, 50);
      }
      item.style.backgroundColor = p.color || '#3b82f6';
      item.textContent = getInitials(p.name);

      // 上下拖拽高亮指示线
      const indTop = document.createElement('div');
      indTop.className = 'acct-dock-drop-indicator top';
      item.appendChild(indTop);

      const indBottom = document.createElement('div');
      indBottom.className = 'acct-dock-drop-indicator bottom';
      item.appendChild(indBottom);

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'acct-dock-tooltip';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;
      tooltip.appendChild(nameSpan);

      if (p.id === dockState.activeProfileId) {
        const badge = document.createElement('span');
        badge.className = 'acct-dock-tooltip-badge';
        badge.textContent = t.currentAccountBadge;
        tooltip.appendChild(badge);
      } else {
        const hint = document.createElement('span');
        hint.className = 'acct-dock-tooltip-hint';
        hint.textContent = t.clickToSwitch;
        tooltip.appendChild(hint);
      }

      item.appendChild(tooltip);

      // 点击切换 (防拖拽结束误触)
      item.onclick = () => {
        if (Date.now() - dragJustEndedAt < 250) return;
        if (p.id !== dockState.activeProfileId) {
          ipcRenderer.invoke('account:switch', { id: p.id }).catch(() => {});
        }
      };

      // 拖拽排序逻辑 (仅在账号数量 > 1 时启用)
      if (canDrag) {
        item.draggable = true;

        item.addEventListener('dragstart', (e) => {
          isDraggingAccount = true;
          draggedAccountId = p.id;
          item.classList.add('dragging');
          cancelAutoCollapse();
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', p.id); } catch {}
          }
        });

        item.addEventListener('dragover', (e) => {
          if (!isDraggingAccount || draggedAccountId === p.id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

          const rect = item.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            if (!item.classList.contains('drop-target-before')) {
              item.classList.add('drop-target-before');
              item.classList.remove('drop-target-after');
            }
          } else {
            if (!item.classList.contains('drop-target-after')) {
              item.classList.add('drop-target-after');
              item.classList.remove('drop-target-before');
            }
          }
        });

        item.addEventListener('dragleave', (e) => {
          const rect = item.getBoundingClientRect();
          if (e.clientY < rect.top || e.clientY >= rect.bottom || e.clientX < rect.left || e.clientX >= rect.right) {
            item.classList.remove('drop-target-before', 'drop-target-after');
          }
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!isDraggingAccount || !draggedAccountId || draggedAccountId === p.id) {
            cleanupAllDropIndicators();
            return;
          }

          const isBefore = item.classList.contains('drop-target-before');
          cleanupAllDropIndicators();

          const currentProfiles = [...(dockState.profiles || [])];
          const srcIdx = currentProfiles.findIndex((x) => x.id === draggedAccountId);
          const targetIdx = currentProfiles.findIndex((x) => x.id === p.id);

          if (srcIdx !== -1 && targetIdx !== -1 && srcIdx !== targetIdx) {
            const [moved] = currentProfiles.splice(srcIdx, 1);
            let insertIdx = currentProfiles.findIndex((x) => x.id === p.id);
            if (!isBefore) {
              insertIdx += 1;
            }
            currentProfiles.splice(insertIdx, 0, moved);

            // 本地即时响应重排
            dockState.profiles = currentProfiles;
            renderDock();

            // 持久化到主进程
            ipcRenderer.invoke('account:reorder', {
              orderedIds: currentProfiles.map((x) => x.id),
            }).catch((err) => {
              console.warn('[Account] Reorder sync error:', err);
            });
          }
        });

        item.addEventListener('dragend', () => {
          dragJustEndedAt = Date.now();
          isDraggingAccount = false;
          draggedAccountId = null;
          item.classList.remove('dragging');
          cleanupAllDropIndicators();
          if (!dockState.pinned) {
            scheduleAutoCollapse(350);
          }
        });
      }

      // 右键管理
      item.oncontextmenu = (e) => openItemContextMenu(e, p);

      list.appendChild(item);
    });

    dockContainer.appendChild(list);

    // 新增账号按钮
    const addBtn = document.createElement('button');
    addBtn.className = 'acct-dock-add-btn';
    addBtn.type = 'button';
    addBtn.style.flexShrink = '0';
    addBtn.title = t.addAccountTooltip;
    addBtn.textContent = '+';
    addBtn.onclick = () => {
      showPromptModal(t.addAccountPromptTitle, t.addAccountDefaultName(profilesToRender.length + 1), (name) => {
        ipcRenderer.invoke('account:add', { name }).catch(() => {});
      });
    };
    dockContainer.appendChild(addBtn);

    // 主题切换快捷按钮 (Dark / Light)
    const themeBtn = document.createElement('button');
    themeBtn.id = 'acct-dock-theme-toggle';
    themeBtn.className = 'acct-dock-add-btn';
    themeBtn.type = 'button';
    themeBtn.style.flexShrink = '0';
    themeBtn.style.marginTop = '4px';
    themeBtn.style.fontSize = '12px';
    themeBtn.innerHTML = currentTheme === 'light' ? '☀️' : '🌙';
    themeBtn.title = currentTheme === 'light' ? t.themeLightTooltip : t.themeDarkTooltip;
    themeBtn.onclick = () => {
      const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
      ipcRenderer.invoke('theme-set', nextTheme).catch(() => {});
    };
    dockContainer.appendChild(themeBtn);

    // ⚙ 配置与自动化控制中心按钮 (Settings & Auto-Allow Center)
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'acct-dock-settings-btn';
    settingsBtn.className = 'acct-dock-add-btn';
    settingsBtn.type = 'button';
    settingsBtn.style.flexShrink = '0';
    settingsBtn.style.marginTop = '4px';
    settingsBtn.style.position = 'relative';
    settingsBtn.style.fontSize = '14px';
    settingsBtn.innerHTML = '⚙';
    settingsBtn.title = t.settingsCenterTooltip;

    // 右下角微型自动化状态指示圆点
    const dot = document.createElement('span');
    dot.id = 'acct-dock-settings-dot';
    Object.assign(dot.style, {
      position: 'absolute',
      right: '1px',
      bottom: '1px',
      width: '7px',
      height: '7px',
      borderRadius: '50%',
      backgroundColor: '#10b981',
      border: '1.5px solid rgba(18, 18, 22, 0.9)',
      pointerEvents: 'none',
      transition: 'background-color 0.2s ease',
    });
    settingsBtn.appendChild(dot);

    settingsBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof window.__museToggleSettingsPopover === 'function') {
        window.__museToggleSettingsPopover();
      }
    };
    dockContainer.appendChild(settingsBtn);
  }

  window.__museRenderDock = renderDock;

  // 全局点击关闭上下文菜单
  window.addEventListener('click', () => closeContextMenu());
  window.addEventListener('contextmenu', (e) => {
    if (activeContextMenu && !activeContextMenu.contains(e.target)) {
      closeContextMenu();
    }
  });

  // 监听主进程广播的账号变化
  ipcRenderer.on('account:changed', (e, newState) => {
    if (newState) {
      dockState.profiles = newState.profiles || [];
      dockState.activeProfileId = newState.activeProfileId || 'default';
      if (typeof newState.dockPinned === 'boolean') {
        dockState.pinned = newState.dockPinned;
        if (dockState.pinned) {
          dockState.collapsed = false;
        }
      }
      renderDock();
    }
  });

  function startDock() {
    injectDockStyles();
    renderDock(); // 先用初始数据渲染，确保绝不空白
    ipcRenderer.invoke('account:get-state').then((res) => {
      if (res) {
        dockState.profiles = res.profiles || [];
        dockState.activeProfileId = res.activeProfileId || 'default';
        if (typeof res.dockPinned === 'boolean') {
          dockState.pinned = res.dockPinned;
          if (dockState.pinned) {
            dockState.collapsed = false;
          }
        }
      }
      renderDock();
    }).catch(() => {
      renderDock();
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startDock);
  } else {
    startDock();
  }
  // 延时再次检查保底附加
  setTimeout(startDock, 500);
  setTimeout(startDock, 2000);
})();

// ---- Global External Link Handling (Open In Default Browser) ---------------
(function initExternalLinkCapture() {
  function extractTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      // 与主进程一致: 只解包已知跳转站的重定向参数 (v1.5.17 加固)
      const REDIRECTOR_HOSTS = new Set([
        'www.google.com', 'google.com', 'www.bing.com', 'bing.com',
        'duckduckgo.com', 'html.duckduckgo.com', 'l.facebook.com',
        'out.reddit.com', 'www.youtube.com',
      ]);
      if (!REDIRECTOR_HOSTS.has(parsed.hostname.toLowerCase())) return null;
      const redirectKeys = ['u', 'url', 'target', 'dest', 'destination', 'link', 'href', 'q'];
      for (const key of redirectKeys) {
        const candidate = parsed.searchParams.get(key);
        if (candidate) {
          try {
            const candUrl = new URL(candidate);
            if (candUrl.protocol === 'http:' || candUrl.protocol === 'https:') {
              const candHost = candUrl.hostname.toLowerCase();
              const isInternal = candHost === 'muse.ai' || candHost.endsWith('.muse.ai') ||
                               candHost === 'meta.ai' || candHost.endsWith('.meta.ai');
              if (!isInternal) {
                return candidate;
              }
            }
          } catch {}
        }
      }
    } catch {}
    return null;
  }

  function isInternalUrl(rawUrl) {
    try {
      if (extractTargetUrl(rawUrl)) return false;
      const parsed = new URL(rawUrl, window.location.href);
      const host = parsed.hostname.toLowerCase();
      if (host === 'muse.ai' || host.endsWith('.muse.ai')) return true;
      if (host === 'meta.ai' || host.endsWith('.meta.ai')) return true;
      // 常见认证回调、连接器与页面跳转
      const authHosts = [
        'accounts.google.com',
        'appleid.apple.com',
        'auth.meta.com',
        'account.meta.com',
        'facebook.com',
        'github.com',
        'spotify.com',
        'accounts.spotify.com',
        'dropbox.com',
        'zoom.us',
        'canva.com',
        'onepeloton.com',
        'peloton.com',
        'slack.com',
        'notion.so',
        'login.microsoftonline.com',
        'live.com',
        'linkedin.com',
      ];
      if (authHosts.some((h) => host === h || host.endsWith('.' + h))) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 使用捕获阶段 (capture: true)，拦截聊天区域中的外部 a 标签点击
  document.addEventListener(
    'click',
    (e) => {
      try {
        const anchor = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!anchor) return;

        // 尊重用户显式打开方式 (v1.5.17, 评审 P2): 带修饰键/中键点击与显式
        // target 的链接交回页面与主进程的窗口打开逻辑, 不在此劫持
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const targetAttr = (anchor.getAttribute('target') || '').toLowerCase();
        if (targetAttr && targetAttr !== '_self') return;

        // 关键防御：如果点击发生在模态弹窗、设置面板或对话框内部，绝不拦截！交由页面自身逻辑处理
        if (anchor.closest('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"], [class*="settings"]')) {
          return;
        }

        const rawHref = anchor.getAttribute('href') || anchor.href;
        if (!rawHref) return;

        // 跳过纯锚点与非网络协议
        if (rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

        let fullHref = rawHref;
        try {
          fullHref = new URL(rawHref, window.location.href).href;
        } catch {}

        if (!fullHref.startsWith('http://') && !fullHref.startsWith('https://') && !fullHref.startsWith('mailto:')) {
          return;
        }

        // 关键防御：如果是身份验证或连接器相关 URL，绝不拦截！
        if (isInternalUrl(fullHref)) {
          return;
        }

        const externalTarget = extractTargetUrl(fullHref);
        if (externalTarget) {
          e.preventDefault();
          e.stopPropagation();
          ipcRenderer.send('open-external-url', externalTarget);
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('open-external-url', fullHref);
      } catch (err) {
        console.warn('[Preload] External link intercept error:', err);
      }
    },
    true
  );

  // ---- In-App Download Toast Component (Scheme A) ------------------------
  function formatBytes(bytes) {
    if (!bytes || typeof bytes !== 'number' || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function showDownloadToast(data) {
    try {
      const { state, fileName, savePath, fileSize } = data || {};
      const isSuccess = state === 'completed';
      const t = getT();

      let container = document.getElementById('acct-download-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'acct-download-toast-container';
        container.style.cssText = `
          position: fixed;
          right: 24px;
          bottom: 24px;
          z-index: 2147483647;
          display: flex;
          flex-direction: column-reverse;
          gap: 10px;
          pointer-events: none;
          max-width: 380px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;
        (document.body || document.documentElement).appendChild(container);
      }

      const isLight = currentTheme === 'light';
      const toast = document.createElement('div');
      toast.className = `acct-download-toast ${isLight ? 'light-mode' : 'dark-mode'}`;
      toast.style.cssText = `
        pointer-events: auto;
        min-width: 300px;
        max-width: 360px;
        padding: 12px 14px;
        border-radius: 12px;
        background: ${isLight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(24, 28, 38, 0.94)'};
        color: ${isLight ? '#1e293b' : '#f1f5f9'};
        border: 1px solid ${isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.12)'};
        box-shadow: 0 12px 32px rgba(0, 0, 0, ${isLight ? '0.15' : '0.45'});
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        display: flex;
        flex-direction: column;
        gap: 8px;
        transform: translateY(20px) scale(0.96);
        opacity: 0;
        transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      `;

      const formattedSize = formatBytes(fileSize);
      const sizeHtml = formattedSize ? `<span style="font-size:11px;opacity:0.65;font-weight:400;margin-left:6px;">(${formattedSize})</span>` : '';

      const header = document.createElement('div');
      header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px;';
      header.innerHTML = `
        <div style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:${isSuccess ? '#10b981' : '#ef4444'};">
          <span>${isSuccess ? '✓' : '⚠'}</span>
          <span>${isSuccess ? t.downloadCompleteTitle : t.downloadFailedTitle}</span>
          ${sizeHtml}
        </div>
        <button class="acct-toast-close" title="${t.closeToast}" style="background:none;border:none;cursor:pointer;color:inherit;opacity:0.6;font-size:16px;padding:0 2px;line-height:1;display:flex;align-items:center;">&times;</button>
      `;

      const body = document.createElement('div');
      body.style.cssText = `
        font-size: 12.5px;
        color: ${isLight ? '#334155' : '#cbd5e1'};
        word-break: break-all;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 500;
      `;
      body.title = fileName || '';
      body.textContent = fileName || '';

      const actions = document.createElement('div');
      actions.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';

      if (isSuccess && savePath) {
        const btnFolder = document.createElement('button');
        btnFolder.textContent = t.openFolder;
        btnFolder.style.cssText = `
          flex: 1;
          padding: 6px 10px;
          font-size: 11.5px;
          font-weight: 600;
          border-radius: 7px;
          border: none;
          cursor: pointer;
          background: #3b82f6;
          color: #ffffff;
          transition: background 0.15s ease;
        `;
        btnFolder.onmouseenter = () => { btnFolder.style.background = '#2563eb'; };
        btnFolder.onmouseleave = () => { btnFolder.style.background = '#3b82f6'; };
        btnFolder.onclick = () => {
          ipcRenderer.invoke('download:open-folder', savePath);
          removeToast();
        };
        actions.appendChild(btnFolder);

        const btnFile = document.createElement('button');
        btnFile.textContent = t.openFile;
        btnFile.style.cssText = `
          padding: 6px 10px;
          font-size: 11.5px;
          font-weight: 600;
          border-radius: 7px;
          border: 1px solid ${isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.2)'};
          cursor: pointer;
          background: ${isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)'};
          color: inherit;
          transition: background 0.15s ease;
        `;
        btnFile.onmouseenter = () => { btnFile.style.background = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.15)'; };
        btnFile.onmouseleave = () => { btnFile.style.background = isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)'; };
        btnFile.onclick = () => {
          ipcRenderer.invoke('download:open-file', savePath);
          removeToast();
        };
        actions.appendChild(btnFile);
      }

      toast.appendChild(header);
      toast.appendChild(body);
      if (isSuccess && savePath) toast.appendChild(actions);

      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.style.transform = 'translateY(0) scale(1)';
        toast.style.opacity = '1';
      });

      let dismissTimer = null;
      function startDismiss() {
        dismissTimer = setTimeout(removeToast, 6000);
      }
      function stopDismiss() {
        if (dismissTimer) clearTimeout(dismissTimer);
      }

      function removeToast() {
        stopDismiss();
        toast.style.transform = 'translateY(16px) scale(0.96)';
        toast.style.opacity = '0';
        setTimeout(() => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 280);
      }

      toast.onmouseenter = stopDismiss;
      toast.onmouseleave = startDismiss;
      startDismiss();

      const closeBtn = header.querySelector('.acct-toast-close');
      if (closeBtn) {
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          removeToast();
        };
      }
    } catch (e) {
      console.warn('[Preload] showDownloadToast error:', e);
    }
  }

  ipcRenderer.on('download:completed', (e, data) => {
    showDownloadToast(data);
  });
})();


