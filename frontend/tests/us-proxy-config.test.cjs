const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
function load(value,mode="development"){
  const context={exports:{},URL,__dirname:path.join(__dirname,'..'),process:{env:{ALPHA_API_PROXY_URL:value,NODE_ENV:mode}}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../next.config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  return context.exports.default;
}
for(const value of [undefined,''])test('unconfigured proxy produces no upstream '+String(value),async()=>{
  assert.equal((await load(value).rewrites()).length,0);
});
for(const [value,origin] of [['https://usmarket.onrender.com','https://usmarket.onrender.com'],
  ['https://usmarket.onrender.com/','https://usmarket.onrender.com'],['https://usmarket.onrender.com:443','https://usmarket.onrender.com'],
  ['http://127.0.0.1:9018','http://127.0.0.1:9018'],['http://localhost:9018/','http://localhost:9018']])
test('reviewed US proxy target normalizes safely '+value,async()=>{
  const rows=await load(value).rewrites();assert.equal(rows.length,1);
  assert.equal(rows[0].destination,origin+'/api/:path*');
});
for(const value of ['https://other.onrender.com','https://usmarket.onrender.com.attacker.test',
  'https://usmarket.onrender.com:444','http://usmarket.onrender.com','https://private:secret@usmarket.onrender.com',
  'https://usmarket.onrender.com/api','https://usmarket.onrender.com?private=secret','https://usmarket.onrender.com#private',
  ' https://usmarket.onrender.com','https://usmarket.onrender.com\n','https://usmarket.onrender.com\\other',
  'http://127.0.0.1.attacker.test:9018','http://localhost:invalid','http://localhost:65536','not-a-url'])
test('unreviewed or malformed proxy fails without echoing configuration '+value,async()=>{
  await assert.rejects(()=>load(value).rewrites(),error=>{
    assert.equal(error.message,'US API proxy target is invalid; use the dedicated US service or loopback development origin');
    assert.doesNotMatch(error.message,/secret|private|attacker/);return true;
  });
});


test('production proxy rejects loopback development configuration',async()=>{
  for(const origin of ['http://localhost:9018','http://127.0.0.1:9018'])await assert.rejects(()=>load(origin,'production').rewrites(),/proxy target is invalid/);
  assert.equal((await load('https://usmarket.onrender.com','production').rewrites())[0].destination,'https://usmarket.onrender.com/api/:path*');
});


for(const mode of ['development','production'])test('browser connection policy scopes Supabase to dedicated project in '+mode,async()=>{
  const rows=await load(undefined,mode).headers();
  const policy=rows[0].headers.find(row=>row.key==='Content-Security-Policy').value;
  const connections=policy.split('; ').find(row=>row.startsWith('connect-src '));
  assert.ok(connections.includes("'self'"));
  assert.ok(connections.includes('https://apidhmrlawbjvisnadht.supabase.co'));
  assert.ok(connections.includes('wss://apidhmrlawbjvisnadht.supabase.co'));
  assert.doesNotMatch(connections,/\*|etwmtakotrqlwwzttekc/);
  if(mode==='production')assert.doesNotMatch(connections,/localhost|127\.0\.0\.1|http:| ws:/);
  else assert.ok(connections.includes('http://127.0.0.1:9000'));
});
