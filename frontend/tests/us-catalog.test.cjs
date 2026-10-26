const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(fetcher=async()=>({packages:[]})) {
  const context={exports:{},require:name=>{if(name==='./api')return {fetchAPI:fetcher};throw Error(name);}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/us-catalog.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  return context.exports;
}
test('newest final evidence takes precedence over an older broader universe',()=>{
  const newer={id:'new',state:'final',session:'2026-10-23',symbols:['AAPL']};
  const older={id:'old',state:'final',session:'2026-10-22',symbols:Array(30).fill('SYNTHETIC')};
  assert.equal(load().defaultCatalogPackage([newer,older]).id,'new');
});
test('newer partial evidence never silently replaces a retained final default',()=>{
  assert.equal(load().defaultCatalogPackage([{id:'partial',state:'partial'},{id:'final',state:'final'}]).id,'final');
  assert.equal(load().defaultCatalogPackage([{id:'partial',state:'partial'}]).id,'partial');
  assert.equal(load().defaultCatalogPackage([]),undefined);
});
test('late earlier catalog response cannot replace a newer reload',async()=>{
  const requests=[];let generation=1;
  const api=load(()=>new Promise(resolve=>requests.push(resolve)));
  const first=api.currentCatalog(()=>generation===1);generation=2;
  const second=api.currentCatalog(()=>generation===2);
  requests[1]({packages:[{id:'new'}]});assert.equal((await second).packages[0].id,'new');
  requests[0]({packages:[{id:'old'}]});assert.equal(await first,null);
});
test('unmounted account ignores both late results and stale errors',async()=>{
  let reject,active=true;
  const api=load(()=>new Promise((_,fail)=>reject=fail));
  const pending=api.currentCatalog(()=>active);active=false;reject(Error('old account failure'));
  assert.equal(await pending,null);
});
test('current catalog errors remain visible and owner is never a request selector',async()=>{
  const requests=[];const api=load(async url=>{requests.push(url);throw Error('Unavailable');});
  await assert.rejects(api.currentCatalog(()=>true),/Unavailable/);
  assert.deepEqual(requests,['/api/us/research/packages']);
});
