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
  return {start:job=>context.exports.observeRefresh(job,value=>statuses.push(value),value=>errors.push(value)),timers,cleared,statuses,errors,requests};
}
test('transport failure preserves recorded outcome and sanitizes details',async()=>{
  const fixture=load(async()=>{throw new Error('private provider response');});
  const job={id:'one',state:'running'};fixture.start(job);await fixture.timers[0]();
  assert.equal(job.state,'running');assert.equal(fixture.statuses.length,0);
  assert.match(fixture.errors[0],/last recorded outcome is unchanged/);
  assert.doesNotMatch(fixture.errors[0],/private/);
});
for(const state of ['completed','failed','interrupted'])test(`server ${state} remains the recorded outcome`,async()=>{
  const fixture=load(async()=>({job:{id:'one',state}}));fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses[0].state,state);assert.equal(fixture.errors.length,0);
});
test('late responses after cleanup cannot affect another account',async()=>{
  let resolve;const fixture=load(()=>new Promise(done=>resolve=done));
  const stop=fixture.start({id:'one',state:'running'});const pending=fixture.timers[0]();
  stop();resolve({job:{id:'one',state:'completed'}});await pending;
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.errors.length,0);assert.deepEqual(fixture.cleared,[1]);
});
test('a fresh observation can recover after a failed status check',async()=>{
  let count=0;const fixture=load(async()=>{if(!count++)throw new Error('offline');return {job:{id:'one',state:'completed'}};});
  const job={id:'one',state:'running'};fixture.start(job);await fixture.timers[0]();fixture.start(job);await fixture.timers[1]();
  assert.equal(fixture.statuses[0].state,'completed');assert.equal(fixture.requests.length,2);
});
for(const job of [{id:'another',state:'completed'},{id:'one',state:'invented'}])test(`unexpected response is not accepted: ${job.id}/${job.state}`,async()=>{
  const fixture=load(async()=>({job}));fixture.start({id:'one',state:'running'});await fixture.timers[0]();
  assert.equal(fixture.statuses.length,0);assert.equal(fixture.errors.length,1);
});
test('terminal records and missing jobs do not poll',()=>{
  const fixture=load(async()=>{throw new Error('must not fetch');});
  for(const state of ['completed','failed','interrupted'])fixture.start({id:'one',state});fixture.start(null);
  assert.equal(fixture.timers.length,0);
});
