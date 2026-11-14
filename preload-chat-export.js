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
    accountHubTitle: 'Account Hub · Grid Overview',
    openAccountHubTooltip: 'Open Account Grid Overview (Multi-session hub)',
    allGroups: 'All Groups',
    searchAccountPlaceholder: 'Search name, purpose, or group...',
    manageGroups: 'Manage Groups',
    feishuSyncBtn: 'Feishu Sync',
    feishuSyncSettings: 'Feishu Settings',
    feishuSyncNow: 'Sync Now',
    feishuSyncing: 'Syncing...',
    purposeLabel: 'Purpose',
    noPurpose: 'No purpose specified',
    tokenResetLabel: 'Token Reset',
    noResetInfo: 'No reset info',
    usageLabel: 'Usage',
    switchToAccount: 'Switch to this account',
    currentActive: 'Active Now',
    editMeta: 'Edit Details',
    groupLabel: 'Group',
    usagePercentLabel: 'Usage Quota (%)',
    saveChanges: 'Save Changes',
    feishuAppId: 'Feishu App ID',
    feishuAppSecret: 'Feishu App Secret',
    feishuAppToken: 'Bitable Base Token',
    feishuTableId: 'Table ID',
    feishuAutoSync: 'Auto sync in background',
    feishuInterval: 'Interval (minutes)',
    feishuFieldMap: 'Column Mappings',
    editProfileTitle: (name) => `Edit Account Details (${name})`,
    groupManagerTitle: 'Manage Account Groups',
    addGroupPrompt: 'Enter new group name:',
    exportConfigBtn: 'Export Backup',
    importConfigBtn: 'Import Config',
    openDataDirBtn: 'Data Folder',
    exportConfigTooltip: 'Export all accounts, proxy queues and settings to a .json file',
    importConfigTooltip: 'Restore all accounts and proxy queues from a .json backup',
    openDataDirTooltip: 'Open Muse local data directory (%APPDATA%\\Muse)',
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
    accountHubTitle: '多账号管理中心 · 九宫格看板',
    openAccountHubTooltip: '打开九宫格账号管理看板 (全景视图)',
    allGroups: '全部群组',
    searchAccountPlaceholder: '搜索账号昵称、主要用途或群组...',
    manageGroups: '群组管理',
    feishuSyncBtn: '飞书同步',
    feishuSyncSettings: '飞书同步配置',
    feishuSyncNow: '立即从飞书同步',
    feishuSyncing: '正在同步多维表格...',
    purposeLabel: '主要用途',
    noPurpose: '未设定用途（点击编辑补充）',
    tokenResetLabel: 'Token 重置',
    noResetInfo: '暂无重置记录',
    usageLabel: '当前用量',
    switchToAccount: '切换至此账号',
    currentActive: '当前正在使用',
    editMeta: '编辑详情',
    groupLabel: '所属群组',
    usagePercentLabel: '当前用量占比 (0-100%)',
    saveChanges: '保存并应用',
    feishuAppId: '自建应用 App ID (cli_xxx)',
    feishuAppSecret: '自建应用 App Secret',
    feishuAppToken: '多维表格 Base Token (bascnxxx)',
    feishuTableId: '数据表 Table ID (tblxxx)',
    feishuAutoSync: '开启后台定时自动同步',
    feishuInterval: '自动同步轮询周期 (分钟)',
    feishuFieldMap: '多维表格列名映射关系',
    editProfileTitle: (name) => `编辑账号信息 (${name})`,
    groupManagerTitle: '管理业务群组与分类',
    addGroupPrompt: '输入新群组名称：',
    exportConfigBtn: '导出配置',
    importConfigBtn: '导入配置',
    openDataDirBtn: '数据目录',
    exportConfigTooltip: '导出当前所有账号与代理出口队列至 .json 备份文件',
    importConfigTooltip: '从 .json 备份文件一键恢复所有账号与代理配置',
    openDataDirTooltip: '打开本地数据与配置目录 (%APPDATA%\\Muse)',
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
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    [data-ui-theme="light"] .acct-dock-list::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    [data-ui-theme="light"] .acct-dock-hub-btn {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(168, 85, 247, 0.12)) !important;
      border-color: rgba(168, 85, 247, 0.35) !important;
      color: #6366f1 !important;
      box-shadow: 0 2px 6px rgba(99, 102, 241, 0.1) !important;
    }
    [data-ui-theme="light"] .acct-dock-hub-btn:hover {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.22), rgba(168, 85, 247, 0.22)) !important;
      color: #4f46e5 !important;
      border-color: #6366f1 !important;
    }
    [data-ui-theme="light"] .acct-dock-divider {
      background: rgba(0, 0, 0, 0.1) !important;
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
      const settingsBtn = document.getElementById('acct-dock-settings-btn');
      if (settingsBtn) {
        const rect = settingsBtn.getBoundingClientRect();
        const popWidth = 295;
        const left = Math.max(12, Math.min(window.innerWidth - popWidth - 12, rect.right - popWidth));
        const bottom = Math.max(12, window.innerHeight - rect.top + 8);
        pop.style.left = `${left}px`;
        pop.style.bottom = `${bottom}px`;
      }
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
  let isPinned = true;
  try {
    const saved = localStorage.getItem('acct_dock_pinned');
    if (saved !== null) {
      isPinned = saved === '1';
    }
  } catch {}

  let dockState = {
    profiles: [],
    activeProfileId: 'default',
    switchingTargetId: null,
    pinned: isPinned,
    collapsed: !isPinned,
    accountGroups: ['默认群组'],
    feishu: null,
    hubOpen: false,
    activeGroupFilter: 'all',
    searchKeyword: '',
  };

  let dockContainer = null;
  let hubOverlay = null;
  let activeContextMenu = null;
  let activeModal = null;
  let collapseTimer = null;
  let isDraggingAccount = false;
  let draggedAccountId = null;
  let dragJustEndedAt = 0;

  function scheduleAutoCollapse(delay = 250) {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      if (!dockState.pinned && !dockState.hubOpen && !activeContextMenu && !activeModal && !isDraggingAccount && dockContainer) {
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

  function updateComposerOffset(pinned) {
    try {
      const inputEl = document.querySelector('textarea, [contenteditable="true"], div[role="textbox"]');
      if (!inputEl) return;

      let curr = inputEl;
      let fixedBottomParent = null;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const style = window.getComputedStyle(curr);
        if ((style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute') &&
            style.bottom && style.bottom !== 'auto') {
          fixedBottomParent = curr;
          break;
        }
        curr = curr.parentElement;
      }

      if (fixedBottomParent) {
        if (pinned) {
          fixedBottomParent.style.transform = 'translateY(-62px)';
          fixedBottomParent.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
        } else {
          fixedBottomParent.style.transform = '';
        }
      }
    } catch {}
  }

  function applyDockPinnedOffset(pinned) {
    try {
      const root = document.documentElement;
      const body = document.body;
      if (root) {
        if (pinned) root.classList.add('muse-dock-pinned');
        else root.classList.remove('muse-dock-pinned');
      }
      if (body) {
        if (pinned) body.classList.add('muse-dock-pinned');
        else body.classList.remove('muse-dock-pinned');
      }
      updateComposerOffset(pinned);
    } catch {}
  }

  function updateHeaderButtons() {
    if (!dockContainer) return;
    const t = getT();
    const collapseBtn = dockContainer.querySelector('.acct-dock-collapse-btn');
    if (collapseBtn) {
      collapseBtn.title = dockState.collapsed ? t.expandDock : t.collapseDock;
      collapseBtn.innerHTML = dockState.collapsed ? '▲' : '▼';
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

  function formatDateTime(val) {
    if (val === null || val === undefined) return '';
    const s = String(val).trim();
    if (!s) return '';

    let dateObj = null;
    if (/^\d{10,13}$/.test(s)) {
      const num = Number(s);
      const ms = num < 1e11 ? num * 1000 : num;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        dateObj = d;
      }
    } else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) {
      const d = new Date(s.replace(/-/g, '/'));
      if (!isNaN(d.getTime())) {
        dateObj = d;
      }
    } else {
      const d = new Date(s);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100) {
        dateObj = d;
      }
    }

    if (dateObj) {
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      const hours = String(dateObj.getHours()).padStart(2, '0');
      const minutes = String(dateObj.getMinutes()).padStart(2, '0');
      const seconds = String(dateObj.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    return s;
  }

  function injectDockStyles() {
    const target = document.head || document.body;
    if (!target) return;
    if (document.getElementById('acct-dock-styles')) return;
    const style = document.createElement('style');
    style.id = 'acct-dock-styles';
    style.textContent = `
      #acct-dock {
        position: fixed;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%) translateY(0);
        max-width: calc(100vw - 32px);
        box-sizing: border-box;
        overflow: visible;
        z-index: 2147483640;
        display: flex;
        flex-direction: row;
        align-items: center;
        background: rgba(18, 18, 22, 0.92);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 28px;
        padding: 4px 12px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.05);
        user-select: none;
        transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #acct-dock::before {
        content: '';
        position: absolute;
        top: -8px;
        left: 0;
        right: 0;
        height: 12px;
        pointer-events: auto;
      }
      #acct-dock.collapsed {
        transform: translateX(-50%) translateY(calc(100% - 14px));
        opacity: 0.85;
      }
      #acct-dock.collapsed:hover {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
      #acct-dock.pinned {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
      /* 当底部多账号栏固定 (Pinned) 时，主界面向上避让 62px，确保输入框与交互区完全不被遮挡 */
      html.muse-dock-pinned,
      html.muse-dock-pinned body {
        height: calc(100vh - 62px) !important;
        max-height: calc(100vh - 62px) !important;
        transition: height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      html.muse-dock-pinned #root,
      html.muse-dock-pinned [data-reactroot],
      html.muse-dock-pinned body > div:first-of-type {
        height: 100% !important;
        max-height: 100% !important;
      }
      .acct-dock-section {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .acct-dock-collapse-btn {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.45);
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
        font-size: 11px;
        flex-shrink: 0;
      }
      .acct-dock-collapse-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
      }
      .acct-dock-pin-btn {
        width: 20px;
        height: 20px;
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
      .acct-dock-hub-btn {
        position: relative;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.35), rgba(168, 85, 247, 0.35));
        border: 1px solid rgba(168, 85, 247, 0.5);
        color: #e0e7ff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
      }
      .acct-dock-hub-btn:hover {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.6), rgba(168, 85, 247, 0.6));
        color: #ffffff;
        border-color: rgba(192, 132, 252, 0.8);
        transform: scale(1.12);
        box-shadow: 0 4px 14px rgba(168, 85, 247, 0.45);
      }
      .acct-dock-divider {
        width: 1px;
        height: 20px;
        background: rgba(255, 255, 255, 0.15);
        margin: 0 6px;
        flex-shrink: 0;
      }
      .acct-dock-list {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        max-width: calc(100vw - 180px);
        overflow-x: auto;
        overflow-y: hidden;
        padding: 4px 2px;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
        flex: 0 1 auto;
        min-width: 0;
      }
      .acct-dock-list::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      .acct-dock-item {
        position: relative;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        color: #fff;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        flex-shrink: 0;
        user-select: none;
        -webkit-user-drag: element;
      }
      .acct-dock-ring {
        position: absolute;
        top: 0;
        left: 0;
        width: 36px;
        height: 36px;
        pointer-events: none;
        z-index: 1;
      }
      .acct-dock-ring-bg {
        stroke: rgba(255, 255, 255, 0.16);
      }
      .acct-dock-ring-progress {
        transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
      }
      [data-ui-theme="light"] .acct-dock-ring-bg {
        stroke: rgba(0, 0, 0, 0.12) !important;
      }
      .acct-dock-avatar {
        position: relative;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 11.5px;
        font-weight: 600;
        z-index: 2;
        transition: box-shadow 0.2s ease;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
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
        top: 0;
        bottom: 0;
        width: 3px;
        background: #3b82f6;
        border-radius: 2px;
        box-shadow: 0 0 8px rgba(59, 130, 246, 0.9);
        display: none;
        pointer-events: none;
        z-index: 2147483646;
      }
      .acct-dock-drop-indicator.left {
        left: -4px;
      }
      .acct-dock-drop-indicator.right {
        right: -4px;
      }
      .acct-dock-item.drop-target-before > .acct-dock-drop-indicator.left {
        display: block;
      }
      .acct-dock-item.drop-target-after > .acct-dock-drop-indicator.right {
        display: block;
      }
      .acct-dock-item:hover {
        transform: scale(1.15) translateY(-2px);
      }
      .acct-dock-item.active .acct-dock-avatar {
        box-shadow: 0 0 0 1.5px #fff, 0 2px 8px rgba(0, 0, 0, 0.5);
      }
      .acct-dock-item.switching {
        animation: acctItemPulse 0.8s ease-in-out infinite alternate !important;
      }
      .acct-dock-item.switching .acct-dock-avatar {
        filter: brightness(1.25) !important;
        box-shadow: 0 0 14px rgba(99, 102, 241, 0.9) !important;
      }
      .acct-dock-item.switching .acct-dock-ring-progress {
        animation: acctRingRotate 1s linear infinite !important;
        transform-origin: 18px 18px !important;
        stroke: #818cf8 !important;
        stroke-dasharray: 40, 60 !important;
      }
      @keyframes acctRingRotate {
        0% { transform: rotate(-90deg); }
        100% { transform: rotate(270deg); }
      }
      @keyframes acctItemPulse {
        0% { transform: scale(1); }
        100% { transform: scale(1.12); }
      }
      .acct-dock-item.active::after {
        content: '';
        position: absolute;
        right: 0px;
        bottom: 0px;
        width: 8px;
        height: 8px;
        background: #10b981;
        border: 2px solid #141416;
        border-radius: 50%;
        z-index: 3;
      }
      .acct-dock-tooltip {
        position: absolute;
        bottom: calc(100% + 10px);
        left: 50%;
        transform: translateX(-50%) translateY(4px);
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
      .acct-dock-item:hover .acct-dock-tooltip,
      .acct-dock-hub-btn:hover .acct-dock-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0);
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
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 1px dashed rgba(255, 255, 255, 0.28);
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        cursor: pointer;
        transition: all 0.2s;
        flex-shrink: 0;
      }
      .acct-dock-add-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border-color: rgba(255, 255, 255, 0.5);
        transform: scale(1.08);
      }
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

      /* Account Hub 全屏/居中看板弹层 */
      #acct-hub-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.68);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
        animation: hubFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #f1f5f9;
        user-select: none;
      }
      @keyframes hubFadeIn {
        from { opacity: 0; transform: scale(0.98); }
        to { opacity: 1; transform: scale(1); }
      }
      .acct-hub-modal {
        width: 1040px;
        max-width: 95vw;
        height: 720px;
        max-height: 90vh;
        background: rgba(22, 23, 29, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 18px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .hub-header {
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-shrink: 0;
      }
      .hub-title-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .hub-title {
        font-size: 16px;
        font-weight: 700;
        color: #f8fafc;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hub-count-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.08);
        color: #94a3b8;
        font-weight: 500;
      }
      .hub-search-input {
        width: 240px;
        padding: 7px 12px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #f8fafc;
        font-size: 12.5px;
        outline: none;
        transition: all 0.2s;
      }
      .hub-search-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
        width: 270px;
      }
      .hub-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .hub-btn {
        padding: 7px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s;
        border: 1px solid transparent;
      }
      .hub-btn-default {
        background: rgba(255, 255, 255, 0.08);
        color: #e2e8f0;
        border-color: rgba(255, 255, 255, 0.1);
      }
      .hub-btn-default:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
      .hub-btn-primary {
        background: #2563eb;
        color: #fff;
      }
      .hub-btn-primary:hover {
        background: #1d4ed8;
      }
      .hub-btn-feishu {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border-color: rgba(16, 185, 129, 0.3);
      }
      .hub-btn-feishu:hover {
        background: rgba(16, 185, 129, 0.25);
        color: #6ee7b7;
      }
      .hub-close-btn {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #94a3b8;
        font-size: 16px;
        transition: all 0.15s;
      }
      .hub-close-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .hub-group-tabs {
        padding: 10px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        align-items: center;
        gap: 8px;
        overflow-x: auto;
        flex-shrink: 0;
      }
      .hub-group-tabs::-webkit-scrollbar { height: 4px; }
      .hub-group-tabs::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 2px; }
      .hub-tab-item {
        padding: 5px 12px;
        border-radius: 16px;
        font-size: 12px;
        cursor: pointer;
        color: #94a3b8;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid transparent;
        white-space: nowrap;
        transition: all 0.15s;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hub-tab-item:hover {
        color: #f1f5f9;
        background: rgba(255, 255, 255, 0.08);
      }
      .hub-tab-item.active {
        color: #fff;
        background: #3b82f6;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35);
      }
      .hub-tab-badge {
        font-size: 10px;
        opacity: 0.8;
      }
      .hub-grid-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
        align-content: start;
      }
      .hub-grid-body::-webkit-scrollbar { width: 6px; }
      .hub-grid-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); border-radius: 3px; }
      .hub-card {
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        cursor: pointer;
        position: relative;
      }
      .hub-card:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.18);
        transform: translateY(-2px);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
      }
      .hub-card.active {
        border-color: #3b82f6;
        background: rgba(59, 130, 246, 0.08);
        box-shadow: 0 0 0 1px #3b82f6, 0 8px 24px rgba(59, 130, 246, 0.2);
      }
      .hub-card-header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .hub-card-avatar {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: 700;
        font-size: 14px;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }
      .hub-card-info {
        flex: 1;
        min-width: 0;
      }
      .hub-card-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hub-card-name {
        font-size: 14px;
        font-weight: 700;
        color: #f8fafc;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hub-card-group-tag {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        color: #94a3b8;
        flex-shrink: 0;
      }
      .hub-card-active-pill {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        font-weight: 600;
        flex-shrink: 0;
      }
      .hub-card-meta {
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11.5px;
      }
      .hub-meta-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        color: #cbd5e1;
        line-height: 1.4;
      }
      .hub-meta-label {
        color: #64748b;
        flex-shrink: 0;
      }
      .hub-meta-val {
        color: #e2e8f0;
        word-break: break-all;
      }
      .hub-usage-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .hub-usage-head {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
      }
      .hub-usage-title { color: #64748b; }
      .hub-usage-stat { font-weight: 600; color: #cbd5e1; }
      .hub-progress-track {
        height: 6px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .hub-progress-bar {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      .hub-progress-bar.normal { background: #10b981; }
      .hub-progress-bar.warning { background: #f59e0b; }
      .hub-progress-bar.exhausted { background: #ef4444; }
      .hub-card-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: auto;
        padding-top: 4px;
      }
      .hub-card-switch-btn {
        flex: 1;
        padding: 6px 10px;
        border-radius: 6px;
        background: #2563eb;
        color: #fff;
        font-size: 11.5px;
        font-weight: 600;
        text-align: center;
        border: none;
        cursor: pointer;
        transition: background 0.15s;
      }
      .hub-card-switch-btn:hover { background: #1d4ed8; }
      .hub-card-switch-btn.active {
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        cursor: default;
      }
      .hub-card-icon-btn {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #94a3b8;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.15s;
      }
      .hub-card-icon-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
      }
      .hub-card-icon-btn.danger:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #f87171;
        border-color: rgba(239, 68, 68, 0.3);
      }
      .hub-empty-state {
        grid-column: 1 / -1;
        text-align: center;
        padding: 60px 20px;
        color: #64748b;
        font-size: 14px;
      }

      /* 详情编辑表单 */
      .hub-form-row {
        margin-bottom: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        text-align: left;
      }
      .hub-form-label {
        font-size: 12px;
        color: #94a3b8;
        font-weight: 500;
      }
      .hub-form-input, .hub-form-select, .hub-form-textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #f8fafc;
        font-size: 13px;
        outline: none;
      }
      .hub-form-input:focus, .hub-form-select:focus, .hub-form-textarea:focus {
        border-color: #3b82f6;
      }
      .hub-form-textarea {
        resize: vertical;
        min-height: 54px;
      }
    `;
    target.appendChild(style);
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

  function showToast(msg) {
    let tEl = document.getElementById('hub-toast');
    if (!tEl) {
      tEl = document.createElement('div');
      tEl.id = 'hub-toast';
      Object.assign(tEl.style, {
        position: 'fixed',
        top: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        backgroundColor: 'rgba(24, 28, 38, 0.95)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        color: '#f8fafc',
        padding: '10px 18px',
        borderRadius: '10px',
        fontSize: '13px',
        fontWeight: '500',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.5)',
        transition: 'all 0.2s',
        pointerEvents: 'none',
      });
      document.body.appendChild(tEl);
    }
    tEl.textContent = msg;
    tEl.style.opacity = '1';
    tEl.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(() => {
      if (tEl) {
        tEl.style.opacity = '0';
        tEl.style.transform = 'translateX(-50%) translateY(-8px)';
      }
    }, 2800);
  }

  // ---- 九宫格/多宫格账号管理看板 (Account Hub) -------------------------------
  function closeAccountHub() {
    dockState.hubOpen = false;
    if (hubOverlay && hubOverlay.parentNode) {
      hubOverlay.parentNode.removeChild(hubOverlay);
    }
    hubOverlay = null;
    if (!dockState.pinned) {
      scheduleAutoCollapse(350);
    }
  }

  function openAccountHub() {
    closeContextMenu();
    closeModal();
    dockState.hubOpen = true;
    cancelAutoCollapse();
    if (!dockState.pinned) {
      dockState.collapsed = false;
      if (dockContainer) dockContainer.classList.remove('collapsed');
      updateHeaderButtons();
    }
    renderAccountHub();
  }

  function renderAccountHub() {
    const t = getT();
    if (!hubOverlay) {
      hubOverlay = document.createElement('div');
      hubOverlay.id = 'acct-hub-overlay';
      hubOverlay.onclick = (e) => {
        if (e.target === hubOverlay) closeAccountHub();
      };
      document.body.appendChild(hubOverlay);
    }
    hubOverlay.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'acct-hub-modal';
    modal.onclick = (e) => e.stopPropagation();

    // 1. Header
    const header = document.createElement('div');
    header.className = 'hub-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'hub-title-wrap';

    const title = document.createElement('div');
    title.className = 'hub-title';
    title.innerHTML = `<span>⊞</span><span>${t.accountHubTitle}</span>`;

    const countBadge = document.createElement('span');
    countBadge.className = 'hub-count-badge';
    countBadge.textContent = `${dockState.profiles.length} 账号 · ${(dockState.accountGroups || []).length} 群组`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(countBadge);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'hub-search-input';
    searchInput.placeholder = t.searchAccountPlaceholder;
    searchInput.value = dockState.searchKeyword || '';
    searchInput.oninput = (e) => {
      dockState.searchKeyword = e.target.value.trim().toLowerCase();
      renderHubGridCards();
    };

    const actions = document.createElement('div');
    actions.className = 'hub-actions';

    // 导出配置备份按钮
    const exportConfigBtn = document.createElement('button');
    exportConfigBtn.className = 'hub-btn hub-btn-default';
    exportConfigBtn.type = 'button';
    exportConfigBtn.title = t.exportConfigTooltip;
    exportConfigBtn.innerHTML = `<span>📤</span><span>${t.exportConfigBtn}</span>`;
    exportConfigBtn.onclick = async () => {
      exportConfigBtn.disabled = true;
      try {
        const res = await ipcRenderer.invoke('config:export');
        if (res && res.ok) {
          showToast(`已成功导出 ${res.profileCount} 个账号与代理配置！`);
        } else if (res && !res.canceled) {
          showToast(`导出失败: ${res.error || '未知错误'}`);
        }
      } catch (err) {
        showToast(`导出失败: ${err.message}`);
      } finally {
        exportConfigBtn.disabled = false;
      }
    };

    // 导入配置备份按钮
    const importConfigBtn = document.createElement('button');
    importConfigBtn.className = 'hub-btn hub-btn-default';
    importConfigBtn.type = 'button';
    importConfigBtn.title = t.importConfigTooltip;
    importConfigBtn.innerHTML = `<span>📥</span><span>${t.importConfigBtn}</span>`;
    importConfigBtn.onclick = async () => {
      importConfigBtn.disabled = true;
      try {
        const res = await ipcRenderer.invoke('config:import');
        if (res && res.ok) {
          showToast(`成功恢复 ${res.profileCount} 个账号与代理配置！`);
          renderAccountHub();
        } else if (res && !res.canceled) {
          showToast(`导入失败: ${res.error || '未知错误'}`);
        }
      } catch (err) {
        showToast(`导入失败: ${err.message}`);
      } finally {
        importConfigBtn.disabled = false;
      }
    };

    // 打开本地数据目录按钮
    const openDirBtn = document.createElement('button');
    openDirBtn.className = 'hub-btn hub-btn-default';
    openDirBtn.type = 'button';
    openDirBtn.title = t.openDataDirTooltip;
    openDirBtn.innerHTML = `<span>📁</span><span>${t.openDataDirBtn}</span>`;
    openDirBtn.onclick = () => {
      ipcRenderer.invoke('config:open-data-dir').catch(() => {});
    };

    // 飞书同步按钮
    const feishuSyncBtn = document.createElement('button');
    feishuSyncBtn.className = 'hub-btn hub-btn-feishu';
    feishuSyncBtn.type = 'button';
    feishuSyncBtn.innerHTML = `<span>🔄</span><span>${t.feishuSyncBtn}</span>`;
    feishuSyncBtn.title = t.feishuSyncNow;
    feishuSyncBtn.onclick = async () => {
      feishuSyncBtn.disabled = true;
      feishuSyncBtn.innerHTML = `<span>⏳</span><span>${t.feishuSyncing}</span>`;
      try {
        const res = await ipcRenderer.invoke('feishu:sync-now');
        if (res && res.ok) {
          showToast(`飞书同步成功：匹配更新 ${res.updatedProfiles} 个账号`);
        } else {
          showToast(`飞书同步提示：${(res && res.error) || '未知错误'}`);
        }
      } catch (err) {
        showToast(`飞书同步失败: ${err.message}`);
      } finally {
        feishuSyncBtn.disabled = false;
        feishuSyncBtn.innerHTML = `<span>🔄</span><span>${t.feishuSyncBtn}</span>`;
      }
    };

    // 飞书配置按钮
    const feishuConfigBtn = document.createElement('button');
    feishuConfigBtn.className = 'hub-btn hub-btn-default';
    feishuConfigBtn.type = 'button';
    feishuConfigBtn.title = t.feishuSyncSettings;
    feishuConfigBtn.innerHTML = '<span>⚙️ 飞书配置</span>';
    feishuConfigBtn.onclick = () => openFeishuSettingsModal();

    // 新增账号按钮
    const addBtn = document.createElement('button');
    addBtn.className = 'hub-btn hub-btn-primary';
    addBtn.type = 'button';
    addBtn.innerHTML = `<span>➕</span><span>${t.addAccountPromptTitle}</span>`;
    addBtn.onclick = () => {
      showPromptModal(t.addAccountPromptTitle, t.addAccountDefaultName(dockState.profiles.length + 1), (name) => {
        ipcRenderer.invoke('account:add', { name }).catch(() => {});
      });
    };

    // 关闭按钮
    const closeBtn = document.createElement('div');
    closeBtn.className = 'hub-close-btn';
    closeBtn.innerHTML = '✕';
    closeBtn.onclick = closeAccountHub;

    actions.appendChild(exportConfigBtn);
    actions.appendChild(importConfigBtn);
    actions.appendChild(openDirBtn);
    actions.appendChild(feishuSyncBtn);
    actions.appendChild(feishuConfigBtn);
    actions.appendChild(addBtn);
    actions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(searchInput);
    header.appendChild(actions);
    modal.appendChild(header);

    // Grid 卡片网格容器 (全景卡片直观陈列，无需分组层级)
    const gridBody = document.createElement('div');
    gridBody.className = 'hub-grid-body';
    modal.appendChild(gridBody);

    function renderHubGridCards() {
      gridBody.innerHTML = '';
      const kw = (dockState.searchKeyword || '').toLowerCase();

      const filtered = (dockState.profiles || []).filter((p) => {
        if (!kw) return true;
        const matchName = (p.name || '').toLowerCase().includes(kw);
        const matchPurpose = (p.purpose || '').toLowerCase().includes(kw);
        return matchName || matchPurpose;
      });

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hub-empty-state';
        empty.innerHTML = `<div>🔍 没有找到匹配的账号记录</div><div style="font-size:12px;margin-top:6px;opacity:0.7;">可尝试更换搜索词或选择其他群组标签</div>`;
        gridBody.appendChild(empty);
        return;
      }

      filtered.forEach((p) => {
        const card = document.createElement('div');
        const isActive = p.id === dockState.activeProfileId;
        card.className = 'hub-card' + (isActive ? ' active' : '');

        // 点击卡片主体快捷切号并关闭
        card.onclick = (e) => {
          if (p.id !== dockState.activeProfileId) {
            ipcRenderer.invoke('account:switch', { id: p.id }).catch(() => {});
            closeAccountHub();
          }
        };

        // 卡片头部
        const cardHeader = document.createElement('div');
        cardHeader.className = 'hub-card-header';

        const avatar = document.createElement('div');
        avatar.className = 'hub-card-avatar';
        avatar.style.backgroundColor = p.color || '#3b82f6';
        avatar.textContent = getInitials(p.name);

        const cardInfo = document.createElement('div');
        cardInfo.className = 'hub-card-info';

        const titleRow = document.createElement('div');
        titleRow.className = 'hub-card-title-row';

        const nameEl = document.createElement('span');
        nameEl.className = 'hub-card-name';
        nameEl.textContent = p.name;
        titleRow.appendChild(nameEl);

        if (isActive) {
          const activePill = document.createElement('span');
          activePill.className = 'hub-card-active-pill';
          activePill.textContent = t.currentActive;
          titleRow.appendChild(activePill);
        }

        cardInfo.appendChild(titleRow);
        cardHeader.appendChild(avatar);
        cardHeader.appendChild(cardInfo);
        card.appendChild(cardHeader);

        // 卡片内容：主要用途与 Token 重置
        const metaBox = document.createElement('div');
        metaBox.className = 'hub-card-meta';

        // 主要用途
        const purposeRow = document.createElement('div');
        purposeRow.className = 'hub-meta-row';
        purposeRow.innerHTML = `<span class="hub-meta-label">📌 ${t.purposeLabel}:</span><span class="hub-meta-val">${p.purpose ? p.purpose : `<span style="color:#64748b;font-style:italic;">${t.noPurpose}</span>`}</span>`;
        metaBox.appendChild(purposeRow);

        // 重置倒计时
        const resetRow = document.createElement('div');
        resetRow.className = 'hub-meta-row';
        const displayReset = p.tokenResetAt ? formatDateTime(p.tokenResetAt) : '';
        resetRow.innerHTML = `<span class="hub-meta-label">⏳ ${t.tokenResetLabel}:</span><span class="hub-meta-val">${displayReset ? displayReset : `<span style="color:#64748b;font-style:italic;">${t.noResetInfo}</span>`}</span>`;
        metaBox.appendChild(resetRow);

        // 代理模式与出口队列
        const proxyRow = document.createElement('div');
        proxyRow.className = 'hub-meta-row';

        const proxyLabel = document.createElement('span');
        proxyLabel.className = 'hub-meta-label';
        proxyLabel.textContent = '🛡️ 代理模式:';

        const proxyVal = document.createElement('span');
        proxyVal.className = 'hub-meta-val';

        const acctMode = p.proxyMode || 'inherit';
        let queueText = '';
        let queueTitle = '';
        let queueColor = '#818cf8';

        if (acctMode === 'system') {
          queueText = '🖥️ 走系统代理 / TUN';
          queueTitle = '强制独立使用 Windows 系统网络代理与 TUN 虚拟网卡';
          queueColor = '#38bdf8';
        } else if (acctMode === 'direct') {
          queueText = '⚡ 直接连接 (Direct)';
          queueTitle = '绕过任何代理，直连互联网';
          queueColor = '#fbbf24';
        } else if (acctMode === 'custom') {
          const cPort = (p.proxyCustom && p.proxyCustom.port) || 7897;
          queueText = `⚙️ 自定义代理 (: ${cPort})`;
          queueTitle = `独立自定义代理: ${(p.proxyCustom && p.proxyCustom.type) || 'HTTP'}://${(p.proxyCustom && p.proxyCustom.host) || '127.0.0.1'}:${cPort}`;
          queueColor = '#c084fc';
        } else {
          // inherit or mihomo
          const queue = Array.isArray(p.proxyQueue) && p.proxyQueue.length > 0 ? p.proxyQueue : null;
          if (queue) {
            queueText = queue.length === 1 ? `🛡️ ${queue[0]}` : `🛡️ ${queue[0]} (备用+${queue.length - 1})`;
            queueTitle = queue.join(' ➔ ');
            queueColor = '#818cf8';
          } else {
            queueText = acctMode === 'mihomo' ? '🛡️ 全部可用节点' : '🌐 跟随全局设置';
            queueTitle = '跟随客户端全局网络与代理设置';
            queueColor = '#64748b';
          }
        }

        proxyVal.title = queueTitle;
        const proxyInner = document.createElement('span');
        proxyInner.style.cssText = `color:${queueColor}; font-weight:600;`;
        proxyInner.textContent = queueText;

        proxyVal.appendChild(proxyInner);
        proxyRow.appendChild(proxyLabel);
        proxyRow.appendChild(proxyVal);
        metaBox.appendChild(proxyRow);

        card.appendChild(metaBox);

        // 用量进度条
        const usageWrap = document.createElement('div');
        usageWrap.className = 'hub-usage-wrap';

        const usagePercent = typeof p.usagePercent === 'number' ? p.usagePercent : 0;
        const usageHead = document.createElement('div');
        usageHead.className = 'hub-usage-head';
        usageHead.innerHTML = `<span class="hub-usage-title">📊 ${t.usageLabel}</span><span class="hub-usage-stat">${p.usageText ? p.usageText : `${usagePercent}%`}</span>`;

        const track = document.createElement('div');
        track.className = 'hub-progress-track';

        const bar = document.createElement('div');
        let statusClass = 'normal';
        if (usagePercent >= 90 || p.status === 'exhausted') statusClass = 'exhausted';
        else if (usagePercent >= 70 || p.status === 'warning') statusClass = 'warning';
        bar.className = `hub-progress-bar ${statusClass}`;
        bar.style.width = `${Math.min(100, Math.max(0, usagePercent))}%`;

        track.appendChild(bar);
        usageWrap.appendChild(usageHead);
        usageWrap.appendChild(track);
        card.appendChild(usageWrap);

        // 卡片底部操作按钮栏
        const cardActions = document.createElement('div');
        cardActions.className = 'hub-card-actions';

        const switchBtn = document.createElement('button');
        switchBtn.className = 'hub-card-switch-btn' + (isActive ? ' active' : '');
        switchBtn.type = 'button';
        switchBtn.textContent = isActive ? `✓ ${t.currentActive}` : t.switchToAccount;
        switchBtn.onclick = (e) => {
          e.stopPropagation();
          if (!isActive) {
            ipcRenderer.invoke('account:switch', { id: p.id }).catch(() => {});
            closeAccountHub();
          }
        };

        const editBtn = document.createElement('button');
        editBtn.className = 'hub-card-icon-btn';
        editBtn.type = 'button';
        editBtn.title = t.editMeta;
        editBtn.innerHTML = '✏️';
        editBtn.onclick = (e) => {
          e.stopPropagation();
          openEditProfileModal(p);
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'hub-card-icon-btn danger';
        delBtn.type = 'button';
        delBtn.title = t.deleteAccount;
        delBtn.innerHTML = '🗑';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          if (dockState.profiles.length <= 1) {
            showToast('至少保留一个账号');
            return;
          }
          if (confirm(t.deleteConfirm(p.name))) {
            ipcRenderer.invoke('account:delete', { id: p.id }).catch(() => {});
          }
        };

        cardActions.appendChild(switchBtn);
        cardActions.appendChild(editBtn);
        if (!isActive && dockState.profiles.length > 1) {
          cardActions.appendChild(delBtn);
        }

        card.appendChild(cardActions);
        gridBody.appendChild(card);
      });
    }

    renderHubGridCards();
    hubOverlay.appendChild(modal);
  }

  // 编辑账号元数据模态框
  // 批量多选代理节点模态框 (嵌套浮层)
  function openBatchNodeSelectModal({ allNodes, currentQueue, onAddBatch }) {
    const batchOverlay = document.createElement('div');
    batchOverlay.className = 'acct-modal-overlay';
    batchOverlay.style.zIndex = '2147483647';

    const bCard = document.createElement('div');
    bCard.className = 'acct-modal-card';
    bCard.style.cssText = 'width:500px; max-height:86vh; display:flex; flex-direction:column; padding:16px; background:#1b1e25; border:1px solid #333948; border-radius:8px; box-shadow:0 12px 36px rgba(0,0,0,0.6);';

    // 头部标题
    const bHeader = document.createElement('div');
    bHeader.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;';
    bHeader.innerHTML = `
      <div style="font-size:14px; font-weight:600; color:#e8eaf0; display:flex; align-items:center; gap:8px;">
        <span>📦 批量选择代理节点</span>
        <span style="font-size:11.5px; color:#818cf8; font-weight:normal;">(共 ${allNodes.length} 个可用)</span>
      </div>
    `;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'acct-modal-btn';
    closeBtn.style.cssText = 'padding:2px 8px; font-size:12px; height:24px; color:#94a3b8;';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => batchOverlay.remove();
    bHeader.appendChild(closeBtn);
    bCard.appendChild(bHeader);

    // 实时搜索框
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 输入关键词实时搜索 (如: us, 香港, 0.1, 专线, 节点名)...';
    searchInput.style.cssText = 'width:100%; box-sizing:border-box; background:#23262e; border:1px solid #3a3f4b; color:#e8eaf0; padding:6px 10px; border-radius:6px; font-size:12px; margin-bottom:8px;';
    bCard.appendChild(searchInput);

    // 快捷地区筛选标签
    const filterChipsWrap = document.createElement('div');
    filterChipsWrap.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap; margin-bottom:8px;';
    const filterOptions = [
      { id: 'all', label: '全部' },
      { id: 'us', label: '美国 (US)' },
      { id: 'hk', label: '香港 (HK)' },
      { id: 'jp', label: '日本 (JP)' },
      { id: 'sg', label: '新加坡 (SG)' },
      { id: 'unadded', label: '未在队列' },
    ];
    let activeFilter = 'all';

    const selectedSet = new Set();

    const matchesFilter = (node, filterId, query) => {
      if (!node || !node.name) return false;
      const name = String(node.name).toLowerCase();
      if (filterId === 'us') {
        const isUS = /us|美国|united states|america|洛杉矶|圣何塞|西雅图|硅谷|纽约|芝加哥|凤凰城/.test(name);
        if (!isUS) return false;
      } else if (filterId === 'hk') {
        const isHK = /hk|香港|hong kong/.test(name);
        if (!isHK) return false;
      } else if (filterId === 'jp') {
        const isJP = /jp|日本|japan|东京|大阪/.test(name);
        if (!isJP) return false;
      } else if (filterId === 'sg') {
        const isSG = /sg|新加坡|singapore/.test(name);
        if (!isSG) return false;
      } else if (filterId === 'unadded') {
        if (currentQueue.includes(node.name)) return false;
      }
      if (query) {
        const q = query.trim().toLowerCase();
        const srcName = String(node._sourceName || '').toLowerCase();
        if (!name.includes(q) && !srcName.includes(q) && !(node.type || '').toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    };

    // 操作工具条 (全选当前筛选, 反选, 清空勾选)
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:11px;';
    
    const actionLeft = document.createElement('div');
    actionLeft.style.cssText = 'display:flex; gap:6px;';

    const btnSelectAllFiltered = document.createElement('button');
    btnSelectAllFiltered.type = 'button';
    btnSelectAllFiltered.className = 'acct-modal-btn';
    btnSelectAllFiltered.style.cssText = 'padding:2px 8px; font-size:11px; height:24px;';
    btnSelectAllFiltered.textContent = '全选筛选';

    const btnInvertFiltered = document.createElement('button');
    btnInvertFiltered.type = 'button';
    btnInvertFiltered.className = 'acct-modal-btn';
    btnInvertFiltered.style.cssText = 'padding:2px 8px; font-size:11px; height:24px;';
    btnInvertFiltered.textContent = '反选';

    const btnClearSelected = document.createElement('button');
    btnClearSelected.type = 'button';
    btnClearSelected.className = 'acct-modal-btn';
    btnClearSelected.style.cssText = 'padding:2px 8px; font-size:11px; height:24px; color:#94a3b8;';
    btnClearSelected.textContent = '清空选择';

    actionLeft.appendChild(btnSelectAllFiltered);
    actionLeft.appendChild(btnInvertFiltered);
    actionLeft.appendChild(btnClearSelected);

    const selectionSummary = document.createElement('span');
    selectionSummary.style.cssText = 'color:#a5b4fc; font-weight:600; font-size:11px;';
    selectionSummary.textContent = '已勾选 0 个节点';

    actionRow.appendChild(actionLeft);
    actionRow.appendChild(selectionSummary);
    bCard.appendChild(actionRow);

    // 节点列表可滚动区域
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1; max-height:260px; overflow-y:auto; background:#16181d; border:1px solid #2d323e; border-radius:6px; padding:4px 6px; margin-bottom:12px;';
    bCard.appendChild(listWrap);

    let currentFilteredList = [];

    const updateSummary = () => {
      selectionSummary.textContent = `已勾选 ${selectedSet.size} 个节点`;
      confirmBatchBtn.textContent = `确认加入队列 (+ 添加 ${selectedSet.size} 个)`;
      confirmBatchBtn.disabled = selectedSet.size === 0;
    };

    const renderList = () => {
      listWrap.innerHTML = '';
      const q = searchInput.value;
      currentFilteredList = allNodes.filter(n => matchesFilter(n, activeFilter, q));

      if (currentFilteredList.length === 0) {
        listWrap.innerHTML = '<div style="color:#64748b; font-size:11.5px; text-align:center; padding:20px;">没有匹配的代理节点</div>';
        return;
      }

      currentFilteredList.forEach((node) => {
        const item = document.createElement('label');
        item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:5px 8px; border-bottom:1px solid #23262e; cursor:pointer; user-select:none; font-size:11.5px;';
        
        const leftBox = document.createElement('div');
        leftBox.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1;';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.style.cssText = 'accent-color:#6366f1; cursor:pointer; flex-shrink:0;';
        chk.checked = selectedSet.has(node.name);
        chk.onchange = () => {
          if (chk.checked) selectedSet.add(node.name);
          else selectedSet.delete(node.name);
          updateSummary();
        };

        const typeBadge = document.createElement('span');
        typeBadge.style.cssText = 'font-size:10px; color:#818cf8; font-weight:600; flex-shrink:0;';
        typeBadge.textContent = `[${String(node.type || '').toUpperCase()}]`;

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'color:#cfd3dc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        nameSpan.textContent = node.name;
        nameSpan.title = node.name;

        leftBox.appendChild(chk);
        leftBox.appendChild(typeBadge);
        leftBox.appendChild(nameSpan);

        const rightBox = document.createElement('div');
        rightBox.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

        if (node._sourceName) {
          const srcBadge = document.createElement('span');
          srcBadge.style.cssText = 'font-size:10px; color:#64748b; background:#1e2128; padding:1px 4px; border-radius:3px;';
          srcBadge.textContent = node._sourceName;
          rightBox.appendChild(srcBadge);
        }

        if (currentQueue.includes(node.name)) {
          const inQueueBadge = document.createElement('span');
          inQueueBadge.style.cssText = 'font-size:10px; color:#818cf8; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.3); padding:1px 5px; border-radius:3px;';
          inQueueBadge.textContent = '已在队列';
          rightBox.appendChild(inQueueBadge);
        }

        item.appendChild(leftBox);
        item.appendChild(rightBox);
        listWrap.appendChild(item);
      });
    };

    filterOptions.forEach(opt => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'acct-modal-btn';
      chip.style.cssText = 'padding:2px 8px; font-size:11px; height:22px; border-radius:11px;';
      chip.textContent = opt.label;
      const updateChipStyle = () => {
        if (activeFilter === opt.id) {
          chip.style.background = '#4f46e5';
          chip.style.color = '#fff';
          chip.style.borderColor = '#6366f1';
        } else {
          chip.style.background = '#23262e';
          chip.style.color = '#94a3b8';
          chip.style.borderColor = '#3a3f4b';
        }
      };
      updateChipStyle();
      chip.onclick = () => {
        activeFilter = opt.id;
        Array.from(filterChipsWrap.children).forEach((c, idx) => {
          c.style.background = (filterOptions[idx].id === activeFilter) ? '#4f46e5' : '#23262e';
          c.style.color = (filterOptions[idx].id === activeFilter) ? '#fff' : '#94a3b8';
          c.style.borderColor = (filterOptions[idx].id === activeFilter) ? '#6366f1' : '#3a3f4b';
        });
        renderList();
      };
      filterChipsWrap.appendChild(chip);
    });
    bCard.insertBefore(filterChipsWrap, actionRow);

    btnSelectAllFiltered.onclick = () => {
      currentFilteredList.forEach(n => selectedSet.add(n.name));
      renderList();
      updateSummary();
    };

    btnInvertFiltered.onclick = () => {
      currentFilteredList.forEach(n => {
        if (selectedSet.has(n.name)) selectedSet.delete(n.name);
        else selectedSet.add(n.name);
      });
      renderList();
      updateSummary();
    };

    btnClearSelected.onclick = () => {
      selectedSet.clear();
      renderList();
      updateSummary();
    };

    searchInput.oninput = () => renderList();

    // 底部操作按钮
    const bFooter = document.createElement('div');
    bFooter.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';

    const cancelBatchBtn = document.createElement('button');
    cancelBatchBtn.type = 'button';
    cancelBatchBtn.className = 'acct-modal-btn cancel';
    cancelBatchBtn.textContent = '取消';
    cancelBatchBtn.onclick = () => batchOverlay.remove();

    const confirmBatchBtn = document.createElement('button');
    confirmBatchBtn.type = 'button';
    confirmBatchBtn.className = 'acct-modal-btn confirm';
    confirmBatchBtn.textContent = '确认加入队列 (+ 添加 0 个)';
    confirmBatchBtn.disabled = true;
    confirmBatchBtn.onclick = () => {
      const addedList = Array.from(selectedSet);
      batchOverlay.remove();
      if (typeof onAddBatch === 'function') {
        onAddBatch(addedList);
      }
    };

    bFooter.appendChild(cancelBatchBtn);
    bFooter.appendChild(confirmBatchBtn);
    bCard.appendChild(bFooter);

    batchOverlay.appendChild(bCard);
    document.body.appendChild(batchOverlay);

    renderList();
    updateSummary();
  }

  // 编辑账号信息模态框
  function openEditProfileModal(p) {
    closeModal();
    const t = getT();
    const overlay = document.createElement('div');
    overlay.className = 'acct-modal-overlay';

    const card = document.createElement('div');
    card.className = 'acct-modal-card';
    card.style.cssText = 'width:460px; max-height:92vh; overflow-y:auto;';

    const titleEl = document.createElement('div');
    titleEl.className = 'acct-modal-title';
    titleEl.textContent = t.editProfileTitle(p.name);

    // 1. 昵称
    const nameRow = document.createElement('div');
    nameRow.className = 'hub-form-row';
    nameRow.innerHTML = `<label class="hub-form-label">${t.renameAccount}</label>`;
    const nameInput = document.createElement('input');
    nameInput.className = 'hub-form-input';
    nameInput.value = p.name || '';
    nameRow.appendChild(nameInput);

    // 2. 主要用途
    const purposeRow = document.createElement('div');
    purposeRow.className = 'hub-form-row';
    purposeRow.innerHTML = `<label class="hub-form-label">${t.purposeLabel}</label>`;
    const purposeInput = document.createElement('textarea');
    purposeInput.className = 'hub-form-textarea';
    purposeInput.value = p.purpose || '';
    purposeInput.placeholder = '例如：竞品技术调研、生产环境自动化测试、客服会话...';
    purposeRow.appendChild(purposeInput);

    // 3. 用量占比与明细
    const usageRow = document.createElement('div');
    usageRow.className = 'hub-form-row';
    usageRow.innerHTML = `<label class="hub-form-label">${t.usagePercentLabel}</label>`;
    const usageInput = document.createElement('input');
    usageInput.type = 'number';
    usageInput.className = 'hub-form-input';
    usageInput.min = '0';
    usageInput.max = '100';
    usageInput.value = typeof p.usagePercent === 'number' ? p.usagePercent : 0;
    usageRow.appendChild(usageInput);

    // 4. Token 重置时间
    const resetRow = document.createElement('div');
    resetRow.className = 'hub-form-row';
    resetRow.innerHTML = `<label class="hub-form-label">${t.tokenResetLabel}</label>`;
    const resetInput = document.createElement('input');
    resetInput.type = 'text';
    resetInput.className = 'hub-form-input';
    resetInput.placeholder = '例如：2026-11-05 00:00:00 或 还有 12 小时';
    resetInput.value = p.tokenResetAt ? formatDateTime(p.tokenResetAt) : '';
    resetRow.appendChild(resetInput);

    // 5. 账号独立网络代理模式选择
    let currentProxyMode = p.proxyMode || 'inherit';
    let currentCustom = (p.proxyCustom && typeof p.proxyCustom === 'object') ? { ...p.proxyCustom } : { type: 'http', host: '127.0.0.1', port: 7897 };

    const proxyModeRow = document.createElement('div');
    proxyModeRow.className = 'hub-form-row';
    proxyModeRow.style.marginTop = '10px';
    proxyModeRow.innerHTML = `<label class="hub-form-label">🌐 账号独立代理模式 (Connection Mode)</label>`;

    const modeSelect = document.createElement('select');
    modeSelect.className = 'hub-form-input';
    modeSelect.style.cssText = 'padding:5px 8px; font-size:12px;';
    modeSelect.innerHTML = `
      <option value="inherit">🌐 跟随全局网络设置 (默认)</option>
      <option value="system">🖥️ 强制走系统代理 / TUN 虚拟网卡 (System)</option>
      <option value="mihomo">🛡️ 内置 Mihomo 专属出口队列 (多账号隔离)</option>
      <option value="direct">⚡ 直接连接 (Direct - 禁用代理)</option>
      <option value="custom">⚙️ 独立自定义代理 (手动指定 IP/端口)</option>
    `;
    modeSelect.value = currentProxyMode;
    proxyModeRow.appendChild(modeSelect);

    const modeTipEl = document.createElement('div');
    modeTipEl.style.cssText = 'font-size:10.5px; color:#8a909d; margin-top:4px; line-height:1.4;';
    proxyModeRow.appendChild(modeTipEl);

    // 自定义代理配置行 (仅在选 custom 时显示)
    const customConfigWrap = document.createElement('div');
    customConfigWrap.style.cssText = 'display:none; background:#1b1e25; border:1px solid #3a3f4b; border-radius:6px; padding:8px; margin-top:6px; font-size:11.5px;';
    customConfigWrap.innerHTML = `
      <div style="font-size:11px; color:#a5b4fc; margin-bottom:4px; font-weight:600;">独立代理服务器地址:</div>
      <div style="display:flex; gap:6px; align-items:center;">
        <select id="acct-custom-type" style="background:#23262e; border:1px solid #3a3f4b; color:#e8eaf0; padding:4px 6px; border-radius:4px; font-size:11px;">
          <option value="http"${(currentCustom.type === 'http') ? ' selected' : ''}>HTTP</option>
          <option value="socks5"${(currentCustom.type === 'socks5') ? ' selected' : ''}>SOCKS5</option>
        </select>
        <input type="text" id="acct-custom-host" value="${currentCustom.host || '127.0.0.1'}" placeholder="127.0.0.1" style="flex:1; background:#23262e; border:1px solid #3a3f4b; color:#e8eaf0; padding:4px 6px; border-radius:4px; font-size:11px;">
        <input type="number" id="acct-custom-port" value="${currentCustom.port || 7897}" placeholder="7897" style="width:70px; background:#23262e; border:1px solid #3a3f4b; color:#e8eaf0; padding:4px 6px; border-radius:4px; font-size:11px;">
      </div>
    `;
    proxyModeRow.appendChild(customConfigWrap);

    // 6. 专属代理出口队列 (Mihomo)
    const proxyRow = document.createElement('div');
    proxyRow.className = 'hub-form-row';
    proxyRow.style.marginTop = '10px';
    proxyRow.innerHTML = `<label class="hub-form-label">🛡️ 专属代理出口队列 (Mihomo 故障转移)</label>`;

    const queueWrap = document.createElement('div');
    queueWrap.style.cssText = 'background:#1e2128; border:1px solid #2d323e; border-radius:6px; padding:8px; font-size:11.5px;';

    const queueNotice = document.createElement('div');
    queueNotice.style.cssText = 'font-size:11px; padding:4px 8px; background:rgba(56,189,248,0.12); color:#38bdf8; border:1px solid rgba(56,189,248,0.25); border-radius:4px; margin-bottom:8px; display:none;';
    queueWrap.appendChild(queueNotice);

    const queueSummaryEl = document.createElement('div');
    queueSummaryEl.style.cssText = 'font-size:10.5px; color:#8a909d; margin-bottom:6px;';
    queueWrap.appendChild(queueSummaryEl);

    let currentQueue = Array.isArray(p.proxyQueue) ? [...p.proxyQueue] : [];
    let currentStrategy = p.proxyStrategy || 'fallback';
    let allAvailableNodes = [];

    const tagsBox = document.createElement('div');
    tagsBox.style.cssText = 'max-height:120px; overflow-y:auto; min-height:28px; display:flex; flex-wrap:wrap; align-items:center; margin-bottom:8px; gap:4px;';

    const renderQueueTags = () => {
      tagsBox.innerHTML = '';
      queueSummaryEl.textContent = `已配置 ${currentQueue.length} 个出口节点 (首节点为主出口，失败自动故障转移)`;
      if (currentQueue.length === 0) {
        tagsBox.innerHTML = '<span style="color:#64748b;font-style:italic;">未分配专属队列 (将跟随系统/全部可用节点)</span>';
        return;
      }
      currentQueue.forEach((nodeName, idx) => {
        const tag = document.createElement('span');
        tag.style.cssText = 'display:inline-flex; align-items:center; background:rgba(99,102,241,0.18); color:#a5b4fc; border:1px solid rgba(99,102,241,0.35); border-radius:4px; padding:2px 6px; font-size:11px;';
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = `${idx === 0 ? '👑 ' : `${idx + 1}. `}${nodeName}`;

        const delSpan = document.createElement('span');
        delSpan.style.cssText = 'margin-left:5px; cursor:pointer; color:#f87171; font-weight:bold;';
        delSpan.textContent = '×';
        delSpan.onclick = () => {
          currentQueue.splice(idx, 1);
          renderQueueTags();
        };

        tag.appendChild(titleSpan);
        tag.appendChild(delSpan);
        tagsBox.appendChild(tag);
      });
    };
    renderQueueTags();
    queueWrap.appendChild(tagsBox);

    // 节点选择工具栏 (单选下拉 + 批量选择模态框 + 清空)
    const addWrap = document.createElement('div');
    addWrap.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;';

    const nodeSelect = document.createElement('select');
    nodeSelect.className = 'hub-form-input';
    nodeSelect.style.cssText = 'flex:1; min-width:160px; padding:4px 8px; font-size:11.5px; height:28px;';
    nodeSelect.innerHTML = '<option value="">-- 选择要加入队列的节点 --</option>';

    ipcRenderer.invoke('mihomo:get-nodes').then((nodes) => {
      allAvailableNodes = Array.isArray(nodes) ? nodes : [];
      if (allAvailableNodes.length > 0) {
        allAvailableNodes.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = n.name;
          opt.textContent = `[${String(n.type || '').toUpperCase()}] ${n.name}`;
          nodeSelect.appendChild(opt);
        });
      } else {
        nodeSelect.innerHTML = '<option value="">(尚未拉取机场订阅，请先在网络设置中同步)</option>';
      }
    }).catch(() => {});

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'acct-modal-btn';
    addBtn.style.cssText = 'padding:4px 8px; font-size:11px; height:28px; flex-shrink:0;';
    addBtn.textContent = '+ 添加';
    addBtn.onclick = () => {
      const val = nodeSelect.value;
      if (val && !currentQueue.includes(val)) {
        currentQueue.push(val);
        renderQueueTags();
      }
    };

    const btnBatchSelectModal = document.createElement('button');
    btnBatchSelectModal.type = 'button';
    btnBatchSelectModal.className = 'acct-modal-btn';
    btnBatchSelectModal.style.cssText = 'padding:4px 10px; font-size:11px; height:28px; flex-shrink:0; background:#4f46e5; color:#fff; border-color:#6366f1;';
    btnBatchSelectModal.textContent = '📦 批量选择节点...';
    btnBatchSelectModal.onclick = () => {
      openBatchNodeSelectModal({
        allNodes: allAvailableNodes,
        currentQueue,
        onAddBatch: (addedList) => {
          let newlyAdded = 0;
          addedList.forEach(name => {
            if (!currentQueue.includes(name)) {
              currentQueue.push(name);
              newlyAdded++;
            }
          });
          renderQueueTags();
          if (newlyAdded > 0) {
            queueSummaryEl.textContent = `已成功批量加入 ${newlyAdded} 个节点！当前共 ${currentQueue.length} 个`;
          }
        }
      });
    };

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'acct-modal-btn';
    clearBtn.style.cssText = 'padding:4px 8px; font-size:11px; height:28px; flex-shrink:0; color:#94a3b8;';
    clearBtn.textContent = '清空';
    clearBtn.onclick = () => {
      currentQueue = [];
      renderQueueTags();
    };

    addWrap.appendChild(nodeSelect);
    addWrap.appendChild(addBtn);
    addWrap.appendChild(btnBatchSelectModal);
    addWrap.appendChild(clearBtn);
    queueWrap.appendChild(addWrap);

    // 快捷批量添加快捷标签栏
    const quickWrap = document.createElement('div');
    quickWrap.style.cssText = 'display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:8px; padding-top:6px; border-top:1px dashed #2d323e;';
    
    const quickLabel = document.createElement('span');
    quickLabel.style.cssText = 'font-size:10.5px; color:#8a909d; flex-shrink:0;';
    quickLabel.textContent = '快捷批量:';
    quickWrap.appendChild(quickLabel);

    const makeQuickBtn = (label, filterFn) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'background:#1a1d24; border:1px solid #333948; color:#a5b4fc; border-radius:4px; padding:2px 6px; font-size:10.5px; cursor:pointer;';
      btn.textContent = label;
      btn.onmouseenter = () => btn.style.borderColor = '#6366f1';
      btn.onmouseleave = () => btn.style.borderColor = '#333948';
      btn.onclick = () => {
        if (!allAvailableNodes || allAvailableNodes.length === 0) return;
        const matching = allAvailableNodes.filter(filterFn).map(n => n.name);
        let addedCount = 0;
        matching.forEach(name => {
          if (!currentQueue.includes(name)) {
            currentQueue.push(name);
            addedCount++;
          }
        });
        renderQueueTags();
        if (addedCount > 0) {
          queueSummaryEl.textContent = `已快捷添加 ${addedCount} 个新节点！当前共 ${currentQueue.length} 个`;
        }
      };
      return btn;
    };

    quickWrap.appendChild(makeQuickBtn('+ 全部可用', () => true));
    quickWrap.appendChild(makeQuickBtn('+ 全部美国', n => /us|美国|united states|america|洛杉矶|圣何塞|西雅图|硅谷|纽约|芝加哥|凤凰城/i.test(n.name)));
    quickWrap.appendChild(makeQuickBtn('+ 全部香港', n => /hk|香港|hong kong/i.test(n.name)));
    quickWrap.appendChild(makeQuickBtn('+ 全部日本', n => /jp|日本|japan|东京|大阪/i.test(n.name)));
    quickWrap.appendChild(makeQuickBtn('+ 全部新加坡', n => /sg|新加坡|singapore/i.test(n.name)));

    const customMatchBtn = document.createElement('button');
    customMatchBtn.type = 'button';
    customMatchBtn.style.cssText = 'background:#1a1d24; border:1px dashed #4b5563; color:#94a3b8; border-radius:4px; padding:2px 6px; font-size:10.5px; cursor:pointer;';
    customMatchBtn.textContent = '+ 按关键字...';
    customMatchBtn.onclick = () => {
      const kw = prompt('请输入要批量匹配并添加的关键字 (如: 0.1、专线、洛杉矶、IEPL):');
      if (!kw || !kw.trim()) return;
      const cleanKw = kw.trim().toLowerCase();
      let addedCount = 0;
      allAvailableNodes.forEach(n => {
        if (n && n.name && n.name.toLowerCase().includes(cleanKw)) {
          if (!currentQueue.includes(n.name)) {
            currentQueue.push(n.name);
            addedCount++;
          }
        }
      });
      renderQueueTags();
      if (addedCount > 0) {
        queueSummaryEl.textContent = `已根据关键词 [${cleanKw}] 批量加入 ${addedCount} 个节点！当前共 ${currentQueue.length} 个`;
      } else {
        alert(`未找到包含 "${cleanKw}" 的新节点`);
      }
    };
    quickWrap.appendChild(customMatchBtn);
    queueWrap.appendChild(quickWrap);

    // 模式切换联动
    const updateModeView = (mode) => {
      currentProxyMode = mode;
      if (mode === 'system') {
        modeTipEl.textContent = '此账号将独立走系统网络代理与 TUN 虚拟网卡（绕过内置 Mihomo 内核）。';
        modeTipEl.style.color = '#38bdf8';
        customConfigWrap.style.display = 'none';
        queueNotice.style.display = 'block';
        queueNotice.textContent = '💡 提示：当前账号已设为独立走系统代理/TUN，实际连接直接使用系统网络，下方队列在切换至 Mihomo 时生效。';
      } else if (mode === 'direct') {
        modeTipEl.textContent = '此账号绕过任何系统代理、VPN 或 Mihomo 内核，直接发起原生网络连接。';
        modeTipEl.style.color = '#fbbf24';
        customConfigWrap.style.display = 'none';
        queueNotice.style.display = 'block';
        queueNotice.textContent = '💡 提示：当前账号已设为直接连接，流量将直连互联网。';
      } else if (mode === 'custom') {
        modeTipEl.textContent = '此账号流量将强制转发至下方指定的本地/局域网代理服务器。';
        modeTipEl.style.color = '#c084fc';
        customConfigWrap.style.display = 'block';
        queueNotice.style.display = 'block';
        queueNotice.textContent = '💡 提示：当前账号已设为独立自定义代理，下方队列在切换至 Mihomo 时生效。';
      } else if (mode === 'mihomo') {
        modeTipEl.textContent = '此账号强制由内置 Mihomo 托管并分配独立本地出口端口与专属故障转移队列。';
        modeTipEl.style.color = '#818cf8';
        customConfigWrap.style.display = 'none';
        queueNotice.style.display = 'none';
      } else {
        // inherit
        modeTipEl.textContent = '跟随设置中心全局网络策略（若全局开启 Mihomo 则走专属出口队列，否则走全局自适应/覆盖）。';
        modeTipEl.style.color = '#8a909d';
        customConfigWrap.style.display = 'none';
        queueNotice.style.display = 'none';
      }
    };

    modeSelect.onchange = () => updateModeView(modeSelect.value);
    updateModeView(currentProxyMode);

    proxyRow.appendChild(queueWrap);

    // 底部操作
    const actions = document.createElement('div');
    actions.className = 'acct-modal-actions';
    actions.style.marginTop = '16px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'acct-modal-btn cancel';
    cancelBtn.textContent = t.cancel;
    cancelBtn.onclick = closeModal;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'acct-modal-btn confirm';
    confirmBtn.textContent = t.saveChanges;
    confirmBtn.onclick = async () => {
      const newName = nameInput.value.trim() || p.name;
      const newPurpose = purposeInput.value.trim();
      const newUsage = parseFloat(usageInput.value) || 0;
      const newReset = resetInput.value.trim();

      const finalCustom = {
        type: document.getElementById('acct-custom-type')?.value || 'http',
        host: document.getElementById('acct-custom-host')?.value?.trim() || '127.0.0.1',
        port: parseInt(document.getElementById('acct-custom-port')?.value, 10) || 7897,
      };

      closeModal();
      await ipcRenderer.invoke('account:update-meta', {
        id: p.id,
        name: newName,
        purpose: newPurpose,
        usagePercent: newUsage,
        usageText: `${newUsage}%`,
        tokenResetAt: newReset ? formatDateTime(newReset) : '',
      }).catch(() => {});

      await ipcRenderer.invoke('account:set-proxy-queue', {
        profileId: p.id,
        proxyQueue: currentQueue,
        proxyStrategy: currentStrategy,
        proxyMode: currentProxyMode,
        proxyCustom: finalCustom,
      }).catch(() => {});

      if (dockState.hubOpen) renderAccountHub();
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    card.appendChild(titleEl);
    card.appendChild(nameRow);
    card.appendChild(purposeRow);
    card.appendChild(usageRow);
    card.appendChild(resetRow);
    card.appendChild(proxyModeRow);
    card.appendChild(proxyRow);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    activeModal = overlay;
  }

  // 飞书多维表格同步配置模态框
  async function openFeishuSettingsModal() {
    closeModal();
    const t = getT();
    const overlay = document.createElement('div');
    overlay.className = 'acct-modal-overlay';

    const card = document.createElement('div');
    card.className = 'acct-modal-card';
    card.style.width = '480px';
    card.style.maxHeight = '85vh';
    card.style.overflowY = 'auto';

    const titleEl = document.createElement('div');
    titleEl.className = 'acct-modal-title';
    titleEl.textContent = t.feishuSyncSettings;

    let cfg = {};
    try {
      cfg = (await ipcRenderer.invoke('feishu:get-config')) || {};
    } catch {}

    const createField = (label, value, placeholder = '', type = 'text') => {
      const row = document.createElement('div');
      row.className = 'hub-form-row';
      row.innerHTML = `<label class="hub-form-label">${label}</label>`;
      const input = document.createElement('input');
      input.type = type;
      input.className = 'hub-form-input';
      input.value = value || '';
      input.placeholder = placeholder;
      row.appendChild(input);
      return { row, input };
    };

    // 内置飞书引擎状态条
    const cliStatusBox = document.createElement('div');
    cliStatusBox.style.fontSize = '12px';
    cliStatusBox.style.padding = '8px 12px';
    cliStatusBox.style.borderRadius = '8px';
    cliStatusBox.style.background = 'rgba(16, 185, 129, 0.15)';
    cliStatusBox.style.color = '#34d399';
    cliStatusBox.style.border = '1px solid rgba(16, 185, 129, 0.25)';
    cliStatusBox.style.marginBottom = '12px';
    cliStatusBox.style.display = 'flex';
    cliStatusBox.style.alignItems = 'center';
    cliStatusBox.style.gap = '8px';
    cliStatusBox.innerHTML = '<span>⚡</span><span><strong>飞书 CLI:</strong> 已内置集成 (零系统依赖，免安装任何外部工具)</span>';

    const appIdF = createField(t.feishuAppId, cfg.appId, 'cli_a1b2c3d4e5f6');
    const secretF = createField(t.feishuAppSecret, cfg.appSecret, '••••••••••••••••', 'password');
    const tokenF = createField(t.feishuAppToken, cfg.appToken, 'bascnXXXXXXXXXXXX');
    const tableF = createField(t.feishuTableId, cfg.tableId, 'tblXXXXXXXXXXXX');

    // 自动同步开关
    const autoRow = document.createElement('div');
    autoRow.className = 'hub-form-row';
    autoRow.style.flexDirection = 'row';
    autoRow.style.alignItems = 'center';
    autoRow.style.justifyContent = 'space-between';
    autoRow.innerHTML = `<label class="hub-form-label">${t.feishuAutoSync}</label>`;
    const autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox';
    autoCheck.checked = !!cfg.autoSync;
    autoRow.appendChild(autoCheck);

    const intervalF = createField(t.feishuInterval, cfg.syncIntervalMinutes || 30, '30', 'number');

    // 字段映射折叠区
    const fMapTitle = document.createElement('div');
    fMapTitle.style.fontSize = '12px';
    fMapTitle.style.fontWeight = '600';
    fMapTitle.style.marginTop = '12px';
    fMapTitle.style.color = '#38bdf8';
    fMapTitle.textContent = `📋 ${t.feishuFieldMap}`;

    const fm = cfg.fieldMap || {};
    const mapNameF = createField('账号名称列', fm.name || '账号名称');
    const mapPurposeF = createField('主要用途列', fm.purpose || '主要用途');
    const mapUsageF = createField('当前用量列', fm.usage || '当前用量');
    const mapResetF = createField('重置时间列', fm.tokenReset || '重置时间');

    // 状态提示
    const statusBox = document.createElement('div');
    statusBox.style.fontSize = '11px';
    statusBox.style.color = '#94a3b8';
    statusBox.style.margin = '10px 0';
    statusBox.style.padding = '8px';
    statusBox.style.background = 'rgba(0, 0, 0, 0.25)';
    statusBox.style.borderRadius = '6px';
    statusBox.textContent = cfg.lastSyncStatus || '尚未同步过多维表格数据';

    // 底部操作
    const actions = document.createElement('div');
    actions.className = 'acct-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'acct-modal-btn cancel';
    cancelBtn.textContent = t.cancel;
    cancelBtn.onclick = closeModal;

    const saveAndSyncBtn = document.createElement('button');
    saveAndSyncBtn.className = 'acct-modal-btn confirm';
    saveAndSyncBtn.textContent = '保存并立即同步';
    saveAndSyncBtn.onclick = async () => {
      const newConfig = {
        enabled: true,
        syncMode: 'auto',
        appId: appIdF.input.value.trim(),
        appSecret: secretF.input.value.trim(),
        appToken: tokenF.input.value.trim(),
        tableId: tableF.input.value.trim(),
        autoSync: autoCheck.checked,
        syncIntervalMinutes: parseInt(intervalF.input.value, 10) || 30,
        fieldMap: {
          name: mapNameF.input.value.trim() || '账号名称',
          purpose: mapPurposeF.input.value.trim() || '主要用途',
          usage: mapUsageF.input.value.trim() || '当前用量',
          tokenReset: mapResetF.input.value.trim() || '重置时间',
        },
      };

      saveAndSyncBtn.disabled = true;
      saveAndSyncBtn.textContent = '同步中...';
      await ipcRenderer.invoke('feishu:save-config', newConfig).catch(() => {});
      try {
        const res = await ipcRenderer.invoke('feishu:sync-now');
        if (res && res.ok) {
          showToast(`飞书同步成功：匹配更新 ${res.updatedProfiles} 个账号`);
        } else {
          showToast(`飞书同步提示: ${(res && res.error) || '未知错误'}`);
        }
      } catch (err) {
        showToast(`飞书同步失败: ${err.message}`);
      }
      closeModal();
      if (dockState.hubOpen) renderAccountHub();
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(saveAndSyncBtn);

    card.appendChild(titleEl);
    card.appendChild(cliStatusBox);
    card.appendChild(appIdF.row);
    card.appendChild(secretF.row);
    card.appendChild(tokenF.row);
    card.appendChild(tableF.row);
    card.appendChild(autoRow);
    card.appendChild(intervalF.row);
    card.appendChild(fMapTitle);
    card.appendChild(mapNameF.row);
    card.appendChild(mapPurposeF.row);
    card.appendChild(mapUsageF.row);
    card.appendChild(mapResetF.row);
    card.appendChild(statusBox);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    activeModal = overlay;
  }

  function openItemContextMenu(e, profile) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    const t = getT();

    const menu = document.createElement('div');
    menu.className = 'acct-context-menu';

    // 0. 打开账号九宫格总览看板
    const hubItem = document.createElement('div');
    hubItem.className = 'acct-context-item';
    hubItem.innerHTML = `<span>⊞</span><span>${t.accountHubTitle}</span>`;
    hubItem.onclick = () => {
      closeContextMenu();
      openAccountHub();
    };
    menu.appendChild(hubItem);

    // 1. 编辑详情 (含用途、用量与群组)
    const editItem = document.createElement('div');
    editItem.className = 'acct-context-item';
    editItem.innerHTML = `<span>📝</span><span>${t.editMeta}</span>`;
    editItem.onclick = () => {
      closeContextMenu();
      openEditProfileModal(profile);
    };
    menu.appendChild(editItem);

    // 2. 修改备注
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

    const menuHeight = 160;
    const top = (e.clientY + menuHeight > window.innerHeight)
      ? Math.max(10, e.clientY - menuHeight)
      : e.clientY + 5;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.min(e.clientX + 5, window.innerWidth - 170)}px`;
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function renderDock() {
    const parent = document.body;
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
    } else if (!dockContainer.parentNode || dockContainer.parentNode !== parent) {
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

    // 左侧区域 (折叠按钮、固定图钉、九宫格总览看板)
    const leftSection = document.createElement('div');
    leftSection.className = 'acct-dock-section';

    const collapseBtn = document.createElement('div');
    collapseBtn.className = 'acct-dock-collapse-btn';
    collapseBtn.title = dockState.collapsed ? t.expandDock : t.collapseDock;
    collapseBtn.innerHTML = dockState.collapsed ? '▲' : '▼';
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
          applyDockPinnedOffset(false);
        }
      }
      updateHeaderButtons();
    };
    leftSection.appendChild(collapseBtn);

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
      applyDockPinnedOffset(dockState.pinned);
      renderDock();
    };
    leftSection.appendChild(pinBtn);

    const hubBtn = document.createElement('div');
    hubBtn.className = 'acct-dock-hub-btn';
    hubBtn.innerHTML = '⊞';
    hubBtn.title = t.openAccountHubTooltip;

    const hubTooltip = document.createElement('div');
    hubTooltip.className = 'acct-dock-tooltip';
    const hubSpan = document.createElement('span');
    hubSpan.textContent = t.accountHubTitle;
    hubTooltip.appendChild(hubSpan);
    const hubBadge = document.createElement('span');
    hubBadge.className = 'acct-dock-tooltip-badge';
    hubBadge.style.background = 'rgba(99, 102, 241, 0.25)';
    hubBadge.style.color = '#818cf8';
    hubBadge.textContent = '九宫格';
    hubTooltip.appendChild(hubBadge);
    hubBtn.appendChild(hubTooltip);

    hubBtn.onclick = (e) => {
      e.stopPropagation();
      openAccountHub();
    };
    leftSection.appendChild(hubBtn);

    dockContainer.appendChild(leftSection);

    // 左侧垂直分割线
    const dividerLeft = document.createElement('div');
    dividerLeft.className = 'acct-dock-divider';
    dockContainer.appendChild(dividerLeft);

    // 中间账号列表
    const list = document.createElement('div');
    list.className = 'acct-dock-list';

    // 鼠标滚轮平滑横向滚动支持
    list.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        list.scrollLeft += e.deltaY;
      }
    }, { passive: false });

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
      item.style.position = 'relative';
      item.style.width = '36px';
      item.style.height = '36px';
      item.style.flexShrink = '0';
      if (dockState.switchingTargetId === p.id) {
        item.classList.add('switching');
      }
      if (p.id === dockState.activeProfileId) {
        item.classList.add('active');
        setTimeout(() => {
          try { item.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); } catch {}
        }, 50);
      }

      // 用量外环计算 (SVG 环形进度条，半径 16，周长 100.53)
      const pct = Math.max(0, Math.min(100, typeof p.usagePercent === 'number' ? p.usagePercent : 0));
      let ringColor = '#10b981'; // 默认健康翠绿 (<70%)
      if (pct >= 90) {
        ringColor = '#ef4444'; // 严重耗尽/用满 (>=90%)
      } else if (pct >= 70) {
        ringColor = '#f59e0b'; // 适中偏高告警 (70%~89%)
      }
      const circumference = 100.53; // 2 * PI * 16
      const strokeOffset = +(circumference * (1 - pct / 100)).toFixed(2);

      const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ringSvg.setAttribute('class', 'acct-dock-ring');
      ringSvg.setAttribute('viewBox', '0 0 36 36');
      ringSvg.setAttribute('width', '36');
      ringSvg.setAttribute('height', '36');
      ringSvg.style.position = 'absolute';
      ringSvg.style.top = '0';
      ringSvg.style.left = '0';
      ringSvg.style.width = '36px';
      ringSvg.style.height = '36px';
      ringSvg.style.pointerEvents = 'none';
      ringSvg.innerHTML = `
        <circle class="acct-dock-ring-bg" cx="18" cy="18" r="16" stroke-width="2.2" fill="none" />
        <circle class="acct-dock-ring-progress" cx="18" cy="18" r="16" stroke-width="2.2" stroke="${ringColor}" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${strokeOffset}" fill="none" transform="rotate(-90 18 18)" />
      `;
      item.appendChild(ringSvg);

      // 内层账号圆形头像 (28px 直径，居中陈列)
      const avatar = document.createElement('div');
      avatar.className = 'acct-dock-avatar';
      avatar.style.width = '28px';
      avatar.style.height = '28px';
      avatar.style.borderRadius = '50%';
      avatar.style.backgroundColor = p.color || '#3b82f6';
      avatar.textContent = getInitials(p.name);
      item.appendChild(avatar);

      // 左右拖拽高亮指示线
      const indLeft = document.createElement('div');
      indLeft.className = 'acct-dock-drop-indicator left';
      item.appendChild(indLeft);

      const indRight = document.createElement('div');
      indRight.className = 'acct-dock-drop-indicator right';
      item.appendChild(indRight);

      // Tooltip 增强 (向上弹出)
      const tooltip = document.createElement('div');
      tooltip.className = 'acct-dock-tooltip';
      tooltip.style.flexDirection = 'column';
      tooltip.style.alignItems = 'flex-start';
      tooltip.style.gap = '3px';

      const tooltipTop = document.createElement('div');
      tooltipTop.style.display = 'flex';
      tooltipTop.style.alignItems = 'center';
      tooltipTop.style.gap = '6px';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;
      tooltipTop.appendChild(nameSpan);

      if (p.id === dockState.activeProfileId) {
        const badge = document.createElement('span');
        badge.className = 'acct-dock-tooltip-badge';
        badge.textContent = t.currentAccountBadge;
        tooltipTop.appendChild(badge);
      } else {
        const hint = document.createElement('span');
        hint.className = 'acct-dock-tooltip-hint';
        hint.textContent = t.clickToSwitch;
        tooltipTop.appendChild(hint);
      }
      tooltip.appendChild(tooltipTop);

      const usageRow = document.createElement('div');
      usageRow.style.fontSize = '11px';
      usageRow.style.color = ringColor;
      usageRow.style.display = 'flex';
      usageRow.style.alignItems = 'center';
      usageRow.style.gap = '5px';
      const displayReset = p.tokenResetAt ? formatDateTime(p.tokenResetAt) : '';
      usageRow.innerHTML = `<span>用量: ${p.usageText || (pct + '%')}</span>${displayReset ? `<span style="color:rgba(255,255,255,0.45);font-size:10px;">· 重置: ${displayReset}</span>` : ''}`;
      tooltip.appendChild(usageRow);

      item.appendChild(tooltip);

      // 点击切换 (防拖拽结束误触)
      item.onclick = () => {
        if (Date.now() - dragJustEndedAt < 250) return;
        if (p.id !== dockState.activeProfileId) {
          dockState.switchingTargetId = p.id;
          renderDock();
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
          const midX = rect.left + rect.width / 2;
          if (e.clientX < midX) {
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

    // 右侧垂直分割线
    const dividerRight = document.createElement('div');
    dividerRight.className = 'acct-dock-divider';
    dockContainer.appendChild(dividerRight);

    // 右侧功能区 (添加账号、主题切换、控制中心)
    const rightSection = document.createElement('div');
    rightSection.className = 'acct-dock-section';

    // 新增账号按钮
    const addBtn = document.createElement('button');
    addBtn.className = 'acct-dock-add-btn';
    addBtn.type = 'button';
    addBtn.title = t.addAccountTooltip;
    addBtn.textContent = '+';
    addBtn.onclick = () => {
      showPromptModal(t.addAccountPromptTitle, t.addAccountDefaultName(profilesToRender.length + 1), (name) => {
        ipcRenderer.invoke('account:add', { name }).catch(() => {});
      });
    };
    rightSection.appendChild(addBtn);

    // 主题切换快捷按钮 (Dark / Light)
    const themeBtn = document.createElement('button');
    themeBtn.id = 'acct-dock-theme-toggle';
    themeBtn.className = 'acct-dock-add-btn';
    themeBtn.type = 'button';
    themeBtn.style.fontSize = '12px';
    themeBtn.innerHTML = currentTheme === 'light' ? '☀️' : '🌙';
    themeBtn.title = currentTheme === 'light' ? t.themeLightTooltip : t.themeDarkTooltip;
    themeBtn.onclick = () => {
      const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
      ipcRenderer.invoke('theme-set', nextTheme).catch(() => {});
    };
    rightSection.appendChild(themeBtn);

    // ⚙ 配置与自动化控制中心按钮 (Settings & Auto-Allow Center)
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'acct-dock-settings-btn';
    settingsBtn.className = 'acct-dock-add-btn';
    settingsBtn.type = 'button';
    settingsBtn.style.position = 'relative';
    settingsBtn.style.fontSize = '13px';
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
    rightSection.appendChild(settingsBtn);

    dockContainer.appendChild(rightSection);
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
    dockState.switchingTargetId = null;
    if (newState) {
      dockState.profiles = newState.profiles || [];
      dockState.activeProfileId = newState.activeProfileId || 'default';
      dockState.accountGroups = newState.accountGroups || ['默认群组'];
      dockState.feishu = newState.feishu || null;
      if (typeof newState.dockPinned === 'boolean') {
        dockState.pinned = newState.dockPinned;
        if (dockState.pinned) {
          dockState.collapsed = false;
        }
        applyDockPinnedOffset(dockState.pinned);
      }
      renderDock();
      if (dockState.hubOpen) {
        renderAccountHub();
      }
    }
  });

  // 监听账号切换中状态（呈现平滑脉冲/旋转指示）
  ipcRenderer.on('account:switching', (e, payload) => {
    if (payload && payload.targetProfileId) {
      dockState.switchingTargetId = payload.targetProfileId;
      renderDock();
    }
  });

  ipcRenderer.on('account:open-hub', () => {
    openAccountHub();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dockState.hubOpen) {
      closeAccountHub();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      if (dockState.hubOpen) {
        closeAccountHub();
      } else {
        openAccountHub();
      }
    }
  });

  function startDock() {
    try {
      const saved = localStorage.getItem('acct_dock_pinned');
      if (saved !== null) {
        dockState.pinned = saved === '1';
        dockState.collapsed = !dockState.pinned;
      } else {
        dockState.pinned = true;
        dockState.collapsed = false;
      }
    } catch {}
    injectDockStyles();
    renderDock(); // 先用初始数据渲染，确保绝不空白
    applyDockPinnedOffset(dockState.pinned);
    ipcRenderer.invoke('account:get-state').then((res) => {
      if (res) {
        dockState.profiles = res.profiles || [];
        dockState.activeProfileId = res.activeProfileId || 'default';
        dockState.accountGroups = res.accountGroups || ['默认群组'];
        dockState.feishu = res.feishu || null;
        if (typeof res.dockPinned === 'boolean') {
          dockState.pinned = res.dockPinned;
          if (dockState.pinned) {
            dockState.collapsed = false;
          }
        }
      }
      applyDockPinnedOffset(dockState.pinned);
      renderDock();
      if (dockState.hubOpen) {
        renderAccountHub();
      }
    }).catch(() => {
      applyDockPinnedOffset(dockState.pinned);
      renderDock();
    });
  }

  // 动态监听 DOM 变化以确保 SPA 路由切换时输入框避让生效
  try {
    const _dockDomObserver = new MutationObserver(() => {
      if (dockState.pinned) {
        updateComposerOffset(true);
      }
    });
    if (document.body || document.documentElement) {
      _dockDomObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  } catch {}

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startDock);
  } else {
    startDock();
  }
  window.addEventListener('load', startDock);
  setTimeout(startDock, 500);
  setTimeout(startDock, 2000);
})();

// ---- Global External Link Handling (Open In Default Browser) ---------------
(function initExternalLinkCapture() {
  function extractTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      let cleanUrl = rawUrl.trim().replace(/[，。；、？！）》」"',;!]+$/, '');
      const parsed = new URL(cleanUrl, window.location.href);
      const host = parsed.hostname.toLowerCase();
      // 与主进程一致: 解包已知跳转站与内部重定向包装的参数 (含 Meta AI / Facebook / Instagram / Google 等)
      const REDIRECTOR_HOSTS = new Set([
        'www.google.com', 'google.com', 'www.bing.com', 'bing.com',
        'duckduckgo.com', 'html.duckduckgo.com',
        'link.meta.com', 'l.facebook.com', 'lm.facebook.com',
        'l.instagram.com', 'l.messenger.com', 'www.facebook.com', 'facebook.com',
        'out.reddit.com', 'www.youtube.com',
        'muse.ai', 'meta.ai', 'meta.com',
      ]);
      if (!REDIRECTOR_HOSTS.has(host) && !REDIRECTOR_HOSTS.has(host.replace(/^www\./, ''))) return null;
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
      if (host === 'meta.com' || host.endsWith('.meta.com')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function isAuthOrConnectorUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('about:')) return true;
    try {
      const parsed = new URL(trimmed, window.location.href);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      const search = parsed.search.toLowerCase();

      // 0. Meta / Muse 跨域 SSO 与 AYMH ("Accounts You Might Have") 握手链
      if (pathname.includes('/aymh') || (search.includes('origin=') && host.endsWith('muse.ai'))) {
        return true;
      }

      // 1. 专属纯身份认证域名
      const dedicatedAuthHosts = [
        'accounts.google.com',
        'appleid.apple.com',
        'auth.meta.com',
        'account.meta.com',
        'family.meta.com',
        'work.meta.com',
        'login.microsoftonline.com',
        'login.live.com',
        'accounts.spotify.com',
      ];
      if (dedicatedAuthHosts.some((h) => host === h || host.endsWith('.' + h))) {
        return true;
      }

      // 2. Meta 家族 (Facebook / Instagram / Messenger) 的认证、授权与 SSO 路径
      const metaFamilyHosts = ['facebook.com', 'fb.com', 'instagram.com', 'messenger.com'];
      if (metaFamilyHosts.some((h) => host === h || host.endsWith('.' + h))) {
        if (
          pathname.includes('/aymh') ||
          pathname.includes('/login') ||
          pathname.includes('/signin') ||
          pathname.includes('/oauth') ||
          pathname.includes('/dialog') ||
          pathname.includes('/checkpoint') ||
          pathname.includes('/recover') ||
          search.includes('client_id=') ||
          search.includes('redirect_uri=')
        ) {
          return true;
        }
      }

      // 3. 内部站点的连接器中转授权与登录路由
      const isInternal = host === 'muse.ai' || host.endsWith('.muse.ai') ||
                         host === 'meta.ai' || host.endsWith('.meta.ai') ||
                         host === 'meta.com' || host.endsWith('.meta.com');
      if (isInternal) {
        if (
          pathname.includes('/connector') ||
          pathname.includes('/auth') ||
          pathname.includes('/oauth') ||
          pathname.includes('/login') ||
          pathname.includes('/signin') ||
          search.includes('connector') ||
          search.includes('error=') ||
          search.includes('code=') ||
          search.includes('state=') ||
          search.includes('token=')
        ) {
          return true;
        }
      }

      // 4. 通用 OAuth 特征参数
      if (
        (search.includes('client_id=') || search.includes('response_type=')) &&
        (search.includes('redirect_uri=') || pathname.includes('oauth') || pathname.includes('auth'))
      ) {
        return true;
      }

      // 5. 第三方常用开放平台的特定登录/授权路径（普通仓库、主页、文档绝不属于 Auth）
      const thirdPartyOAuthHosts = [
        'github.com',
        'spotify.com',
        'dropbox.com',
        'zoom.us',
        'canva.com',
        'onepeloton.com',
        'peloton.com',
        'slack.com',
        'notion.so',
        'live.com',
        'linkedin.com',
        'twitter.com',
        'x.com',
        'plaid.com',
      ];
      if (thirdPartyOAuthHosts.some((h) => host === h || host.endsWith('.' + h))) {
        if (
          pathname.includes('/oauth') ||
          pathname.startsWith('/login') ||
          pathname.startsWith('/signin') ||
          pathname.includes('/authorize') ||
          search.includes('client_id=') ||
          search.includes('redirect_uri=')
        ) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  // 使用捕获阶段 (capture: true)，仅拦截用户对真正超链接元素 (a 标签 / role="link" / data-href) 的显式点击
  document.addEventListener(
    'click',
    (e) => {
      try {
        // 仅处理常规鼠标左键单点，带修饰键（Ctrl/Alt/Shift）或用户正在选中文本时绝不拦截
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        if (window.getSelection && window.getSelection().toString().trim().length > 0) return;

        // 严禁在输入框、文本编辑区、自身 Dock 控制栏或弹出对话框中触发外链跳转
        if (e.target && e.target.closest) {
          if (e.target.closest('#acct-dock, #muse-export-btn, input, textarea, select, [contenteditable="true"]')) {
            return;
          }
          if (e.target.closest('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"], [class*="settings"]')) {
            return;
          }
        }

        // 核心守卫：必须确切命中 a 标签、带 data-href/data-url 的元素或 role="link"
        const anchor = e.target && e.target.closest
          ? (e.target.closest('a') || e.target.closest('[data-href], [data-url], [role="link"]'))
          : null;

        // 如果用户点击的不是超链接元素（如普通文本、气泡背景、邮箱、Key 等普通文字），坚决不拦截！
        if (!anchor) return;

        let rawHref = anchor.getAttribute('href') || anchor.href || anchor.getAttribute('data-href') || anchor.getAttribute('data-url');

        // 若 href 为 "#"、"javascript:..." 或为空（常见于 React/Slate 等前端组件）：
        // 仅当该 anchor 自身纯文本内容是以 http:// 或 https:// 开头的 URL 时才提取
        if (!rawHref || rawHref === '#' || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) {
          const anchorText = (anchor.innerText || anchor.textContent || '').trim();
          if (/^https?:\/\//i.test(anchorText)) {
            const match = anchorText.match(/^https?:\/\/[^\s，。；、？！）》」"'\`<>]+/i);
            if (match) {
              rawHref = match[0];
            } else {
              return;
            }
          } else {
            return;
          }
        }

        let fullHref = rawHref.trim().replace(/[，。；、？！）》」"',;!]+$/, '');
        try {
          fullHref = new URL(fullHref, window.location.href).href;
        } catch {
          return;
        }

        if (!fullHref.startsWith('http://') && !fullHref.startsWith('https://') && !fullHref.startsWith('mailto:')) {
          return;
        }

        // 关键防御：内部主站点链接，不在此拦截，交由应用主窗口内部导航
        if (isInternalUrl(fullHref)) {
          return;
        }

        // 关键防御：如果是身份验证或连接器相关 URL，交由主进程 setWindowOpenHandler 弹窗处理
        if (isAuthOrConnectorUrl(fullHref)) {
          return;
        }

        // 外部链接（GitHub 仓库、文档、文章等）：调用系统默认外部浏览器打开，阻止应用内无响应或误拦截
        const externalTarget = extractTargetUrl(fullHref);
        const finalUrl = (externalTarget || fullHref).trim().replace(/[，。；、？！）》」"',;!]+$/, '');

        console.log('[ExternalLink Preload] Opening external URL in default browser:', finalUrl);
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send('open-external-url', finalUrl);
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


