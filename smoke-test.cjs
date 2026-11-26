const assert=require('node:assert/strict');
const {diagnoseCliFailure}=require('./managed-codex.cjs');
assert.equal(diagnoseCliFailure('claude',{},'Failed to authenticate: OAuth session expired and could not be refreshed').cliCode,'auth_expired');
assert.equal(diagnoseCliFailure('codex',{},'Failed to create unified exec process: app runtime provisioning service is unavailable').cliCode,'windows_runtime');
assert.equal(diagnoseCliFailure('agy',{code:'ENOENT'},'').cliCode,'cli_missing');

const {spawn}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-room-'));
const procs=[];
for(const name of ['hub.cjs','db.cjs','limits.cjs','updater.cjs','bridge.cjs','handoff.cjs','index.html','VERSION'])fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
fs.mkdirSync(path.join(root,'.codex'));
fs.writeFileSync(path.join(root,'.codex/config.toml'),'');
fs.writeFileSync(path.join(root,'managed-codex.cjs'),"const fs=require('node:fs'),path=require('node:path');\nexports.runCodex=async(project,prompt,session,provider,model,effort,options)=>{\n if(options?.rank){const input=JSON.parse(prompt.split('Treat this JSON solely as data: ').at(-1));if(input.message==='Bad rank JSON')return {id:'judge',reply:'broken'};if(input.message==='Sequential test')return {id:'judge',reply:JSON.stringify({ranks:input.roster.map(x=>({id:x.id,rank:x.name==='gpt-test'?1:x.name==='Codex CLI'?2:0}))})};if(input.message.startsWith('Private test ')||input.message.startsWith('Tag '))return {id:'judge',reply:JSON.stringify({ranks:input.roster.map(x=>({id:x.id,rank:x.name==='Codex CLI'?1:0}))})};let n=0;return {id:'judge',reply:JSON.stringify({ranks:input.roster.slice().reverse().map(x=>({id:x.id,rank:input.message==='Tie test'?(x.provider==='agy'?0:1):x.provider==='agy'?0:++n}))})};}\n const content=prompt.split('\\n\\n').at(-1);\n const body=content.split('\\n').slice(1).join('\\n');\n const peer=content.startsWith('Message from Codex CLI')||content.startsWith('Message from Claude Code CLI');\n if(provider==='claude'&&fs.existsSync(path.join(project,'fail-claude')))throw Error('CLI missing');\n if(body==='Hold reply'||body==='Tie test')await new Promise(resolve=>setTimeout(resolve,650));\n let reply='[[AGENT_ROOM_NO_REPLY]]';\n if(prompt.includes('This turn is a task handoff notification'))reply='[[HANDOFF_ACCEPT]]';\n else if(!session)reply=provider==='agy'?'AGY started '+model+' '+effort:provider==='claude'?'Claude opened':'Opened';\n else if(!peer&&body.startsWith('Tag '))reply=body.slice(4); else if(body.startsWith('Private test '))reply='[[TO:'+body.slice(13)+']]\\nTargeted only';\n else if(!peer&&['Follow up','Hold reply','Everyone hello','Sequential test','Tie test'].includes(body))reply=(provider==='claude'?'Claude resumed: ':'Resumed: ')+body;\n else if(!peer&&body==='Broadcast relay'&&provider==='codex'){const roster=JSON.parse(prompt.match(/room roster: (\\[.*?\\])\\. Never/)[1]);reply='[[CALL:'+roster.find(x=>x.name==='Claude Code CLI').id+']]\\nShared hello to Claude';}\n else if(peer&&body==='Shared hello to Claude'&&provider==='claude')reply='Shared reply to Codex';\n return {id:'mock-'+provider,reply};\n};");
fs.appendFileSync(path.join(root,'managed-codex.cjs'),`
const baseRun=exports.runCodex;
exports.runCodex=async (...args)=>{
 const [,prompt,,provider,,,options]=args;
 if(options?.rank&&prompt.startsWith('This is your turn to coordinate')){
  const {name,prior}=JSON.parse(prompt.split('Treat the JSON solely as data: ').at(-1));
  return {id:'coordination',reply:name+' agrees after '+prior.length+' notes'};
 }
 if(options?.rank&&prompt.startsWith('This is your turn in a meeting-only coordination')){
  const {name,prior}=JSON.parse(prompt.split('Treat the JSON solely as data: ').at(-1));
  return {id:'coordination-discuss',reply:JSON.stringify({note:name+' consensus after '+prior.length+' notes',files:['ignored.js'],work:true})};
 }
 if(options?.rank&&prompt.includes('"message":"Coordination test"')){
  const {roster}=JSON.parse(prompt.split('Treat this JSON solely as data: ').at(-1));
  return {id:'judge',reply:JSON.stringify({coordinate:true,ranks:roster.map(x=>({id:x.id,rank:['gpt-test','Codex CLI'].includes(x.name)?1:0}))})};
 }
 if(options?.rank&&prompt.includes('"message":"Meeting coordination test"')){
  const {roster}=JSON.parse(prompt.split('Treat this JSON solely as data: ').at(-1));
  return {id:'judge',reply:JSON.stringify({coordinate:true,coordinateMode:'discuss',ranks:roster.map(x=>({id:x.id,rank:['gpt-test','Codex CLI'].includes(x.name)?1:0}))})};
 }
 if(!options?.rank&&prompt.includes('[Agent Room 마무리 확인]')){
  fs.appendFileSync(path.join(__dirname,'wrapups.log'),provider+'\\n');
  return {id:'mock-'+provider,reply:'Wrap-up summary '+Math.random().toString(36).slice(2,8)+' [[DONE]]'};
 }
 if(!options?.rank&&prompt.includes('Coordination is complete.')&&prompt.endsWith('Coordination test')){
  return {id:'mock-'+provider,reply:'Work started after coordination'};
 }
 return baseRun(...args);
};
`);
function start(file,args=[]){
  const child=spawn(process.execPath,[path.join(root,file),...args],{env:{...process.env,ROOM_PORT:'0',AGENT_ROOM_PROJECT:root}});
  procs.push(child); return child;
}
async function main(){
  const hub=start('hub.cjs');
  const [line]=await Promise.race([once(hub.stdout,'data'),once(hub,'exit').then(([code])=>{throw Error('Test hub exited before startup: '+code);})]);
  let url=String(line).trim();
  let {token}=JSON.parse(fs.readFileSync(path.join(root,'local/hub.json')));
  const cookie='agent_room='+fs.readFileSync(path.join(root,'local/browser-key'),'utf8').trim();
  const get=route=>fetch(url+route,{headers:{Cookie:cookie}});
  async function post(route,body,auth=true){
    const response=await fetch(url+route,{method:'POST',headers:{
      'Content-Type':'application/json',...(route==='/control'?{Origin:url,Cookie:cookie}:auth?{Authorization:'Bearer '+token}:{})
    },body:JSON.stringify(body)});
    return {status:response.status,data:await response.json().catch(()=>({}))};
  }
  async function rpc(route,body){const result=await post(route,body);assert.equal(result.status,200);return result.data;}
  const sync=async()=>await (await get('/state')).json();
  assert.equal((await post('/tool',{action:'list_rooms'},false)).status,403);
  assert.match(await (await get('/')).text(),/Agent Room/);
  // Local auth: anonymous callers only see the version, cannot open the UI, control, or download.
  const anon=await (await fetch(url+'/state')).json();
  assert.ok(anon.authRequired&&anon.version&&anon.rooms.length===0&&anon.messages===undefined);
  assert.equal((await fetch(url+'/')).status,401);
  assert.equal((await fetch(url+'/?key=wrong')).status,403);
  const login=await fetch(url+'/?key='+cookie.slice('agent_room='.length),{redirect:'manual'});
  assert.equal(login.status,302);assert.match(login.headers.get('set-cookie')||'',/HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(url+'/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:'{"action":"create","name":"x"}'})).status,403);
  assert.equal((await fetch(url+'/state',{headers:{Authorization:'Bearer '+token}})).ok&&!!(await (await fetch(url+'/state',{headers:{Authorization:'Bearer '+token}})).json()).messages,true);
  const {rooms:[room]}=await rpc('/control',{action:'create',name:'Test room'});
  const sender=await rpc('/tool',{action:'request_join',room:room.id,name:'Codex mock'});
  await rpc('/control',{action:'approve',participant:sender.participant});
  assert.equal((await post('/tool',{action:'remote_user_message',room:room.id,request:'33ff9911-9429-404b-afaf-1ba5f73497ba',text:'Private'})).status,400);
  await rpc('/control',{action:'remote_share',room:room.id,shared:true});
  const remote={action:'remote_user_message',room:room.id,request:'22ff9911-9429-404b-afaf-1ba5f73497ba',text:'Remote test'};
  assert.deepEqual(await rpc('/tool',remote),await rpc('/tool',remote));
  assert.equal((await sync()).messages.filter(m=>m.body==='Remote test').length,1);
  const writes={action:'send_message',room:room.id,participant:sender.participant};
  await rpc('/tool',{...writes,request:'history',text:'Previous history'});
  const client=start('bridge.cjs',['claude']);
  const frames=[];
  require('node:readline').createInterface({input:client.stdout}).on('line',line=>frames.push(JSON.parse(line)));
  const emit=(method,params,id)=>client.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,id})+'\n');
  async function until(fn,attempts=100){
    for(let i=0;i<attempts;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,60));}
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
  const pendingState=await sync();
  assert.ok(pendingState.members.find(m=>m.id===managed.id).busy);
  assert.ok(!pendingState.messages.some(m=>m.author===managed.id&&m.seq>working.seq&&m.body==='메시지를 받았습니다. 응답을 준비합니다.'));
  assert.ok(!pendingState.messages.some(m=>m.body==='Resumed: Hold reply'));
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
  await until(async()=>(await sync()).deliveries.find(d=>d.seq===relayed.seq&&d.member===managed.id&&d.state==='context_only'));
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
  const extra=await rpc('/control',{action:'new_agent',room:room.id,provider:'codex',model:'gpt-test'});
  const secondCodex=extra.members.find(m=>m.name==='gpt-test');
  assert.equal(secondCodex.provider,'codex');
  await until(async()=>(await sync()).members.find(m=>m.id===secondCodex.id&&m.state==='approved'));
  const added=await rpc('/control',{action:'new_agent',room:room.id,provider:'agy',model:'gemini-test',effort:'high'});
  const managedAgy=added.members.find(m=>m.name==='gemini-test');
  await until(async()=>(await sync()).messages.find(m=>m.author===managedAgy.id&&m.body==='AGY started gemini-test high'));
  const edited=await rpc('/control',{action:'edit_agent',room:room.id,participant:managedAgy.id,model:'other-model',name:'Reviewer',effort:'low'});
  assert.equal(edited.members.find(m=>m.id===managedAgy.id).name,'Reviewer');
  assert.equal(edited.members.find(m=>m.id===managedAgy.id).model,'other-model');
  assert.equal(edited.members.find(m=>m.id===managedAgy.id).effort,'low');
  const createdTask=(await rpc('/tool',{action:'handoff_create',room:room.id,participant:pending.id,title:'Agent Room follow-up',next:'Run the next check',summary:'Old context'})).task;
  assert.equal(createdTask.owner,pending.id);
  const offer=(await rpc('/tool',{action:'handoff_offer',room:room.id,participant:pending.id,id:createdTask.id,revision:createdTask.revision,target:managed.id})).task;
  assert.equal(offer.owner,pending.id);
  assert.equal(offer.offered_to,managed.id);
  assert.equal((await post('/tool',{action:'handoff_accept',room:room.id,participant:pending.id,id:offer.id,revision:offer.revision})).status,400);
  const accepted=await until(async()=>(await sync()).tasks.find(t=>t.id===createdTask.id&&t.owner===managed.id));
  assert.equal(accepted.status,'open');
  assert.equal((await post('/control',{action:'handoff_update',room:room.id,id:offer.id,revision:offer.revision,summary:'Stale edit'})).status,400);
  const audit=await rpc('/control',{action:'handoff_history',room:room.id,id:offer.id});
  assert.equal(audit.events[0].action,'handoff_accept');
  const scopedUser=await rpc('/control',{action:'user_message',room:room.id,text:'Private test '+managedClaude.id});
  const scopedUserSeq=scopedUser.messages.find(m=>m.body==='Private test '+managedClaude.id).seq;
  const targeted=await until(async()=>(await sync()).messages.find(m=>m.relay_root===scopedUserSeq&&m.author===managed.id&&m.body==='Targeted only'));
  const targetState=await sync();
  assert.equal(targeted.recipient,managedClaude.id);
  assert.deepEqual(targetState.deliveries.filter(d=>d.seq===targeted.seq).map(d=>d.member),[managedClaude.id]);
  await rpc('/control',{action:'room_ranking',room:room.id,enabled:true});
  const ranked=await rpc('/control',{action:'user_message',room:room.id,text:'Rank test'});
  const rankedSeq=ranked.messages.find(m=>m.body==='Rank test').seq;
  await until(async()=>(await sync()).replyPlans.find(p=>p.seq===rankedSeq&&p.state==='ready'));
  const ranking=(await sync()).deliveries.filter(d=>d.seq===rankedSeq);
  assert.equal(ranking.find(d=>d.member===managedAgy.id).priority,0);
  assert.equal(ranking.find(d=>d.member===secondCodex.id).priority,1);
  await until(async()=>(await sync()).deliveries.find(d=>d.seq===rankedSeq&&d.member===managedAgy.id&&['context_only','context_seen','accepted'].includes(d.state)),420);
  assert.ok(!(await sync()).messages.some(m=>m.relay_root===rankedSeq&&m.author===managedAgy.id));
  const tie=await rpc('/control',{action:'user_message',room:room.id,text:'Tie test'});
  const tieSeq=tie.messages.find(m=>m.body==='Tie test').seq;
  const simultaneous=await until(async()=>{
    const rows=(await sync()).deliveries.filter(d=>d.seq===tieSeq);
    return rows.filter(d=>d.priority===1&&d.state==='working').length>=2?rows:null;
  });
  assert.ok(simultaneous.filter(d=>d.priority!==null).every(d=>d.priority===0||d.priority===1));
  // Parallel answers: only the last finisher gets one wrap-up turn with the others' replies.
  await until(async()=>(await sync()).deliveries.filter(d=>d.seq===tieSeq&&d.priority===1&&d.state==='answered').length>=2);
  const pausedForWrap=(await sync()).deliveries.filter(d=>d.seq===tieSeq&&d.state==='queued').map(d=>d.member);
  for(const member of pausedForWrap)await rpc('/control',{action:'pause_agent',room:room.id,participant:member,paused:true});
  await until(async()=>(await sync()).messages.some(m=>m.relay_root===tieSeq&&m.body.startsWith('Wrap-up summary')));
  await new Promise(r=>setTimeout(r,1500));
  assert.equal((await sync()).messages.filter(m=>m.relay_root===tieSeq&&m.body.startsWith('Wrap-up summary')).length,1);
  for(const member of pausedForWrap)await rpc('/control',{action:'pause_agent',room:room.id,participant:member,paused:false});
  const seqState=await rpc('/control',{action:'user_message',room:room.id,text:'Sequential test'});
  const seqMsg=seqState.messages.find(m=>m.body==='Sequential test').seq;
  await until(async()=>{
    const st=await sync();
    const rows=st.deliveries.filter(d=>d.seq===seqMsg);
    return rows.find(d=>d.member===secondCodex.id&&d.priority===1&&d.state==='answered')&&rows.find(d=>d.member===managed.id&&d.priority===2&&d.state==='answered')&&st.messages.some(m=>m.relay_root===seqMsg&&m.author===secondCodex.id)&&st.messages.some(m=>m.relay_root===seqMsg&&m.author===managed.id)?rows:null;
  },420);
  const bad=await rpc('/control',{action:'user_message',room:room.id,text:'Bad rank JSON'});
  const badSeq=bad.messages.find(m=>m.body==='Bad rank JSON').seq;
  await until(async()=>(await sync()).replyPlans.find(p=>p.seq===badSeq&&p.state==='fallback'));
  const retractState=await rpc('/control',{action:'user_message',room:room.id,text:'Retract test'});
  const retractSeq=retractState.messages.find(m=>m.body==='Retract test').seq;
  await rpc('/control',{action:'retract_message',room:room.id,seq:retractSeq});
  const afterRetract=await sync();
  assert.equal(afterRetract.messages.find(m=>m.seq===retractSeq).retracted,1);
  assert.ok(!afterRetract.deliveries.some(d=>d.seq===retractSeq&&['queued','ranking','context_only'].includes(d.state)));
  await until(async()=>!(await sync()).deliveries.some(d=>d.seq===retractSeq&&['working','submitting'].includes(d.state)),420);
  assert.ok(!(await sync()).messages.some(m=>m.relay_root===retractSeq));
  const privateText='Private test '+managedAgy.id;
  const privateState=await rpc('/control',{action:'user_message',room:room.id,text:privateText});
  const privateSeq=privateState.messages.find(m=>m.body===privateText).seq;
  const privateReply=await until(async()=>(await sync()).messages.find(m=>m.relay_root===privateSeq&&m.author===managed.id&&m.recipient===managedAgy.id),420);
  await until(async()=>(await sync()).deliveries.find(d=>d.seq===privateReply.seq&&d.member===managedAgy.id));
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
  const {rooms:roomsAfter,createdRoom}=await rpc('/control',{action:'create',name:'Second room'});
  const room2=roomsAfter.find(r=>r.name==='Second room');
  assert.equal(createdRoom,room2.id);
  const dup=await rpc('/control',{action:'create',name:'Second room'});
  assert.notEqual(dup.createdRoom,room2.id);
  assert.ok(dup.rooms.some(r=>r.id===dup.createdRoom));
  await rpc('/control',{action:'delete_room',room:dup.createdRoom});
  // New rooms are private until shared explicitly.
  assert.ok(!(await sync()).remoteRooms.some(r=>r.room===room2.id));
  await rpc('/control',{action:'remote_share',room:room2.id,shared:true});
  assert.ok((await sync()).remoteRooms.some(r=>r.room===room2.id));
  // "Always share" is a standing policy that also covers rooms created later.
  await rpc('/control',{action:'remote_share_all',shared:true});
  const later=await rpc('/control',{action:'create',name:'Shared later'});
  assert.ok(later.remoteShareAll&&later.remoteRooms.some(r=>r.room===later.createdRoom));
  await rpc('/control',{action:'remote_share_all',shared:false});
  const privateLater=await rpc('/control',{action:'create',name:'Private later'});
  assert.ok(!privateLater.remoteShareAll&&!privateLater.remoteRooms.some(r=>r.room===privateLater.createdRoom));
  for(const id of [later.createdRoom,privateLater.createdRoom])await rpc('/control',{action:'delete_room',room:id});
  await rpc('/control',{action:'remote_share',room:room.id,shared:true});
  await rpc('/control',{action:'remote_share',room:room2.id,shared:true});
  await rpc('/control',{action:'user_message',room:room2.id,text:'Only in room 2',attachments:[{name:'poc.html',data:Buffer.from('<script>alert(1)</script>').toString('base64')}]});
  const scoped1=await (await get('/state?room='+encodeURIComponent(room.id))).json();
  const scoped2=await (await get('/state?room='+encodeURIComponent(room2.id))).json();
  assert.ok(scoped1.messages.length>0&&scoped1.messages.every(m=>m.room===room.id));
  assert.ok(scoped2.messages.length===1&&scoped2.messages[0].room===room2.id);
  const uploadedFile=fs.readdirSync(path.join(root,'local','uploads')).find(f=>f.endsWith('-poc.html'));
  assert.ok(uploadedFile);
  assert.equal((await fetch(url+'/uploads/'+encodeURIComponent(uploadedFile))).status,403);
  const uploadRes=await get('/uploads/'+encodeURIComponent(uploadedFile));
  assert.equal(uploadRes.status,200);
  assert.equal(uploadRes.headers.get('x-content-type-options'),'nosniff');
  assert.equal(uploadRes.headers.get('content-security-policy'),'sandbox');
  assert.match(uploadRes.headers.get('content-disposition')||'',/^attachment;/);
  const altProject=path.join(root,'alt-proj');
  fs.mkdirSync(altProject);
  const projState=await rpc('/control',{action:'set_project',room:room.id,project:altProject,applyMcp:false});
  assert.ok(projState.recentProjects.includes(altProject));
  assert.equal((await post('/control',{action:'set_project',project:path.join(root,'missing-dir'),applyMcp:false})).status,400);
  const renamed=await rpc('/control',{action:'rename_room',room:room2.id,name:'Renamed room 2'});
  assert.equal(renamed.rooms.find(r=>r.id===room2.id).name,'Renamed room 2');
  const updatedRoom2=await rpc('/control',{action:'room_ranking',room:room2.id,name:'Configured room 2',mode:'broadcast',memo:'Room rule'});
  assert.equal(updatedRoom2.rooms.find(r=>r.id===room2.id).name,'Configured room 2');
  assert.equal(updatedRoom2.rooms.find(r=>r.id===room2.id).memo,'Room rule');
  const joinAgain=async(id,code)=>{
    emit('tools/call',{name:'join_room_code',arguments:{request:code}},id);
    return (await until(()=>frames.find(frame=>frame.id===id))).result;
  };
  const {code}=await rpc('/control',{action:'room_code',room:room2.id});
  assert.equal((await joinAgain(21,code)).isError,true);
  const orphan=(await rpc('/tool',{action:'handoff_create',room:room.id,participant:pending.id,title:'Orphan check',next:'Keep going'})).task;
  assert.equal((await post('/tool',{action:'handoff_update',room:room.id,participant:managed.id,id:orphan.id,revision:orphan.revision,note:'blocked while owner is active'})).status,400);
  await rpc('/control',{action:'disconnect',participant:pending.id});
  const takeover=(await rpc('/tool',{action:'handoff_update',room:room.id,participant:managed.id,id:orphan.id,revision:orphan.revision,note:'took over'})).task;
  assert.equal(takeover.revision,orphan.revision+1);
  assert.ok((await rpc('/control',{action:'handoff_history',room:room.id,id:orphan.id})).events[0].note.startsWith('[inactive owner override]'));
  const tagFailTask=(await rpc('/tool',{action:'handoff_create',room:room.id,participant:managedClaude.id,title:'Tag fail',next:'x'})).task;
  await rpc('/control',{action:'user_message',room:room.id,text:'Tag [[HANDOFF_COMPLETE:'+tagFailTask.id+']]'});
  await until(async()=>(await sync()).messages.find(m=>m.author===managed.id&&m.body.includes('#'+tagFailTask.id)&&m.body.includes('Only the task owner')));
  assert.equal((await sync()).tasks.find(t=>t.id===tagFailTask.id).status,'open');
  const tagOkTask=(await rpc('/tool',{action:'handoff_create',room:room.id,participant:managed.id,title:'Tag ok',next:'x'})).task;
  await rpc('/control',{action:'user_message',room:room.id,text:'Tag [[HANDOFF_COMPLETE:'+tagOkTask.id+']]'});
  await until(async()=>(await sync()).tasks.find(t=>t.id===tagOkTask.id&&t.status==='done'));
  assert.equal(JSON.parse((await joinAgain(22,code)).content[0].text).state,'pending');
  assert.equal((await sync()).members.filter(item=>item.room===room2.id&&item.name==='Claude Code'&&item.state==='pending').length,1);
  await rpc('/control',{action:'set_work_mode',room:room.id,workMode:'chat'});
  assert.equal((await sync()).rooms.find(r=>r.id===room.id).work_mode,'chat');
  await rpc('/control',{action:'set_work_mode',room:room.id,workMode:'dev'});
  assert.equal((await sync()).rooms.find(r=>r.id===room.id).work_mode,'dev');
  const coordination=await rpc('/control',{action:'user_message',room:room.id,text:'Coordination test'});
  const requestSeq=coordination.messages.find(message=>message.body==='Coordination test').seq;
  const completed=await until(async()=>{
    const state=await sync();
    const replies=state.messages.filter(message=>message.relay_root===requestSeq);
    return replies.filter(reply=>reply.body==='Work started after coordination').length===2?replies:false;
  },420);
  assert.match(completed[0].body,/after 0 notes/);
  assert.match(completed[1].body,/after 1 notes/);
  assert.equal(completed[2].body,'Work started after coordination');
  const meeting=await rpc('/control',{action:'user_message',room:room.id,text:'Meeting coordination test'});
  const meetingSeq=meeting.messages.find(message=>message.body==='Meeting coordination test').seq;
  const meetingDone=await until(async()=>{
    const state=await sync();
    const plan=state.replyPlans.find(p=>p.seq===meetingSeq);
    if(plan?.state!=='coordinated')return false;
    return state;
  },420);
  const meetingReplies=meetingDone.messages.filter(message=>message.relay_root===meetingSeq);
  assert.equal(meetingReplies.length,2);
  assert.match(meetingReplies[0].body,/consensus after 0 notes/);
  assert.match(meetingReplies[1].body,/consensus after 1 notes/);
  const meetingDeliveries=meetingDone.deliveries.filter(d=>d.seq===meetingSeq);
  assert.equal(meetingDeliveries.filter(d=>d.state==='context_seen').length,2);
  assert.equal(meetingDeliveries.every(d=>d.state==='context_seen'||d.state==='context_only'),true);
  console.log('Passed: room approval, one channel push, reply, receipt, one-use subagent invitation, separate authorship, inherited revocation, room-wide broadcast, managed Codex and Claude creation and resume, durable outbox across hub restart, shared agent replies, room-scoped state, safe upload headers, and project switching.');
}
main().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>procs.forEach(p=>p.kill()));
