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
export async function readBody(request,limit){
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
let meshTablesReady=false;
async function ensureMeshTables(db){
  if(meshTablesReady)return;
  await db.prepare('CREATE TABLE IF NOT EXISTS room_nodes (room TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL, public_url TEXT NOT NULL DEFAULT \'\', can_host INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL, PRIMARY KEY (room, node_id))').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS room_hosts (room TEXT PRIMARY KEY, host_node_id TEXT, hub_url TEXT, epoch INTEGER NOT NULL DEFAULT 1, election_mode TEXT NOT NULL DEFAULT \'rule\', lease_expires_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS node_reports(room TEXT,node_id TEXT,data TEXT NOT NULL,PRIMARY KEY(room,node_id))').run();
  meshTablesReady=true;
}
const hostLeaseMs=25000;
async function electHost(db,room,now,requestedMode){
  await ensureMeshTables(db);
  await db.prepare('DELETE FROM room_nodes WHERE room=? AND last_seen<?').bind(room,now-45000).run();
  const readHost=()=>db.prepare('SELECT host_node_id,hub_url,epoch,election_mode,lease_expires_at FROM room_hosts WHERE room=?').bind(room).first();
  const current=await readHost();
  const nodes=(await db.prepare('SELECT node_id,label,public_url,can_host,priority,last_seen FROM room_nodes WHERE room=? ORDER BY priority DESC,node_id ASC').bind(room).all()).results||[];
  const reports=(await db.prepare('SELECT r.node_id,r.data FROM node_reports r JOIN room_nodes n ON n.room=r.room AND n.node_id=r.node_id WHERE r.room=?').bind(room).all()).results||[];
  const byNode=new Map(reports.map(r=>[r.node_id,JSON.parse(r.data)]));
  for(const n of nodes)n.report=byNode.get(n.node_id)||null;
  const candidates=nodes.filter(node=>node.can_host&&node.public_url&&node.last_seen+hostLeaseMs>now);
  const mode=requestedMode==='random'?'random':requestedMode==='rule'?'rule':(current?.election_mode||'rule');
  const incumbent=candidates.find(node=>node.node_id===current?.host_node_id);
  if(!(incumbent&&current.lease_expires_at>now)){
    const next=mode==='random'?candidates[Math.floor(Math.random()*candidates.length)]:candidates[0];
    if(!current||current.host_node_id||next){
      // A concurrent election or heartbeat may have already renewed the lease.
      await db.prepare(`INSERT INTO room_hosts(room,host_node_id,hub_url,epoch,election_mode,lease_expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(room) DO UPDATE SET
        host_node_id=excluded.host_node_id,hub_url=excluded.hub_url,epoch=excluded.epoch,
        election_mode=excluded.election_mode,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
        WHERE room_hosts.epoch=? AND room_hosts.lease_expires_at=?`)
        .bind(room,next?.node_id??null,next?.public_url??null,(current?.epoch??0)+1,mode,
          next?next.last_seen+hostLeaseMs:0,now,current?.epoch??-1,current?.lease_expires_at??-1).run();
    }
  }
  const elected=await readHost();
  return {mode:elected.host_node_id?'hub':'offline_queue',hostNodeId:elected.host_node_id,hubUrl:elected.hub_url,
    epoch:elected.epoch,electionMode:elected.election_mode,leaseExpiresAt:elected.lease_expires_at,nodes};
}
export async function handleRoom(request,env){
  const route=new URL(request.url).pathname;
  const owner=request.headers.get('oai-authenticated-user-id');
  if(route==='/api/room/rendezvous/claim'&&request.method==='POST'){
    if(!await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY))return json({error:'Unauthorized'},403);
    let p;try{p=await readBody(request,4096);}catch{return json({error:'Invalid claim'},400);}
    if(!isId(p?.room)||!isId(p.run)||!/^[0-9a-f]{64}$/.test(p.ticket)||!isText(p.nodeId,80)||!isText(p.host,80)||!Number.isSafeInteger(p.epoch))return json({error:'Invalid claim'},400);
    await ensureMeshTables(env.DB);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS mesh_claims(room TEXT,run TEXT,node TEXT,ticket TEXT NOT NULL,PRIMARY KEY(room,run))').run();
    const now=Date.now();
    const lease='SELECT 1 FROM room_hosts h JOIN room_nodes n ON n.room=h.room WHERE h.room=? AND h.host_node_id=? AND h.epoch=? AND h.lease_expires_at>? AND n.node_id=? AND n.last_seen>?';
    const args=[p.room,p.host,p.epoch,now,p.nodeId,now-25000];
    await env.DB.prepare('INSERT OR IGNORE INTO mesh_claims(room,run,node,ticket) SELECT ?,?,?,? WHERE EXISTS('+lease+')').bind(p.room,p.run,p.nodeId,p.ticket,...args).run();
    const claimed=await env.DB.prepare('SELECT node FROM mesh_claims WHERE room=? AND run=? AND ticket=? AND EXISTS('+lease+')').bind(p.room,p.run,p.ticket,...args).first();
    return claimed?.node===p.nodeId?json({claimed:true}):json({error:'Execution claim unavailable'},409);
  }
  if((route==='/api/room/rendezvous/register'||route==='/api/room/rendezvous/heartbeat')&&request.method==='POST'){
    if(!await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY))return json({error:'Unauthorized'},403);
    let payload;try{payload=await readBody(request,65536);}catch{return json({error:'Invalid payload'},400);}
    const room=payload.room, nodeId=payload.nodeId;
    if(!isId(room)||!isText(nodeId,80))return json({error:'Invalid node'},400);
    const label=isText(payload.label,80)?payload.label.trim():nodeId.slice(0,24);
    const publicUrl=typeof payload.publicUrl==='string'&&/^https?:\/\/\S{3,240}$/i.test(payload.publicUrl.trim())?payload.publicUrl.trim().replace(/\/+$/,''):'';
    const canHost=payload.canHost&&publicUrl?1:0;
    const priority=Number.isFinite(Number(payload.priority))?Math.max(0,Math.min(100,Math.round(Number(payload.priority)))):0;
    const now=Date.now();
    await ensureMeshTables(env.DB);
    await env.DB.prepare('INSERT INTO room_nodes(room,node_id,label,public_url,can_host,priority,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(room,node_id) DO UPDATE SET label=excluded.label,public_url=excluded.public_url,can_host=excluded.can_host,priority=excluded.priority,last_seen=excluded.last_seen').bind(room,nodeId,label,publicUrl,canHost,priority,now).run();
    if(route==='/api/room/rendezvous/heartbeat'&&canHost){
      await env.DB.prepare('UPDATE room_hosts SET lease_expires_at=?,hub_url=?,updated_at=? WHERE room=? AND host_node_id=?').bind(now+hostLeaseMs,publicUrl,now,room,nodeId).run();
    }
    if(payload.report && typeof payload.report==='object'){
      const raw=payload.report;
      const short=v=>typeof v==='string'?v.slice(0,80):'';
      const report={platform:short(raw.platform),version:short(raw.version),policy:short(raw.policy),
        runs:(Array.isArray(raw.runs)?raw.runs:[]).filter(r=>isId(r?.run)).slice(0,20).map(r=>({run:r.run,state:short(r.state)})),
        repositories:(Array.isArray(raw.repositories)?raw.repositories:[]).slice(0,8).map(p=>({name:short(p?.name),exists:p?.exists===true,commit:/^[0-9a-f]{40,64}$/.test(p?.commit)?p.commit:''})),
        agents:(Array.isArray(raw.agents)?raw.agents:[]).slice(0,24).map(a=>({provider:short(a?.provider),model:short(a?.model),permission_profile:short(a?.permission_profile),cli:['present','missing'].includes(a?.cli)?a.cli:'unverified'})),
        copies:(Array.isArray(raw.copies)?raw.copies:[]).filter(c=>c&&Number.isSafeInteger(c.seq)&&c.seq>0).slice(0,12).map(c=>({source:short(c.source),seq:c.seq}))};
      await env.DB.prepare('INSERT INTO node_reports(room,node_id,data) VALUES(?,?,?) ON CONFLICT(room,node_id) DO UPDATE SET data=excluded.data').bind(room,nodeId,JSON.stringify(report)).run();
    }
    const res=await electHost(env.DB,room,now,payload.electionMode);
    return json({...res,role:res.hostNodeId===nodeId?'hub':'node'});
  }
  if(route==='/api/room/rendezvous/room'&&request.method==='GET'){
    const deviceOk=await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY);
    if(!deviceOk&&(!owner||owner!==env.REMOTE_OWNER_ID))return json({error:'Forbidden'},403);
    const room=new URL(request.url).searchParams.get('room')||'';
    if(!isId(room))return json({error:'Invalid room'},400);
    const res=await electHost(env.DB,room,Date.now());
    return json(res);
  }
  if(route==='/api/room/device'&&request.method==='POST'){
    if(!await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY))return json({error:'Unauthorized'},403);
    let payload;try{payload=await readBody(request,25*1024*1024);}catch{return json({error:'Invalid payload'},400);}
    if(!Array.isArray(payload.rooms)||!payload.rooms.every(room=>isId(room?.id)&&isText(room.name,70))||
       !Array.isArray(payload.events)||payload.events.length>35||!Array.isArray(payload.acknowledged)||payload.acknowledged.length>20)return json({error:'Invalid batch'},400);
    const ids=new Set(payload.rooms.map(room=>room.id));
    if(!payload.acknowledged.every(isId)||!payload.events.every(e=>ids.has(e?.room)&&Number.isSafeInteger(e.seq)&&e.seq>0&&isText(e.name,120)&&isText(e.text,30000)&&isText(e.created,50)&&(e.commandId===undefined||isId(e.commandId))&&(e.remoteSource===undefined||['direct','site'].includes(e.remoteSource))))return json({error:'Invalid event'},400);
    const actions=[];
    if(!payload.heartbeat){
      actions.push(env.DB.prepare('DELETE FROM remote_rooms'),env.DB.prepare("INSERT OR IGNORE INTO remote_rooms(id,name) SELECT json_extract(value,'$.id'),json_extract(value,'$.name') FROM json_each(?) ORDER BY key").bind(JSON.stringify(payload.rooms)));
    }
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
    }else if(payload.heartbeat){
      await ensureStateTable(env.DB);
      actions.push(env.DB.prepare("UPDATE remote_state SET data=json_set(data,'$.syncedAt',?) WHERE id=1").bind(Date.now()));
    }else{
      await ensureStateTable(env.DB);
      actions.push(env.DB.prepare('INSERT OR IGNORE INTO remote_state(id,data) VALUES(1,?)')
        .bind(JSON.stringify({snapshotMissing:true,detectedAt:Date.now()})));
    }
    const eventOffset=actions.length;
    actions.push(
      ...payload.events.map(e=>env.DB.prepare('INSERT OR IGNORE INTO remote_events(seq,name,text,created,room,command_id,remote_source) VALUES(?,?,?,?,?,?,?)').bind(e.seq,e.name,e.text,e.created,e.room,e.commandId??null,e.remoteSource??null)),
      ...payload.acknowledged.map(id=>env.DB.prepare('UPDATE remote_commands SET delivered=1 WHERE id=?').bind(id)),
      env.DB.prepare("DELETE FROM remote_commands WHERE delivered=0 AND room IS NOT NULL AND room NOT IN (SELECT id FROM remote_rooms) AND text NOT LIKE '{\"__control\":true,\"control\":\"create\"%'")
    );
    const writes=await env.DB.batch(actions);
    const newestReply=env.onNewReply&&payload.events.findLast((event,index)=>{
      const age=Date.now()-Date.parse(event.created);
      return writes[eventOffset+index]?.meta?.changes>0&&event.notifyReply===true&&!event.commandId&&event.name!=='나'&&!event.text.startsWith('🔔')&&age>=-60000&&age<300000;
    });
    if(newestReply)env.onNewReply(newestReply);
    const pending=await env.DB.prepare("SELECT id,text,room FROM remote_commands WHERE delivered=0 AND (room IN (SELECT id FROM remote_rooms) OR text LIKE '{\"__control\":true,\"control\":\"create\"%') ORDER BY created,id LIMIT 20").all();
    return json({commands:pending.results,siteVersion:'1.0.9'});
  }
  if(route==='/api/room/whoami'&&request.method==='GET')return owner?json({id:owner}):json({error:'Sign-in required'},403);
  if(!owner||(env.REMOTE_OWNER_ID&&owner!==env.REMOTE_OWNER_ID))return json({error:'Owner sign-in required'},403);
  if(route!=='/api/room/browser')return json({error:'Not found'},404);
  if(request.method==='GET'){
    const rooms=(await env.DB.prepare('SELECT id,name FROM remote_rooms ORDER BY rowid').all()).results;
    const url=new URL(request.url);
    const room=url.searchParams.get('room');
    const since=Number(url.searchParams.get('since'));
    if(room&&!rooms.some(item=>item.id===room))return json({error:'Room is not shared'},404);
    let events=[];
    if(room){
      if(Number.isSafeInteger(since)&&since>0){
        events=(await env.DB.prepare('SELECT seq,name,text,created,command_id AS commandId,remote_source AS remoteSource,(SELECT c.created FROM remote_commands c WHERE c.id=remote_events.command_id AND c.room=remote_events.room) AS siteAcceptedAt FROM remote_events WHERE room=? AND seq>? ORDER BY seq ASC LIMIT 100').bind(room,since).all()).results;
      }else{
        events=(await env.DB.prepare('SELECT seq,name,text,created,command_id AS commandId,remote_source AS remoteSource,(SELECT c.created FROM remote_commands c WHERE c.id=remote_events.command_id AND c.room=remote_events.room) AS siteAcceptedAt FROM remote_events WHERE room=? ORDER BY seq DESC LIMIT 100').bind(room).all()).results.reverse();
      }
    }
    let snapshot=null;
    try{
      await ensureStateTable(env.DB);
      const row=await env.DB.prepare('SELECT data FROM remote_state WHERE id=1').first();
      if(row?.data){
        const parsed=JSON.parse(row.data);
        if(!parsed.snapshotMissing)snapshot=parsed;
      }
    }catch{}
    return json({rooms,events,snapshot});
  }
  // Only a Bearer token verified by the standalone Worker may skip the same-origin check.
  const hasBearer=env.BEARER_VERIFIED===true&&Boolean(request.headers.get('authorization')?.startsWith('Bearer '));
  if(request.method!=='POST'||(request.headers.get('origin')!==new URL(request.url).origin&&!hasBearer))return json({error:'Forbidden'},403);
  let payload;try{payload=await readBody(request,25*1024*1024);}catch{return json({error:'Invalid payload'},400);}
  if(!isId(payload.id))return json({error:'Invalid message'},400);
  let storedText=payload.text, targetRoom=payload.room;
  if(payload.control){
    if(!['approval_decide','retry_agent','pause_agent','room_ranking','create','rename_room','edit_agent'].includes(payload.control))return json({error:'Unsupported control'},400);
    if(payload.control==='create'){
      if(!isText(payload.name,70))return json({error:'Invalid room name'},400);
      targetRoom=null;
      storedText=JSON.stringify({__control:true,control:'create',name:payload.name.trim()});
    }else{
      if(!isId(targetRoom)||!await env.DB.prepare('SELECT id FROM remote_rooms WHERE id=?').bind(targetRoom).first())return json({error:'Room is not shared'},404);
      if(payload.control==='approval_decide'&&(!isId(payload.id_target)||typeof payload.allow!=='boolean'))return json({error:'Invalid approval decision'},400);
      if(['pause_agent','retry_agent'].includes(payload.control)&&(!isId(payload.participant)||(payload.control==='pause_agent'&&typeof payload.paused!=='boolean')))return json({error:'Invalid agent control'},400);
      if(payload.control==='rename_room'&&!isText(payload.name,70))return json({error:'Invalid room name'},400);
      if(payload.control==='edit_agent'&&(!isId(payload.participant)||!isText(payload.name,120)||!['model','effort','role'].every(key=>typeof payload[key]==='string'&&payload[key].length<=120)))return json({error:'Invalid agent settings'},400);
      storedText=JSON.stringify({__control:true,name:payload.name,model:payload.model,effort:payload.effort,role:payload.role,control:payload.control,id:payload.id_target,allow:payload.allow,participant:payload.participant,paused:payload.paused,enabled:payload.enabled,mode:payload.mode,mainMember:payload.mainMember});
    }
  }else{
    const rawAttachments=Array.isArray(payload.attachments)?payload.attachments:[];
    if(rawAttachments.length>5)return json({error:'Too many attachments'},400);
    const attachments=[];
    for(const item of rawAttachments){
      if(!isText(item?.name,120)||typeof item?.data!=='string'||!/^[A-Za-z0-9+/=]+$/.test(item.data))return json({error:'Invalid attachment'},400);
      attachments.push({name:item.name.trim(),data:item.data});
    }
    const textVal=typeof payload.text==='string'?payload.text:'';
    if((!textVal.trim()&&!attachments.length)||textVal.length>8000)return json({error:'Invalid message'},400);
    // Plain messages must never look like the stored control/msg envelope the PC relay parses.
    if(textVal.trimStart().startsWith('{"__control"')||textVal.trimStart().startsWith('{"__msg"'))return json({error:'Invalid message'},400);
    if(!isId(targetRoom)||!await env.DB.prepare('SELECT id FROM remote_rooms WHERE id=?').bind(targetRoom).first())return json({error:'Room is not shared'},404);
    storedText=attachments.length?JSON.stringify({__msg:true,text:textVal,attachments}):textVal;
  }
  const old=await env.DB.prepare('SELECT text,room FROM remote_commands WHERE id=?').bind(payload.id).first();
  if(old&&(old.text!==storedText||(old.room??null)!==(targetRoom??null)))return json({error:'Request ID already used'},409);
  await env.DB.prepare('INSERT OR IGNORE INTO remote_commands(id,text,created,room) VALUES(?,?,?,?)').bind(payload.id,storedText,Date.now(),targetRoom).run();
  return json({queued:true});
}
