const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
const plan={id:'one',symbol:'AAPL',revision:2,trigger:100,stop:95,state:'draft',session:'2026-10-19',updated_at:'2026-10-20T00:00:00Z',notes:'Saved thesis',exit_policy:'Review invalidation',package_id:'package',setup_version:'setup',expiry:'2026-11-20'};
function load(loader, states=[]){let index=0;const effects=[],updates=[],refs=[];const context={exports:{},require(name){if(name==='react')return {...React,useState:initial=>{const slot=index++;return [states[slot]??initial,value=>updates.push([slot,value])];},useRef:initial=>{const ref={current:initial};refs.push(ref);return ref;},useEffect:fn=>effects.push(fn)};if(name==='../lib/us-plans')return {loadUSPlanRevision:loader};if(name==='../lib/us-research')return {usd:value=>'$'+value};return require(name);}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/us/plan-history.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);const root=context.exports.default({plan});const buttons=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);React.Children.forEach(node.props?.children,walk);}walk(root);return {root,buttons,effects,updates};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('history displays saved evidence read-only with bounded navigation',()=>{const fixture=load(async()=>plan);const html=renderToStaticMarkup(fixture.root);assert.match(html,/Read-only revision 2 of 2/);assert.match(html,/Saved thesis/);assert.match(html,/No trigger, fill, return/);assert.doesNotMatch(html,/<form|<input|<textarea/);assert.equal(fixture.buttons[1].props.disabled,true);});
test('older action verifies exact previous revision',async()=>{const calls=[];const fixture=load(async(p,revision)=>{calls.push(revision);return {...p,revision};});fixture.buttons[0].props.onClick();await tick();assert.deepEqual(calls,[1]);assert.equal(fixture.updates.find(([slot])=>slot===0)[1].revision,1);});
test('failed history load preserves displayed record and sanitizes feedback',async()=>{const fixture=load(async()=>{throw new Error('private detail');});fixture.buttons[0].props.onClick();await tick();assert.equal(fixture.updates.some(([slot])=>slot===0),false);const error=fixture.updates.find(([slot,value])=>slot===2&&value)[1];assert.match(error,/draft are unchanged/);assert.doesNotMatch(error,/private/);});
test('late history response cannot update an unmounted panel',async()=>{let resolve;const fixture=load(()=>new Promise(done=>resolve=done));const cleanup=fixture.effects[0]();fixture.buttons[0].props.onClick();const before=fixture.updates.length;cleanup();resolve({...plan,revision:1});await tick();assert.equal(fixture.updates.length,before);});


test('history renders capital and server-recorded sizing from the displayed revision',()=>{
  const older={...plan,revision:1,direction:'BULL',quantity:10,capital:5000,risk_pct:1,allocation_cap_pct:20,
    sizing:{planning_notional_usd:900,stop_risk_usd:45,risk_budget_usd:50,allocation_budget_usd:1000}};
  const f=load(async()=>older,[older]);const html=renderToStaticMarkup(f.root);
  assert.match(html,/Read-only revision 1 of 2/);assert.match(html,/10 whole shares/);
  for(const value of ['$5000','$900','$45','$50','$1000']) assert.ok(html.includes(value));
  assert.match(html,/1% \/ 20%/);assert.match(html,/belong to this saved revision/);
  assert.doesNotMatch(html,/<form|<input|<textarea/);
});
test('missing or invalid recorded sizing stays unknown without recomputation',()=>{
  const older={...plan,revision:1,quantity:1.5,capital:null,risk_pct:true,allocation_cap_pct:'20',
    sizing:{planning_notional_usd:NaN,stop_risk_usd:-1,risk_budget_usd:false}};
  const html=renderToStaticMarkup(load(async()=>older,[older]).root);
  assert.match(html,/Unknown whole shares/);assert.match(html,/Unknown \/ Unknown/);
  assert.ok((html.match(/Unknown/g)||[]).length>=8);
  assert.doesNotMatch(html,/NaN|false|true|\$null|\$undefined|\$-1/);
});
test('zero-capacity recorded sizing remains explicit zero',()=>{
  const zero={...plan,direction:'BULL',quantity:0,capital:1,risk_pct:1,allocation_cap_pct:1,
    sizing:{planning_notional_usd:0,stop_risk_usd:0,risk_budget_usd:0.01,allocation_budget_usd:0.01}};
  const html=renderToStaticMarkup(load(async()=>zero,[zero]).root);
  assert.match(html,/0 whole shares/);assert.match(html,/Recorded planning notional<\/dt><dd>\$0<\/dd>/);
});
