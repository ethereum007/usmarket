const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const model = require('../app/latest-updates/model.ts');
const setups = require('../app/latest-updates/market-setup.ts');
const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../app/latest-updates/market-data/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function route(fetch, now = '2026-10-12T06:30:00Z') {
  class Clock extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return Date.parse(now); } }
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => name === 'next/server' ? { NextResponse: { json: (data, options = {}) => ({ data, ...options }) } } : name === '../model' ? model : setups, fetch, Date: Clock, Intl, URLSearchParams, AbortSignal, Set, Number });
  return exports.GET;
}
const request = query => ({ nextUrl: { searchParams: new URLSearchParams(query) } });
test('invalid symbols do not reach the price provider', async () => {
  const result = await route(() => { throw Error('must not fetch'); })(request({ symbol: 'https://evil.example', date: '2026-10-11' }));
  assert.equal(result.status, 400);
});
test('forming daily candles are excluded and cache keys use a stable date boundary', async () => {
  let requestedUrl;
  const result = await route(async url => { requestedUrl = url; return { ok: true, json: async () => ({ chart: { result: [{ meta: { currency: 'INR', exchangeTimezoneName: 'Asia/Kolkata' }, timestamp: [Date.parse('2026-10-09T03:45:00Z') / 1000, Date.parse('2026-10-12T03:45:00Z') / 1000], indicators: { quote: [{ open: [100, 100], high: [102, 105], low: [99, 98], close: [101, 104], volume: [1000, 1500] }] } }] } }) }; })(request({ symbol: 'KEC', date: '2026-10-12' }));
  assert.equal(result.data.candles.length, 1); assert.equal(result.data.candles[0].date, '2026-10-09');
  assert.equal(new URL(requestedUrl).searchParams.get('period2'), String(Date.parse('2026-10-13T00:00:00+05:30') / 1000));
});
test('provider errors return unavailable with no cached false success', async () => {
  const result = await route(async () => ({ ok: false }))(request({ symbol: 'KEC', date: '2026-10-11' }));
  assert.equal(result.status, 503); assert.equal(result.headers['Cache-Control'], 'no-store');
});
test('wrong-market candles are rejected', async () => {
  const result = await route(async () => ({ ok: true, json: async () => ({ chart: { result: [{ meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' }, timestamp: [], indicators: { quote: [{}] } }] } }) }))(request({ symbol: 'KEC', date: '2026-10-11' }));
  assert.equal(result.status, 503);
});
