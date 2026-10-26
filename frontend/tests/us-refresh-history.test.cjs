const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(states, fetcher = async () => ({ jobs: [] }), poster = async () => ({})) {
  const effects = [], updates = [], opened = [];
  let index = 0;
  const context = { exports: {}, require(name) {
    if (name === 'react') return { ...React, useState: initial => {
      const slot = index++; return [states[slot] ?? initial, value => updates.push([slot, value])];
    }, useRef: initial => ({ current: initial }), useEffect: fn => effects.push(fn) };
    if (name === '../lib/api') return { fetchAPI: fetcher, postAPI: poster };
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

test('interrupted history reports unknown completion without opening a guessed result', () => {
  const fixture=load([[{id:'interrupted',state:'interrupted',completion_unknown:true,error:'Completion is unknown. Check saved research before retrying.',package_id:'a'.repeat(64)}],false,'']);
  const html=renderToStaticMarkup(fixture.element);
  assert.match(html,/Completion is unknown/);
  assert.doesNotMatch(html,/Open saved research/);
  assert.equal(buttons(fixture.element).length,1);
});


test('recovery is hidden without remote capability and needs explicit confirmation', () => {
  const job={id:'one',state:'running'};
  assert.doesNotMatch(renderToStaticMarkup(load([[job],false,'']).element),/Interrupt refresh/);
  const fixture=load([[job],false,'',0,true]);
  const action=buttons(fixture.element).find(button=>button.props.children==='Interrupt refresh');
  action.props.onClick();
  assert.ok(fixture.updates.some(([slot,value])=>slot===6 && value==='one'));
});

test('confirmed recovery submits only job identity and preserves completed race result', async () => {
  const requests=[];
  const fixture=load([[{id:'one',state:'running'}],false,'',0,true,'','one'],undefined,async(url,body)=>{
    requests.push([url,body]);return {job:{id:'one',state:'completed',package_id:'a'.repeat(64)}};
  });
  const action=buttons(fixture.element).find(button=>button.props.children==='Confirm interruption');
  await action.props.onClick();
  assert.equal(requests.length,1);
  assert.equal(requests[0][0],'/api/us/research/jobs/one/interrupt');
  assert.equal(JSON.stringify(requests[0][1]),'{}');
  const update=fixture.updates.find(([slot,value])=>slot===0 && typeof value==='function');
  assert.equal(update[1]([{id:'one',state:'running'}])[0].state,'completed');
});

test('failed recovery gives no invented terminal state and sanitizes feedback', async () => {
  const fixture=load([[{id:'one',state:'running'}],false,'',0,true,'','one'],undefined,async()=>{throw Error('private provider details');});
  await buttons(fixture.element).find(button=>button.props.children==='Confirm interruption').props.onClick();
  assert.equal(fixture.updates.some(([slot])=>slot===0),false);
  const error=fixture.updates.find(([slot,value])=>slot===2 && value);
  assert.match(error[1],/not confirmed/); assert.doesNotMatch(error[1],/private/);
});


test('duplicate recovery clicks send once and late account responses are ignored', async () => {
  let resolve; let count=0;
  const fixture=load([[{id:'one',state:'running'}],false,'',0,true,'','one'],async()=>({jobs:[]}),()=>{count++;return new Promise(done=>resolve=done);});
  const cleanup=fixture.effects[0]();
  await new Promise(done=>setImmediate(done));
  const action=buttons(fixture.element).find(button=>button.props.children==='Confirm interruption');
  const first=action.props.onClick();
  await action.props.onClick();
  assert.equal(count,1);
  cleanup();const before=fixture.updates.length;
  resolve({job:{id:'one',state:'interrupted'}});await first;
  assert.equal(fixture.updates.length,before);
});
