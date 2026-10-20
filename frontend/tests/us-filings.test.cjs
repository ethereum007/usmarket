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


function renderEvidence(view, filings) {
  const evidence={symbol:'AAPL',cik:'123',state:'partial',observed_at:'2026-10-19T21:00:00Z',scope:'Issuer-level recent filings',omitted_records:1,filings};
  const states=[evidence,'',false,0,view];
  const module=load('us/filings.tsx',{react:{...React,useEffect(){},useState:()=>[states.shift(),()=>{}]},'../lib/api':{},'../latest-updates/model':model});
  return renderToStaticMarkup(React.createElement(module.default,{symbol:'AAPL'}));
}
const reportRows=[{id:'results',form:'8-K/A',accepted_at:'2026-10-19T20:00:00Z',filing_date:'2026-10-19',report_date:'2026-10-16',source_url:'https://www.sec.gov/Archives/results.htm',amendment:true,results_item_reported:true},
{id:'periodic',form:'10-Q',accepted_at:'2026-10-18T20:00:00Z',filing_date:'2026-10-18',report_date:'2026-09-30',source_url:'https://www.sec.gov/Archives/periodic.htm',amendment:false,results_item_reported:false}];
test('filing, report and acceptance dates stay distinct with no fiscal-period inference',()=>{
  const html=renderEvidence('all',reportRows);
  assert.match(html,/Accepted/);assert.match(html,/Filing date: 2026-10-19/);assert.match(html,/Report date: 2026-10-16/);
  assert.match(html,/fiscal quarter\/year and earnings-event timing are not inferred/);
  assert.match(html,/Showing 2 of 2/);assert.match(html,/Partial evidence/);
});
test('results filter preserves amendment evidence without showing unrelated periodic reports',()=>{
  const html=renderEvidence('results',reportRows);
  assert.match(html,/results.htm/);assert.doesNotMatch(html,/periodic.htm/);
  assert.match(html,/Amendment/);assert.match(html,/Showing 1 of 2/);
});
test('periodic filter includes amended reports without interpreting results-item status',()=>{
  const html=renderEvidence('periodic',[...reportRows,{...reportRows[1],id:'amendment',form:'10-Q/A',source_url:'https://www.sec.gov/Archives/amendment.htm'}]);
  assert.match(html,/periodic.htm/);assert.match(html,/amendment.htm/);assert.doesNotMatch(html,/results.htm/);
});
test('empty filter is distinct from absent filing evidence',()=>{
  const html=renderEvidence('results',[reportRows[1]]);
  assert.match(html,/No returned filings match this filter/);assert.doesNotMatch(html,/No supported recent filings returned/);
  assert.match(html,/Upcoming earnings date and BMO\/AMC timing remain unknown/);
});
test('missing report dates remain unknown and date-only values are not timezone shifted',()=>{
  const html=renderEvidence('all',[{...reportRows[1],report_date:null}]);
  assert.match(html,/Report date: Unknown/);assert.match(html,/Filing date: 2026-10-18/);
});
