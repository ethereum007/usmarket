const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const valid={schema_version:1,market:'US',currency:'USD',revision_count:2,plan_revisions:[{id:'same',revision:1},{id:'same',revision:2}]};
function load(fetcher) {
  const effects=[],updates=[],requests=[],downloads=[],revoked=[],blobs=[];
  const context={exports:{},Blob:class {constructor(parts){blobs.push(parts.join(''));}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:url=>revoked.push(url)},
    document:{body:{appendChild(){}},createElement:()=>({click(){downloads.push([this.href,this.download]);},remove(){}})},require(name){
      if(name==='react')return {...React,useState:initial=>[initial,value=>updates.push(value)],useRef:initial=>({current:initial}),useEffect:fn=>effects.push(fn)};
      if(name==='../lib/api')return {fetchAPI:url=>{requests.push(url);return fetcher(url);}};
      return require(name);
    }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/us/plan-export.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const element=context.exports.default();
  return {start:()=>element.props.children[0].props.onClick(),effects,updates,requests,downloads,revoked,blobs};
}
const flush=()=>new Promise(done=>setImmediate(done));
test('private history download retains all revisions and releases the object URL',async()=>{
  const fixture=load(async()=>valid);fixture.start();await flush();
  assert.deepEqual(fixture.requests,['/api/us/plans/export']);
  assert.equal(fixture.downloads[0][1],'usmarket-plan-history.json');
  assert.deepEqual(JSON.parse(fixture.blobs[0]),valid);assert.deepEqual(fixture.revoked,['blob:test']);
});
test('duplicate clicks send once and account cleanup prevents a late download',async()=>{
  let resolve;const fixture=load(()=>new Promise(done=>resolve=done));
  const cleanup=fixture.effects[0]();fixture.start();fixture.start();assert.equal(fixture.requests.length,1);
  cleanup();const before=fixture.updates.length;resolve(valid);await flush();
  assert.equal(fixture.downloads.length,0);assert.equal(fixture.updates.length,before);
});
for(const payload of [{...valid,revision_count:1},{...valid,currency:'INR'},null])test('invalid history is not downloaded '+JSON.stringify(payload),async()=>{
  const fixture=load(async()=>payload);fixture.start();await flush();
  assert.equal(fixture.downloads.length,0);assert.ok(fixture.updates.some(value=>typeof value==='string' && value.includes('not confirmed')));
});
test('network failures do not leak provider text or create a download',async()=>{
  const fixture=load(async()=>{throw Error('private provider details');});fixture.start();await flush();
  assert.equal(fixture.downloads.length,0);assert.ok(fixture.updates.some(value=>typeof value==='string' && value.includes('not confirmed')));
  assert.equal(fixture.updates.some(value=>typeof value==='string' && value.includes('provider details')),false);
});
