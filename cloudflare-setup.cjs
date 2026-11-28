'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomBytes}=require('node:crypto');
const run=promisify(execFile);
const randomName=()=>'agent-room-'+randomBytes(6).toString('hex');
const cloud='https://api.cloudflare.com/client/v4';

async function wrangler(args){
  const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npx-cli.js');
  if(!fs.existsSync(cli))throw Error('Node 설치에 포함된 npm을 찾을 수 없습니다. npm이 포함된 Node.js로 다시 시작하세요.');
  try{
    const {stdout}=await run(process.execPath,[cli,'--yes','wrangler@4',...args],{
      cwd:require('node:os').tmpdir(),windowsHide:true,timeout:args[0]==='login'?300000:120000,
      maxBuffer:1024*1024,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    return stdout.trim();
  }catch{throw Error('Wrangler를 실행하지 못했습니다. 인터넷 연결과 Cloudflare 브라우저 승인을 확인한 뒤 다시 시도하세요.');}
}

function workerUpload(root,state){
  const parts=new FormData();
  const metadata={main_module:'worker.mjs',compatibility_date:'2026-01-01',bindings:[
    {type:'d1',name:'DB',id:state.db},{type:'secret_text',name:'REMOTE_DEVICE_KEY',text:state.key},
    {type:'secret_text',name:'REMOTE_ACCESS_PASSWORD',text:state.password}]};
  parts.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
  const read=file=>fs.readFileSync(path.join(root,'remote-site',file),'utf8');
  const main=read('cloudflare/worker.mjs').replace("'../handler.mjs'","'./handler.mjs'").replace("'../page.html'","'./page.html'").replace("'../pwa.mjs'","'./pwa.mjs'").replace("'../icons.mjs'","'./icons.mjs'");
  for(const [name,type,body] of [['worker.mjs','application/javascript+module',main],['handler.mjs','application/javascript+module',read('handler.mjs')],['page.html','text/plain',read('page.html')],['pwa.mjs','application/javascript+module',read('pwa.mjs')],['icons.mjs','application/javascript+module',read('icons.mjs')]]){
    parts.append(name,new Blob([body],{type}),name);
  }
  return parts;
}

function createSetup({root,local,connect,fetcher=fetch,cli=wrangler}){
  const file=path.join(local,'cloudflare-setup.json');
  let status={phase:'idle',message:''},busy=false;
  const set=(phase,message,more={})=>{status={phase,message,...more};};
  const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const save=s=>{fs.writeFileSync(file+'.tmp',JSON.stringify(s),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const json=(method,body)=>({method,body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
  async function provision(choice){
    let saved=read();
    set('working','Cloudflare 로그인 확인 중');
    let auth;
    const token=async()=>{const raw=await cli(['auth','token','--json']);try{return JSON.parse(raw);}catch{throw Error('Wrangler 인증 응답을 확인하지 못했습니다.');}};
    try{auth=await token();}catch{
      set('working','열린 브라우저에서 Cloudflare 로그인과 권한 승인을 완료하세요.');
      await cli(['login']);auth=await token();
    }
    if(!auth?.token)throw Error('Wrangler OAuth 로그인이 필요합니다.');
    async function api(route,options={}){
      const r=await fetcher(cloud+route,{...options,redirect:'error',signal:AbortSignal.timeout(60000),
        headers:{...options.headers,Authorization:'Bearer '+auth.token}});
      const data=await r.json().catch(()=>null);
      if(!r.ok||!data?.success){
        const detail=data?.errors?.[0]||{};
        const message=detail.code===10034?'Cloudflare 계정 이메일 인증을 완료한 뒤 다시 시도하세요.':'Cloudflare 요청 실패 (HTTP '+r.status+(detail.code?', 코드 '+detail.code:'')+').';
        throw Object.assign(Error(message),{status:r.status,code:detail.code,nameTaken:/already (?:been )?(?:taken|registered|used|exists)|not available|unavailable/i.test(String(detail.message||''))});
      }
      return data.result;
    }
    const accounts=await api('/accounts?per_page=50');
    const requested=choice||saved?.account;
    const account=requested?accounts.find(a=>a.id===requested):accounts.length===1?accounts[0]:null;
    if(!account){
      if(!accounts.length)throw Error('사용할 수 있는 Cloudflare 계정이 없습니다.');
      set('account','배포할 Cloudflare 계정을 선택하세요.',{accounts:accounts.map(({name,id})=>({name,id}))});return;
    }
    if(saved&&saved.account!==account.id)throw Error('이 PC에서 설정을 시작한 Cloudflare 계정으로 로그인하세요.');
    if(!saved){
      saved={account:account.id,name:randomName(),key:randomBytes(32).toString('hex'),password:randomBytes(24).toString('base64url')};save(saved);
    }
    const base='/accounts/'+account.id;
    const dashboard='https://dash.cloudflare.com/'+account.id+'/workers/onboarding';
    set('working','workers.dev 주소 확인 중');
    let sub;
    try{sub=(await api(base+'/workers/subdomain'))?.subdomain;}catch(e){
      if(e.status===403&&e.code!==10034){set('attention','Cloudflare에서 workers.dev 등록 상태와 계정 권한을 확인하세요.',{url:dashboard});return;}
      if(e.status!==404&&e.code!==10007)throw e;
    }
    if(!sub){
      try{
        for(let attempt=0;attempt<5;attempt++){
          const candidate=attempt===0?saved.name:randomName();
          try{sub=(await api(base+'/workers/subdomain',json('PUT',{subdomain:candidate})))?.subdomain;break;}
          catch(error){
            if(!(error.status===409||error.nameTaken)||attempt===4)throw error;
            const current=await api(base+'/workers/subdomain').catch(e=>{if(e.status===404||e.code===10007)return null;throw e;});
            if(current?.subdomain){sub=current.subdomain;break;}
          }
        }
      }
      catch(e){
        if(e.code===10034)throw e;
        set('attention','Cloudflare에서 workers.dev 주소 등록을 완료한 뒤 다시 시도하세요.',{url:dashboard});return;
      }
    }
    if(!/^[a-z0-9-]+$/i.test(sub||''))throw Error('Cloudflare에서 workers.dev 주소를 확인하지 못했습니다.');
    set('working','D1 데이터베이스 준비 중');
    if(!saved.db){
      const dbs=await api(base+'/d1/database?name='+saved.name);
      const existing=dbs.find(d=>d.name===saved.name);
      const database=existing||await api(base+'/d1/database',json('POST',{name:saved.name}));
      if(!database?.uuid)throw Error('D1 데이터베이스 식별자를 확인하지 못했습니다.');
      saved.db=database.uuid;save(saved);
    }
    const sql=async statement=>{
      const rows=await api(base+'/d1/database/'+saved.db+'/query',json('POST',{sql:statement}));
      if(!Array.isArray(rows)||rows.some(r=>r.success===false))throw Error('D1 스키마 적용 실패');
      return rows[0]?.results||[];
    };
    for(const filename of ['schema.sql','0001_multiple_rooms.sql','0002_remote_state.sql','0003_remote_command_id.sql','0004_multi_node.sql']){
      const content=fs.readFileSync(path.join(root,'remote-site',filename),'utf8').replaceAll('--> statement-breakpoint','');
      for(let statement of content.split(';').map(s=>s.trim()).filter(Boolean)){
        const add=/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(statement);
        if(add&&(await sql('PRAGMA table_info('+add[1]+')')).some(c=>c.name===add[2]))continue;
        statement=statement.replace(/^CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/i,'CREATE $1 IF NOT EXISTS ');
        await sql(statement);
      }
    }
    set('working','Worker와 접속 인증 설정 중');
    const script=base+'/workers/scripts/'+saved.name;
    await api(script,{method:'PUT',body:workerUpload(root,saved)});
    await api(script+'/subdomain',json('POST',{enabled:true}));
    const site='https://'+saved.name+'.'+sub+'.workers.dev';
    saved.pendingSite=site;save(saved);
    // A newly registered workers.dev subdomain or script can take a few minutes to resolve, so wait up to ~3 minutes.
    let verified=false,last='';
    const started=Date.now();
    while(!verified&&Date.now()-started<180000){
      set('working','실제 주소에서 비밀번호·PC 연결 키·DB 확인 중 ('+Math.round((Date.now()-started)/1000)+'초, 새 주소는 몇 분 걸릴 수 있어요)');
      try{
        const check=await fetcher(site+'/api/room/setup-check',{headers:{'x-agent-room-key':saved.key,Authorization:'Bearer '+saved.password},redirect:'error',signal:AbortSignal.timeout(8000)});
        verified=check.ok&&(await check.json().catch(()=>({}))).ready===true;
        if(!verified)last='HTTP '+check.status+(check.status===403?' (키 또는 비밀번호 불일치)':check.status===404?' (Worker가 아직 배포되지 않음)':check.status>=500?' (Worker 또는 DB 오류)':'');
      }catch(error){last=/ENOTFOUND|getaddrinfo/i.test(String(error?.cause?.code||error?.message))?'주소를 아직 찾을 수 없음 (DNS 전파 대기)':String(error?.cause?.code||error?.message||error);}
      if(!verified)await new Promise(r=>setTimeout(r,5000));
    }
    if(!verified)throw Error('Worker 배포 후 연결 확인을 마치지 못했습니다 ('+last+'). 설정은 저장돼 있으니 다시 시도하면 이어서 확인합니다. 주소: '+site);
    const mode=connect(site,saved.key);
    saved.site=site;save(saved);set('done','원격 연결을 확인했습니다.',{site,mode});
  }
  return {
    start(account){
      if(!busy){busy=true;provision(account).catch(e=>set('error',e.message)).finally(()=>{busy=false;});}
      return status;
    },
    status(){if(status.phase==='idle'){const s=read();if(s?.site)return {phase:'done',message:'마지막으로 설정한 원격 주소',site:s.site};}return status;},
    link(){const s=read();if(!s?.site)throw Error('원격 설정을 먼저 완료하세요.');return s.site+'/_connect#'+s.password;}
  };
}
module.exports={createSetup};
