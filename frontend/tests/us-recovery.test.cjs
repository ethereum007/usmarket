const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, mocks = {}, globals = {}) {
  const context = { exports: {}, Error, URL, ...globals, require: name => mocks[name] || require(name) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  return context.exports;
}
test('recovery requests use only a same-origin US destination and trimmed email', async () => {
  let sent;
  const api = load('lib/us-recovery.ts', { './supabase': { supabase: { auth: { resetPasswordForEmail: async (...args) => { sent = args; return {}; } } } } });
  await api.requestUSRecovery(' account@example.test ', 'https://us.example.test/other');
  assert.equal(sent[0], 'account@example.test');
  assert.equal(sent[1].redirectTo, 'https://us.example.test/us/recover');
  await assert.rejects(api.requestUSRecovery('x', 'javascript:alert(1)'));
});
test('reset provider errors never expose account existence or raw response', async () => {
  const api = load('lib/us-recovery.ts', { './supabase': { supabase: { auth: { resetPasswordForEmail: async () => ({ error: { message: 'ACCOUNT EXISTS: private provider details' } }) } } } });
  await assert.rejects(api.requestUSRecovery('account@example.test', 'https://us.example.test'), error => !error.message.includes('EXISTS') && !error.message.includes('private'));
});
test('password update needs recovery state, matching confirmation and minimum length', async () => {
  const calls = [];
  const api = load('lib/us-recovery.ts', { './supabase': { supabase: { auth: { updateUser: async body => { calls.push(body); return {}; } } } } });
  await assert.rejects(api.updateUSRecoveredPassword('synthetic-long-password', 'synthetic-long-password', false));
  await assert.rejects(api.updateUSRecoveredPassword('short', 'short', true));
  await assert.rejects(api.updateUSRecoveredPassword('synthetic-long-password', 'different', true));
  assert.equal(calls.length, 0);
  await api.updateUSRecoveredPassword('synthetic-long-password', 'synthetic-long-password', true);
  assert.deepEqual(Object.keys(calls[0]), ['password']);
});
test('missing configuration fails closed for both recovery actions', async () => {
  const api = load('lib/us-recovery.ts', { './supabase': { supabase: null } });
  await assert.rejects(api.requestUSRecovery('x', 'https://us.example.test'));
  await assert.rejects(api.updateUSRecoveredPassword('synthetic-long-password', 'synthetic-long-password', true));
});
test('early SDK recovery event is captured and resets on account switch or sign-out', () => {
  let notify;
  const fake = { auth: { onAuthStateChange: callback => { notify = callback; } } };
  const lib = load('lib/supabase.ts', { '@supabase/supabase-js': { createClient: () => fake } }, { process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://us.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-public' } } });
  const owner = { user: { id: 'owner-a' } };
  assert.equal(lib.isRecoverySession(), false);
  notify('PASSWORD_RECOVERY', owner);
  assert.equal(lib.isRecoverySession(), true);
  notify('TOKEN_REFRESHED', owner);
  assert.equal(lib.isRecoverySession(), true);
  notify('SIGNED_IN', { user: { id: 'owner-b' } });
  assert.equal(lib.isRecoverySession(), false);
  notify('PASSWORD_RECOVERY', { user: { id: 'anonymous', is_anonymous: true } });
  assert.equal(lib.isRecoverySession(), false);
  notify('PASSWORD_RECOVERY', owner);
  notify('SIGNED_OUT', null);
  assert.equal(lib.isRecoverySession(), false);
});
test('workspace guard sends recovery sessions to US recovery without rendering research', () => {
  const routes = [], effects = [];
  const lib = load('components/auth/USAccessGuard.tsx', { react: { ...React, useEffect: effect => effects.push(effect) }, 'next/navigation': { useRouter: () => ({ replace: url => routes.push(url) }) }, '../../contexts/AuthContext': { useAuth: () => ({ user: { id: 'owner-a' }, loading: false, recoverySession: true }) } });
  const html = renderToStaticMarkup(React.createElement(lib.USAccessGuard, null, 'PRIVATE_RESEARCH'));
  effects.forEach(effect => effect());
  assert.doesNotMatch(html, /PRIVATE_RESEARCH/);
  assert.deepEqual(routes, ['/us/recover']);
});
function recoveryComponent(auth, values = []) {
  const states = ['', '', '', false, '', false, false, false].map((value, i) => values[i] ?? value);
  const updates = [], calls = [];
  const lib = load('us/recover/page.tsx', { react: { ...React, useState: () => [states.shift(), value => updates.push(value)], useRef: value => ({ current: value }) }, 'next/link': { default: props => React.createElement('a', { href: props.href }, props.children) }, '../../contexts/AuthContext': { useAuth: () => auth }, '../../lib/supabase': { supabase: {} }, '../../lib/us-recovery': { requestUSRecovery: async () => calls.push('request'), updateUSRecoveredPassword: async () => calls.push('update') } }, { window: { location: { origin: 'https://us.example.test' } } });
  return { element: lib.default(), updates, calls };
}
test('ordinary sessions cannot see the password-update form', () => {
  const fixture = recoveryComponent({ user: { id: 'owner' }, loading: false, recoverySession: false });
  const html = renderToStaticMarkup(fixture.element);
  assert.match(html, /Account email/);
  assert.doesNotMatch(html, /Confirm new password/);
});
test('verified recovery view has confirmation and no password value in URLs', () => {
  const fixture = recoveryComponent({ user: { id: 'owner' }, loading: false, recoverySession: true });
  const html = renderToStaticMarkup(fixture.element);
  assert.match(html, /Confirm new password/);
  assert.match(html, /autoComplete="new-password"/);
  assert.match(html, /Update password and sign out/);
});
test('password success followed by failed sign-out is reported as updated, not failed update', async () => {
  const fixture = recoveryComponent({ user: { id: 'owner' }, loading: false, recoverySession: true, signOut: async () => { throw new Error('offline'); } });
  const form = fixture.element.props.children.find(child => child?.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(fixture.calls, ['update']);
  assert.ok(fixture.updates.some(value => typeof value === 'string' && value.includes('Password updated, but sign-out')));
});
test('thrown SDK failures are sanitized for both recovery operations', async () => {
  const fail = async () => { throw new Error('private provider account details'); };
  const api = load('lib/us-recovery.ts', { './supabase': { supabase: { auth: { resetPasswordForEmail: fail, updateUser: fail } } } });
  const clean = error => !error.message.includes('private provider');
  await assert.rejects(api.requestUSRecovery('account@example.test', 'https://us.example.test'), clean);
  await assert.rejects(api.updateUSRecoveredPassword('synthetic-long-password', 'synthetic-long-password', true), clean);
});
