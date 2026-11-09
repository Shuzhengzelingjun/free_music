const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function auth() {
  const exports = {};
  const env = {ADMIN_SECRET:'random-test-secret-32-characters-long', ADMIN_USERNAME:'owner', ADMIN_PASSWORD:'owner-password', STORE_USERNAME:'shop', STORE_PASSWORD:'shop-password'};
  const code = ts.transpileModule(fs.readFileSync('lib/auth.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code, {exports, require: name => name === 'next/headers' ? {} : require(name), process:{env}, Buffer, Date});
  return exports;
}
test('store and administrator credentials grant separate roles', () => {
  const a = auth();
  assert.equal(a.accountRole('shop','shop-password'),'store');
  assert.equal(a.accountRole('owner','owner-password'),'admin');
  assert.equal(a.accountRole('shop','owner-password'),null);
  assert.equal(a.sessionRole(a.createSessionToken('store')),'store');
  assert.equal(a.sessionRole(a.createSessionToken('admin')),'admin');
});
test('tampered and legacy sessions cannot gain administrator privileges', () => {
  const a = auth();
  const token = a.createSessionToken('store');
  const [, sig] = token.split('.');
  const payload = Buffer.from(JSON.stringify({version:2,role:'admin',exp:Date.now()+100000})).toString('base64url');
  assert.equal(a.sessionRole(`${payload}.${sig}`),null);
  const sign = data => { const p=Buffer.from(JSON.stringify(data)).toString('base64url'); return `${p}.${require('crypto').createHmac('sha256','random-test-secret-32-characters-long').update(p).digest('base64url')}`; };
  assert.equal(a.sessionRole(sign({role:'admin',exp:Date.now()+100000})),null);
  assert.equal(a.sessionRole(sign({version:2,role:'admin',exp:Date.now()-1000})),null);
});
function worker(fetcher) {
  const handlers = {};
  const stores = new Map();
  const key = r => new URL(typeof r === 'string' ? r : r.url, 'https://music.test').href;
  const caches = {open:async name => {
    if (!stores.has(name)) stores.set(name,new Map());
    const map=stores.get(name);
    return {match:async r => map.get(key(r))?.clone(),put:async(r,v)=>{ const bytes = await v.arrayBuffer(); map.set(key(r),new Response(bytes,{status:v.status,headers:v.headers})); },delete:async r=>map.delete(key(r))};
  },delete:async name=>stores.delete(name)};
  const context = vm.createContext({self:{clients:{matchAll:async()=>[]},location:{origin:'https://music.test'},addEventListener:(name,fn)=>handlers[name]=fn},caches,fetch:fetcher,Response,Request,Headers,URL,AbortSignal,TransformStream,Map,Set,Date,Promise});
  vm.runInContext(fs.readFileSync('public/sw.js','utf8'),context);
  const request = async path => { let result; handlers.fetch({request:new Request('https://music.test'+path),respondWith:p=>result=p}); return result; };
  return {context,handlers,caches,request};
}
test('audio byte ranges return exactly the requested bytes including zero offset',async()=>{
  const w=worker(()=>{});
  w.context.sample=new Response('0123456789',{headers:{'content-length':'10','content-type':'audio/mpeg'}});
  w.context.request=new Request('https://music.test/song',{headers:{range:'bytes=0-1'}});
  const response=await vm.runInContext('fulfill(sample, request)',w.context);
  assert.equal(response.status,206);
  assert.equal(response.headers.get('content-range'),'bytes 0-1/10');
  assert.equal(await response.text(),'01');
});
test('offline reload uses cached playlist and grants playback only, never admin',async()=>{
  let offline=false;
  const w=worker(async request=>{if(offline)throw new Error('offline');return Response.json(request.url.includes('session')?{ok:true,role:'admin'}:{songs:[{id:'one'}]});});
  await w.request('/api/admin/session');
  await w.request('/api/playlist?id=one');
  offline=true;
  const session=await (await w.request('/api/admin/session')).json();
  assert.equal(session.role,'store');
  assert.equal(session.offline,true);
  assert.equal((await (await w.request('/api/playlist?id=one')).json()).songs[0].id,'one');
});
test('whole playlist download caches every song and reports ready only on completion',async()=>{
  const messages=[];
  const w=worker(async url=>new Response(url==='/'?'<html></html>':'audio'));
  let work;
  w.handlers.message({data:{type:'retain-audio',urls:['https://music.test/a.mp3','https://music.test/b.mp3']},source:{postMessage:m=>messages.push(m)},waitUntil:p=>work=p});
  await work;
  assert.equal(messages.at(-1).ready,true);
  assert.equal(messages.at(-1).done,2);
  assert.ok(await (await w.caches.open('fm-audio-v2')).match('https://music.test/b.mp3'));
});
test('failed downloads are never reported as offline ready',async()=>{
  const messages=[];
  const w=worker(async url=>{if(url!=='/')throw new Error('network');return new Response('<html></html>');});
  let work;
  w.handlers.message({data:{type:'retain-audio',urls:['https://music.test/a.mp3']},source:{postMessage:m=>messages.push(m)},waitUntil:p=>work=p});
  await work;
  assert.equal(messages.at(-1).ready,false);
  assert.equal(messages.at(-1).failed,true);
});
function loadRoute(path, mocks) {
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{exports,require:name=>mocks[name],Response,Request});
  return exports;
}
test('library APIs reject store sessions before reading or mutating data',async()=>{
  const route=loadRoute('app/api/admin/library/route.ts',{
    '@/lib/auth':{isAdmin:async()=>false},
    '@/lib/http':{}, '@/lib/library':{}, '@/lib/manifest':{},
  });
  assert.equal((await route.GET()).status,403);
  assert.equal((await route.POST(new Request('https://music.test/api/admin/library',{method:'POST'}))).status,403);
});
test('authenticated session checks renew the same role without elevation',async()=>{
  let renewed;
  const route=loadRoute('app/api/admin/session/route.ts',{
    '@/lib/auth':{getSessionRole:async()=> 'store',setSessionCookie:async role=>renewed=role},
    '@/lib/http':{},
  });
  const response=await route.GET();
  assert.equal(renewed,'store');
  assert.equal((await response.json()).role,'store');
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('seek request is forwarded immediately with Range while full download is pending',async()=>{
  let forwarded;
  const w=worker(async request=>{
    if (typeof request === 'string') return new Promise(()=>{});
    forwarded=request;
    return new Response('target segment',{status:206});
  });
  const request=new Request('https://music.test/song.mp3',{headers:{range:'bytes=800-999'}});
  w.context.event={request,waitUntil:()=>{}};
  const response=await vm.runInContext('serve(event)',w.context);
  assert.equal(response.status,206);
  assert.equal(forwarded.headers.get('range'),'bytes=800-999');
  assert.equal(await response.text(),'target segment');
});
test('download reports byte progress and completes only after the cache receives the full stream',async()=>{
  const updates=[];
  const w=worker(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.enqueue(new Uint8Array([3,4]));controller.close();}}),{headers:{'content-length':'4'}}));
  w.context.self.clients.matchAll=async()=>[{postMessage:m=>updates.push(m)}];
  await vm.runInContext('cacheTrack("https://music.test/song.mp3")',w.context);
  assert.ok(updates.some(m=>m.state==='downloading' && m.loaded>0));
  assert.equal(updates.at(-1).state,'complete');
  assert.equal(updates.at(-1).loaded,4);
});
test('cached seek supports missing content length, suffix ranges and rejects reversed ranges',async()=>{
  const w=worker(()=>{});
  for (const [range,status,body] of [['bytes=2-4',206,'234'],['bytes=-3',206,'789'],['bytes=8-2',416,'']]) {
    w.context.sample=new Response('0123456789');
    w.context.request=new Request('https://music.test/song',{headers:{range}});
    const response=await vm.runInContext('fulfill(sample,request)',w.context);
    assert.equal(response.status,status);
    assert.equal(await response.text(),body);
  }
});
