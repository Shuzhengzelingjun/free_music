const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const ts=require('typescript');
function login(fetch) {
 const exports={};
 const code=ts.transpileModule(fs.readFileSync('lib/login.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{exports,fetch,AbortSignal,Error});
 return exports.submitLogin('shop','password');
}
test('login reports network failures instead of silently rejecting',async()=>{
 await assert.rejects(login(async()=>{throw new Error('offline');}),/无法连接登录服务/);
});
test('login reports non-JSON server errors',async()=>{
 await assert.rejects(login(async()=>new Response('<html>Error</html>',{status:500})),/ADMIN_SECRET/);
});
test('login preserves rate-limit feedback',async()=>{
 await assert.rejects(login(async()=>Response.json({error:'Try again in 30 sec'},{status:429})),/30 sec/);
});
test('login validates success payload',async()=>{
 await assert.rejects(login(async()=>Response.json({})),/返回异常/);
 assert.equal((await login(async()=>Response.json({ok:true,role:'store'}))).role,'store');
});
