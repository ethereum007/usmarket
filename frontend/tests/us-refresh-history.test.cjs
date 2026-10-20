const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(states, fetcher = async () => ({ jobs: [] })) {
  const effects = [], updates = [], opened = [];
  let index = 0;
  const context = { exports: {}, require(name) {
    if (name === 'react') return { ...React, useState: initial => {
      const slot = index++; return [states[slot] ?? initial, value => updates.push([slot, value])];
    }, useEffect: fn => effects.push(fn) };
    if (name === '../lib/api') return { fetchAPI: fetcher };
    return require(name);
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app/us/refresh-history.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, context);
  const element = context.exports.default({ onOpen: id => opened.push(id), revision: '' });
  return { element, effects, updates, opened };
}
function buttons(element) {
  const found=[];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') found.push(node);
    React.Children.forEach(node.props?.children, walk);
  }
  walk(element);return found;
}
test('history shows empty state only after a successful load', () => {
  const html=renderToStaticMarkup(load([[],false,'']).element);
  assert.match(html,/No recorded refresh jobs/);
  assert.match(html,/not a worker heartbeat/);
  assert.doesNotMatch(renderToStaticMarkup(load([[],true,'']).element),/No recorded refresh jobs/);
});
test('history failures are distinct from an empty history', () => {
  const html=renderToStaticMarkup(load([[],false,'History unavailable']).element);
  assert.match(html,/role="alert"/);
  assert.doesNotMatch(html,/No recorded refresh jobs/);
});
test('only completed jobs with valid package IDs can open exact research', () => {
  const id='a'.repeat(64);
  const fixture=load([[{id:'one',state:'completed',package_id:id},{id:'two',state:'running',package_id:id},{id:'three',state:'completed',package_id:'../bad'}],false,'']);
  const actions=buttons(fixture.element);
  assert.equal(actions.length,2);
  actions[1].props.onClick();
  assert.deepEqual(fixture.opened,[id]);
});
test('history retrieves the owner-scoped API with no client-supplied owner', async () => {
  const requests=[];
  const fixture=load([],async url => {requests.push(url);return {jobs:[{id:'saved',state:'completed'}]};});
  fixture.effects[0]();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,['/api/us/research/jobs']);
  assert.ok(fixture.updates.some(([slot,value])=>slot===0 && value[0]?.id==='saved'));
});
test('late history responses cannot update an unmounted account panel', async () => {
  let resolve;
  const fixture=load([],()=>new Promise(done=>resolve=done));
  const cleanup=fixture.effects[0]();
  const before=fixture.updates.length;
  cleanup(); resolve({jobs:[{id:'old-owner'}]});
  await new Promise(done=>setImmediate(done));
  assert.equal(fixture.updates.length,before);
});
test('transport errors are sanitized in history feedback', async () => {
  const fixture=load([],async()=>{throw new Error('private provider details');});
  fixture.effects[0]();
  await new Promise(done=>setImmediate(done));
  const error=fixture.updates.find(([slot,value])=>slot===2 && value);
  assert.match(error[1],/history is unavailable/);
  assert.doesNotMatch(error[1],/private/);
});
