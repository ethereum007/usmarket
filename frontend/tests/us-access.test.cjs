const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, auth, configured = true) {
  const redirects = [], effects = [];
  const context = { exports: {}, require(name) {
    if (name === 'react') return { ...React, useEffect: fn => effects.push(fn) };
    if (name === 'next/navigation') return { useRouter: () => ({ replace: url => redirects.push(url) }) };
    if (name.endsWith('AuthContext')) return { useAuth: () => auth };
    if (name.endsWith('supabase')) return { supabase: configured ? {} : null };
    return require(name);
  }};
  const source = fs.readFileSync(path.join(__dirname, '../app', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  return { component: context.exports.default || context.exports.USAccessGuard, redirects, effects };
}
for (const [label, user, loading, visible, redirected] of [
  ['signed out', null, false, false, true],
  ['initializing', null, true, false, false],
  ['anonymous session', { is_anonymous: true }, false, false, true],
  ['signed in', { id: 'owner', is_anonymous: false }, false, true, false],
]) test(`US guard: ${label}`, () => {
  const fixture = load('components/auth/USAccessGuard.tsx', { user, loading });
  const html = renderToStaticMarkup(React.createElement(fixture.component, null, 'PRIVATE_RESEARCH'));
  fixture.effects.forEach(fn => fn());
  assert.equal(html.includes('PRIVATE_RESEARCH'), visible);
  assert.equal(fixture.redirects.length > 0, redirected);
  if (redirected) assert.equal(fixture.redirects[0], '/us/login');
});
test('US sign-in fails closed with missing configuration and has no inherited pricing', () => {
  const fixture = load('us/login/page.tsx', { user: null, loading: false }, false);
  const html = renderToStaticMarkup(React.createElement(fixture.component));
  assert.match(html, /not configured/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /₹|Nifty|NSE|Zoom|Premium/);
  assert.match(html, /autoComplete="current-password"/);
});
test('US sign-in redirects authenticated users back to workspace', () => {
  const fixture = load('us/login/page.tsx', { user: { id: 'owner' }, loading: false });
  renderToStaticMarkup(React.createElement(fixture.component));
  fixture.effects.forEach(fn => fn());
  assert.deepEqual(fixture.redirects, ['/us']);
});
test('US sign-in does not accept anonymous sessions', () => {
  const fixture = load('us/login/page.tsx', { user: { is_anonymous: true }, loading: false });
  renderToStaticMarkup(React.createElement(fixture.component));
  fixture.effects.forEach(fn => fn());
  assert.deepEqual(fixture.redirects, []);
});
async function providerFixture(checkSubscription, logoutError = null) {
  const effects = [], tierRequests = [], tokens = [];
  const context = { exports: {}, window: { setTimeout, clearTimeout }, require(name) {
    if (name === 'react') return { ...React, useEffect: fn => effects.push(fn), useCallback: fn => fn, useState: initial => [initial, () => {}] };
    if (name.endsWith('/supabase')) return { supabase: { auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'owner' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: logoutError }),
    }}};
    if (name.endsWith('/api')) return { primeAuthAccessToken: token => tokens.push(token), fetchAPI: async url => { tierRequests.push(url); return {}; } };
    return require(name);
  }};
  const source = fs.readFileSync(path.join(__dirname, '../app/contexts/AuthContext.tsx'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  const element = context.exports.AuthProvider({ children: null, checkSubscription });
  const cleanups = effects.map(fn => fn());
  await new Promise(resolve => setImmediate(resolve));
  cleanups.forEach(fn => fn?.());
  return { value: element.props.value, tierRequests, tokens };
}
test('US provider primes the bearer token without requesting Indian subscription service', async () => {
  const fixture = await providerFixture(false);
  assert.deepEqual(fixture.tokens, ['test-token']);
  assert.deepEqual(fixture.tierRequests, []);
  const legacy = await providerFixture(true);
  assert.deepEqual(legacy.tierRequests, ['/api/user-tier']);
});
test('failed sign-out is reported instead of silently claiming success', async () => {
  const fixture = await providerFixture(false, new Error('offline'));
  await assert.rejects(fixture.value.signOut(), /offline/);
  assert.deepEqual(fixture.tokens, ['test-token']);
});
test('inherited auth URLs redirect exclusively to US sign-in', async () => {
  const context = { exports: {}, __dirname: path.join(__dirname, '..'), process: { env: {} } };
  const source = fs.readFileSync(path.join(__dirname, '../next.config.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const redirects = await context.exports.default.redirects();
  for (const route of ['login', 'signup', 'forgot-password', 'reset-password']) {
    assert.equal(redirects.find(item => item.source === `/${route}/:path*`).destination, '/us/login');
  }
  assert.equal(redirects.some(item => item.source.startsWith('/us/')), false);
});
