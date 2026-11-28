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

// ---- 2. interrupted-update recovery ---------------------------------------------------------------------
const procs=[];
const cleanup=[];
function makeRoot(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-flow-'));
  cleanup.push(root);
  for(const name of ['hub.cjs','db.cjs','limits.cjs','updater.cjs','bridge.cjs','handoff.cjs','managed-codex.cjs','codex-app-server.cjs','codex-ipc.cjs','index.html','VERSION']){
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

async function main(){
  await restoresFromBackup();
  await ignoresUnsafeBackup();
  await leavesRunningUpdaterAlone();
  console.log('Passed: assistant allow-list parity, interrupted-update restore, unsafe-backup rejection, live-updater guard.');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>{
  for(const p of procs)try{p.kill();}catch{}
  setTimeout(()=>{for(const dir of cleanup)try{fs.rmSync(dir,{recursive:true,force:true});}catch{}},500).unref?.();
});
