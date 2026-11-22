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
  if(!response.ok)throw Error('HTTP '+response.status);
  return response.json();
}
function post(headers,body){return {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)};}
async function main(){
  const site=new URL(siteText);
  if(site.protocol!=='https:'||!site.hostname.endsWith('.chatgpt.site')||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('Use the private https://…chatgpt.site origin.');
  if(!roomName||!deviceKey||deviceKey.length<32)throw Error('A room name and AGENT_ROOM_DEVICE_KEY are required.');
  const relay=new URL('/api/room/device',site);
  const headers={'X-Agent-Room-Key':deviceKey,...(siteAccess?{'OAI-Sites-Authorization':'Bearer '+siteAccess}:{})};
  const readHub=()=>{
    const config=JSON.parse(fs.readFileSync(hubPath,'utf8'));
    if(config.url!=='http://127.0.0.1:4317')throw Error('Unexpected local hub address.');
    return config;
  };
  const first=await request(readHub().url+'/state');
  const matches=first.rooms.filter(r=>r.name===roomName||r.id===roomName);
  if(matches.length!==1)throw Error('Choose exactly one room by its name or ID.');
  const room=matches[0].id;
  const cursorPath=path.join(localDir,'remote-cursor.json');
  const cursor=fs.existsSync(cursorPath)?JSON.parse(fs.readFileSync(cursorPath,'utf8')):{};
  const key=site.origin+' '+room;
  function save(){const temp=cursorPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(cursor));fs.renameSync(temp,cursorPath);}
  if(!Number.isSafeInteger(cursor[key])){
    cursor[key]=Math.max(0,...first.messages.filter(m=>m.room===room).map(m=>m.seq));
    save();
  }
  let acknowledged=[], lastError='';
  console.log('Remote sync enabled for the selected room. Existing local history is excluded. Ctrl+C stops syncing.');
  while(true){
    try{
      const hub=readHub();
      const state=await request(hub.url+'/state');
      const batch=state.messages.filter(m=>m.room===room&&m.seq>cursor[key]).slice(0,40);
      const response=await request(relay,post(headers,{acknowledged,events:batch.filter(m=>!m.recipient).map(m=>({seq:m.seq,name:m.name,text:m.body.length>30000?m.body.slice(0,29980)+'… [원격 표시 생략]':m.body,created:m.created}))}));
      acknowledged=[];
      if(batch.length){cursor[key]=batch.at(-1).seq;save();}
      for(const command of response.commands){
        await request(hub.url+'/tool',post({Authorization:'Bearer '+hub.token},{action:'remote_user_message',room,request:command.id,text:command.text}));
        acknowledged.push(command.id);
      }
      if(lastError){console.log('Remote sync restored.');lastError='';}
    }catch(error){
      if(error.message!==lastError){console.error('Remote sync paused: '+error.message);lastError=error.message;}
    }
    await wait(2000);
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
