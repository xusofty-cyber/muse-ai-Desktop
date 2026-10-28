// Pilot P2 tests: URL-classification trio (node:test, no deps).
// The trio is extracted verbatim from main.js into lib/url-classification.js;
// these tests pin the behaviour main.js call sites rely on, including the
// phishing-redirect and about:blank cases from the v1.5.17 hardening.
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractExternalTargetUrl,
  isInternalSiteUrl,
  isAuthOrConnectorUrl,
} = require('../lib/url-classification');

// --- extractExternalTargetUrl: unwrap only known redirectors ---

test('extract: google redirect ?q= unwraps an external target', () => {
  assert.equal(
    extractExternalTargetUrl('https://www.google.com/url?q=https://evil.example/x'),
    'https://evil.example/x');
});

test('extract: bing and facebook redirectors unwrap ?u=', () => {
  assert.equal(
    extractExternalTargetUrl('https://www.bing.com/search?u=https://evil.example/x'),
    'https://evil.example/x');
  assert.equal(
    extractExternalTargetUrl('https://l.facebook.com/l.php?u=https://evil.example/x'),
    'https://evil.example/x');
});

test('extract: redirector host match is case-insensitive', () => {
  assert.equal(
    extractExternalTargetUrl('https://WWW.GOOGLE.COM/url?q=https://evil.example/x'),
    'https://evil.example/x');
});

test('extract: internal redirect targets are NOT unwrapped', () => {
  assert.equal(
    extractExternalTargetUrl('https://www.google.com/url?q=https://muse.ai/chat'),
    null);
  assert.equal(
    extractExternalTargetUrl('https://www.google.com/url?q=https://sub.meta.ai/x'),
    null);
});

test('extract: unknown hosts with ?u= are NOT unwrapped (phishing guard)', () => {
  assert.equal(
    extractExternalTargetUrl('https://evil.example/?u=https://victim.example/'),
    null);
});

test('extract: non-http(s) candidates and garbage are rejected', () => {
  assert.equal(
    extractExternalTargetUrl('https://www.google.com/url?q=javascript:alert(1)'),
    null);
  assert.equal(
    extractExternalTargetUrl('https://www.google.com/url?q=not-a-url'),
    null);
  assert.equal(extractExternalTargetUrl(null), null);
  assert.equal(extractExternalTargetUrl(42), null);
  assert.equal(extractExternalTargetUrl('not a url'), null);
});

// --- isInternalSiteUrl ---

test('internal: muse/meta families and subdomains', () => {
  assert.equal(isInternalSiteUrl('https://muse.ai/chat'), true);
  assert.equal(isInternalSiteUrl('https://www.muse.ai/'), true);
  assert.equal(isInternalSiteUrl('https://MUSE.AI/chat'), true);
  assert.equal(isInternalSiteUrl('https://meta.ai/'), true);
  assert.equal(isInternalSiteUrl('https://meta.com/'), true);
  assert.equal(isInternalSiteUrl('https://sub.meta.com/x'), true);
});

test('internal: suffix-spoof domains are NOT internal', () => {
  assert.equal(isInternalSiteUrl('https://muse.ai.evil.example/'), false);
  assert.equal(isInternalSiteUrl('https://notmuse.ai/'), false);
  assert.equal(isInternalSiteUrl('https://evil.example/'), false);
});

test('internal: redirector-wrapped external links count as external', () => {
  assert.equal(
    isInternalSiteUrl('https://www.google.com/url?q=https://evil.example/x'),
    false);
});

test('internal: file: pages are NOT internal (v1.5.17)', () => {
  assert.equal(isInternalSiteUrl('file:///tmp/page.html'), false);
  assert.equal(isInternalSiteUrl('about:blank'), false);
  assert.equal(isInternalSiteUrl('not a url'), false);
});

// --- isAuthOrConnectorUrl ---

test('auth: about:blank placeholder (OAuth popup pattern)', () => {
  assert.equal(isAuthOrConnectorUrl('about:blank'), true);
  assert.equal(isAuthOrConnectorUrl('about:config'), true);
  // '' is falsy, so the first guard returns false before the about:
  // branch is reached; the '' arm in that branch is dead code.
  assert.equal(isAuthOrConnectorUrl(''), false);
  assert.equal(isAuthOrConnectorUrl(null), false);
});

test('auth: auth host families and subdomains', () => {
  assert.equal(isAuthOrConnectorUrl('https://facebook.com/login'), true);
  assert.equal(isAuthOrConnectorUrl('https://www.facebook.com/'), true);
  assert.equal(isAuthOrConnectorUrl('https://accounts.google.com/o/oauth2/auth'), true);
  assert.equal(isAuthOrConnectorUrl('https://github.com/login/oauth'), true);
  assert.equal(isAuthOrConnectorUrl('https://appleid.apple.com/auth/authorize'), true);
});

test('auth: lookalike hosts without a dot boundary are NOT auth', () => {
  assert.equal(isAuthOrConnectorUrl('https://evilfacebook.com/'), false);
  assert.equal(isAuthOrConnectorUrl('https://facebook.com.evil.example/'), false);
});

test('auth: internal connector/auth routes and callbacks', () => {
  assert.equal(isAuthOrConnectorUrl('https://muse.ai/connector/callback?code=abc'), true);
  assert.equal(isAuthOrConnectorUrl('https://muse.ai/auth/login'), true);
  assert.equal(isAuthOrConnectorUrl('https://meta.ai/page?token=abc'), true);
  assert.equal(isAuthOrConnectorUrl('https://meta.ai/page?error=access_denied'), true);
  assert.equal(isAuthOrConnectorUrl('https://muse.ai/chat'), false);
});

test('auth: generic OAuth characteristics', () => {
  assert.equal(
    isAuthOrConnectorUrl('https://example.com/oauth/authorize?client_id=abc&redirect_uri=https://app/cb'),
    true);
  assert.equal(
    isAuthOrConnectorUrl('https://example.com/oauth?response_type=code'),
    true);
  // client_id alone, without redirect_uri or an oauth/auth path, is not enough.
  assert.equal(isAuthOrConnectorUrl('https://example.com/cb?client_id=abc'), false);
  assert.equal(isAuthOrConnectorUrl('https://example.com/'), false);
  assert.equal(isAuthOrConnectorUrl('garbage'), false);
});
