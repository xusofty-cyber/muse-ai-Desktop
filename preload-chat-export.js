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

  function createWidget() {
    if (widgetContainer) return;
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', createWidget);
      return;
    }

    widgetContainer = document.createElement('div');
    widgetContainer.id = 'muse-automation-widget';
    Object.assign(widgetContainer.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '999998',
      fontFamily: '"Segoe UI", system-ui, sans-serif',
      fontSize: '12px',
      userSelect: 'none',
    });

    const badge = document.createElement('button');
    badge.id = 'muse-automation-badge';
    Object.assign(badge.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 12px',
      borderRadius: '20px',
      border: '1px solid #3a3f4b',
      background: '#16181d',
      color: '#e8eaf0',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      transition: 'all 0.2s ease',
      fontWeight: '600',
    });

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    widgetContainer.appendChild(badge);

    // Dropdown Panel
    panelContainer = document.createElement('div');
    panelContainer.id = 'muse-automation-panel';
    Object.assign(panelContainer.style, {
      display: 'none',
      position: 'absolute',
      top: '36px',
      right: '0',
      width: '260px',
      backgroundColor: '#1b1e24',
      border: '1px solid #3a3f4b',
      borderRadius: '10px',
      padding: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      color: '#e8eaf0',
      flexDirection: 'column',
      gap: '10px',
    });

    widgetContainer.appendChild(panelContainer);
    document.body.appendChild(widgetContainer);

    document.addEventListener('click', (e) => {
      if (widgetContainer && !widgetContainer.contains(e.target)) {
        panelContainer.style.display = 'none';
      }
    });

    updateWidgetUI();
  }

  function togglePanel() {
    if (!panelContainer) return;
    panelContainer.style.display = panelContainer.style.display === 'none' ? 'flex' : 'none';
  }

  function renderPanelContent() {
    if (!panelContainer) return;
    const hostname = location.hostname;
    const siteAllowed = isCurrentSiteAllowed();

    panelContainer.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2d323e; padding-bottom:8px;">
        <span style="font-weight:700; font-size:13px; color:#fff;">⚡ Automation Controls</span>
        <button id="muse-panel-close" style="background:none; border:none; color:#8a909d; cursor:pointer; font-size:14px;">✕</button>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12.5px;">Master Switch</span>
        <input type="checkbox" id="muse-chk-master" ${autoState.enabled ? 'checked' : ''} style="cursor:pointer;">
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12.5px;">Auto Allow All</span>
        <input type="checkbox" id="muse-chk-allowall" ${autoState.autoAllowAll ? 'checked' : ''} style="cursor:pointer;">
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12px; color:#a0a6b5;">Allow on ${hostname}</span>
        <input type="checkbox" id="muse-chk-site" ${siteAllowed ? 'checked' : ''} style="cursor:pointer;">
      </div>

      <div style="border-top:1px solid #2d323e; padding-top:8px; display:flex; flex-direction:column; gap:6px;">
        <span style="font-size:11px; font-weight:600; color:#8a909d; text-transform:uppercase;">Actions & Connectors</span>

        <label style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;">
          <span>Connectors & Plugins</span>
          <input type="checkbox" id="muse-chk-act-connectors" ${isActionAllowed('connectors') ? 'checked' : ''}>
        </label>

        <label style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;">
          <span>File & Data Access</span>
          <input type="checkbox" id="muse-chk-act-file" ${isActionAllowed('file_access') ? 'checked' : ''}>
        </label>

        <label style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;">
          <span>External Links</span>
          <input type="checkbox" id="muse-chk-act-links" ${isActionAllowed('external_links') ? 'checked' : ''}>
        </label>

        <label style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;">
          <span>Code Execution</span>
          <input type="checkbox" id="muse-chk-act-code" ${isActionAllowed('code_execution') ? 'checked' : ''}>
        </label>

        <label style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;">
          <span>Media & Mic</span>
          <input type="checkbox" id="muse-chk-act-media" ${isActionAllowed('media_permissions') ? 'checked' : ''}>
        </label>
      </div>

      <button id="muse-panel-settings" style="margin-top:4px; padding:6px; font-size:11.5px; background:#2a2e39; border:1px solid #3a3f4b; color:#d1d5db; border-radius:6px; cursor:pointer;">Full Settings & Hotkeys…</button>
    `;

    panelContainer.querySelector('#muse-panel-close').onclick = () => { panelContainer.style.display = 'none'; };

    panelContainer.querySelector('#muse-chk-master').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { enabled: e.target.checked });
    };

    panelContainer.querySelector('#muse-chk-allowall').onchange = (e) => {
      ipcRenderer.invoke('automation-set', { autoAllowAll: e.target.checked });
    };

    panelContainer.querySelector('#muse-chk-site').onchange = (e) => {
      ipcRenderer.invoke('automation-toggle-site', hostname, e.target.checked);
    };

    panelContainer.querySelector('#muse-chk-act-connectors').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'connectors', e.target.checked);
    };
    panelContainer.querySelector('#muse-chk-act-file').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'file_access', e.target.checked);
    };
    panelContainer.querySelector('#muse-chk-act-links').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'external_links', e.target.checked);
    };
    panelContainer.querySelector('#muse-chk-act-code').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'code_execution', e.target.checked);
    };
    panelContainer.querySelector('#muse-chk-act-media').onchange = (e) => {
      ipcRenderer.invoke('automation-set-site-action', hostname, 'media_permissions', e.target.checked);
    };

    panelContainer.querySelector('#muse-panel-settings').onclick = () => {
      ipcRenderer.invoke('open-settings');
      panelContainer.style.display = 'none';
    };
  }

  function updateWidgetUI() {
    if (!widgetContainer) createWidget();
    if (!widgetContainer) return;

    if (!autoState.showOnScreenWidget) {
      widgetContainer.style.display = 'none';
      return;
    }
    widgetContainer.style.display = 'block';

    const badge = widgetContainer.querySelector('#muse-automation-badge');
    if (!badge) return;

    if (autoState.enabled) {
      if (autoState.autoAllowAll) {
        badge.innerHTML = `<span style="color:#7ee2a8;">⚡</span> Auto Allow: ALL`;
        badge.style.borderColor = '#3b82f6';
      } else if (isCurrentSiteAllowed()) {
        badge.innerHTML = `<span style="color:#7ee2a8;">⚡</span> Auto Allow: ON`;
        badge.style.borderColor = '#10b981';
      } else {
        badge.innerHTML = `<span style="color:#f59e0b;">⚡</span> Auto Allow: PAUSED`;
        badge.style.borderColor = '#f59e0b';
      }
    } else {
      badge.innerHTML = `<span style="color:#8a909d;">⚡</span> Auto Allow: OFF`;
      badge.style.borderColor = '#3a3f4b';
    }

    renderPanelContent();
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
    createWidget();
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
// ---- floating export button -------------------------------------------------
function injectExportButton() {
  if (document.getElementById('muse-export-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'muse-export-btn';
  btn.type = 'button';
  btn.textContent = '\u2913 Export chat';
  btn.title = 'Export this chat to a file';
  btn.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'padding:9px 14px', 'border-radius:999px', 'border:1px solid rgba(255,255,255,0.18)',
    'background:rgba(20,20,24,0.92)', 'color:#fff',
    'font:500 13px/1.2 system-ui,-apple-system,sans-serif', 'cursor:pointer',
    'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
  ].join(';');
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(52,52,60,0.95)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,20,24,0.92)'; });
  btn.addEventListener('click', (e) => { e.preventDefault(); ipcRenderer.send('muse-export-request'); });
  (document.body || document.documentElement).appendChild(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectExportButton);
} else {
  injectExportButton();
}

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
        bottom: 80px;
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
    input.placeholder = '输入账号备注昵称...';

    const actions = document.createElement('div');
    actions.className = 'muse-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'muse-modal-btn cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = closeModal;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'muse-modal-btn confirm';
    confirmBtn.textContent = '确定';
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

    const menu = document.createElement('div');
    menu.className = 'muse-context-menu';

    // 1. 修改备注
    const renameItem = document.createElement('div');
    renameItem.className = 'muse-context-item';
    renameItem.innerHTML = '<span>✏️</span><span>修改备注名称</span>';
    renameItem.onclick = () => {
      closeContextMenu();
      showPromptModal(`修改账号名称 (${profile.name})`, profile.name, (newName) => {
        if (newName && newName !== profile.name) {
          ipcRenderer.invoke('account:rename', { id: profile.id, name: newName });
        }
      });
    };
    menu.appendChild(renameItem);

    // 2. 退出登录
    const signOutItem = document.createElement('div');
    signOutItem.className = 'muse-context-item';
    signOutItem.innerHTML = '<span>🚪</span><span>退出此账号登录</span>';
    signOutItem.onclick = () => {
      closeContextMenu();
      if (confirm(`确定要退出账号 [${profile.name}] 的登录状态吗？将清除此账号的登录凭据。`)) {
        ipcRenderer.invoke('account:sign-out', { id: profile.id });
      }
    };
    menu.appendChild(signOutItem);

    // 3. 删除账号
    if (dockState.profiles.length > 1) {
      const deleteItem = document.createElement('div');
      deleteItem.className = 'muse-context-item danger';
      deleteItem.innerHTML = '<span>🗑️</span><span>删除此账号</span>';
      deleteItem.onclick = () => {
        closeContextMenu();
        if (confirm(`确定要删除账号 [${profile.name}] 吗？该账号的所有独立本地数据将被清理。`)) {
          ipcRenderer.invoke('account:delete', { id: profile.id });
        }
      };
      menu.appendChild(deleteItem);
    }

    // 4. 网络代理设置
    const proxyItem = document.createElement('div');
    proxyItem.className = 'muse-context-item';
    proxyItem.innerHTML = '<span>🌐</span><span>网络代理设置…</span>';
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
    collapseBtn.title = dockState.collapsed ? '展开多账号栏' : '收起多账号栏';
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
      : [{ id: dockState.activeProfileId || 'default', name: '我的账号', color: '#3b82f6' }];

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
        badge.textContent = '当前账号';
        tooltip.appendChild(badge);
      } else {
        const hint = document.createElement('span');
        hint.className = 'muse-dock-tooltip-hint';
        hint.textContent = '点击切换';
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
    addBtn.title = '添加新账号（家庭成员/多会话）';
    addBtn.textContent = '+';
    addBtn.onclick = () => {
      showPromptModal('添加新账号', `账号 ${profilesToRender.length + 1}`, (name) => {
        ipcRenderer.invoke('account:add', { name }).catch(() => {});
      });
    };
    dockContainer.appendChild(addBtn);
  }

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

