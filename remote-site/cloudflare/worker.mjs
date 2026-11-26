import {handleRoom} from '../handler.mjs';
import pageHtml from '../page.html';

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
  return sameToken(got,expected);
}

function loginPage(error=''){
  const msg=error?`<p style="color:#ff9b92;font-size:13px;margin:0 0 12px">${error.replace(/[<>&"]/g,'')}</p>`:'';
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Room 로그인</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e8eaf0;font-family:system-ui,sans-serif"><form method="POST" action="/_login" style="width:min(340px,90vw);padding:24px;border-radius:14px;background:#161922;border:1px solid #2a2f3b;display:grid;gap:12px"><h2 style="margin:0;font-size:18px">Agent Room 원격 접속</h2><p style="margin:0;font-size:13px;color:#9aa1b0">소유자 비밀번호를 입력해 주세요.</p>${msg}<input name="password" type="password" required autocomplete="current-password" placeholder="REMOTE_ACCESS_PASSWORD" style="padding:10px 12px;border-radius:8px;border:1px solid #2a2f3b;background:#1e222d;color:#e8eaf0;font:inherit"><button type="submit" style="padding:10px;border-radius:8px;border:0;background:#7c9cff;color:#0f1117;font-weight:600;font:inherit;cursor:pointer">로그인</button></form></body></html>`,{
    status:error?401:200,
    headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const route=url.pathname;

    // Device sync endpoint uses REMOTE_DEVICE_KEY inside handleRoom.
    if(route==='/api/room/device'){
      return handleRoom(request,env);
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

    if(route.startsWith('/api/room/')){
      const headers=new Headers(request.headers);
      headers.delete('oai-authenticated-user-id');
      if(signedIn)headers.set('oai-authenticated-user-id',env.REMOTE_OWNER_ID||'owner');
      const proxied=new Request(request,{headers});
      return handleRoom(proxied,env);
    }

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
