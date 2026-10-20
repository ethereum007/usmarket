const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
function load(file){const context={exports:{},require(name){if(name==='../lib/us-research')return load('lib/us-research.ts');return require(name);}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app',file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;}
const moduleUnderTest=load('us/session-brief.tsx');
function fixture(change={}){const symbols=change.symbols || ['AAPL','MSFT'];return {instrument_snapshot:{records:Object.fromEntries(symbols.map(symbol=>[symbol,{resolution:'resolved'}]))},session:'2026-10-19',state:'final',benchmark:'SPY',feed:'sip',symbols:['AAPL','MSFT'],features:{AAPL:{available:true,rs20:5,rs60:null},MSFT:{available:true,rs20:8,rs60:9}},setups:[{symbol:'AAPL'}],...change};}
test('ranks existing benchmark RS and preserves setup counts without inventing scores',()=>{
const brief=moduleUnderTest.sessionBrief(fixture());assert.equal(brief.leaders[0].symbol,'MSFT');assert.equal(brief.leaders[1].setups,1);assert.equal(brief.available,2);});
test('gapped, unresolved and excluded histories cannot enter candidates',()=>{
for(const change of [{history_gaps:{MSFT:['2026-10-01']}},{instrument_exclusions:{MSFT:'unresolved'}},{instrument_snapshot:{records:{AAPL:{resolution:'resolved'},MSFT:{resolution:'unavailable'}}}}]){
const brief=moduleUnderTest.sessionBrief(fixture(change));assert.deepEqual(Array.from(brief.leaders,row=>row.symbol),['AAPL']);assert.equal(brief.rankable,1);}});
test('missing and non-finite RS remain unknown rather than zero or a leader',()=>{
for(const value of [null,undefined,NaN,Infinity]){const brief=moduleUnderTest.sessionBrief(fixture({features:{AAPL:{available:true,rs20:value},MSFT:{available:false,rs20:99}}}));assert.equal(brief.rankable,0);assert.equal(brief.available,1);}});
test('candidate list is bounded and ties deterministic with duplicate membership removed',()=>{
const symbols=['G','F','E','D','C','B','A','A'];const brief=moduleUnderTest.sessionBrief(fixture({symbols,features:Object.fromEntries(symbols.map(symbol=>[symbol,{available:true,rs20:-2}]))}));
assert.equal(brief.requested,7);assert.equal(brief.leaders.length,5);assert.deepEqual(Array.from(brief.leaders,row=>row.symbol),['A','B','C','D','E']);});
test('partial/historical brief exposes limitations and unknown earnings',()=>{
const html=renderToStaticMarkup(React.createElement(moduleUnderTest.default,{data:fixture({state:'partial'}),onInspect:()=>{}}));
for(const text of ['2026-10-19','Partial research','not current market conditions','does not represent the entire US market','Earnings date and BMO/AMC timing remain unknown','Unknown','Negative values still trail SPY'])assert.ok(html.includes(text),text);
assert.match(html,/scope="col"/);assert.match(html,/scope="row"/);});
test('empty evidence is explicit and inspection opens the exact ranked symbol',()=>{
const html=renderToStaticMarkup(React.createElement(moduleUnderTest.default,{data:fixture({features:{}}),onInspect:()=>{}}));assert.match(html,/No eligible relative-strength candidates/);
const opened=[];const root=moduleUnderTest.default({data:fixture(),onInspect:symbol=>opened.push(symbol)});
function visit(node){if(!node||typeof node!=='object')return;if(node.type==='button')node.props.onClick();React.Children.forEach(node.props?.children,visit);}visit(root);
assert.deepEqual(opened,['MSFT','AAPL']);});

test('legacy packages without resolved instrument evidence cannot produce candidates',()=>{
const brief=moduleUnderTest.sessionBrief(fixture({instrument_snapshot:undefined}));assert.equal(brief.rankable,0);assert.equal(brief.available,2);
});
