const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/us-browser-notes.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {notesKey,readNotes,writeNotes}=context.exports;
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
function storage(initial={}) {
  const data=new Map(Object.entries(initial)),reads=[],writes=[];
  return {data,reads,writes,getItem:key=>{reads.push(key);return data.get(key)??null;},setItem:(key,value)=>{writes.push(key);data.set(key,value);}};
}
test('account switches never read or overwrite another owner notes or shortlist',()=>{
  const store=storage();
  writeNotes(store,A,{AAPL:{note:'Owner A private thesis',saved:true}});
  assert.equal(JSON.stringify(readNotes(store,B)),'{}');
  writeNotes(store,B,{MSFT:{note:'Owner B thesis',saved:false}});
  assert.equal(readNotes(store,A).AAPL.note,'Owner A private thesis');
  assert.equal(readNotes(store,A).MSFT,undefined);
  assert.equal(readNotes(store,B).AAPL,undefined);
  assert.notEqual(notesKey(A),notesKey(B));
});
test('legacy unowned data is neither read nor automatically migrated',()=>{
  const legacy=JSON.stringify({AAPL:{note:'Unowned private note',saved:true}});
  const store=storage({'alpha-us-research-notes-v1':legacy});
  assert.equal(JSON.stringify(readNotes(store,A)),'{}');
  writeNotes(store,A,{MSFT:{note:'New note',saved:true}});
  assert.equal(store.data.get('alpha-us-research-notes-v1'),legacy);
  assert.deepEqual(store.reads,[notesKey(A)]);
});
test('signed-out or invalid identities never touch browser notes',()=>{
  const store=storage();
  for(const owner of [undefined,'','owner','../other',A.toUpperCase().replace('1111','FFFF')]) {
    assert.equal(notesKey(owner),null);
    assert.equal(JSON.stringify(readNotes(store,owner)),'{}');
    writeNotes(store,owner,{AAPL:{note:'Must not save',saved:true}});
  }
  assert.equal(store.reads.length,0);assert.equal(store.writes.length,0);
});
test('malformed note entries are excluded and storage failures remain explicit',()=>{
  const store=storage({[notesKey(A)]:JSON.stringify({AAPL:{note:'Valid',saved:true},MSFT:{note:2,saved:true},'../bad':{note:'Bad',saved:true}})});
  assert.deepEqual(Object.keys(readNotes(store,A)),['AAPL']);
  assert.throws(()=>readNotes({getItem:()=>'{bad'},A));
  assert.throws(()=>writeNotes({setItem:()=>{throw Error('Unavailable');}},A,{}));
});
