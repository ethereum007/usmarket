const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(fetcher) {
  const timers=[], cleared=[], statuses=[], errors=[], requests=[];
  const context={exports:{},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:id=>cleared.push(id),encodeURIComponent,
    require(name){if(name==='./api')return {fetchAPI:url=>{requests.push(url);return fetcher(url);}};throw new Error(name);}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/us-refresh-status.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {restore:()=>context.exports.restoreActiveRefresh(),start:job=>context.exports.observeRefresh(job,value=>statuses.push(value),value=>errors.push(value)),timers,cleared,statuses,errors,requests};
}
test('transport failure preserves recorded outcome and sanitizes details',async()=>{
  const fixture=load(async()=>{throw new Error('private provider response');});
  const job={id:'one',state:'running'};fixture.start(job);await fixture.timers[0]();
  assert.equal(job.state,'running');assert.equal(fixture.statuses.length,0);
  assert.match(fixture.errors[0],/last recorded outcome is unchanged/);
  assert.doesNotMatch(fixture.errors[0],/private/);
});
for(const state of ['completed','failed','interrupted'])test(`server ${state} remains the recorded outcome`,async()=>{
  const fixture=load(async()=>({job:{id:'one',state,...(state==='completed'?{package_id:'a'.repeat(64)}:{})}}));fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses[0].state,state);assert.equal(fixture.errors.length,0);
});
test('late responses after cleanup cannot affect another account',async()=>{
  let resolve;const fixture=load(()=>new Promise(done=>resolve=done));
  const stop=fixture.start({id:'one',state:'running'});const pending=fixture.timers[0]();
  stop();resolve({job:{id:'one',state:'completed',package_id:'a'.repeat(64)}});await pending;
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.errors.length,0);assert.deepEqual(fixture.cleared,[1]);
});
test('a fresh observation can recover after a failed status check',async()=>{
  let count=0;const fixture=load(async()=>{if(!count++)throw new Error('offline');return {job:{id:'one',state:'completed',package_id:'a'.repeat(64)}};});
  const job={id:'one',state:'running'};fixture.start(job);await fixture.timers[0]();fixture.start(job);await fixture.timers[1]();
  assert.equal(fixture.statuses[0].state,'completed');assert.equal(fixture.requests.length,2);
});
for(const job of [{id:'another',state:'completed',package_id:'a'.repeat(64)},{id:'one',state:'invented'}])test(`unexpected response is not accepted: ${job.id}/${job.state}`,async()=>{
  const fixture=load(async()=>({job}));fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.errors.length,1);
});
test('terminal records and missing jobs do not poll',()=>{
  const fixture=load(async()=>{throw new Error('must not fetch');});
  for(const state of ['completed','failed','interrupted'])fixture.start({id:'one',state});fixture.start(null);
  assert.equal(fixture.timers.length,0);
});


for(const state of ['queued','running'])test(`reload rediscovers recorded ${state} without creating work`,async()=>{
  const fixture=load(async()=>({jobs:[{id:'terminal',state:'completed',package_id:'a'.repeat(64)},{id:'existing',state}]}));
  const job=await fixture.restore();
  assert.equal(job.id,'existing');assert.equal(job.state,state);
  assert.deepEqual(fixture.requests,['/api/us/research/jobs']);
  assert.equal(fixture.timers.length,0);
  fixture.start(job);assert.equal(fixture.timers.length,1);
});

test('completed or interrupted history does not invent an active refresh',async()=>{
  const fixture=load(async()=>({jobs:[{id:'done',state:'completed',package_id:'a'.repeat(64)},{id:'unknown',state:'interrupted'}]}));
  assert.equal(await fixture.restore(),null);
});
for(const jobs of [null,[{id:'one',state:'invented'}],[{id:'one',state:'running'},{id:'two',state:'queued'}],
    [{id:'same',state:'running'},{id:'same',state:'completed',package_id:'a'.repeat(64)}]])test('malformed or ambiguous history does not select a guessed worker '+JSON.stringify(jobs),async()=>{
  const fixture=load(async()=>({jobs}));await assert.rejects(fixture.restore());
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.timers.length,0);
});


for(const package_id of [undefined,null,'not-a-package','../old','A'.repeat(64),true])test('completed observation requires exact package identity '+String(package_id),async()=>{
  const fixture=load(async()=>({job:{id:'one',state:'completed',package_id}}));
  fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.errors.length,1);
  assert.match(fixture.errors[0],/last recorded outcome is unchanged/);
});
test('verified completion preserves its exact package instead of choosing catalog evidence',async()=>{
  const id='b'.repeat(64);
  const fixture=load(async()=>({job:{id:'one',state:'completed',package_id:id}}));
  fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses[0].package_id,id);assert.equal(fixture.errors.length,0);
});


for(const job of [{id:'one',state:'failed',error:{private:'provider payload'}},
  {id:'one',state:'running',updated_at:{private:'provider payload'}},null,[]])
test('polling rejects malformed observation fields without changing outcome '+JSON.stringify(job),async()=>{
  const f=load(async()=>({job}));const prior={id:'one',state:'running'};
  f.start(prior);await f.timers[0]();
  assert.equal(prior.state,'running');assert.equal(f.statuses.length,0);
  assert.equal(f.errors.length,1);assert.doesNotMatch(f.errors[0],/private|payload/);
});
