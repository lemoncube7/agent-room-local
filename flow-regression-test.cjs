'use strict';
// Regression tests for flows that the main smoke test does not cover:
//  1. settings-assistant allow-list parity between hub.cjs and index.html
//  2. interrupted-update recovery (local/update-in-progress.json + backup restore) and its safety conditions
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');

// ---- 1. allow-list parity -------------------------------------------------------------------------------
{
  const hub=fs.readFileSync(path.join(__dirname,'hub.cjs'),'utf8');
  const page=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const block=hub.match(/const ASSISTANT_ACTIONS=\{([\s\S]*?)\n\};/);
  assert.ok(block,'ASSISTANT_ACTIONS block not found in hub.cjs');
  const serverActions=new Set([...block[1].matchAll(/^\s{2}([a-z_]+):'/gm)].map(m=>m[1]));
  serverActions.add('report_issue'); // proposed through its own branch, not the table
  const clientBlock=page.match(/function splitAssistantActions[\s\S]*?new Set\(\[([^\]]*)\]\)/);
  assert.ok(clientBlock,'allowed set not found in splitAssistantActions');
  const clientActions=new Set([...clientBlock[1].matchAll(/'([a-z_]+)'/g)].map(m=>m[1]));
  assert.ok(serverActions.size>=10,'unexpectedly small server action list');
  assert.deepEqual([...serverActions].sort(),[...clientActions].sort(),
    'ASSISTANT_ACTIONS (hub.cjs) and splitAssistantActions (index.html) must list the same actions');
}

// ---- 1b. CLI version recording (record only; flag only on known mismatch symptoms) ----------------------
{
  const cv=require('./cli-versions.cjs');
  assert.equal(cv.parseVersion('codex-cli 0.48.2'),'0.48.2');
  assert.equal(cv.parseVersion('2.1.4 (Claude Code)'),'2.1.4');
  assert.equal(cv.parseVersion('no version here'),null);
  assert.ok(cv.looksLikeVersionMismatch("error: unexpected argument '--sandbox' found"));
  assert.ok(!cv.looksLikeVersionMismatch('usage limit reached'));
  let calls=0;
  const run=(file,args,opts,cb)=>{calls++;cb(file.includes('bad')?Error('x'):null,'tool 1.2.3\n','');};
  cv.clearCache();
  cv.readVersions({codex:'C:/a/codex.exe',claude:'C:/bad/claude.exe',agy:''},{run}).then(async v=>{
    assert.deepEqual(v,{codex:'1.2.3',claude:null,agy:null});
    await cv.readVersion('C:/a/codex.exe',{run});
    assert.equal(calls,2,'version lookups must be cached');
  }).catch(e=>{console.error(e);process.exitCode=1;});
}

// ---- 2. interrupted-update recovery ---------------------------------------------------------------------
const procs=[];
const cleanup=[];
function makeRoot(prefix='agent-room-flow-'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  cleanup.push(root);
  for(const name of ['hub.cjs','db.cjs','limits.cjs','updater.cjs','bridge.cjs','handoff.cjs','managed-codex.cjs','codex-app-server.cjs','codex-ipc.cjs','cli-versions.cjs','index.html','VERSION']){
    const from=path.join(__dirname,name);
    if(fs.existsSync(from))fs.copyFileSync(from,path.join(root,name));
  }
  fs.mkdirSync(path.join(root,'.codex'));
  fs.writeFileSync(path.join(root,'.codex/config.toml'),'');
  fs.mkdirSync(path.join(root,'local'),{recursive:true});
  return root;
}
function startHub(root,extraEnv={}){
  const child=spawn(process.execPath,[path.join(root,'hub.cjs')],{
    env:{...process.env,ROOM_PORT:'0',AGENT_ROOM_PROJECT:root,...extraEnv},stdio:['ignore','pipe','pipe']
  });
  procs.push(child);
  return child;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000,label='condition'){
  const end=Date.now()+ms;
  while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}
  throw Error('Timed out waiting for '+label);
}
function writeMarker(root,{backup,files,updaterPid}){
  fs.writeFileSync(path.join(root,'local/update-in-progress.json'),JSON.stringify({backup,files,updaterPid,from:'1.0.0',to:'9.9.9'}));
}
const markerPath=root=>path.join(root,'local/update-in-progress.json');
async function waitHubJson(root){
  return until(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'local/hub.json'),'utf8'));}catch{return null;}},20000,'hub.json');
}
async function stopHub(cfg){
  try{await fetch(cfg.url+'/shutdown_for_update',{method:'POST',headers:{Authorization:'Bearer '+cfg.token,'Content-Type':'application/json'},body:'{}'});}catch{}
}

async function restoresFromBackup(){
  const root=makeRoot();
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-update-flowtest-'));
  cleanup.push(backup);
  fs.writeFileSync(path.join(backup,'VERSION'),'0.0.1-restored');
  fs.mkdirSync(path.join(backup,'sub'));
  fs.writeFileSync(path.join(backup,'sub','nested.txt'),'nested-restored');
  // Escape attempts must be skipped, not followed.
  writeMarker(root,{backup,files:['VERSION','sub/nested.txt','../escaped.txt'],updaterPid:99999999});
  const hub=startHub(root);
  // The first hub restores the files, respawns itself on the restored code and exits.
  const [code]=await once(hub,'exit');
  assert.equal(code,0,'recovering hub should exit cleanly after respawn');
  assert.equal(fs.readFileSync(path.join(root,'VERSION'),'utf8'),'0.0.1-restored');
  assert.equal(fs.readFileSync(path.join(root,'sub','nested.txt'),'utf8'),'nested-restored');
  assert.equal(fs.existsSync(path.join(path.dirname(root),'escaped.txt')),false,'path escape must not be restored');
  assert.equal(fs.existsSync(markerPath(root)),false,'marker must be removed after recovery');
  // The respawned hub must start (with recovery disabled so it does not loop) and be stoppable.
  const cfg=await waitHubJson(root);
  assert.match(cfg.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  await stopHub(cfg);
}

async function ignoresUnsafeBackup(){
  const root=makeRoot();
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'not-an-update-backup-'));
  cleanup.push(outside);
  fs.writeFileSync(path.join(outside,'VERSION'),'must-not-be-copied');
  const before=fs.readFileSync(path.join(root,'VERSION'),'utf8');
  writeMarker(root,{backup:outside,files:['VERSION'],updaterPid:99999999});
  const hub=startHub(root);
  const [line]=await Promise.race([once(hub.stdout,'data'),once(hub,'exit').then(([c])=>{throw Error('hub exited early: '+c);})]);
  assert.match(String(line),/^http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(fs.readFileSync(path.join(root,'VERSION'),'utf8'),before,'backup outside the temp update folder must be ignored');
  assert.equal(fs.existsSync(markerPath(root)),false,'unusable marker must be cleaned up');
  hub.kill();
}

async function leavesRunningUpdaterAlone(){
  const root=makeRoot();
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-update-flowtest-'));
  cleanup.push(backup);
  fs.writeFileSync(path.join(backup,'VERSION'),'must-not-be-restored-yet');
  const before=fs.readFileSync(path.join(root,'VERSION'),'utf8');
  // This test process stands in for a live updater.
  writeMarker(root,{backup,files:['VERSION'],updaterPid:process.pid});
  const hub=startHub(root);
  const [line]=await Promise.race([once(hub.stdout,'data'),once(hub,'exit').then(([c])=>{throw Error('hub exited early: '+c);})]);
  assert.match(String(line),/^http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(fs.readFileSync(path.join(root,'VERSION'),'utf8'),before,'must not restore while the updater is still alive');
  assert.equal(fs.existsSync(markerPath(root)),true,'marker must stay while the updater is alive');
  hub.kill();
}

// The relay sends the hub token to the address in local/hub.json: any loopback port is fine (the hub may move
// off 4317), but a non-loopback host must be refused before any request is made.
async function relayHubAddressRules(){
  const http=require('node:http');
  const seen=[];
  const fake=http.createServer((req,res)=>{seen.push({url:req.url,auth:req.headers.authorization||''});res.writeHead(200,{'Content-Type':'application/json'}).end('{}');});
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  const port=fake.address().port;
  const runRelay=async hubUrl=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-relay-'));
    cleanup.push(root);
    fs.copyFileSync(path.join(__dirname,'remote-sync.cjs'),path.join(root,'remote-sync.cjs'));
    fs.mkdirSync(path.join(root,'local'));
    fs.writeFileSync(path.join(root,'local','hub.json'),JSON.stringify({url:hubUrl,token:'relay-test-token'}));
    const child=spawn(process.execPath,[path.join(root,'remote-sync.cjs'),'https://relay-test.invalid'],{
      env:{...process.env,AGENT_ROOM_DEVICE_KEY:'k'.repeat(40)},stdio:['ignore','pipe','pipe']
    });
    procs.push(child);
    let stderr='';
    child.stderr.on('data',d=>{stderr+=String(d);});
    return {child,stderr:()=>stderr};
  };
  try{
    const ok=await runRelay('http://127.0.0.1:'+port);
    await until(()=>seen.length>0,15000,'relay to call the fake hub on a non-default port');
    assert.equal(seen[0].url,'/state');
    assert.equal(seen[0].auth,'Bearer relay-test-token');
    ok.child.kill();
    seen.length=0;
    const bad=await runRelay('http://localhost:'+port);
    await until(()=>/Unexpected local hub address/.test(bad.stderr()),15000,'relay to refuse a non-127.0.0.1 hub address');
    await sleep(500);
    assert.equal(seen.length,0,'relay must not contact a non-loopback hub address');
    bad.child.kill();
  }finally{fake.close();}
}

// Port conflicts: another program on the default port -> the hub moves to a free port and publishes it in hub.json;
// another Agent Room hub on the default port -> no second hub is started.
async function portConflictRules(){
  const http=require('node:http');
  const net=require('node:net');
  const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const spawnDefaultPort=(root,port)=>{
    const env={...process.env,AGENT_ROOM_PROJECT:root,AGENT_ROOM_DEFAULT_PORT:String(port),AGENT_ROOM_NO_BACKGROUND:'1'};
    delete env.ROOM_PORT;
    const child=spawn(process.execPath,[path.join(root,'hub.cjs')],{env,stdio:['ignore','pipe','pipe']});
    procs.push(child);
    return child;
  };
  // A: a foreign program holds the default port.
  const port=await freePort();
  const foreign=http.createServer((req,res)=>res.writeHead(200).end('not agent room'));
  await new Promise(r=>foreign.listen(port,'127.0.0.1',r));
  try{
    const rootA=makeRoot();
    const hubA=spawnDefaultPort(rootA,port);
    const cfg=await waitHubJson(rootA);
    const movedPort=Number(new URL(cfg.url).port);
    assert.notEqual(movedPort,port,'hub must not claim the occupied port');
    const state=await (await fetch(cfg.url+'/state')).json();
    assert.ok(state.version,'hub on the fallback port must answer');
    // B: an Agent Room hub already holds a port -> a second hub on the same default exits without publishing an address.
    const rootB=makeRoot();
    const hubB=spawnDefaultPort(rootB,movedPort);
    const [code]=await once(hubB,'exit');
    assert.equal(code,0,'second hub should exit quietly when an Agent Room hub already owns the port');
    assert.equal(fs.existsSync(path.join(rootB,'local/hub.json')),false,'second hub must not publish an address');
    const [fallbackDuplicate]=await once(spawnDefaultPort(makeRoot(),port),'exit');
    assert.equal(fallbackDuplicate,0,'a hub on an occupied fallback port also prevents duplicate startup');
    await new Promise(resolve=>foreign.close(resolve));
    const [sameInstallDuplicate]=await once(spawnDefaultPort(rootA,port),'exit');
    assert.equal(sameInstallDuplicate,0,'the same installation must reuse its running hub after the default port is freed');
    assert.equal((await waitHubJson(rootA)).url,cfg.url);
    await stopHub(cfg);
    await once(hubA,'exit');
  }finally{foreign.close();}
  // C: an explicit ROOM_PORT is never moved.
  const taken=await freePort();
  const holder=http.createServer((req,res)=>res.end('x'));
  await new Promise(r=>holder.listen(taken,'127.0.0.1',r));
  try{
    const rootC=makeRoot();
    const hubC=spawn(process.execPath,[path.join(rootC,'hub.cjs')],{env:{...process.env,AGENT_ROOM_PROJECT:rootC,ROOM_PORT:String(taken)},stdio:'ignore'});
    procs.push(hubC);
    const [code]=await once(hubC,'exit');
    assert.equal(code,1,'explicit ROOM_PORT that is taken must fail instead of moving');
  }finally{holder.close();}
}

// Many Windows users have Korean user names and folders with spaces. The hub must start from such a path,
// answer requests, and keep its data inside it.
async function startsFromKoreanSpacedPath(){
  const root=makeRoot('OneDrive - 에이전트 룸 테스트 폴더 ');
  assert.match(root,/에이전트 룸 테스트 폴더 /);
  const hub=startHub(root);
  const [line]=await Promise.race([once(hub.stdout,'data'),once(hub,'exit').then(([c])=>{throw Error('hub exited early from Korean/space path: '+c);})]);
  const url=String(line).trim();
  assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);
  const state=await (await fetch(url+'/state')).json();
  assert.ok(state.version,'hub must answer from a Korean/space path');
  assert.ok(fs.existsSync(path.join(root,'local','rooms.db')),'database must be created inside the install folder');
  hub.kill();
}

// Rooms without their own folder get <workspaces>/<date>_<name>; "reset" returns to it after a custom folder.
async function defaultRoomFolders(){
  const root=makeRoot();
  const ws=path.join(root,'workspaces');
  const hub=startHub(root,{AGENT_ROOM_PROJECT:'',AGENT_ROOM_WORKSPACES:ws});
  const cfg=await waitHubJson(root);
  const tool=async body=>{
    const cookie='agent_room='+fs.readFileSync(path.join(root,'local/browser-key'),'utf8').trim();
    const r=await fetch(cfg.url+'/control',{method:'POST',headers:{Origin:cfg.url,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();if(!r.ok)throw Error('tool '+body.action+' '+r.status+' '+JSON.stringify(j));return j;
  };
  const created=await tool({action:'create',name:'테스트: 방/1'});
  const room=created.createdRoom||created.rooms?.find(r=>r.name==='테스트: 방/1')?.id;
  assert.ok(room,'room id');
  const custom=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-custom-'));cleanup.push(custom);
  await tool({action:'set_project',room,roomOnly:true,project:custom});
  let st=await (await fetch(cfg.url+'/state',{headers:{Authorization:'Bearer '+cfg.token}})).json();
  assert.equal(path.resolve(st.rooms.find(r=>r.id===room).project),path.resolve(custom));
  await tool({action:'set_project',room,roomOnly:true,reset:true,project:''});
  st=await (await fetch(cfg.url+'/state',{headers:{Authorization:'Bearer '+cfg.token}})).json();
  const dir=st.rooms.find(r=>r.id===room).project;
  assert.equal(path.dirname(dir),ws,'default folder lives under workspaces');
  assert.match(path.basename(dir),/^\d{4}-\d{2}-\d{2}_테스트 방1$/);
  assert.ok(fs.statSync(dir).isDirectory());
  await tool({action:'set_room_arch_docs',room,value:false});
  st=await (await fetch(cfg.url+'/state',{headers:{Authorization:'Bearer '+cfg.token}})).json();
  assert.equal(st.rooms.find(r=>r.id===room).arch_docs,0);
  hub.kill();
}

// Subagent replies wake the parent by default; a line with only [[NOT_CALL_PARENT]] (outside code fences) opts out.
function subagentParentCallRules(){
  const src=fs.readFileSync(path.join(__dirname,'hub.cjs'),'utf8');
  const start=src.indexOf('function stripParentTags');
  assert.ok(start>=0,'stripParentTags missing from hub.cjs');
  const end=src.indexOf('\nconst leadingEndTag',start);
  const strip=new Function(src.slice(start,end)+'\nreturn stripParentTags;')();
  assert.deepEqual(strip('[[NOT_CALL_PARENT]]\nnote for the room'),{text:'note for the room',notCall:true});
  assert.deepEqual(strip('progress\n  [[not_call_parent]]  \n'),{text:'progress\n',notCall:true});
  assert.equal(strip('plain reply').notCall,false,'no tag means the parent is woken');
  assert.equal(strip('mention [[NOT_CALL_PARENT]] mid-sentence').notCall,false,'a mid-sentence mention does not opt out');
  assert.equal(strip('```\n[[NOT_CALL_PARENT]]\n```').notCall,false,'a tag inside a code fence does not opt out');
  // The older mark must not leak into the room and must not change anything.
  assert.deepEqual(strip('[[CALL_PARENT]]\nresult'),{text:'result',notCall:false});
  // The wake-up depends only on the opt-out.
  assert.match(src,/const reportsToParent=Boolean\(row\.parent\)&&!notCallParent;/,'default wake-up with opt-out');
  const gates=(src.match(/reportsToParent/g)||[]).length;
  assert.ok(gates>=4,'parent wake-ups must all depend on reportsToParent (found '+gates+' references)');
}

async function main(){
  subagentParentCallRules();
  const corruptRoot=makeRoot();
  const local=path.join(corruptRoot,'local');
  const dbFile=path.join(local,'rooms.db');
  fs.mkdirSync(local,{recursive:true});
  fs.writeFileSync(dbFile,'invalid SQLite database');
  const [corruptExit]=await once(startHub(corruptRoot),'exit');
  assert.equal(corruptExit,1);
  assert.match(fs.readFileSync(path.join(local,'startup-db-error.txt'),'utf8'),/rooms\.db/);
  assert.equal(fs.readFileSync(dbFile,'utf8'),'invalid SQLite database');
  await startsFromKoreanSpacedPath();
  await defaultRoomFolders();
  await portConflictRules();
  await relayHubAddressRules();
  await restoresFromBackup();
  await ignoresUnsafeBackup();
  await leavesRunningUpdaterAlone();
  console.log('Passed: assistant allow-list parity, subagent opt-out tag (NOT_CALL_PARENT), corrupt database notice, Korean/space path start, default room folders and reset, port-conflict fallback, relay hub-address rules, interrupted-update restore, unsafe-backup rejection, live-updater guard.');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>{
  for(const p of procs)try{p.kill();}catch{}
  setTimeout(()=>{for(const dir of cleanup)try{fs.rmSync(dir,{recursive:true,force:true});}catch{}},500).unref?.();
});
