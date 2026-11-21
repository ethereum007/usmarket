const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const context={exports:{},require:name=>name==='../lib/api'||name==='../lib/us-research'?{}:require(name)};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/us/live-feed.tsx'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText,context);
const verify=context.exports.verifyLiveIdentity;
const valid={state:'connected',feed:'iex',rows:[{symbol:'AAPL'},{symbol:'SPY'}]};
for(const change of [
  {feed:'sip'}, {state:'invented'}, {rows:undefined}, {rows:null}, {rows:{}},
  {rows:[null,null]}, {rows:[{symbol:'AAPL'},{symbol:'AAPL'}]},
  {rows:[{symbol:'MSFT'},{symbol:'SPY'}]}, {rows:[{symbol:'AAPL'}]},
])test('mismatched live response rejected '+JSON.stringify(change),()=>{
  assert.throws(()=>verify({...valid,...change},'AAPL,SPY','iex'),/could not be verified/);
});
test('requested symbols can arrive in provider order without changing evidence',()=>{
  const value={...valid,rows:[...valid.rows].reverse()};
  assert.equal(verify(value,'AAPL,SPY','iex'),value);
});
for(const state of ['denied','unavailable'])test(state+' remains explicit without invented rows',()=>{
  const value={state,feed:'sip'};
  assert.equal(verify(value,'AAPL,SPY','sip'),value);
  assert.throws(()=>verify(value,'AAPL,SPY','iex'),/could not be verified/);
});
