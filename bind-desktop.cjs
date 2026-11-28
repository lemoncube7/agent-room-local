'use strict';
const fs=require('node:fs');
const path=require('node:path');
const [roomLabel,thread,chosenParticipant]=process.argv.slice(2).filter(arg=>arg!=='--test');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'local','hub.json'),'utf8'));
if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(String(config.url||'')))throw Error('Expected local Agent Room hub.');
async function post(body){
  const response=await fetch(config.url+'/tool',{
    method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Agent Room request failed.');
  return result;
}
async function main(){
  if(!roomLabel||!thread)throw Error('Usage: node bind-desktop.cjs "<room name>" "<Codex thread UUID>" [participant ID] [--test]');
  const state=await (await fetch(config.url+'/state',{headers:{Authorization:'Bearer '+config.token},signal:AbortSignal.timeout(5000)})).json();
  const rooms=state.rooms.filter(room=>room.name===roomLabel||room.id===roomLabel);
  if(rooms.length!==1)throw Error('Select one room by name or ID.');
  const room=rooms[0].id;
  const matches=state.members.filter(m=>m.room===room&&m.name==='Codex'&&!m.provider&&m.state==='approved'&&(!chosenParticipant||m.id===chosenParticipant));
  if(matches.length!==1)throw Error('Approve the existing Codex participant or specify its participant ID.');
  const participant=matches[0].id;
  await post({action:'bind_codex_desktop',room,participant,thread,pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH||null});
  console.log('Bound the approved Codex desktop participant. Messages after binding are eligible for delivery.');
  if(process.argv.includes('--test')){
    const result=await post({action:'test_codex_desktop',room,participant});
    console.log('Verification message: '+result.seq);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
