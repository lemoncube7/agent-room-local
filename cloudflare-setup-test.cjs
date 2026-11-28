'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {createSetup}=require('./cloudflare-setup.cjs');
const {pathToFileURL}=require('node:url');
async function main(){
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'ar-cf-test-'));
 const db=new DatabaseSync(':memory:');
 const candidates=[];let sub='',login=false,creates=0,uploads=0,apply=0,worker,env,interrupt=true;
 const success=result=>Response.json({success:true,result});
 const cli=async args=>{if(args[0]==='login'){login=true;return '';}if(!login)throw Error();return JSON.stringify({token:'test-oauth'});};
 async function fetcher(u,opts){
  const url=new URL(u),p=url.pathname;
  if(url.hostname.endsWith('.workers.dev'))return worker.fetch(new Request(u,opts),env);
  assert.equal(opts.headers.Authorization,'Bearer test-oauth');
  if(p.endsWith('/accounts'))return success([{id:'a',name:'First'},{id:'b',name:'Second'}]);
  assert.ok(p.includes('/accounts/b/'));
  if(p.endsWith('/workers/subdomain')){
   if(opts.method==='PUT'){
    const name=JSON.parse(opts.body).subdomain;
    assert.match(name,/^agent-room-[a-f0-9]{12}$/);
    candidates.push(name);
    if(candidates.length===1)return Response.json({success:false,errors:[{message:'subdomain is already taken'}]},{status:400});
    assert.notEqual(name,candidates[0]);sub=name;
   }
   return sub?success({subdomain:sub}):Response.json({success:false},{status:404});
  }
  if(p.endsWith('/d1/database')){
   if(opts.method==='POST'){creates++;return success({uuid:'test-db'});}
   return success([]);
  }
  if(p.endsWith('/query')){
   const stmt=db.prepare(JSON.parse(opts.body).sql);
   return success([{success:true,results:stmt.all()}]);
  }
  if(p.endsWith('/subdomain'))return success({enabled:true});
  if(opts.method==='PUT'){
   if(interrupt){interrupt=false;return Response.json({success:false},{status:503});}
   uploads++;
   const data=opts.body,meta=JSON.parse(await data.get('metadata').text());
   env=Object.fromEntries(meta.bindings.map(b=>[b.name,b.text]));
   env.DB={prepare:q=>({first:async()=>db.prepare(q).get()})};
   const script=(await data.get('worker.mjs').text()).replace("import pageHtml from './page.html';",'const pageHtml='+JSON.stringify(await data.get('page.html').text())+';');
   fs.writeFileSync(path.join(local,'handler.mjs'),await data.get('handler.mjs').text());
   for(const [name,part] of data.entries())if(name.endsWith('.mjs')&&name!=='worker.mjs'&&name!=='handler.mjs')fs.writeFileSync(path.join(local,name),await part.text());
   fs.writeFileSync(path.join(local,'worker.mjs'),script);
   worker=(await import(pathToFileURL(path.join(local,'worker.mjs')).href)).default;
   return success({});
  }
  throw Error('Unexpected API call: '+p);
 }
 const setup=createSetup({root:__dirname,local,cli,fetcher,connect(site,key){assert.equal(key,env.REMOTE_DEVICE_KEY);apply++;}});
 async function wait(){for(let i=0;i<200&&setup.status().phase==='working';i++)await new Promise(r=>setTimeout(r,5));return setup.status();}
 try{
  setup.start();assert.equal((await wait()).phase,'account');
  setup.start('b');setup.start('b');assert.equal((await wait()).phase,'error');assert.equal(apply,0);
  setup.start();const state=await wait();assert.equal(state.phase,'done',state.message);
  assert.equal(candidates.length,2);assert.deepEqual([creates,uploads,apply],[1,1,1]);
  const link=new URL(setup.link());assert.equal(link.hash.slice(1),env.REMOTE_ACCESS_PASSWORD);
  const landing=await worker.fetch(new Request(link.origin+link.pathname),env);
  assert.equal(landing.status,200);assert.ok((await landing.text()).includes('replaceState'));
  const signed=await worker.fetch(new Request(link.origin+'/_login',{method:'POST',body:new URLSearchParams({password:link.hash.slice(1)})}),env);
  assert.equal(signed.status,302);assert.ok(signed.headers.has('Set-Cookie'));
  assert.equal((await worker.fetch(new Request(link.origin+'/api/room/setup-check'),env)).status,403);
  console.log('Passed: login, account choice, subdomain, D1, retry without duplicate resources, Worker bindings, authenticated health check and phone sign-in.');
 }finally{db.close();fs.rmSync(local,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
