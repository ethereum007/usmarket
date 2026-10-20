const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, mocks = {}) {
  const context = { exports: {}, require: name => mocks[name] || require(name), URL, Date };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  return context.exports;
}
const model = load('latest-updates/model.ts');
test('imported source validator preserves NSE defaults while SEC is explicit', () => {
  assert.ok(model.sourceLink('https://www.nseindia.com/filing'));
  assert.equal(model.sourceLink('https://www.sec.gov/Archives/doc.htm'), null);
  assert.ok(model.sourceLink('https://www.sec.gov/Archives/doc.htm', ['sec.gov']));
});
for (const url of ['http://www.sec.gov/doc', 'https://sec.gov.evil.example/doc', 'https://evilsec.gov/doc', 'javascript:alert(1)', '/doc']) test(`SEC source rejects unsafe link ${url}`, () => {
  assert.equal(model.sourceLink(url, ['sec.gov']), null);
});
test('filing UI labels amendments, retrieval time and unknown earnings without invented dates', () => {
  const evidence = { symbol: 'AAPL', cik: '123', state: 'available', observed_at: '2026-10-19T21:00:00Z', scope: 'Issuer-level recent filings', omitted_records: 0,
    filings: [{ id: 'one', form: '8-K/A', accepted_at: '2026-10-19T20:00:00Z', source_url: 'https://www.sec.gov/Archives/doc.htm', amendment: true, results_item_reported: true },
      { id: 'two', form: '8-K', accepted_at: '2026-10-18T20:00:00Z', source_url: 'https://sec.gov.evil.example/doc', amendment: false, results_item_reported: false }] };
  const states = [evidence, '', false, 0];
  const module = load('us/filings.tsx', { react: { ...React, useEffect() {}, useState: () => [states.shift(), () => {}] }, '../lib/api': {}, '../latest-updates/model': model });
  const html = renderToStaticMarkup(React.createElement(module.default, { symbol: 'AAPL' }));
  assert.match(html, /Amendment/);
  assert.match(html, /Upcoming earnings date and BMO\/AMC timing remain unknown/);
  assert.match(html, /Retrieved 2026-10-19T21:00:00Z/);
  assert.match(html, / ET/);
  assert.match(html, /Original source unavailable/);
  assert.doesNotMatch(html, /href="https:\/\/sec.gov.evil/);
});
