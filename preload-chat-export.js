// Runs in an isolated world with full DOM access. Exposes a single chat
// scraper to the main process via contextBridge, plus a small floating
// "Export chat" button that asks the main process to run the export.
// It never touches the network and never modifies the page content,
// except for the floating button and a brief scroll used to coax
// paginated history into the DOM (restored afterwards).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offlineAPI', {
  selfHealToSystem: () => ipcRenderer.invoke('proxy-set', { mode: 'system', enabled: false }),
  openProxySettings: () => ipcRenderer.invoke('open-settings', 'tab-proxy'),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Theme & AutoHide Engine (Dark / Light + Corner Auto-Fade) --------------
let currentTheme = 'dark';
let currentLocale = 'en';
let uiSettings = { autoHideButtons: true };

const I18N_RENDERER = {
  en: {
    expandDock: 'Expand accounts dock',
    collapseDock: 'Collapse accounts dock',
    myAccount: 'My account',
    currentAccountBadge: 'Current',
    clickToSwitch: 'Click to switch',
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
  },
  'zh-CN': {
    expandDock: '展开多账号栏',
    collapseDock: '收起多账号栏',
    myAccount: '我的账号',
    currentAccountBadge: '当前账号',
    clickToSwitch: '点击切换',
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
    const pop = document.getElementById('muse-settings-popover');
    if (pop && pop.style.display === 'flex' && typeof window.__museRenderSettingsPopoverContent === 'function') {
      window.__museRenderSettingsPopoverContent();
    }
  }
}


function injectThemeStyles() {
  if (document.getElementById('muse-theme-autohide-styles')) return;
  const style = document.createElement('style');
  style.id = 'muse-theme-autohide-styles';
  style.textContent = `
    /* Left-Bottom Integrated Settings Popover & Controls */
    #muse-settings-popover {
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
    .muse-popover-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 8px;
    }
    .muse-popover-title {
      font-weight: 700;
      font-size: 13.5px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .muse-popover-close {
      background: none;
      border: none;
      color: #8a909d;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .muse-popover-close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .muse-pop-badge {
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
    .muse-pop-badge.on {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.3);
    }
    .muse-pop-badge.paused {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }
    .muse-pop-badge.off {
      background: rgba(107, 114, 128, 0.15);
      color: #9ca3af;
      border-color: rgba(107, 114, 128, 0.3);
    }
    .muse-pop-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
    }
    .muse-pop-row label {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .muse-pop-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .muse-pop-btn {
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
    .muse-pop-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      color: #fff;
    }
    .muse-pop-btn.primary {
      background: #3b5bfd;
      border-color: #3b5bfd;
      color: #fff;
    }
    .muse-pop-btn.primary:hover {
      background: #2b49e0;
    }

    /* Light Mode Theme Overrides */
    [data-muse-theme="light"] #muse-settings-popover {
      background: rgba(255, 255, 255, 0.98) !important;
      color: #1e293b !important;
      border-color: rgba(0, 0, 0, 0.14) !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05) !important;
    }
    [data-muse-theme="light"] .muse-popover-header {
      border-bottom-color: rgba(0, 0, 0, 0.08) !important;
    }
    [data-muse-theme="light"] .muse-popover-title {
      color: #0f172a !important;
    }
    [data-muse-theme="light"] .muse-popover-close {
      color: #64748b !important;
    }
    [data-muse-theme="light"] .muse-popover-close:hover {
      background: rgba(0, 0, 0, 0.06) !important;
      color: #0f172a !important;
    }
    [data-muse-theme="light"] .muse-pop-card {
      background: #f8fafc !important;
      border-color: #e2e8f0 !important;
    }
    [data-muse-theme="light"] .muse-pop-row label {
      color: #334155 !important;
    }
    [data-muse-theme="light"] .muse-pop-btn {
      background: #f1f5f9 !important;
      border-color: #cbd5e1 !important;
      color: #1e293b !important;
    }
    [data-muse-theme="light"] .muse-pop-btn:hover {
      background: #e2e8f0 !important;
      color: #0f172a !important;
    }
    [data-muse-theme="light"] #muse-account-dock {
      background: rgba(255, 255, 255, 0.94) !important;
      border-color: rgba(0, 0, 0, 0.1) !important;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1) !important;
    }
    [data-muse-theme="light"] .muse-dock-collapse-btn {
      color: #64748b !important;
    }
    [data-muse-theme="light"] .muse-dock-collapse-btn:hover {
      color: #0f172a !important;
      background: rgba(0, 0, 0, 0.06) !important;
    }
    [data-muse-theme="light"] .muse-dock-add-btn {
      background: rgba(0, 0, 0, 0.06) !important;
      border-color: rgba(0, 0, 0, 0.1) !important;
      color: #334155 !important;
    }
    [data-muse-theme="light"] .muse-dock-add-btn:hover {
      background: rgba(0, 0, 0, 0.1) !important;
      color: #0f172a !important;
    }
    [data-muse-theme="light"] .muse-context-menu {
      background: #ffffff !important;
      border-color: #e2e8f0 !important;
      color: #1e293b !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important;
    }
    [data-muse-theme="light"] .muse-context-item {
      color: #334155 !important;
    }
    [data-muse-theme="light"] .muse-context-item:hover {
      background: #f1f5f9 !important;
      color: #0f172a !important;
    }
    [data-muse-theme="light"] .muse-modal-card {
      background: #ffffff !important;
      border-color: #e2e8f0 !important;
      color: #0f172a !important;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.15) !important;
    }
    [data-muse-theme="light"] .muse-modal-input {
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
    root.setAttribute('data-muse-theme', currentTheme);
  }
  const themeBtn = document.getElementById('muse-dock-theme-toggle');
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
  const scroller = findScroller();
  if (scroller) {
    try {
      let lastH = scroller.scrollHeight;
      for (let i = 0; i < 4; i++) {
        scroller.scrollTop = 0;
        await sleep(650);
        if (scroller.scrollHeight <= lastH + 50) break;
        lastH = scroller.scrollHeight;
      }
      scroller.scrollTop = scroller.scrollHeight;
    } catch {
      /* scrolling is best-effort */
    }
  }

  const root = document.querySelector('main') || document.body;
  let els = attributeMessages();
  let method = 'attributes';
  if (!els.length) {
    els = structuralMessages(root);
    method = 'structural';
  }

  let messages = els.map((el) => ({
    role: classifyRole(el),
    text: cleanMarkdown(nodeToMarkdown(el)),
    timestamp: timestampOf(el),
  })).filter((m) => m.text.length > 0);

  if (!messages.length) {
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
    messages,
  };
}

contextBridge.exposeInMainWorld('museExport', {
  scrape: () => scrapeChat(),
});

contextBridge.exposeInMainWorld('automationAPI', {
  get: () => ipcRenderer.invoke('automation-get'),
  set: (updates) => ipcRenderer.invoke('automation-set', updates),
  toggle: () => ipcRenderer.invoke('automation-toggle'),
  toggleSite: (hostname, enabled) => ipcRenderer.invoke('automation-toggle-site', hostname, enabled),
  setAction: (actionKey, enabled) => ipcRenderer.invoke('automation-set-action', actionKey, enabled),
  setSiteAction: (hostname, actionKey, enabled) => ipcRenderer.invoke('automation-set-site-action', hostname, actionKey, enabled),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  onChanged: (callback) => {
    ipcRenderer.on('automation-changed', (e, state) => callback(state));
  },
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
    if (autoState.autoAllowAll) return true;
    const hostname = location.hostname.toLowerCase();
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
    let toast = document.getElementById('muse-auto-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'muse-auto-toast';
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
    popoverContainer.id = 'muse-settings-popover';
    parent.appendChild(popoverContainer);

    document.addEventListener('click', (e) => {
      const settingsBtn = document.getElementById('muse-dock-settings-btn');
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
      <div class="muse-popover-header">
        <div class="muse-popover-title">
          <span>${t.popoverTitle}</span>
        </div>
        <button class="muse-popover-close" id="muse-pop-close-btn" title="Close">✕</button>
      </div>

      <!-- 自动化审批区块 -->
      <div class="muse-pop-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-weight:600; font-size:12px;">${t.autoAllowTitle}</span>
          <span class="muse-pop-badge ${meta.cls}">${meta.text}</span>
        </div>

        <div class="muse-pop-row">
          <label>
            <input type="checkbox" id="muse-pop-chk-master" ${autoState.enabled ? 'checked' : ''}>
            <span>${t.masterSwitch}</span>
          </label>
        </div>

        <div class="muse-pop-row">
          <label>
            <input type="checkbox" id="muse-pop-chk-allowall" ${autoState.autoAllowAll ? 'checked' : ''}>
            <span>${t.allowAll}</span>
          </label>
        </div>

        <div class="muse-pop-row">
          <label>
            <input type="checkbox" id="muse-pop-chk-site" ${siteAllowed ? 'checked' : ''}>
            <span>${t.enableOnSite(hostname)}</span>
          </label>
        </div>

        <!-- 细分行为授权 -->
        <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.1); display:flex; flex-direction:column; gap:4px;">
          <div style="font-size:11px; color:#8a909d; font-weight:600;">${t.actionScope}</div>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="muse-pop-act-connectors" ${isActionAllowed('connectors') ? 'checked' : ''}>
            <span>${t.actConnectors}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="muse-pop-act-file" ${isActionAllowed('file_access') ? 'checked' : ''}>
            <span>${t.actFile}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="muse-pop-act-links" ${isActionAllowed('external_links') ? 'checked' : ''}>
            <span>${t.actLinks}</span>
          </label>
          <label style="font-size:11.5px; display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="muse-pop-act-code" ${isActionAllowed('code_execution') ? 'checked' : ''}>
            <span>${t.actCode}</span>
          </label>
        </div>
      </div>

      <!-- 外观与快捷入口区块 -->
      <div style="display:flex; gap:6px;">
        <button class="muse-pop-btn" id="muse-pop-theme-btn" style="flex:1;">
          <span>${currentTheme === 'light' ? t.themeBtnLight : t.themeBtnDark}</span>
        </button>
        <button class="muse-pop-btn" id="muse-pop-proxy-btn" style="flex:1;">
          <span>${t.proxyBtn}</span>
        </button>
        <button class="muse-pop-btn" id="muse-pop-lang-btn" style="flex:1;">
          <span>${currentLocale === 'zh-CN' ? '🌐 EN' : '🌐 中文'}</span>
        </button>
      </div>

      <!-- 打开完整设置 -->
      <button class="muse-pop-btn primary" id="muse-pop-full-settings">
        <span>${t.fullSettingsBtn}</span>
      </button>
    `;

    // 绑定事件
    pop.querySelector('#muse-pop-close-btn').onclick = () => { pop.style.display = 'none'; };

    pop.querySelector('#muse-pop-chk-master').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { enabled: e.target.checked });
    };

    pop.querySelector('#muse-pop-chk-allowall').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { autoAllowAll: e.target.checked });
    };

    pop.querySelector('#muse-pop-chk-site').onchange = (e) => {
      ipcRenderer.invoke('automation-toggle-site', hostname, e.target.checked);
    };

    pop.querySelector('#muse-pop-act-connectors').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'connectors', e.target.checked);
    };
    pop.querySelector('#muse-pop-act-file').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'file_access', e.target.checked);
    };
    pop.querySelector('#muse-pop-act-links').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'external_links', e.target.checked);
    };
    pop.querySelector('#muse-pop-act-code').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'code_execution', e.target.checked);
    };

    pop.querySelector('#muse-pop-theme-btn').onclick = () => {
      const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
      ipcRenderer.invoke('theme-set', nextTheme).catch(() => {});
      pop.style.display = 'none';
    };

    pop.querySelector('#muse-pop-proxy-btn').onclick = () => {
      ipcRenderer.invoke('open-settings', 'tab-proxy');
      pop.style.display = 'none';
    };

    pop.querySelector('#muse-pop-lang-btn').onclick = () => {
      const nextLocale = currentLocale === 'zh-CN' ? 'en' : 'zh-CN';
      ipcRenderer.invoke('locale-set', nextLocale).catch(() => {});
      pop.style.display = 'none';
    };

    pop.querySelector('#muse-pop-full-settings').onclick = () => {
      ipcRenderer.invoke('open-settings');
      pop.style.display = 'none';
    };
  }

  window.__museRenderSettingsPopoverContent = renderSettingsPopoverContent;

  function updateWidgetUI() {
    // 同步 Dock 上设置按钮的指示点
    const dot = document.getElementById('muse-dock-settings-dot');
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
    'grant access', 'run code', 'proceed', 'continue'
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
    if (!isCurrentSiteAllowed()) return;

    // Search for interactive confirmation buttons
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'));

    for (const btn of buttons) {
      if (btn.__museAutoHandled) continue;
      if (btn.offsetWidth === 0 || btn.offsetHeight === 0 || btn.disabled) continue;

      const txt = (btn.innerText || btn.value || btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!txt) continue;

      const isMatch = CLICK_KEYWORDS.some((kw) => {
        if (txt === kw) return true;
        if (txt.startsWith(kw + ' ') || txt.endsWith(' ' + kw)) return true;
        return false;
      });

      if (!isMatch) continue;

      // Check context container
      let container = btn.closest(CONNECTOR_CONTAINER_SELECTORS.join(', '));
      const containerText = container ? container.innerText || '' : document.body.innerText.slice(0, 1000);

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

  // Observe page changes
  const observer = new MutationObserver(() => {
    checkAndAutoApprove();
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
  let isCollapsed = false;
  try {
    isCollapsed = localStorage.getItem('muse_dock_collapsed') === '1';
  } catch {}

  let dockState = {
    profiles: [],
    activeProfileId: 'default',
    collapsed: isCollapsed,
  };

  let dockContainer = null;
  let activeContextMenu = null;
  let activeModal = null;

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
    if (document.getElementById('muse-account-dock-styles')) return;
    const style = document.createElement('style');
    style.id = 'muse-account-dock-styles';
    style.textContent = `
      #muse-account-dock {
        position: fixed;
        left: 10px;
        bottom: 14px;
        z-index: 2147483640;
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(18, 18, 22, 0.85);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 8px 6px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
        user-select: none;
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #muse-account-dock.collapsed {
        transform: translateX(-34px);
        opacity: 0.55;
      }
      #muse-account-dock.collapsed:hover {
        transform: translateX(0);
        opacity: 1;
      }
      .muse-dock-collapse-btn {
        width: 22px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.4);
        margin-bottom: 6px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
        font-size: 10px;
      }
      .muse-dock-collapse-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
      }
      .muse-dock-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 380px;
        overflow-y: auto;
        padding: 2px;
        scrollbar-width: none;
      }
      .muse-dock-list::-webkit-scrollbar {
        display: none;
      }
      .muse-dock-item {
        position: relative;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
        flex-shrink: 0;
      }
      .muse-dock-item:hover {
        transform: scale(1.1);
      }
      .muse-dock-item.active {
        box-shadow: 0 0 0 2.5px #fff, 0 4px 12px rgba(0, 0, 0, 0.4);
      }
      .muse-dock-item.active::after {
        content: '';
        position: absolute;
        right: -3px;
        bottom: -2px;
        width: 8px;
        height: 8px;
        background: #10b981;
        border: 2px solid #141416;
        border-radius: 50%;
      }
      .muse-dock-tooltip {
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
      .muse-dock-item:hover .muse-dock-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateY(-50%) translateX(0);
      }
      .muse-dock-tooltip-badge {
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 4px;
        background: rgba(16, 185, 129, 0.25);
        color: #34d399;
        font-weight: 500;
      }
      .muse-dock-tooltip-hint {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
      }
      .muse-dock-add-btn {
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
      }
      .muse-dock-add-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border-color: rgba(255, 255, 255, 0.5);
        transform: scale(1.08);
      }
      .muse-context-menu {
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
      .muse-context-item {
        padding: 7px 10px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background 0.15s;
      }
      .muse-context-item:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .muse-context-item.danger {
        color: #f87171;
      }
      .muse-context-item.danger:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
      }
      .muse-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .muse-modal-card {
        background: #1c1c22;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 16px;
        padding: 20px;
        width: 320px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .muse-modal-title {
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 12px;
      }
      .muse-modal-input {
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
      .muse-modal-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
      }
      .muse-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .muse-modal-btn {
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid transparent;
        font-weight: 500;
        transition: all 0.15s;
      }
      .muse-modal-btn.cancel {
        background: transparent;
        border-color: rgba(255, 255, 255, 0.15);
        color: #ccc;
      }
      .muse-modal-btn.cancel:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }
      .muse-modal-btn.confirm {
        background: #3b82f6;
        color: #fff;
      }
      .muse-modal-btn.confirm:hover {
        background: #2563eb;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showPromptModal(title, initialValue, onConfirm) {
    closeModal();
    const t = getT();
    const overlay = document.createElement('div');
    overlay.className = 'muse-modal-overlay';

    const card = document.createElement('div');
    card.className = 'muse-modal-card';

    const titleEl = document.createElement('div');
    titleEl.className = 'muse-modal-title';
    titleEl.textContent = title;

    const input = document.createElement('input');
    input.className = 'muse-modal-input';
    input.value = initialValue || '';
    input.placeholder = t.addAccountPlaceholder;

    const actions = document.createElement('div');
    actions.className = 'muse-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'muse-modal-btn cancel';
    cancelBtn.textContent = t.cancel;
    cancelBtn.onclick = closeModal;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'muse-modal-btn confirm';
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
    menu.className = 'muse-context-menu';

    // 1. 修改备注
    const renameItem = document.createElement('div');
    renameItem.className = 'muse-context-item';
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
    signOutItem.className = 'muse-context-item';
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
      deleteItem.className = 'muse-context-item danger';
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
    proxyItem.className = 'muse-context-item';
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
      dockContainer.id = 'muse-account-dock';
      parent.appendChild(dockContainer);
    } else if (!dockContainer.parentNode) {
      parent.appendChild(dockContainer);
    }

    if (dockState.collapsed) {
      dockContainer.classList.add('collapsed');
    } else {
      dockContainer.classList.remove('collapsed');
    }

    dockContainer.innerHTML = '';

    // 折叠按钮
    const collapseBtn = document.createElement('div');
    collapseBtn.className = 'muse-dock-collapse-btn';
    collapseBtn.title = dockState.collapsed ? t.expandDock : t.collapseDock;
    collapseBtn.innerHTML = dockState.collapsed ? '▶' : '◀';
    collapseBtn.onclick = (e) => {
      e.stopPropagation();
      dockState.collapsed = !dockState.collapsed;
      try { localStorage.setItem('muse_dock_collapsed', dockState.collapsed ? '1' : '0'); } catch {}
      renderDock();
    };
    dockContainer.appendChild(collapseBtn);

    // 账号列表
    const list = document.createElement('div');
    list.className = 'muse-dock-list';

    // 保底至少渲染一个当前账号徽章
    const profilesToRender = (dockState.profiles && dockState.profiles.length > 0)
      ? dockState.profiles
      : [{ id: dockState.activeProfileId || 'default', name: t.myAccount, color: '#3b82f6' }];

    profilesToRender.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'muse-dock-item';
      if (p.id === dockState.activeProfileId) {
        item.classList.add('active');
      }
      item.style.backgroundColor = p.color || '#3b82f6';
      item.textContent = getInitials(p.name);

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'muse-dock-tooltip';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;
      tooltip.appendChild(nameSpan);

      if (p.id === dockState.activeProfileId) {
        const badge = document.createElement('span');
        badge.className = 'muse-dock-tooltip-badge';
        badge.textContent = t.currentAccountBadge;
        tooltip.appendChild(badge);
      } else {
        const hint = document.createElement('span');
        hint.className = 'muse-dock-tooltip-hint';
        hint.textContent = t.clickToSwitch;
        tooltip.appendChild(hint);
      }

      item.appendChild(tooltip);

      // 点击切换
      item.onclick = () => {
        if (p.id !== dockState.activeProfileId) {
          ipcRenderer.invoke('account:switch', { id: p.id }).catch(() => {});
        }
      };

      // 右键管理
      item.oncontextmenu = (e) => openItemContextMenu(e, p);

      list.appendChild(item);
    });

    dockContainer.appendChild(list);

    // 新增账号按钮
    const addBtn = document.createElement('button');
    addBtn.className = 'muse-dock-add-btn';
    addBtn.type = 'button';
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
    themeBtn.id = 'muse-dock-theme-toggle';
    themeBtn.className = 'muse-dock-add-btn';
    themeBtn.type = 'button';
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
    settingsBtn.id = 'muse-dock-settings-btn';
    settingsBtn.className = 'muse-dock-add-btn';
    settingsBtn.type = 'button';
    settingsBtn.style.marginTop = '4px';
    settingsBtn.style.position = 'relative';
    settingsBtn.style.fontSize = '14px';
    settingsBtn.innerHTML = '⚙';
    settingsBtn.title = t.settingsCenterTooltip;

    // 右下角微型自动化状态指示圆点
    const dot = document.createElement('span');
    dot.id = 'muse-dock-settings-dot';
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
      if (parsed.protocol === 'file:') return true;
      // 常见认证回调与页面跳转
      if (host.includes('accounts.google.com') || host.includes('auth.meta.com') || host.includes('facebook.com')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 使用捕获阶段 (capture: true)，优先拦截网页中所有 a 标签点击
  document.addEventListener(
    'click',
    (e) => {
      try {
        const anchor = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!anchor) return;
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

        const externalTarget = extractTargetUrl(fullHref);
        if (externalTarget) {
          e.preventDefault();
          e.stopPropagation();
          ipcRenderer.send('open-external-url', externalTarget);
          return;
        }

        if (!isInternalUrl(fullHref)) {
          e.preventDefault();
          e.stopPropagation();
          ipcRenderer.send('open-external-url', fullHref);
        }
      } catch (err) {
        console.warn('[Preload] External link intercept error:', err);
      }
    },
    true
  );
})();

