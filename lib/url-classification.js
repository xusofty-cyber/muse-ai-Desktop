// Pure URL-classification helpers, extracted verbatim from main.js (pilot P2).
// No Electron dependency: the three functions use only the global URL
// parser, string methods, and each other (isInternalSiteUrl calls
// extractExternalTargetUrl, kept in this module). Safe to require in
// plain node tests; main.js requires and re-exports them.

// ---- External links & navigation security (Open in system default browser) --
function extractExternalTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    // 只解包已知跳转站的重定向参数 (v1.5.17 加固, 评审 P2): 此前任意 URL 的
    // ?u=/?url= 参数都会被解包直达, 页面可借此绕过外链提示把用户带到钓鱼站
    const REDIRECTOR_HOSTS = new Set([
      'www.google.com', 'google.com', 'www.bing.com', 'bing.com',
      'duckduckgo.com', 'html.duckduckgo.com', 'l.facebook.com',
      'out.reddit.com', 'www.youtube.com',
    ]);
    if (!REDIRECTOR_HOSTS.has(parsed.hostname.toLowerCase())) return null;
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

function isInternalSiteUrl(rawUrl) {
  try {
    // 若属于外部链接包装重定向，实质属于外链
    if (extractExternalTargetUrl(rawUrl)) return false;

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
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  // 关键：允许空白弹窗占位符（现代前端异步打开 OAuth 弹窗的通用标准模式）
  if (rawUrl === 'about:blank' || rawUrl === '' || rawUrl.startsWith('about:')) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // 1. Meta / Facebook / Instagram 家族认证域名及通用 OAuth 域名
    const authHosts = [
      'meta.com',
      'auth.meta.com',
      'account.meta.com',
      'family.meta.com',
      'work.meta.com',
      'facebook.com',
      'fb.com',
      'instagram.com',
      'accounts.google.com',
      'appleid.apple.com',
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
      'login.live.com',
      'linkedin.com',
      'twitter.com',
      'x.com',
      'plaid.com',
      'functionhealth.com',
      'healthex.com',
    ];
    if (authHosts.some((h) => host === h || host.endsWith('.' + h))) {
      return true;
    }

    // 2. 内部站点的连接器中转授权与登录路由（含认证错误回调、状态码与授权换码）
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

    // 3. 通用 OAuth 特征（包含 client_id 以及 redirect_uri / response_type）
    if (
      (search.includes('client_id=') || search.includes('response_type=')) &&
      (search.includes('redirect_uri=') || pathname.includes('oauth') || pathname.includes('auth'))
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

module.exports = { extractExternalTargetUrl, isInternalSiteUrl, isAuthOrConnectorUrl };
