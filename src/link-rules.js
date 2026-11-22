// src/link-rules.js
// 外部链接、站内导航、授权弹窗、账号页面等 URL 判断规则。全部是纯函数, 不依赖任何应用状态,
// 可以直接单元测试。由 main.js 引用 (2026-11-22 main.js 拆分 第 1 步, 函数体原样迁移)。
//
// 注意: preload-chat-export.js 在 sandbox 下无法 require 本地模块, 里面还保留一份
// extractTargetUrl / isShareOrDocumentUrl / isAuthOrConnectorUrl 的拷贝。
// 改这里任何规则后必须同步 preload, 并运行 npm run check:links。
'use strict';

// ---- External links & navigation security (Open in system default browser) --
function extractExternalTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    let cleanUrl = rawUrl.trim().replace(/[，。；、？！）》」"',;!]+$/, '');
    const parsed = new URL(cleanUrl);
    const host = parsed.hostname.toLowerCase();

    // 只解包已知跳转站与内部重定向包装的参数 (含 Meta AI / Facebook / Instagram / Google 等外链跳板)
    const REDIRECTOR_HOSTS = new Set([
      'www.google.com', 'google.com', 'www.bing.com', 'bing.com',
      'duckduckgo.com', 'html.duckduckgo.com',
      'link.meta.com', 'l.facebook.com', 'lm.facebook.com',
      'l.instagram.com', 'l.messenger.com', 'www.facebook.com', 'facebook.com',
      'out.reddit.com', 'www.youtube.com',
      'muse.ai', 'meta.ai', 'meta.com',
      // Meta AI / Muse 聊天里的外链会先经过 l.meta.ai/?u=... 中转 (2026-11-22 修复白屏)
      'l.meta.ai', 'lm.meta.ai', 'l.muse.ai', 'lm.muse.ai', 'l.meta.com', 'lm.meta.com',
    ]);
    if (!REDIRECTOR_HOSTS.has(host) && !REDIRECTOR_HOSTS.has(host.replace(/^www\./, ''))) return null;

    // 识别常见重定向跳转参数
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

function isShareOrDocumentUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    // [LINK-RULES:share] 与 preload-chat-export.js 保持一致, 由 scripts/check-link-rules.js 校验 (本文件为主)
    // 按完整路径段匹配 (审查 M4): 此前 includes('/doc') 会把 /doctor、/docs 帮助中心等误判为分享链接
    const segs = pathname.split('/').filter(Boolean);
    const FIRST_SEGMENTS = ['share', 's', 'doc', 'd', 'file', 'files', 'f', 'p', 'v']; // 仅作为首段时才算
    const ANY_SEGMENTS = ['artifact', 'artifacts', 'attachment', 'attachments', 'download', 'export', 'preview'];
    if (segs.length && FIRST_SEGMENTS.includes(segs[0]) && segs.length > 1) return true;
    if (segs.length && segs[0] === 'share') return true;
    if (segs.some((s) => ANY_SEGMENTS.includes(s))) return true;
    // 只认明确的签名/临时资源参数; 去掉过宽的 token= / key=
    const params = parsed.searchParams;
    if (['share', 'expires', 'signature', 'sig'].some((k) => params.has(k))) return true;
    return false;
  } catch {
    return false;
  }
}

function isInternalSiteUrl(rawUrl) {
  try {
    // 若属于外部链接包装重定向，实质属于外链
    if (extractExternalTargetUrl(rawUrl)) return false;
    // 分享/文档/附件/临时资源链接不作为应用内基础导航，应作为独立资源处理
    if (isShareOrDocumentUrl(rawUrl)) return false;

    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'muse.ai' || host.endsWith('.muse.ai')) return true;
    if (host === 'meta.ai' || host.endsWith('.meta.ai')) return true;
    if (host === 'meta.com' || host.endsWith('.meta.com')) return true;
    // file: 不再归为内部站点 (v1.5.17, 评审 P2): 旧归类让任意本地 HTML 能在
    // 挂有特权 preload 的窗口内被当作内部页面放行导航。应用自身页面都由主
    // 进程直接 loadURL/loadFile 打开, 不经过链接/导航拦截, 不受此改动影响。
    return false;
  } catch {
    return false;
  }
}

function isAuthOrConnectorUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  // 关键：允许空白弹窗占位符（现代前端异步打开 OAuth 弹窗的通用标准模式：先 window.open('') 再重定向）
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('about:')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // 0. Meta / Muse 跨域 SSO 与 AYMH ("Accounts You Might Have") 握手链
    if (pathname.includes('/aymh') || (search.includes('origin=') && host.endsWith('muse.ai'))) {
      return true;
    }

    // 1. 专属纯身份认证域名（该域名整个域均为登录/认证中心）
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

    // 3. 内部站点的连接器中转授权与登录路由（含认证错误回调、状态码与授权换码）
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

    // 4. 通用 OAuth 特征（包含 client_id 以及 redirect_uri / response_type / state / code）
    if (
      (search.includes('client_id=') || search.includes('response_type=')) &&
      (search.includes('redirect_uri=') || pathname.includes('oauth') || pathname.includes('auth'))
    ) {
      return true;
    }

    // 5. 第三方常用开放平台（GitHub, Slack, Notion, Zoom, Dropbox, Canva 等）的特定登录/授权路径
    // [LINK-RULES:oauth-hosts] 与 preload-chat-export.js 保持一致
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
      'functionhealth.com',
      'healthex.com',
    ];
    if (thirdPartyOAuthHosts.some((h) => host === h || host.endsWith('.' + h))) {
      // 只有明确属于 OAuth 授权或登录的路径才认定为 Auth 弹窗，普通仓库/文章/主页属于常规外部链接
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

// 识别第三方广告、追踪分析与数据上报埋点链接 (防止 iframe 内部重定向或打点唤起外部默认浏览器)
function isTrackingOrAdUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // 常见广告 / 埋点统计 / 转化追踪域名
    const trackingHosts = [
      'doubleclick.net',
      'google-analytics.com',
      'googletagmanager.com',
      'fbthirdpartypixel.com',
      'analytics.twitter.com',
      'clarity.ms',
      'hotjar.com',
      'segment.io',
      'mixpanel.com',
      'scorecardresearch.com',
      'criteo.com',
      'adroll.com',
    ];

    if (trackingHosts.some((h) => host === h || host.endsWith('.' + h))) {
      return true;
    }

    if (host === 'tr.snapchat.com' || (host.endsWith('snapchat.com') && pathname.startsWith('/cm/'))) {
      return true;
    }

    if (
      pathname.includes('/activityi') ||
      pathname.includes('/pixel') ||
      search.includes('dc_pre=') ||
      search.includes('fbthirdpartypixel')
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ---- Meta 账户中心等账号相关页面 ------------------------------------------------
// 设置 > 通用 > "Meta 账户" 会 window.open 到 accountscenter.meta.com 等地址。
// 此前它被 isInternalSiteUrl 归为内部站点, 根路径 ("/") 时既不导航也不弹窗, 直接 deny,
// 表现为"点击无任何反应"; 若交给系统浏览器又拿不到当前账号的登录态。
// 现在统一在应用内弹出独立窗口, 并复用当前账号 (profile) 的 session, 保证打开的是本账号的页面。
function isMetaAccountUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    // 账户中心 (Meta / Facebook / Instagram 三个入口域名)
    if (/^accountscenter\.(meta|facebook|instagram)\.com$/.test(host)) return true;
    // meta.com 家族的其余子域 (账号、隐私、设备、帮助中心等); meta.ai / muse.ai 主站不在此列
    if (host === 'meta.com' || host.endsWith('.meta.com')) return true;
    return false;
  } catch {
    return false;
  }
}

// 仅"账户中心"本身 (accountscenter.*): 主窗口内的普通跳转只对它改为弹窗,
// 不再匹配整个 *.meta.com, 避免截断 meta.ai 登录/退出/切号中途经过 www.meta.com 的跳转链
function isMetaAccountCenterUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl).trim()).hostname.toLowerCase();
    return /^accountscenter\.(meta|facebook|instagram)\.com$/.test(host);
  } catch {
    return false;
  }
}

// 站内 (muse.ai / meta.ai / meta.com) 但需要单独打开的链接: 分享页、文档、产物、附件等。
// 此前它们统一交给系统默认浏览器, 而系统浏览器里没有当前账号的登录态, 打开后要么要求登录,
// 要么看到的是别的账号。现在改为在应用内用当前账号的 session 打开。
function isOwnSiteHost(rawUrl) {
  try {
    const host = new URL(String(rawUrl).trim()).hostname.toLowerCase();
    return host === 'muse.ai' || host.endsWith('.muse.ai') ||
           host === 'meta.ai' || host.endsWith('.meta.ai') ||
           host === 'meta.com' || host.endsWith('.meta.com');
  } catch {
    return false;
  }
}

function isDownloadLikeUrl(rawUrl) {
  try {
    const pathname = new URL(String(rawUrl).trim()).pathname.toLowerCase();
    return /\/(download|export|attachments?)(\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

// 需要带当前账号登录态打开的链接 (Meta 账户中心、站内分享/文档/附件等)
function isProfileScopedUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  if (!/^https?:\/\//i.test(rawUrl.trim())) return false;
  if (extractExternalTargetUrl(rawUrl)) return false; // 跳板包装的真外链, 仍走系统浏览器
  return isMetaAccountUrl(rawUrl) || isOwnSiteHost(rawUrl);
}

module.exports = {
  extractExternalTargetUrl,
  isShareOrDocumentUrl,
  isInternalSiteUrl,
  isAuthOrConnectorUrl,
  isTrackingOrAdUrl,
  isMetaAccountUrl,
  isMetaAccountCenterUrl,
  isOwnSiteHost,
  isDownloadLikeUrl,
  isProfileScopedUrl,
};
