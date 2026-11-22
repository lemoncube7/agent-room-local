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
export async function handleRoom(request,env){
  const route=new URL(request.url).pathname;
  const owner=request.headers.get('oai-authenticated-user-id');
  if(route==='/api/room/device'&&request.method==='POST'){
    if(!await sameSecret(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY))return json({error:'Unauthorized'},403);
    let payload;try{payload=await readBody(request,1500000);}catch{return json({error:'Invalid payload'},400);}
    if(!Array.isArray(payload.events)||payload.events.length>40||!Array.isArray(payload.acknowledged)||payload.acknowledged.length>20)return json({error:'Invalid batch'},400);
    if(!payload.acknowledged.every(isId)||!payload.events.every(e=>Number.isSafeInteger(e?.seq)&&e.seq>0&&isText(e.name,120)&&isText(e.text,30000)&&isText(e.created,50)))return json({error:'Invalid event'},400);
    const actions=[
      ...payload.events.map(e=>env.DB.prepare('INSERT OR IGNORE INTO remote_events(seq,name,text,created) VALUES(?,?,?,?)').bind(e.seq,e.name,e.text,e.created)),
      ...payload.acknowledged.map(id=>env.DB.prepare('UPDATE remote_commands SET delivered=1 WHERE id=?').bind(id)),
    ];
    if(actions.length)await env.DB.batch(actions);
    const pending=await env.DB.prepare('SELECT id,text FROM remote_commands WHERE delivered=0 ORDER BY created,id LIMIT 20').all();
    return json({commands:pending.results});
  }
  if(route==='/api/room/whoami'&&request.method==='GET')return owner?json({id:owner}):json({error:'Sign-in required'},403);
  if(!owner||!env.REMOTE_OWNER_ID||owner!==env.REMOTE_OWNER_ID)return json({error:'Owner sign-in required'},403);
  if(route!=='/api/room/browser')return json({error:'Not found'},404);
  if(request.method==='GET'){
    const recent=await env.DB.prepare('SELECT seq,name,text,created FROM remote_events ORDER BY seq DESC LIMIT 100').all();
    return json({events:recent.results.reverse()});
  }
  if(request.method!=='POST'||request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Forbidden'},403);
  let payload;try{payload=await readBody(request,40000);}catch{return json({error:'Invalid payload'},400);}
  if(!isId(payload.id)||!isText(payload.text,8000))return json({error:'Invalid message'},400);
  const old=await env.DB.prepare('SELECT text FROM remote_commands WHERE id=?').bind(payload.id).first();
  if(old&&old.text!==payload.text)return json({error:'Request ID already used'},409);
  await env.DB.prepare('INSERT OR IGNORE INTO remote_commands(id,text,created) VALUES(?,?,?)').bind(payload.id,payload.text,Date.now()).run();
  return json({queued:true});
}
