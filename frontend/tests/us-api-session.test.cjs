const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const token = (sub, version = 'old') => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.${version}`;
const denied = () => new Response(JSON.stringify({ detail:'Sign in to the US workspace' }), { status:401, headers:{ 'WWW-Authenticate':'Bearer' } });
function fixture({ initial = token(A), refresh = async () => ({ data:{ session:{ access_token:token(A,'new') } } }), lookup = async () => ({ data:{ session:null } }), response = denied, retryResponse = () => new Response(JSON.stringify({ success:true })) } = {}) {
  const calls = [];
  let refreshed = 0, listener;
  const auth = { getSession:lookup, onAuthStateChange: callback => { listener = callback; }, refreshSession: async () => { refreshed++; return refresh(); } };
  const context = { exports:{}, window:{ location:{ protocol:'https:', host:'localhost' } }, process:{ env:{} },
    Headers, Response, AbortController, setTimeout, clearTimeout, atob,
    fetch: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? response() : retryResponse(); },
    require: name => name === './supabase' ? { supabase:{ auth } } : require(name) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/api.ts'),'utf8'), {
    compilerOptions:{ module:ts.ModuleKind.CommonJS },
  }).outputText, context);
  const api = context.exports;
  api.primeAuthAccessToken(initial);
  return { api, calls, refreshed:() => refreshed, event: next => listener('SIGNED_IN', next ? { access_token:next } : null) };
}
for (const method of ['GET','POST']) test(`US ${method} retries once with refreshed same-account token`, async () => {
  const f = fixture();
  if (method === 'POST') await f.api.postAPI('/api/us/plans/id', { expected_revision:2, notes:'Retain exact draft' });
  else await f.api.fetchAPI('/api/us/research/packages');
  assert.equal(f.refreshed(),1);
  assert.equal(f.calls.length,2);
  assert.equal(new Headers(f.calls[1].init.headers).get('Authorization'),`Bearer ${token(A,'new')}`);
  assert.equal(f.calls[1].init.body,f.calls[0].init.body);
  assert.equal(f.calls[1].init.method,f.calls[0].init.method);
});
for (const next of [token(B,'new'), 'malformed-token']) test(`US request never replays under changed/invalid subject: ${next.slice(-9)}`, async () => {
  const f = fixture({ refresh:async () => ({ data:{ session:{ access_token:next } } }) });
  await assert.rejects(f.api.postAPI('/api/us/plans/id', { notes:'Private A draft' }),/401/);
  assert.equal(f.calls.length,1);
});
for (const initial of ['bad-token',token('not-an-account')]) test('unverifiable initial subject cannot authorize automatic replay',async () => {
  const f = fixture({ initial });
  await assert.rejects(f.api.fetchAPI('/api/us/research/packages'),/401/);
  assert.equal(f.refreshed(),0);
  assert.equal(f.calls.length,1);
});
for (const status of [403,409,422,429,503]) test(`US ${status} never refreshes or replays`, async () => {
  const f = fixture({ response:() => new Response(JSON.stringify({ detail:'Rejected' }),{status}) });
  await assert.rejects(f.api.postAPI('/api/us/plans/id',{}));
  assert.equal(f.refreshed(),0);
  assert.equal(f.calls.length,1);
});
test('unrecognized 401 without bearer challenge is not replayed',async () => {
  const f = fixture({ response:() => new Response(JSON.stringify({ detail:'Sign in to the US workspace' }),{status:401}) });
  await assert.rejects(f.api.fetchAPI('/api/us/research/access'),/401/);
  assert.equal(f.refreshed(),0);
});
for (const next of [null,token(B)]) test('account switch/sign-out during refresh prevents replay and preserves new auth state',async () => {
  let resolve;
  const f = fixture({ refresh:() => new Promise(done => { resolve = done; }) });
  const request = f.api.postAPI('/api/us/plans/id',{ notes:'Private A draft' });
  while (!resolve) await new Promise(done => setImmediate(done));
  f.event(next);
  resolve({ data:{ session:{ access_token:token(A,'new') } } });
  await assert.rejects(request,/401/);
  assert.equal(f.calls.length,1);
  // A subsequent request uses the account event, not the late refresh result.
  if (next) {
    await f.api.fetchAPI('/api/us/research/access');
    assert.equal(new Headers(f.calls[1].init.headers).get('Authorization'),`Bearer ${next}`);
  }
});
test('normal token-refreshed event permits same-account replay',async () => {
  const f = fixture({ refresh:async () => { f.event(token(A,'new')); return { data:{ session:{ access_token:token(A,'new') } } }; } });
  await f.api.fetchAPI('/api/us/research/access');
  assert.equal(f.calls.length,2);
});
test('failed refresh preserves initial 401 without replay',async () => {
  const f = fixture({ refresh:async () => { throw new Error('Synthetic refresh unavailable'); } });
  await assert.rejects(f.api.fetchAPI('/api/us/research/access'),/401/);
  assert.equal(f.calls.length,1);
});
test('second 401 is returned without a refresh loop',async () => {
  const f = fixture({ retryResponse:denied });
  await assert.rejects(f.api.fetchAPI('/api/us/research/access'),/401/);
  assert.equal(f.calls.length,2);
  assert.equal(f.refreshed(),1);
});
test('legacy expired-token response retains existing refresh behavior',async () => {
  const f = fixture({ response:() => new Response(JSON.stringify({ detail:'Invalid or expired token' }),{status:401}) });
  await f.api.fetchAPI('/api/swing/plans');
  assert.equal(f.calls.length,2);
  assert.equal(f.refreshed(),1);
});
test('failed refresh cannot clear an account that signed in during refresh',async () => {
  let reject;
  const f = fixture({ refresh:() => new Promise((done,fail) => { reject = fail; }) });
  const request = f.api.fetchAPI('/api/us/research/access');
  while (!reject) await new Promise(done => setImmediate(done));
  f.event(token(B));
  reject(new Error('Synthetic unavailable refresh'));
  await assert.rejects(request,/401/);
  await f.api.fetchAPI('/api/us/research/access');
  assert.equal(new Headers(f.calls[1].init.headers).get('Authorization'),`Bearer ${token(B)}`);
});
test('account changed before the 401 is read never starts a refresh',async () => {
  const f = fixture({ response:() => { f.event(token(B)); return denied(); } });
  await assert.rejects(f.api.postAPI('/api/us/plans/id',{ notes:'Private A draft' }),/401/);
  assert.equal(f.refreshed(),0);
  assert.equal(f.calls.length,1);
});
test('transport failure is not automatically replayed',async () => {
  const f = fixture({ response:() => { throw new Error('Synthetic network failure'); } });
  await assert.rejects(f.api.postAPI('/api/us/plans/id',{}),/network failure/);
  assert.equal(f.refreshed(),0);
  assert.equal(f.calls.length,1);
});

for (const fails of [false,true]) for (const next of [null,token(B)]) test(`late initial session ${fails ? 'failure' : 'success'} cannot replace changed account ${next ? 'B' : 'signed-out'}`,async () => {
  let resolve,reject;
  const f = fixture({ initial:null, lookup:() => new Promise((done,fail) => { resolve=done;reject=fail; }),
                      response:() => new Response(JSON.stringify({ success:true })) });
  const request = f.api.postAPI('/api/us/plans/id',{ notes:'Draft prepared before account change' });
  while (!resolve) await new Promise(done => setImmediate(done));
  f.event(next);
  if (fails) reject(new Error('Synthetic lookup failed'));
  else resolve({ data:{ session:{ access_token:token(A) } } });
  await assert.rejects(request,/Account changed/);
  assert.equal(f.calls.length,0);
  assert.equal(f.refreshed(),0);
  if (next) {
    await f.api.fetchAPI('/api/us/research/access');
    assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),`Bearer ${next}`);
  }
});
test('concurrent initial requests share one lookup and both stop after account change',async () => {
  let resolve,lookups=0;
  const f = fixture({ initial:null, lookup:() => { lookups++; return new Promise(done => { resolve=done; }); } });
  const first = f.api.fetchAPI('/api/us/research/packages');
  const second = f.api.postAPI('/api/us/plans/id',{ notes:'Private draft' });
  while (!resolve) await new Promise(done => setImmediate(done));
  f.event(token(B));
  resolve({ data:{ session:{ access_token:token(A) } } });
  const results = await Promise.allSettled([first,second]);
  assert.equal(lookups,1);
  for (const result of results) { assert.equal(result.status,'rejected'); assert.match(result.reason.message,/Account changed/); }
  assert.equal(f.calls.length,0);
});
test('unchanged initial session lookup sends the original account token',async () => {
  const f = fixture({ initial:null, lookup:async () => ({ data:{ session:{ access_token:token(A) } } }),
                      response:() => new Response(JSON.stringify({ success:true })) });
  await f.api.postAPI('/api/us/plans/id',{ expected_revision:0 });
  assert.equal(f.calls.length,1);
  assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),`Bearer ${token(A)}`);
});

for (const next of [null,token(B)]) test('account change after headers are prepared still prevents the first network request',async () => {
  const f = fixture();
  const request = f.api.postAPI('/api/us/plans/id',{ notes:'Private A draft' });
  f.event(next);
  await assert.rejects(request,/Account changed/);
  assert.equal(f.calls.length,0);
});
test('same-account token rotation after header preparation does not rebind the request',async () => {
  const f = fixture({ response:() => new Response(JSON.stringify({ success:true })) });
  const request = f.api.postAPI('/api/us/plans/id',{ notes:'Private A draft' });
  f.event(token(A,'rotated'));
  await request;
  assert.equal(f.calls.length,1);
  assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),`Bearer ${token(A)}`);
});
