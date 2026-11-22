const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-'));
const procs=[];
for(const name of ['hub.cjs','bridge.cjs','index.html'])fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
function start(file,args=[]){
  const child=spawn(process.execPath,[path.join(root,file),...args],{env:{...process.env,ROOM_PORT:'0'}});
  procs.push(child); return child;
}
async function main(){
  const hub=start('hub.cjs');
  const [line]=await once(hub.stdout,'data');
  const url=String(line).trim();
  const {token}=JSON.parse(fs.readFileSync(path.join(root,'local/hub.json')));
  async function post(route,body,auth=true){
    const response=await fetch(url+route,{method:'POST',headers:{
      'Content-Type':'application/json',...(route==='/control'?{Origin:url}:auth?{Authorization:'Bearer '+token}:{})
    },body:JSON.stringify(body)});
    return {status:response.status,data:await response.json().catch(()=>({}))};
  }
  async function rpc(route,body){const result=await post(route,body);assert.equal(result.status,200);return result.data;}
  const sync=async()=>await (await fetch(url+'/state')).json();
  assert.equal((await post('/tool',{action:'list_rooms'},false)).status,403);
  assert.match(await (await fetch(url)).text(),/Agent Room/);
  const {rooms:[room]}=await rpc('/control',{action:'create',name:'Test room'});
  const sender=await rpc('/tool',{action:'request_join',room:room.id,name:'Codex mock'});
  await rpc('/control',{action:'approve',participant:sender.participant});
  const writes={action:'send_message',room:room.id,participant:sender.participant};
  await rpc('/tool',{...writes,request:'history',text:'Previous history'});
  const client=start('bridge.cjs',['claude']);
  const frames=[];
  require('node:readline').createInterface({input:client.stdout}).on('line',line=>frames.push(JSON.parse(line)));
  const emit=(method,params,id)=>client.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,id})+'\n');
  async function until(fn){
    for(let i=0;i<100;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,60));}
    throw Error('Timed out waiting for integration event.');
  }
  emit('initialize',{protocolVersion:'2025-03-26'},1);
  assert.ok((await until(()=>frames.find(f=>f.id===1))).result.capabilities.experimental['claude/channel']);
  emit('notifications/initialized');
  emit('tools/call',{name:'request_join',arguments:{room:room.id}},2);
  const pending=await until(async()=>(await sync()).members.find(m=>m.name==='Claude Code'));
  await rpc('/control',{action:'approve',participant:pending.id});
  const message=await rpc('/tool',{...writes,request:'request-1',text:'Please review.'});
  assert.deepEqual(await rpc('/tool',{...writes,request:'request-1',text:'Please review.'}),message);
  const push=await until(()=>frames.find(f=>f.method==='notifications/claude/channel'));
  assert.match(push.params.content,/Please review/);
  assert.equal(push.params.meta.message_id,String(message.seq));
  emit('tools/call',{name:'send_message',arguments:{request:'reply-1',text:'Reviewed.'}},3);
  await until(async()=>(await sync()).messages.find(m=>m.body==='Reviewed.'));
  await until(async()=>(await sync()).deliveries.find(m=>m.state==='accepted'));
  assert.equal(frames.filter(f=>f.method==='notifications/claude/channel').length,1);
  const invite=await rpc('/tool',{action:'invite_subagent',room:room.id,participant:sender.participant,name:'UI reviewer'});
  const worker=start('bridge.cjs',['work']);
  const workerFrames=[];
  require('node:readline').createInterface({input:worker.stdout}).on('line',line=>workerFrames.push(JSON.parse(line)));
  const workerCall=(id,name,args)=>worker.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');
  workerCall(1,'join_subagent',{request:invite.invitation});
  await until(()=>workerFrames.find(f=>f.id===1&&!f.result.isError));
  assert.equal((await post('/tool',{action:'join_subagent',request:invite.invitation})).status,400);
  const sub=await until(async()=>(await sync()).members.find(m=>m.parent===sender.participant));
  workerCall(2,'send_message',{request:'sub1',text:'UI review complete.'});
  assert.equal((await until(()=>workerFrames.find(f=>f.id===2))).result.isError,true);
  await rpc('/control',{action:'approve',participant:sub.id});
  workerCall(3,'send_message',{request:'sub1',text:'UI review complete.'});
  await until(async()=>(await sync()).messages.find(m=>m.body==='UI review complete.'&&m.name==='UI reviewer'));
  await rpc('/control',{action:'disconnect',participant:sender.participant});
  workerCall(4,'read_messages',{after:0});
  assert.equal((await until(()=>workerFrames.find(f=>f.id===4))).result.isError,true);
  console.log('Passed: room approval, one channel push, reply, receipt, one-use subagent invitation, separate authorship, inherited revocation.');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>procs.forEach(p=>p.kill()));
