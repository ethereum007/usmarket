const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function compile(file, mocks = {}, globals = {}) {
  const context = { exports: {}, Error, ...globals, require: name => mocks[name] || require(name) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  return context.exports;
}
const setup = { symbol: 'AAPL', signal: 'BULL', setup_version: 'b'.repeat(64), setup_id: 'c'.repeat(64), source_snapshot_id: 'd'.repeat(64), entry_price: 100, stop_loss: 95 };
const data = { id: 'a'.repeat(64), market: 'US', currency: 'USD', state: 'final', session: '2026-10-16', setups: [setup] };
const plan = { id: 'plan-id', revision: 2, package_id: data.id, setup_version: setup.setup_version, setup_id: setup.setup_id, source_snapshot_id: setup.source_snapshot_id, symbol: 'AAPL', direction: 'BULL', notes: 'original' };
const fields = () => new Map(Object.entries({ trigger: '100', stop: '95', expiry: '2026-11-25', capital: '10000', risk_pct: '1', allocation_cap_pct: '20', notes: 'Private thesis', exit_policy: 'Review invalidation', state: 'draft', owner: 'forged', filled: 'true', earnings_state: 'checked_no_event' }));
test('US request uses exact source, expected revision and explicit fields only', async () => {
  let sent;
  const lib = compile('lib/us-plans.ts', { './api': { postAPI: async (url, body) => { sent = { url, body }; return { plan }; } } });
  await lib.saveUSPlan(plan.id, data, setup, plan, fields());
  assert.equal(sent.url, '/api/us/plans/plan-id');
  assert.equal(sent.body.expected_revision, 2);
  assert.equal(sent.body.package_id, data.id);
  assert.equal(sent.body.trigger, 100);
  assert.equal(sent.body.notes, 'Private thesis');
  for (const key of ['owner', 'filled', 'earnings_state']) assert.equal(key in sent.body, false);
});
for (const change of [{ state: 'partial' }, { currency: 'INR' }, { market: 'NSE' }, { setups: [] }]) test(`invalid source never submits: ${JSON.stringify(change)}`, () => {
  let calls = 0;
  const lib = compile('lib/us-plans.ts', { './api': { postAPI: () => calls++ } });
  assert.throws(() => lib.saveUSPlan('id', { ...data, ...change }, setup, null, fields()), /final US/);
  assert.equal(calls, 0);
});
test('revision cannot be rebound to a new package', () => {
  const lib = compile('lib/us-plans.ts', { './api': {} });
  assert.throws(() => lib.saveUSPlan(plan.id, { ...data, id: 'e'.repeat(64) }, setup, plan, fields()), /new plan/);
});
test('reload retrieves exact private revision and its original package', async () => {
  const paths = [];
  const lib = compile('lib/us-plans.ts', { './api': { fetchAPI: async url => { paths.push(url); return url.includes('/research/') ? { package: data } : { plan }; } } });
  const result = await lib.loadUSPlan(plan);
  assert.equal(result.setup, setup);
  assert.deepEqual(paths.sort(), [`/api/us/plans/plan-id?revision=2`, `/api/us/research/packages/${data.id}`].sort());
});
for (const badSetup of [{ ...setup, source_snapshot_id: 'wrong' }, { ...setup, signal: 'BEAR' }, { ...setup, symbol: 'MSFT' }]) test(`mismatched original evidence is not opened: ${badSetup.symbol}/${badSetup.signal}/${badSetup.source_snapshot_id}`, async () => {
  const lib = compile('lib/us-plans.ts', { './api': { fetchAPI: async url => url.includes('/research/') ? { package: { ...data, setups: [badSetup] } } : { plan } } });
  await assert.rejects(lib.loadUSPlan(plan), /could not be verified/);
});
function editorFixture(save, existing = null) {
  const updates = [], saved = [], effects = [];
  let uuids = 0;
  const react = { ...React, useState: value => [value, next => updates.push(next)], useRef: value => ({ current: value }), useEffect: effect => effects.push(effect) };
  const lib = compile('us/plans.tsx', {
    react, 'next/dynamic': { default: () => () => null },
    '../lib/theme': { useTheme: () => ({ theme: 'dark' }) },
    '../lib/us-plans': { saveUSPlan: save }, '../lib/us-research': { usd: value => `$${value}` },
  }, { FormData: class { constructor() { return fields(); } }, crypto: { randomUUID: () => `new-${++uuids}` } });
  const element = lib.USPlanEditor({ data, setup, existing, onSaved: item => saved.push(item) });
  const cleanups = effects.map(fn => fn());
  return { element, updates, saved, cleanups };
}
test('adapted editor renders USD, ET expiry, private notes and honest event policy', () => {
  const fixture = editorFixture(async () => ({ plan }));
  const html = renderToStaticMarkup(fixture.element);
  assert.match(html, /Planning capital \(USD\)/);
  assert.match(html, /New York/);
  assert.match(html, /Private plan notes/);
  assert.match(html, /Earnings and catalysts unknown/);
  assert.doesNotMatch(html, /₹|earnings_state|Nifty/);
});
test('rapid duplicate submit is blocked and timeout retry retains the same plan ID', async () => {
  const calls = [];
  let reject;
  const fixture = editorFixture(id => { calls.push(id); return new Promise((resolve, fail) => { reject = fail; }); });
  const submit = fixture.element.props.onSubmit;
  const event = { preventDefault() {}, currentTarget: {} };
  const pending = submit(event);
  await submit(event);
  assert.equal(calls.length, 1);
  reject(new Error('API request timed out'));
  await pending;
  assert.equal(fixture.saved.length, 0);
  const retry = submit(event);
  assert.equal(calls[0], calls[1]);
  reject(new Error('API error 409: Plan changed'));
  await retry;
  assert.equal(fixture.saved.length, 0);
  assert.ok(fixture.updates.some(value => typeof value === 'string' && value.includes('409')));
});
test('successful save confirms returned revision without synthesizing a fill', async () => {
  const fixture = editorFixture(async () => ({ plan }), plan);
  await fixture.element.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.deepEqual(fixture.saved, [plan]);
});
test('a save response from an unmounted editor cannot replace another source editor', async () => {
  let complete;
  const fixture = editorFixture(() => new Promise(resolve => { complete = resolve; }));
  const pending = fixture.element.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  fixture.cleanups.forEach(fn => fn?.());
  complete({ plan });
  await pending;
  assert.equal(fixture.saved.length, 0);
});
test('a different returned revision is never silently opened', async () => {
  const lib = compile('lib/us-plans.ts', { './api': { fetchAPI: async url => url.includes('/research/') ? { package: data } : { plan: { ...plan, revision: 3 } } } });
  await assert.rejects(lib.loadUSPlan(plan), /could not be verified/);
});
