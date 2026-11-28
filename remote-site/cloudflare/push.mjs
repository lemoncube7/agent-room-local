import {encryptPushPayload} from './push-payload.mjs';

const encode=new TextEncoder();
const P256={name:'ECDSA',namedCurve:'P-256'};
const lifetime=30*24*60*60*1000;
const base64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const json=value=>Response.json(value,{headers:{'Cache-Control':'no-store'}});

function pushEndpoint(value){
  if(typeof value!=='string'||value.length>2048)return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash)return null;
    if(!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(url.hostname)&&!url.hostname.endsWith('.notify.windows.com'))return null;
    return url;
  }catch{return null;}
}

async function signingKey(db){
  const query='SELECT private_jwk,public_key FROM remote_push_key WHERE id=1';
  const existing=await db.prepare(query).first();
  if(existing)return existing;
  const pair=await crypto.subtle.generateKey(P256,true,['sign','verify']);
  const [privateKey,raw]=await Promise.all([crypto.subtle.exportKey('jwk',pair.privateKey),crypto.subtle.exportKey('raw',pair.publicKey)]);
  await db.prepare('INSERT OR IGNORE INTO remote_push_key(id,private_jwk,public_key) VALUES(1,?,?)')
    .bind(JSON.stringify(privateKey),base64url(raw)).run();
  return db.prepare(query).first();
}

export async function pushSettings(request,db,ownerHash,readBody){
  if(request.method==='GET')return json({publicKey:(await signingKey(db)).public_key});
  if(!['POST','DELETE'].includes(request.method))return new Response(null,{status:405});
  if(request.headers.get('origin')!==new URL(request.url).origin)return new Response(null,{status:403});
  let url,keys;
  try{
    const data=await readBody(request,4096);
    url=pushEndpoint(data.endpoint);
    keys=data.keys;
  }catch{}
  if(!url)return new Response(null,{status:400});
  if(request.method==='DELETE'){
    await db.prepare('DELETE FROM remote_push_subscriptions WHERE endpoint=? AND owner_hash=?').bind(url.href,ownerHash).run();
  }else{
    if(typeof keys?.p256dh!=='string'||typeof keys.auth!=='string'||!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh)||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth))return new Response(null,{status:400});
    await db.batch([
      db.prepare('DELETE FROM remote_push_subscriptions WHERE expires_at<=? OR owner_hash<>?').bind(Date.now(),ownerHash),
      db.prepare('INSERT OR REPLACE INTO remote_push_subscriptions(endpoint,owner_hash,expires_at,p256dh,auth) VALUES(?,?,?,?,?)').bind(url.href,ownerHash,Date.now()+lifetime,keys.p256dh,keys.auth),
      db.prepare('DELETE FROM remote_push_subscriptions WHERE endpoint IN (SELECT endpoint FROM remote_push_subscriptions ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET 20)')
    ]);
  }
  return json({ok:true});
}

export async function sendReplyPush(db,ownerHash,subject,event,send=fetch){
  const {results}=await db.prepare('SELECT endpoint,p256dh,auth FROM remote_push_subscriptions WHERE owner_hash=? AND expires_at>?').bind(ownerHash,Date.now()).all();
  if(!results.length)return;
  const {private_jwk,public_key}=await signingKey(db);
  const key=await crypto.subtle.importKey('jwk',JSON.parse(private_jwk),P256,false,['sign']);
  const tokens=new Map();
  async function token(audience){
    const header=base64url(encode.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
    const claims=base64url(encode.encode(JSON.stringify({aud:audience,exp:Math.floor(Date.now()/1000)+3600,sub:subject})));
    const body=header+'.'+claims;
    return body+'.'+base64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encode.encode(body)));
  }
  const preview=Array.from(event.text.replace(/^\s*\[\[DONE\]\]\s*/, '').split(/\n\s*\[첨부 파일\]/)[0].replace(/\s+/g,' ').trim());
  const payload=JSON.stringify({title:'Agent Room · '+event.name,body:preview.length>160?preview.slice(0,160).join('')+'…':preview.join('')});
  await Promise.allSettled(results.map(async ({endpoint,p256dh,auth})=>{
    const url=pushEndpoint(endpoint);
    if(!url)return;
    if(!tokens.has(url.origin))tokens.set(url.origin,token(url.origin));
    const body=p256dh&&auth?await encryptPushPayload(payload,p256dh,auth):undefined;
    const response=await send(url,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(8000),headers:{
      Authorization:'vapid t='+await tokens.get(url.origin)+', k='+public_key,
      TTL:'300',Urgency:'normal',Topic:'agent-room-reply',...(body?{'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'}:{})
    }});
    if(response.status===404||response.status===410){
      await db.prepare('DELETE FROM remote_push_subscriptions WHERE endpoint=? AND owner_hash=?').bind(endpoint,ownerHash).run();
    }else if(!response.ok){
      console.warn('Agent Room push service returned HTTP '+response.status);
    }
  }));
}
