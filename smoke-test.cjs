const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-'));
const procs=[];
for(const name of ['hub.cjs','bridge.cjs','index.html','VERSION'])fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
fs.mkdirSync(path.join(root,'.codex'));
fs.writeFileSync(path.join(root,'.codex/config.toml'),'');
fs.writeFileSync(path.join(root,'managed-codex.cjs'),"const fs=require('node:fs'),path=require('node:path');\nexports.runCodex=async(project,prompt,session,provider)=>{\n const content=prompt.split('\\n\\n').at(-1);\n const body=content.split('\\n').slice(1).join('\\n');\n const peer=content.startsWith('Message from Codex CLI')||content.startsWith('Message from Claude Code CLI');\n if(provider==='claude'&&fs.existsSync(path.join(project,'fail-claude')))throw Error('CLI missing');\n if(body==='Hold reply')await new Promise(resolve=>setTimeout(resolve,650));\n let reply='[[AGENT_ROOM_NO_REPLY]]';\n if(!session)reply=provider==='claude'?'Claude opened':'Opened';\n else if(!peer&&['Follow up','Hold reply','Everyone hello'].includes(body))reply=(provider==='claude'?'Claude resumed: ':'Resumed: ')+body;\n else if(!peer&&body==='Broadcast relay'&&provider==='codex')reply='Shared hello to Claude';\n else if(peer&&body==='Shared hello to Claude'&&provider==='claude')reply='Shared reply to Codex';\n return {id:'mock-'+provider,reply};\n};");
function start(file,args=[]){
  const child=spawn(process.execPath,[path.join(root,file),...args],{env:{...process.env,ROOM_PORT:'0',AGENT_ROOM_PROJECT:root}});
  procs.push(child); return child;
}
async function main(){
  const hub=start('hub.cjs');
  const [line]=await Promise.race([once(hub.stdout,'data'),once(hub,'exit').then(([code])=>{throw Error('Test hub exited before startup: '+code);})]);
  let url=String(line).trim();
  let {token}=JSON.parse(fs.readFileSync(path.join(root,'local/hub.json')));
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
  await rpc('/control',{action:'user_message',room:room.id,text:'Room-wide message'});
  await until(()=>frames.find(f=>f.method==='notifications/claude/channel'&&f.params.content.includes('Room-wide message')));
  assert.ok((await rpc('/tool',{action:'read_messages',room:room.id,participant:sender.participant})).messages.some(m=>m.body==='Room-wide message'));
  frames.splice(frames.findIndex(f=>f.method==='notifications/claude/channel'),1);
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
  const sessionState=await rpc('/control',{action:'new_codex',room:room.id});
  const managed=sessionState.members.find(m=>m.name==='Codex CLI');
  await until(async()=>(await sync()).messages.find(m=>m.body==='Opened'));
  await rpc('/control',{action:'user_message',room:room.id,participant:managed.id,text:'Follow up'});
  await until(async()=>(await sync()).messages.find(m=>m.body==='Resumed: Follow up'));
  await rpc('/control',{action:'user_message',room:room.id,participant:managed.id,text:'Hold reply'});
  const working=await until(async()=>(await sync()).deliveries.find(d=>d.name==='Codex CLI'&&d.state==='working'));
  await until(async()=>(await sync()).deliveries.find(d=>d.seq===working.seq&&d.state==='answered'));
  const claudeState=await rpc('/control',{action:'new_claude',room:room.id});
  const managedClaude=claudeState.members.find(m=>m.name==='Claude Code CLI');
  await until(async()=>(await sync()).messages.find(m=>m.body==='Claude opened'));
  await rpc('/control',{action:'user_message',room:room.id,participant:managedClaude.id,text:'Follow up'});
  await until(async()=>(await sync()).messages.find(m=>m.body==='Claude resumed: Follow up'));
  await rpc('/control',{action:'user_message',room:room.id,participant:'',text:'Everyone hello'});
  await until(async()=>{
    const messages=(await sync()).messages;
    return messages.some(m=>m.body==='Resumed: Everyone hello')&&messages.some(m=>m.body==='Claude resumed: Everyone hello');
  });
  await until(()=>frames.find(f=>f.method==='notifications/claude/channel'&&f.params.content.includes('Everyone hello')));
  await rpc('/control',{action:'user_message',room:room.id,text:'Broadcast relay'});
  const relayed=await until(async()=>(await sync()).messages.find(m=>m.body==='Shared reply to Codex'));
  assert.equal(relayed.author,managedClaude.id);
  assert.equal(relayed.recipient,null);
  await until(async()=>(await sync()).deliveries.find(d=>d.seq===relayed.seq&&d.member===managed.id&&d.state==='no_reply'));
  const silence=await rpc('/control',{action:'user_message',room:room.id,participant:'',text:'FYI silence'});
  const silentSeq=silence.messages.find(m=>m.body==='FYI silence').seq;
  await until(async()=>(await sync()).deliveries.filter(d=>d.seq===silentSeq&&d.state==='no_reply').length===2);
  assert.ok(!(await sync()).messages.some(m=>m.body==='[[AGENT_ROOM_NO_REPLY]]'));
  fs.writeFileSync(path.join(root,'fail-claude'),'');
  const failureStart=await rpc('/control',{action:'new_claude',room:room.id});
  const failed=failureStart.members.filter(m=>m.name==='Claude Code CLI').at(-1);
  await until(async()=>(await sync()).members.find(m=>m.id===failed.id&&m.state==='start_failed'));
  const afterFailure=await rpc('/control',{action:'user_message',room:room.id,text:'Broadcast after failed launch'});
  const afterFailureSeq=afterFailure.messages.find(m=>m.body==='Broadcast after failed launch').seq;
  assert.ok(!afterFailure.deliveries.some(d=>d.seq===afterFailureSeq&&d.member===failed.id));
  const stopped=once(hub,'exit');
  hub.kill();
  await stopped;
  emit('tools/call',{name:'send_message',arguments:{request:'during-restart',text:'Saved while offline.'}},11);
  const queued=await until(()=>frames.find(f=>f.id===11));
  assert.equal(JSON.parse(queued.result.content[0].text).queued,true);
  const replacement=start('hub.cjs');
  const [newLine]=await once(replacement.stdout,'data');
  url=String(newLine).trim();
  ({token}=JSON.parse(fs.readFileSync(path.join(root,'local/hub.json'))));
  await until(async()=>(await sync()).messages.find(m=>m.body==='Saved while offline.'));
  emit('tools/call',{name:'send_message',arguments:{request:'during-restart',text:'Saved while offline.'}},12);
  await until(()=>frames.find(f=>f.id===12));
  assert.equal((await sync()).messages.filter(m=>m.body==='Saved while offline.').length,1);
  console.log('Passed: room approval, one channel push, reply, receipt, one-use subagent invitation, separate authorship, inherited revocation, room-wide broadcast, managed Codex and Claude creation and resume, durable outbox across hub restart, shared agent replies.');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>procs.forEach(p=>p.kill()));
