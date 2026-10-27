const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const origin = 'https://etwmtakotrqlwwzttekc.supabase.co';
function load(url, key) {
  if (arguments.length < 2) key = 'synthetic-public-key';
  const calls = [], subscriptions = [];
  const client = { auth:{ onAuthStateChange: callback => subscriptions.push(callback) } };
  const context = { exports:{}, process:{ env:{ NEXT_PUBLIC_SUPABASE_URL:url, NEXT_PUBLIC_SUPABASE_ANON_KEY:key } },
    require: name => {
      assert.equal(name,'@supabase/supabase-js');
      return { createClient:(...args) => { calls.push(args);return client; } };
    } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/lib/supabase.ts'),'utf8'), {
    compilerOptions:{ module:ts.ModuleKind.CommonJS },
  }).outputText,context);
  return { api:context.exports,calls,subscriptions,client };
}
for (const url of [undefined,'','http://etwmtakotrqlwwzttekc.supabase.co','https://other-project.supabase.co',
  origin+'.attacker.example',origin+':444',origin+'/auth',origin+'?project=other',origin+'#fragment',
  'https://user:password@etwmtakotrqlwwzttekc.supabase.co',' '+origin,origin+'\n',origin+'\\other']) {
  test(`invalid or different browser auth target is disabled: ${JSON.stringify(url)}`,() => {
    const f = load(url);
    assert.equal(f.api.supabase,null);
    assert.equal(f.calls.length,0);
    assert.equal(f.subscriptions.length,0);
    assert.equal(f.api.isRecoverySession(),false);
  });
}
for (const suffix of ['','/',':443',':443/']) test(`dedicated target creates exactly one auth client: ${suffix}`,() => {
  const f = load(origin+suffix);
  assert.equal(f.api.supabase,f.client);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][0],origin+suffix);
  assert.equal(f.calls[0][1],'synthetic-public-key');
  assert.equal(f.subscriptions.length,1);
  f.subscriptions[0]('PASSWORD_RECOVERY',{ user:{ id:'synthetic-user',is_anonymous:false } });
  assert.equal(f.api.isRecoverySession(),true);
  f.subscriptions[0]('SIGNED_OUT',null);
  assert.equal(f.api.isRecoverySession(),false);
});
for (const key of ['', '   ',undefined]) test('missing public key never initializes browser authentication',() => {
  const f = load(origin,key);
  assert.equal(f.api.supabase,null);
  assert.equal(f.calls.length,0);
});
