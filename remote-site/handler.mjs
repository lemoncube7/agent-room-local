const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
async function sameSecret(a,b){
  if(typeof a!=='string'||typeof b!=='string'||b.length<32)return false;
  const digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [x,y]=await Promise.all([digest(a),digest(b)]);
  let difference=0;
  for(let i=0;i<x.length;i++)difference|=x[i]^y[i];
  return difference===0;
}
const isId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const isText=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
async function readBody(request,limit){
  const reader=request.body?.getReader();
  if(!reader)throw Error('Missing body.');
  const decoder=new TextDecoder();
  let size=0,text='';
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Body too large.');text+=decoder.decode(value,{stream:true});}
    return JSON.parse(text+decoder.decode());
  }finally{await reader.cancel().catch(()=>{});}
}
let stateTableReady=false;
async function ensureStateTable(db){
  if(stateTableReady)return;
  await db.prepare('CREATE TABLE IF NOT EXISTS remote_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)').run();
  stateTableReady=true;
}
export async function handleRoom(request,env){
  const route=new URL(request.url).pathname;
  const owner=request.headers.get('oai-authenticated-user-id');
  if(route==='/api/room/device'&&request.method==='POST'){
    if(!await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY))return json({error:'Unauthorized'},403);
    let payload;try{payload=await readBody(request,1500000);}catch{return json({error:'Invalid payload'},400);}
    if(!Array.isArray(payload.rooms)||!payload.rooms.every(room=>isId(room?.id)&&isText(room.name,70))||
       !Array.isArray(payload.events)||payload.events.length>35||!Array.isArray(payload.acknowledged)||payload.acknowledged.length>20)return json({error:'Invalid batch'},400);
    const ids=new Set(payload.rooms.map(room=>room.id));
    if(!payload.acknowledged.every(isId)||!payload.events.every(e=>ids.has(e?.room)&&Number.isSafeInteger(e.seq)&&e.seq>0&&isText(e.name,120)&&isText(e.text,30000)&&isText(e.created,50)&&(e.commandId===undefined||isId(e.commandId))))return json({error:'Invalid event'},400);
    const actions=[env.DB.prepare('DELETE FROM remote_rooms'),env.DB.prepare("INSERT OR IGNORE INTO remote_rooms(id,name) SELECT json_extract(value,'$.id'),json_extract(value,'$.name') FROM json_each(?) ORDER BY key").bind(JSON.stringify(payload.rooms))];
    if(ids.has(payload.legacyRoom)){
      actions.push(env.DB.prepare('UPDATE remote_events SET room=? WHERE room IS NULL').bind(payload.legacyRoom));
      actions.push(env.DB.prepare('UPDATE remote_commands SET room=? WHERE room IS NULL').bind(payload.legacyRoom));
    }
    if(payload.snapshot&&typeof payload.snapshot==='object'){
      await ensureStateTable(env.DB);
      const snapshot={...payload.snapshot,syncedAt:Date.now()};
      let data=JSON.stringify(snapshot);
      if(data.length>250000){
        const members=Array.isArray(snapshot.members)?snapshot.members:[];
        snapshot.members=members.map(member=>({...member,progress:member?.progress?{
          step:member.progress.step,task:member.progress.task,updatedAt:member.progress.updatedAt
        }:null}));
        data=JSON.stringify(snapshot);
      }
      actions.push(env.DB.prepare('INSERT OR REPLACE INTO remote_state(id,data) VALUES(1,?)').bind(data));
    }else{
      await ensureStateTable(env.DB);
      actions.push(env.DB.prepare('INSERT OR IGNORE INTO remote_state(id,data) VALUES(1,?)')
        .bind(JSON.stringify({snapshotMissing:true,detectedAt:Date.now()})));
    }
    actions.push(
      ...payload.events.map(e=>env.DB.prepare('INSERT OR IGNORE INTO remote_events(seq,name,text,created,room,command_id) VALUES(?,?,?,?,?,?)').bind(e.seq,e.name,e.text,e.created,e.room,e.commandId??null)),
      ...payload.acknowledged.map(id=>env.DB.prepare('UPDATE remote_commands SET delivered=1 WHERE id=?').bind(id)),
      env.DB.prepare("DELETE FROM remote_commands WHERE delivered=0 AND room IS NOT NULL AND room NOT IN (SELECT id FROM remote_rooms) AND text NOT LIKE '{\"__control\":true,\"control\":\"create\"%'")
    );
    await env.DB.batch(actions);
    const pending=await env.DB.prepare("SELECT id,text,room FROM remote_commands WHERE delivered=0 AND (room IN (SELECT id FROM remote_rooms) OR text LIKE '{\"__control\":true,\"control\":\"create\"%') ORDER BY created,id LIMIT 20").all();
    return json({commands:pending.results});
  }
  if(route==='/api/room/whoami'&&request.method==='GET')return owner?json({id:owner}):json({error:'Sign-in required'},403);
  if(!owner||(env.REMOTE_OWNER_ID&&owner!==env.REMOTE_OWNER_ID))return json({error:'Owner sign-in required'},403);
  if(route!=='/api/room/browser')return json({error:'Not found'},404);
  if(request.method==='GET'){
    const rooms=(await env.DB.prepare('SELECT id,name FROM remote_rooms ORDER BY rowid').all()).results;
    const room=new URL(request.url).searchParams.get('room');
    if(room&&!rooms.some(item=>item.id===room))return json({error:'Room is not shared'},404);
    const recent=room?await env.DB.prepare('SELECT seq,name,text,created,command_id AS commandId FROM remote_events WHERE room=? ORDER BY seq DESC LIMIT 100').bind(room).all():{results:[]};
    let snapshot=null;
    try{
      await ensureStateTable(env.DB);
      const row=await env.DB.prepare('SELECT data FROM remote_state WHERE id=1').first();
      if(row?.data){
        const parsed=JSON.parse(row.data);
        if(!parsed.snapshotMissing)snapshot=parsed;
      }
    }catch{}
    return json({rooms,events:recent.results.reverse(),snapshot});
  }
  if(request.method!=='POST'||request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Forbidden'},403);
  let payload;try{payload=await readBody(request,40000);}catch{return json({error:'Invalid payload'},400);}
  if(!isId(payload.id))return json({error:'Invalid message'},400);
  let storedText=payload.text, targetRoom=payload.room;
  if(payload.control){
    if(!['approval_decide','retry_agent','pause_agent','room_ranking','create'].includes(payload.control))return json({error:'Unsupported control'},400);
    if(payload.control==='create'){
      if(!isText(payload.name,70))return json({error:'Invalid room name'},400);
      targetRoom=null;
      storedText=JSON.stringify({__control:true,control:'create',name:payload.name.trim()});
    }else{
      if(!isId(targetRoom)||!await env.DB.prepare('SELECT id FROM remote_rooms WHERE id=?').bind(targetRoom).first())return json({error:'Room is not shared'},404);
      if(payload.control==='approval_decide'&&(!isId(payload.id_target)||typeof payload.allow!=='boolean'))return json({error:'Invalid approval decision'},400);
      if(['pause_agent','retry_agent'].includes(payload.control)&&(!isId(payload.participant)||(payload.control==='pause_agent'&&typeof payload.paused!=='boolean')))return json({error:'Invalid agent control'},400);
      storedText=JSON.stringify({__control:true,control:payload.control,id:payload.id_target,allow:payload.allow,participant:payload.participant,paused:payload.paused,enabled:payload.enabled,mode:payload.mode,mainMember:payload.mainMember});
    }
  }else{
    if(!isText(payload.text,8000))return json({error:'Invalid message'},400);
    // Plain messages must never look like the stored control envelope the PC relay parses.
    if(payload.text.trimStart().startsWith('{"__control"'))return json({error:'Invalid message'},400);
    if(!isId(targetRoom)||!await env.DB.prepare('SELECT id FROM remote_rooms WHERE id=?').bind(targetRoom).first())return json({error:'Room is not shared'},404);
  }
  const old=await env.DB.prepare('SELECT text,room FROM remote_commands WHERE id=?').bind(payload.id).first();
  if(old&&(old.text!==storedText||(old.room??null)!==(targetRoom??null)))return json({error:'Request ID already used'},409);
  await env.DB.prepare('INSERT OR IGNORE INTO remote_commands(id,text,created,room) VALUES(?,?,?,?)').bind(payload.id,storedText,Date.now(),targetRoom).run();
  return json({queued:true});
}
