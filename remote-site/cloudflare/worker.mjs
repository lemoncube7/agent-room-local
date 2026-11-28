import {handleRoom,readBody} from '../handler.mjs';
import pageHtml from '../page.html';
import {manifest,serviceWorker} from '../pwa.mjs';
import {icons} from '../icons.mjs';
import {pushSettings,sendReplyPush} from './push.mjs';

const COOKIE_NAME='ar_owner';

async function sha256Hex(value){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function sameToken(a,b){
  if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
  const [x,y]=await Promise.all([sha256Hex(a),sha256Hex(b)]);
  let diff=0;
  for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);
  return diff===0;
}

function parseCookie(header,name){
  for(const part of String(header||'').split(';')){
    const idx=part.indexOf('=');
    if(idx<0)continue;
    if(part.slice(0,idx).trim()===name)return decodeURIComponent(part.slice(idx+1).trim());
  }
  return '';
}

async function expectedCookieValue(env){
  const pw=typeof env.REMOTE_ACCESS_PASSWORD==='string'?env.REMOTE_ACCESS_PASSWORD:'';
  if(pw.length<16)return '';
  return sha256Hex(pw+':agent-room-owner');
}

async function isOwnerSignedIn(request,env){
  const expected=await expectedCookieValue(env);
  if(!expected)return false;
  const got=parseCookie(request.headers.get('cookie'),COOKIE_NAME);
  if(await sameToken(got,expected))return true;
  const auth=request.headers.get('authorization')||'';
  if(auth.startsWith('Bearer ')){
    const bearerHash=await sha256Hex(auth.slice(7).trim()+':agent-room-owner');
    if(await sameToken(bearerHash,expected))return true;
  }
  return false;
}
function withCors(request,response){
  const origin=request.headers.get('origin');
  if(!origin)return response;
  const headers=new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',origin);
  headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');
  headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  headers.set('Vary','Origin');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

function loginPage(error=''){
  const msg=error?`<p style="color:#ff9b92;font-size:13px;margin:0 0 12px">${error.replace(/[<>&"]/g,'')}</p>`:'';
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Room 로그인</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e8eaf0;font-family:system-ui,sans-serif"><form method="POST" action="/_login" style="width:min(340px,90vw);padding:24px;border-radius:14px;background:#161922;border:1px solid #2a2f3b;display:grid;gap:12px"><h2 style="margin:0;font-size:18px">Agent Room 원격 접속</h2><p style="margin:0;font-size:13px;color:#9aa1b0">소유자 비밀번호를 입력해 주세요.</p>${msg}<input name="password" type="password" required autocomplete="current-password" placeholder="REMOTE_ACCESS_PASSWORD" style="padding:10px 12px;border-radius:8px;border:1px solid #2a2f3b;background:#1e222d;color:#e8eaf0;font:inherit"><button type="submit" style="padding:10px;border-radius:8px;border:0;background:#7c9cff;color:#0f1117;font-weight:600;font:inherit;cursor:pointer">로그인</button></form></body></html>`,{
    status:error?401:200,
    headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}
  });
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    const route=url.pathname;

    // Device sync endpoint uses REMOTE_DEVICE_KEY inside handleRoom.
    if(route==='/api/room/device'){
      return handleRoom(request,{...env,onNewReply:event=>ctx.waitUntil((async()=>{
        const owner=await expectedCookieValue(env);
        if(owner)await sendReplyPush(env.DB,await sha256Hex('push:'+owner),url.origin,event);
      })().catch(()=>console.warn('Agent Room background push failed')))});
    }

    if(route==='/api/room/setup-check'&&request.method==='GET'){
      if(!env.REMOTE_DEVICE_KEY||!await sameToken(request.headers.get('x-agent-room-key'),env.REMOTE_DEVICE_KEY)||!await isOwnerSignedIn(request,env))return new Response(null,{status:403});
      await env.DB.prepare('SELECT id FROM remote_rooms LIMIT 1').first();
      return Response.json({ready:true},{headers:{'Cache-Control':'no-store'}});
    }
    if(route==='/_connect'&&request.method==='GET'){
      const html='<!doctype html><html lang="ko"><meta charset="utf-8"><title>Agent Room 연결</title><form method="post" action="/_login"><label>접속 비밀번호 <input name="password" type="password" required></label><button>연결</button></form><script>const pw=location.hash.slice(1);history.replaceState(null,"","/_connect");if(pw){const f=document.forms[0];f.elements.password.value=pw;f.submit();}</script></html>';
      return new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
    if(route==='/_login'&&request.method==='POST'){
      const expected=await expectedCookieValue(env);
      if(!expected)return loginPage('서버에 REMOTE_ACCESS_PASSWORD(16자 이상) 시크릿이 설정되지 않았습니다.');
      const form=await request.formData();
      const pw=String(form.get('password')||'');
      const got=await sha256Hex(pw+':agent-room-owner');
      if(!await sameToken(got,expected))return loginPage('비밀번호가 올바르지 않습니다.');
      const secure=url.protocol==='https:'?'; Secure':'';
      return new Response(null,{
        status:302,
        headers:{
          Location:'/',
          'Set-Cookie':`${COOKIE_NAME}=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
          'Cache-Control':'private, no-store'
        }
      });
    }

    if(route==='/_logout'&&request.method==='POST'){
      return new Response(null,{
        status:302,
        headers:{
          Location:'/',
          'Set-Cookie':`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          'Cache-Control':'private, no-store'
        }
      });
    }

    const signedIn=await isOwnerSignedIn(request,env);
    if(route==='/api/room/push'){
      if(!signedIn)return new Response(null,{status:403});
      return pushSettings(request,env.DB,await sha256Hex('push:'+await expectedCookieValue(env)),readBody);
    }

    if(route.startsWith('/api/room/')){
      if(request.method==='OPTIONS'){
        return withCors(request,new Response(null,{status:204}));
      }
      const headers=new Headers(request.headers);
      headers.delete('oai-authenticated-user-id');
      if(signedIn)headers.set('oai-authenticated-user-id',env.REMOTE_OWNER_ID||'owner');
      const proxied=new Request(request,{headers});
      // Tell the shared handler the Bearer token was actually verified here (ChatGPT Sites never sets this).
      const bearerVerified=signedIn&&Boolean(request.headers.get('authorization')?.startsWith('Bearer '));
      const res=await handleRoom(proxied,{...env,BEARER_VERIFIED:bearerVerified});
      return request.headers.get('authorization')?.startsWith('Bearer ')?withCors(request,res):res;
    }

    // PWA files are public (no secrets) so the browser can install the app before/after sign-in.
    if(route==='/manifest.webmanifest')return new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/manifest+json','Cache-Control':'public, max-age=3600'}});
    if(route==='/sw.js')return new Response(serviceWorker,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache','Service-Worker-Allowed':'/'}});
    const iconMatch=route.match(/^\/icons\/(192|512)\.png$/);
    if(iconMatch){const bin=Uint8Array.from(atob(icons[iconMatch[1]]),c=>c.charCodeAt(0));return new Response(bin,{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=86400'}});}

    if(route==='/'||route==='/index.html'){
      if(!signedIn)return loginPage();
      return new Response(pageHtml,{
        status:200,
        headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}
      });
    }

    return new Response('Not found',{status:404});
  }
};
