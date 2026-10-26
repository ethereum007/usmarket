const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');const path = require('node:path');const vm = require('node:vm');const ts = require('typescript');
const id='11111111-1111-4111-8111-111111111111';
function load(poster) {
  const requests=[],jobs=[],errors=[],pending=[],lifecycle={active:true,pending:false};
  const context={exports:{},require:name=>{if(name==='./api')return {postAPI:(url,body)=>{requests.push([url,body]);return poster(url,body);}};throw Error(name);}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/us-refresh-submit.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {start:()=>context.exports.submitRefresh({symbols:'AAPL',benchmark:'SPY',feed:'sip'},lifecycle,job=>jobs.push(job),error=>errors.push(error),value=>pending.push(value)),requests,jobs,errors,pending,lifecycle};
}
test('rapid clicks submit once before acknowledgement and send no owner selector',async()=>{
  let resolve;const f=load(()=>new Promise(done=>resolve=done));const first=f.start();await f.start();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0][0],'/api/us/research/refresh');
  assert.equal(JSON.stringify(f.requests[0][1]),JSON.stringify({symbols:'AAPL',benchmark:'SPY',feed:'sip'}));
  resolve({job:{id,state:'queued',owner:'hidden'}});await first;
  assert.equal(JSON.stringify(f.jobs),JSON.stringify([{id,state:'queued'}]));assert.deepEqual(f.pending,[true,false]);
});
test('account cleanup ignores a late acknowledgement and pending UI updates',async()=>{
  let resolve;const f=load(()=>new Promise(done=>resolve=done));const first=f.start();
  f.lifecycle.active=false;resolve({job:{id,state:'queued'}});await first;
  assert.equal(f.jobs.length,0);assert.deepEqual(f.pending,[true]);
});
for(const job of [null,{id:'wrong',state:'queued'},{id,state:'completed'},{id,state:'invented'}])test('malformed admission is unconfirmed '+JSON.stringify(job),async()=>{
  const f=load(async()=>({job}));await f.start();assert.equal(f.jobs.length,0);
  assert.match(f.errors.at(-1),/not confirmed/);assert.equal(f.lifecycle.pending,false);
});
test('timeout does not fabricate a failed job and allows an explicit later attempt',async()=>{
  let count=0;const f=load(async()=>{if(!count++)throw Error('private provider details');return {job:{id,state:'queued'}};});
  await f.start();assert.equal(f.jobs.length,0);assert.doesNotMatch(f.errors.at(-1),/provider details/);
  await f.start();assert.equal(f.jobs.length,1);assert.equal(f.requests.length,2);
});
