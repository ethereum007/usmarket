const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, mocks = {}, enabled = 'true') {
  const context = { exports: {}, Error, URL, process: { env: { NEXT_PUBLIC_US_SIGNUP_ENABLED: enabled } }, require: name => mocks[name] || require(name) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  return context.exports;
}
function helper(auth, enabled = 'true') { return load('lib/us-signup.ts', { './supabase': { supabase: auth ? { auth } : null } }, enabled); }
const password = 'synthetic-long-password';
test('signup is disabled unless explicitly enabled, with no provider call', async () => {
  let calls = 0;
  for (const enabled of [undefined, 'false', 'TRUE', '1']) {
    const api = helper({ signUp: async () => calls++ }, enabled === undefined ? '' : enabled);
    await assert.rejects(api.requestUSSignup('account@example.test', password, password, 'https://us.example.test'), /not available/);
  }
  assert.equal(calls, 0);
});
test('signup uses explicit fields, fixed confirmation destination and no identity enumeration', async () => {
  const calls = [];
  const api = helper({ signUp: async value => { calls.push(value); return { data: { session: null, user: { identities: [] } } }; } });
  const result = await api.requestUSSignup(' account@example.test ', password, password, 'https://us.example.test/other?next=evil');
  assert.equal(result.state, 'check_email');
  assert.equal(calls[0].email, 'account@example.test');
  assert.equal(calls[0].options.emailRedirectTo, 'https://us.example.test/us/login');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['email', 'options', 'password']);
});
test('invalid passwords and missing configuration never request signup', async () => {
  let calls = 0;
  const api = helper({ signUp: async () => calls++ });
  await assert.rejects(api.requestUSSignup('x', 'short', 'short', 'https://us.example.test'));
  await assert.rejects(api.requestUSSignup('x', password, 'different', 'https://us.example.test'));
  await assert.rejects(helper(null).requestUSSignup('x', password, password, 'https://us.example.test'));
  assert.equal(calls, 0);
});
for (const thrown of [false, true]) test(`provider failures are sanitized (thrown=${thrown})`, async () => {
  const api = helper({ signUp: async () => { if (thrown) throw new Error('private account exists'); return { error: { message: 'private account exists' } }; } });
  await assert.rejects(api.requestUSSignup('account@example.test', password, password, 'https://us.example.test'), error => !error.message.includes('private') && !error.message.includes('exists'));
});
test('unexpected automatic session is signed out locally and flagged for configuration review', async () => {
  const calls = [];
  const api = helper({ signUp: async () => ({ data: { session: { user: { id: 'synthetic' } } } }), signOut: async options => { calls.push(options); return {}; } });
  const result = await api.requestUSSignup('x', password, password, 'https://us.example.test');
  assert.equal(result.state, 'configuration_review');
  assert.equal(calls[0].scope, 'local');
});
test('failed cleanup is reported honestly instead of claiming sign-out', async () => {
  const api = helper({ signUp: async () => ({ data: { session: {} } }), signOut: async () => ({ error: { message: 'offline' } }) });
  assert.equal((await api.requestUSSignup('x', password, password, 'https://us.example.test')).state, 'cleanup_required');
});
test('disabled signup screen contains no account-creation form', () => {
  const module = load('us/signup/page.tsx', { 'next/link': { default: props => React.createElement('a', { href: props.href }, props.children) }, '../../contexts/AuthContext': { useAuth: () => ({ user: null, loading: false }) }, '../../lib/supabase': { supabase: {} }, '../../lib/us-signup': { US_SIGNUP_ENABLED: false } });
  const html = renderToStaticMarkup(React.createElement(module.default));
  assert.match(html, /Self-service signup is not enabled/);
  assert.doesNotMatch(html, /<form/);
});
