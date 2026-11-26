'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:wait}=require('node:timers/promises');
const [siteText,roomName]=process.argv.slice(2);
const deviceKey=process.env.AGENT_ROOM_DEVICE_KEY;
const siteAccess=process.env.AGENT_ROOM_SITE_ACCESS;
const localDir=path.join(__dirname,'local');
const hubPath=path.join(localDir,'hub.json');

async function request(url,options){
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(12000),redirect:'error'});
  if(!response.ok)throw Object.assign(Error('HTTP '+response.status),{status:response.status});
  return response.json();
}
function post(headers,body){return {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)};}
const MAX_RELAY_BYTES=1400000;
function buildRelayBatch(messages,body){
  const events=[];
  const batch=[];
  let bytes=Buffer.byteLength(JSON.stringify({...body,events}));
  if(bytes>=MAX_RELAY_BYTES)throw Error('The remote agent state is too large to sync.');
  for(const message of messages.slice(0,35)){
    if(!message.recipient){
      const event={room:message.room,seq:message.seq,name:message.name,text:message.body.slice(0,30000),created:message.created};
      if(message.request?.startsWith("remote:"))event.commandId=message.request.slice(7);
      const next=Buffer.byteLength(JSON.stringify(event))+(events.length?1:0);
      if(bytes+next>MAX_RELAY_BYTES)break;
      bytes+=next;
      events.push(event);
    }
    batch.push(message);
  }
  if(messages.length&&!batch.length)throw Error('The message and agent state do not fit in one sync request.');
  return {batch,body:{...body,events}};
}
async function main(){
  const site=new URL(siteText);
  if(site.protocol!=='https:'||!site.hostname.endsWith('.chatgpt.site')||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('Use the private https://…chatgpt.site origin.');
  if(!deviceKey||deviceKey.length<32)throw Error('AGENT_ROOM_DEVICE_KEY is required.');
  const relay=new URL('/api/room/device',site);
  const headers={'X-Agent-Room-Key':deviceKey,...(siteAccess?{'OAI-Sites-Authorization':'Bearer '+siteAccess}:{})};
  const readHub=()=>{
    const config=JSON.parse(fs.readFileSync(hubPath,'utf8'));
    if(config.url!=='http://127.0.0.1:4317')throw Error('Unexpected local hub address.');
    return config;
  };
  const hubAuth=()=>({headers:{Authorization:'Bearer '+readHub().token}});
  const first=await request(readHub().url+'/state',hubAuth());
  const matches=roomName?first.rooms.filter(r=>r.name===roomName||r.id===roomName):[];
  if(roomName&&matches.length!==1)throw Error('Choose exactly one room by its name or ID.');
  const initialRoom=matches[0]?.id;
  const cursorPath=path.join(localDir,'remote-cursor.json');
  const cursor=fs.existsSync(cursorPath)?JSON.parse(fs.readFileSync(cursorPath,'utf8')):{};
  const key=room=>site.origin+' '+room;
  function save(){const temp=cursorPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(cursor));fs.renameSync(temp,cursorPath);}
  let acknowledged=[],lastError='',lastSyncKey='',lastHeartbeat=0;
  const controlResults=new Map();
  console.log('Remote relay enabled. Room selection is controlled in Agent Room.');
  while(true){
    let waitMs=2000;
    try{
      const hub=readHub();
      const state=await request(hub.url+'/state',{headers:{Authorization:'Bearer '+hub.token}});
      const selection=state.remoteConfigured?state.remoteRooms:initialRoom?[{room:initialRoom,since:Math.max(0,...first.messages.filter(m=>m.room===initialRoom).map(m=>m.seq))}]:[];
      const allowed=new Set(selection.map(item=>item.room));
      const rooms=state.rooms.filter(room=>allowed.has(room.id)).map(({id,name})=>({id,name}));
      const floors=new Map(selection.map(x=>[x.room,Math.max(x.since,cursor[key(x.room)]||0)]));
      const snapshot={
        members:(state.members||[]).filter(m=>allowed.has(m.room)&&m.state!=='disconnected').map(({id,room,name,state:st,provider,model,paused,busy,progress,conflict,cliError})=>({id,room,name,state:st,provider,model,paused,busy,progress,conflict,cliError})),
        approvals:(state.approvals||[]).filter(a=>allowed.has(a.room)).map(({id,room,name,tool,input,created})=>({id,room,name,tool,input:String(input||'').slice(0,800),created})),
        limits:state.limits||{},
        ranking:(state.ranking||[]).filter(r=>allowed.has(r.room)).map(({room,enabled,mode,main_member})=>({room,enabled,mode,main_member})),
        controlResults:[...controlResults.values()].filter(item=>item.room===null||allowed.has(item.room))
      };
      const messages=state.messages.filter(m=>allowed.has(m.room)&&m.seq>floors.get(m.room));
      const syncKey=JSON.stringify({rooms,snapshot});
      const stateChanged=syncKey!==lastSyncKey;
      const anyBusy=snapshot.members.some(m=>m.busy)||snapshot.approvals.length>0;
      const heartbeatDue=Date.now()-lastHeartbeat>=15000;
      if(!stateChanged&&!messages.length&&!acknowledged.length&&!heartbeatDue){
        await wait(anyBusy?2000:5000);
        continue;
      }
      const payloadMeta=stateChanged
        ?{rooms,legacyRoom:initialRoom,acknowledged,snapshot}
        :{rooms,legacyRoom:initialRoom,acknowledged,heartbeat:true};
      const {batch,body}=buildRelayBatch(messages,payloadMeta);
      const response=await request(relay,post(headers,body));
      lastSyncKey=syncKey;
      lastHeartbeat=Date.now();
      waitMs=(anyBusy||batch.length>0||acknowledged.length>0||response.commands.length>0)?2000:5000;
      acknowledged=[];
      for(const item of batch)cursor[key(item.room)]=item.seq;
      if(batch.length)save();
      for(const command of response.commands){
        let ctrl=null;
        if(typeof command.text==='string'&&command.text.startsWith('{"__control":true,')){
          try{ctrl=JSON.parse(command.text);}catch{}
        }
        if(ctrl?.__control){
          if(!controlResults.has(command.id)){
            let ok=false;
            if(ctrl.control==='create'||allowed.has(command.room)){
              try{
                const allowedControls=['approval_decide','retry_agent','pause_agent','room_ranking','create'];
                if(!allowedControls.includes(ctrl.control))throw Object.assign(Error('Unsupported control'),{status:400});
                const {control,name,id,allow,participant,paused,enabled,mode,mainMember}=ctrl;
                await request(hub.url+'/tool',post({Authorization:'Bearer '+hub.token},{action:'remote_control',room:command.room,control,name,id,allow,participant,paused,enabled,mode,mainMember}));
                ok=true;
              }catch(error){if(error.status!==400&&error.status!==403)throw error;}
            }
            controlResults.set(command.id,{id:command.id,room:command.room,ok});
            if(controlResults.size>80)controlResults.delete(controlResults.keys().next().value);
          }
          acknowledged.push(command.id);
          continue;
        }
        if(!allowed.has(command.room))continue;
        let msgText=command.text, attachments=[];
        if(typeof command.text==='string'&&command.text.startsWith('{"__msg":true,')){
          try{const parsed=JSON.parse(command.text);msgText=String(parsed.text||'');attachments=Array.isArray(parsed.attachments)?parsed.attachments:[];}catch{}
        }
        await request(hub.url+'/tool',post({Authorization:'Bearer '+hub.token},{action:'remote_user_message',room:command.room,request:command.id,text:msgText,attachments}));
        acknowledged.push(command.id);
      }
      try{const alive=path.join(localDir,'remote-alive.json');fs.writeFileSync(alive+'.tmp',JSON.stringify({pid:process.pid,site:site.origin,at:Date.now(),siteVersion:response.siteVersion}));fs.renameSync(alive+'.tmp',alive);}catch{}
      if(lastError){console.log('Remote sync restored.');lastError='';}
    }catch(error){
      if(error.message!==lastError){console.error('Remote sync paused: '+error.message);lastError=error.message;}
    }
    await wait(waitMs);
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={buildRelayBatch};
