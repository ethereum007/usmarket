const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function compile(file, mocks = {}, globals = {}) {
  const context = { exports: {}, Error, ...globals, require: name => mocks[name] || (["./plan-history", "./plan-export"].includes(name) ? { default: () => null } : require(name)) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  return context.exports;
}
const setup = { symbol: 'AAPL', signal: 'BULL', provider_asset_id: '11111111-1111-4111-8111-111111111111', setup_version: 'b'.repeat(64), setup_id: 'c'.repeat(64), source_snapshot_id: 'd'.repeat(64), entry_price: 100, stop_loss: 95 };
const data = { id: 'a'.repeat(64), market: 'US', currency: 'USD', state: 'final', session: '2026-10-16', setups: [setup] };
const plan = { id: 'plan-id', revision: 2, market: 'US', currency: 'USD', session: data.session, provider_asset_id: setup.provider_asset_id, package_id: data.id, setup_version: setup.setup_version, setup_id: setup.setup_id, source_snapshot_id: setup.source_snapshot_id, symbol: 'AAPL', direction: 'BULL', notes: 'original' };
const fields = () => new Map(Object.entries({ trigger: '100', stop: '95', expiry: '2026-11-25', capital: '10000', risk_pct: '1', allocation_cap_pct: '20', notes: 'Private thesis', exit_policy: 'Review invalidation', state: 'draft', owner: 'forged', filled: 'true', earnings_state: 'checked_no_event' }));
test('US request uses exact source, expected revision and explicit fields only', async () => {
  let sent;
  const lib = compile('lib/us-plans.ts', { './api': { postAPI: async (url, body) => { sent = { url, body }; return { plan: {...plan,revision:3} }; } } });
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
function editorFixture(save, existing = null, preview = async () => ({ sizing: { quantity: 20 } }), browser, replacementGuard, onDraftStarted) {
  const updates = [], saved = [], effects = [];
  let uuids = 0;
  const react = { ...React, useState: value => [value, next => updates.push(next)], useRef: value => ({ current: value }), useEffect: effect => effects.push(effect) };
  const lib = compile('us/plans.tsx', {
    react, 'next/dynamic': { default: () => () => null },
    '../lib/theme': { useTheme: () => ({ theme: 'dark' }) },
    '../lib/us-plans': { saveUSPlan: save, previewUSPlanSizing: preview }, '../lib/us-research': { usd: value => `$${value}` },
  }, { ...(browser ? { window: browser } : {}), FormData: class { constructor() { return fields(); } }, crypto: { randomUUID: () => `new-${++uuids}` } });
  const element = lib.USPlanEditor({ data, setup, existing, onSaved: item => saved.push(item), replacementGuard, onDraftStarted });
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

test('historical revision reload reuses source verification and never posts', async () => {
  const calls=[];const old={...plan,revision:1};
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>{calls.push(url);return url.includes('/research/')?{package:data}:{plan:old};},postAPI:()=>{throw new Error('must not save');}}});
  const saved=await lib.loadUSPlanRevision(plan,1);
  assert.equal(saved.revision,1);assert.ok(calls.includes('/api/us/plans/plan-id?revision=1'));
});
for(const revision of [0,-1,1.5,3,NaN])test(`invalid history revision never fetches: ${revision}`,async()=>{
  let calls=0;const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:()=>calls++}});
  await assert.rejects(()=>lib.loadUSPlanRevision(plan,revision),/existing saved revision/);assert.equal(calls,0);
});
test('history refuses a rebound historical thesis',async()=>{
  const old={...plan,revision:1,setup_version:'changed'};
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>url.includes('/research/')?{package:data}:{plan:old}}});
  await assert.rejects(()=>lib.loadUSPlanRevision(plan,1),/evidence|thesis/);
});


test('sizing preview sends only direction and numeric sizing fields',async()=>{
  let sent;const lib=compile('lib/us-plans.ts',{'./api':{postAPI:async(url,body)=>{sent={url,body};return {sizing:{quantity:20}};}}});
  await lib.previewUSPlanSizing('BULL',fields());
  assert.equal(sent.url,'/api/us/plans/sizing-preview');
  assert.deepEqual(Object.keys(sent.body).sort(),['allocation_cap_pct','capital','direction','risk_pct','stop','trigger']);
  assert.equal(sent.body.trigger,100);assert.equal(sent.body.direction,'BULL');
});
function previewButton(element){let found;function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button'&&node.props.type==='button')found=node;React.Children.forEach(node.props?.children,walk);}walk(element);return found;}
test('preview shows server sizing without saving a revision',async()=>{
  let saves=0;const fixture=editorFixture(async()=>{saves++;return {plan};},null,async()=>({sizing:{quantity:20}}));
  previewButton(fixture.element).props.onClick({currentTarget:{form:{}}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saves,0);assert.ok(fixture.updates.some(value=>value?.quantity===20));
});
test('changing inputs invalidates an in-flight sizing response',async()=>{
  let resolve;const fixture=editorFixture(async()=>({plan}),null,()=>new Promise(done=>resolve=done));
  previewButton(fixture.element).props.onClick({currentTarget:{form:{}}});fixture.element.props.onChange();resolve({sizing:{quantity:20}});
  await new Promise(done=>setImmediate(done));assert.equal(fixture.updates.some(value=>value?.quantity===20),false);
});
test('closing editor invalidates an in-flight sizing response',async()=>{
  let resolve;const fixture=editorFixture(async()=>({plan}),null,()=>new Promise(done=>resolve=done));
  previewButton(fixture.element).props.onClick({currentTarget:{form:{}}});fixture.cleanups.forEach(fn=>fn?.());resolve({sizing:{quantity:20}});
  await new Promise(done=>setImmediate(done));assert.equal(fixture.updates.some(value=>value?.quantity===20),false);
});


function departureFixture(save) {
  const listeners=new Map();
  const browser={addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
  const f=editorFixture(save,null,undefined,browser);
  function departure() { let blocked=false;const event={preventDefault:()=>{blocked=true;},returnValue:undefined};listeners.get('beforeunload')?.(event);return {blocked,event}; }
  return {...f,listeners,departure};
}
test('clean editor leaves freely but edited draft requests browser departure warning',()=>{
  const f=departureFixture(async()=>({plan}));
  assert.equal(f.departure().blocked,false);
  f.element.props.onChange();
  assert.equal(f.departure().blocked,true);
  assert.equal(f.departure().event.returnValue,'');
  f.cleanups.forEach(cleanup=>cleanup?.());
  assert.equal(f.listeners.size,0);
});
test('failed save preserves unsaved departure warning and confirmed save clears it',async()=>{
  let fails=true;const f=departureFixture(async()=>{if(fails)throw Error('Not confirmed');return {plan};});
  f.element.props.onChange();
  const event={preventDefault(){},currentTarget:{}};
  await f.element.props.onSubmit(event);
  assert.equal(f.departure().blocked,true);assert.equal(f.saved.length,0);
  fails=false;await f.element.props.onSubmit(event);
  assert.equal(f.departure().blocked,false);assert.deepEqual(f.saved,[plan]);
});
test('pending save warns on departure and late failure cannot update unmounted editor',async()=>{
  let reject;const f=departureFixture(()=>new Promise((done,fail)=>{reject=fail;}));
  const pending=f.element.props.onSubmit({preventDefault(){},currentTarget:{}});
  assert.equal(f.departure().blocked,true);
  f.cleanups.forEach(cleanup=>cleanup?.());
  const before=f.updates.length;reject(Error('Synthetic late failure'));await pending;
  assert.equal(f.updates.length,before);assert.equal(f.listeners.size,0);
});


test('replacement guard confirms current edits and blocks pending saves',async()=>{
  let confirmed=false, prompts=0, finish;
  const guard={current:null};
  const f=editorFixture(()=>new Promise(resolve=>finish=resolve),null,undefined,{confirm:()=>{prompts++;return confirmed;},addEventListener(){},removeEventListener(){}},guard);
  assert.equal(guard.current(),true);
  f.element.props.onChange();assert.equal(guard.current(),false);assert.equal(prompts,1);
  confirmed=true;assert.equal(guard.current(),true);
  const pending=f.element.props.onSubmit({preventDefault(){},currentTarget:{}});
  const before=prompts;assert.equal(guard.current(),false);assert.equal(prompts,before);
  finish({plan});await pending;assert.equal(guard.current(),true);assert.equal(prompts,before);
  f.cleanups.forEach(fn=>fn?.());assert.equal(guard.current,null);
});
test('failed save keeps replacement confirmation required',async()=>{
  const guard={current:null};let prompts=0;
  const f=editorFixture(async()=>{throw Error('unconfirmed');},null,undefined,{confirm:()=>{prompts++;return false;},addEventListener(){},removeEventListener(){}},guard);
  f.element.props.onChange();await f.element.props.onSubmit({preventDefault(){},currentTarget:{}});
  assert.equal(guard.current(),false);assert.equal(prompts,1);assert.equal(f.saved.length,0);
});


test('evidence finishing after edits checks replacement guard before replacing editor',async()=>{
  let complete, stateIndex=0;const refs=[], updates=[];
  const react={...React,useState:value=>{const index=stateIndex++;return [index===0?[plan]:value,next=>updates.push({index,next})];},useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useEffect(){}};
  const lib=compile('us/plans.tsx',{react,'next/dynamic':{default:()=>()=>null},'../lib/theme':{useTheme:()=>({theme:'dark'})},'../lib/us-plans':{loadUSPlan:()=>new Promise(resolve=>complete=resolve)},'../lib/us-research':{usd:value=>`$${value}`}});
  const tree=lib.default({data,setup});let open;
  function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button'&&String(node.props.children).startsWith('Open saved evidence'))open=node;React.Children.forEach(node.props?.children,walk);}walk(tree);
  open.props.onClick();let checks=0;refs[2].current=()=>{checks++;return false;};
  complete({plan,data,setup});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(checks,1);assert.equal(updates.some(row=>row.index===3),false);
  assert.ok(updates.some(row=>row.index===2&&String(row.next).includes('replacement cancelled')));
});


function draftWorkspace() {
  const states=[], refs=[];let stateIndex=0, refIndex=0;
  const react={...React,useState:value=>{const index=stateIndex++;if(!(index in states))states[index]=value;return [states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},useRef:value=>{const index=refIndex++;return refs[index]||(refs[index]={current:value});},useEffect(){}};
  const lib=compile('us/plans.tsx',{react,'next/dynamic':{default:()=>()=>null},'../lib/theme':{useTheme:()=>({theme:'dark'})},'../lib/us-plans':{},'../lib/us-research':{usd:value=>`$${value}`}});
  function find(tree,predicate){let found;function walk(node){if(!node||typeof node!=='object')return;if(predicate(node))found=node;React.Children.forEach(node.props?.children,walk);}walk(tree);return found;}
  function render(selectedData=data,selectedSetup=setup){stateIndex=0;refIndex=0;const tree=lib.default({data:selectedData,setup:selectedSetup});return {editor:find(tree,node=>node.type===lib.USPlanEditor),start:find(tree,node=>node.type==='button'&&node.props.children==='Start a new plan for the selected setup')};}
  return {render,refs};
}

test('new draft keeps exact research and editor identity across selection changes and loading',()=>{
  const workspace=draftWorkspace();const first=workspace.render();first.editor.props.onDraftStarted();
  const otherSetup={...setup,symbol:'MSFT',setup_version:'e'.repeat(64)};
  const otherData={...data,id:'f'.repeat(64),setups:[otherSetup]};
  const changed=workspace.render(otherData,otherSetup);
  assert.equal(changed.editor.props.data,data);assert.equal(changed.editor.props.setup,setup);assert.equal(changed.editor.key,first.editor.key);
  assert.equal(workspace.render(null,undefined).editor.props.data,data);
  workspace.refs[2].current=()=>false;changed.start.props.onClick();
  assert.equal(workspace.render(otherData,otherSetup).editor.props.data,data);
  workspace.refs[2].current=()=>true;changed.start.props.onClick();
  const selected=workspace.render(otherData,otherSetup);
  assert.equal(selected.editor.props.data,otherData);assert.equal(selected.editor.props.setup,otherSetup);
  assert.notEqual(selected.editor.key,first.editor.key);
});


test('input change and clean save attempt preserve draft source before asynchronous save',async()=>{
  let pins=0, fail;
  const changed=editorFixture(async()=>({plan}),null,undefined,undefined,undefined,()=>pins++);
  changed.element.props.onChange();assert.equal(pins,1);
  const clean=editorFixture(()=>{assert.equal(pins,2);return new Promise((resolve,reject)=>fail=reject);},null,undefined,undefined,undefined,()=>pins++);
  const saving=clean.element.props.onSubmit({preventDefault(){},currentTarget:{}});
  fail(Error('unconfirmed'));await saving;assert.equal(pins,2);assert.equal(clean.saved.length,0);
});


test('explicit new plan remounts editor even when selected source has not changed',()=>{
  const workspace=draftWorkspace();const first=workspace.render();first.editor.props.onDraftStarted();
  workspace.refs[2].current=()=>true;workspace.render().start.props.onClick();
  const fresh=workspace.render();assert.equal(fresh.editor.props.data,data);
  assert.notEqual(fresh.editor.key,first.editor.key);assert.equal(fresh.start,undefined);
});


for(const field of ['package_id','setup_version','setup_id','source_snapshot_id','symbol','direction'])
test('reopen rejects internally matching but rebound selected thesis: '+field,async()=>{
  const replacement=field==='symbol'?'MSFT':field==='direction'?'BEAR':'e'.repeat(64);
  const saved={...plan,[field]:replacement};
  const changedSetup={...setup,setup_version:saved.setup_version,setup_id:saved.setup_id,
    source_snapshot_id:saved.source_snapshot_id,symbol:saved.symbol,signal:saved.direction};
  const changedData={...data,id:saved.package_id,setups:[changedSetup]};
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>url.includes('/research/')?{package:changedData}:{plan:saved}}});
  await assert.rejects(()=>lib.loadUSPlan(plan),/could not be verified/);
});


for(const field of ['provider_asset_id','session'])test('reopen refuses changed selected asset/session '+field,async()=>{
  const replacement=field==='session'?'2026-10-15':'22222222-2222-4222-8222-222222222222';
  const saved={...plan,[field]:replacement};
  const changedData={...data,session:saved.session,setups:[{...setup,provider_asset_id:saved.provider_asset_id}]};
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>url.includes('/research/')?{package:changedData}:{plan:saved}}});
  await assert.rejects(()=>lib.loadUSPlan(plan),/could not be verified/);
});
for(const change of [{session:'2026-10-15'},{setups:[{...setup,provider_asset_id:'22222222-2222-4222-8222-222222222222'}]}])
test('reopened source must match saved asset/session '+JSON.stringify(change),async()=>{
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>url.includes('/research/')?{package:{...data,...change}}:{plan}}});
  await assert.rejects(()=>lib.loadUSPlan(plan),/could not be verified/);
});


test('legacy missing asset identity stays unknown without inventing a provider mapping',async()=>{
  const oldPlan={...plan,provider_asset_id:null};const oldSetup={...setup};delete oldSetup.provider_asset_id;
  const lib=compile('lib/us-plans.ts',{'./api':{fetchAPI:async url=>url.includes('/research/')?{package:{...data,setups:[oldSetup]}}:{plan:oldPlan}}});
  const result=await lib.loadUSPlan(oldPlan);assert.equal(result.plan.provider_asset_id,null);
  assert.equal(result.setup.provider_asset_id,undefined);
});


for(const change of [{id:'other'},{revision:2},{revision:4},{package_id:'e'.repeat(64)},
  {setup_version:'e'.repeat(64)},{setup_id:'e'.repeat(64)},{source_snapshot_id:'e'.repeat(64)},
  {symbol:'MSFT'},{direction:'BEAR'},{session:'2026-10-15'},
  {provider_asset_id:'22222222-2222-4222-8222-222222222222'},{market:'NSE'},{currency:'INR'}])
test('save acknowledgement must match requested next revision and source '+JSON.stringify(change),async()=>{
  const lib=compile('lib/us-plans.ts',{'./api':{postAPI:async()=>({plan:{...plan,revision:3,...change}})}});
  await assert.rejects(()=>lib.saveUSPlan(plan.id,data,setup,plan,fields()),/not confirmed/);
});

test('new-plan acknowledgement confirms revision one only',async()=>{
  const lib=compile('lib/us-plans.ts',{'./api':{postAPI:async()=>({plan:{...plan,revision:1}})}});
  assert.equal((await lib.saveUSPlan(plan.id,data,setup,null,fields())).plan.revision,1);
});
