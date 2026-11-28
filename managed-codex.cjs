'use strict';
const {execFile,execFileSync,spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const appVersion = (()=>{try{return fs.readFileSync(path.join(__dirname,'VERSION'),'utf8').trim()||'0.0.0';}catch{return '0.0.0';}})();

function cliSettings(){
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname,'local','cli.json'),'utf8').replace(/^\uFEFF/,''));
  } catch (error) {
    if(error.code!=='ENOENT')throw error;
    return {};
  }
}
let cachedStoreCodex;
function findWindowsStoreCodex() {
  if (process.platform !== 'win32') return null;
  if (cachedStoreCodex && fs.existsSync(cachedStoreCodex)) return cachedStoreCodex;
  try {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const loc = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }).trim();
    const exe = loc ? path.join(loc, 'app', 'resources', 'codex.exe') : '';
    if (exe && fs.existsSync(exe)) { cachedStoreCodex = exe; return exe; }
  } catch {}
  return null;
}
function cliCommand(provider) {
  const env=process.env['AGENT_ROOM_'+provider.toUpperCase()];
  const saved=cliSettings();
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA,'npm','node_modules') : null;
  const defaults = provider==='claude'
    ? [path.join(os.homedir(),'.local','bin','claude.exe'), npm && path.join(npm,'@anthropic-ai','claude-code','cli.js')]
    : provider==='agy'?[process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'agy','bin','agy.exe')]:[findWindowsStoreCodex(), npm && path.join(npm,'@openai','codex','bin','codex.js')];
  const executable = env || [saved?.[provider],...defaults].find(candidate=>candidate&&fs.existsSync(candidate));
  if(executable && /\.(?:cjs|mjs|js)$/i.test(executable))return [process.execPath, executable];
  return [executable || provider];
}

function sumUsage(target,source,fallbackTurns=0){
  const input=Number(source?.input_tokens??source?.inputTokens??0)+(Number(source?.cache_read_input_tokens??source?.cache_read_tokens??source?.cached_input_tokens??0))+(Number(source?.cache_creation_input_tokens??0));
  const output=Number(source?.output_tokens??source?.outputTokens??0);
  const cost=Number(source?.total_cost_usd??source?.cost_usd??0);
  const turns=Number(source?.num_turns??fallbackTurns);
  target.turns+=Number.isFinite(turns)?turns:fallbackTurns;
  target.inputTokens+=Number.isFinite(input)?input:0;
  target.outputTokens+=Number.isFinite(output)?output:0;
  target.costUsd+=Number.isFinite(cost)?cost:0;
}
function summarizeDiagnostic(diagnostic){
  const lines=String(diagnostic||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){
    const line=lines[i];
    if(line.startsWith('{')){
      try{
        const obj=JSON.parse(line);
        const msg=obj.error?.message||obj.error||obj.message||obj.result||obj.response;
        if(typeof msg==='string'&&msg.trim())return msg.trim().replace(/\s+/g,' ').slice(0,220);
      }catch{}
    }
    if(/error|fail|exception|denied|invalid|refused|limit|expired|not found|unknown/i.test(line))
      return line.replace(/\s+/g,' ').slice(0,220);
  }
  return lines.length?lines.at(-1).replace(/\s+/g,' ').slice(0,220):'';
}
function parseCodex(stdout, session) {
  const events = stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const usage={turns:0,inputTokens:0,outputTokens:0,costUsd:0};
  for(const event of events)if(event.type==='turn.completed'&&event.usage)sumUsage(usage,event.usage,1);
  if(!usage.turns)usage.turns=1;
  return {
    toolDiagnostics: events.filter(event=>event.type==='item.completed'&&event.item?.type==='command_execution'&&event.item.exit_code!==0).map(event=>event.item.aggregated_output||'').join('\n'),
    id: session || events.find(event => event.type === 'thread.started')?.thread_id,
    reply: events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
      .map(event => event.item.text).filter(Boolean).at(-1),
    usage
  };
}

function diagnoseCliFailure(provider,error,diagnostic){
  const name={codex:'Codex',claude:'Claude Code',agy:'Antigravity'}[provider]||'CLI';
  const detail=summarizeDiagnostic(diagnostic);
  const failure=(code,message,action)=>Object.assign(new Error(name+' · '+message+' '+action),{cliCode:code});
  if(/app runtime provisioning service|failed to create unified exec process|appx.*provision/i.test(diagnostic))
    return failure('windows_runtime','Windows에서 작업 명령을 실행하는 환경이 시작되지 않았어요.','기존 데스크톱 대화를 연결하거나 독립 CLI 설치를 확인하세요.');
  if(/oauth.{0,35}(?:expired|refresh)|failed to authenticate|not logged in|please log in|authentication failed|not authenticated|login required/i.test(diagnostic))
    return failure('auth_expired','로그인이 만료됐거나 인증에 실패했어요.',provider==='claude'?'터미널에서 claude auth login을 실행한 뒤 다시 보내세요.':provider==='codex'?'터미널에서 codex login을 실행한 뒤 다시 보내세요.':'Antigravity를 열어 로그인한 뒤 다시 보내세요.');
  if(/rate limit|resource_exhausted|usage limit|quota exceeded|third-party quota reached|quota reached|hit your.{0,20}limit|5-hour limit|(?:http|status)\s*429/i.test(diagnostic)){
    const error=failure('usage_limit','요청 또는 사용량 한도에 걸렸어요.','한도 초기화 후 다시 시도하거나 사용 가능한 모델을 선택하세요.');
    const reset=diagnostic.match(/resets in\s+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i);
    const seconds=reset?Number(reset[1]||0)*3600+Number(reset[2]||0)*60+Number(reset[3]||0):0;
    if(seconds>0)error.quotaResetAt=Date.now()+seconds*1000;
    return error;
  }
  if(/model.{0,100}(?:invalid|not available|not found|not supported)|invalid model/i.test(diagnostic))
    return failure('model_unavailable','선택한 모델을 사용할 수 없어요.','모델 목록에서 다른 모델을 선택하세요.');
  if(error?.code==='ENOENT')return failure('cli_missing','실행 파일이나 작업 폴더를 찾지 못했어요.','CLI를 설치하고 시작 화면에서 프로젝트를 다시 선택하세요.');
  if(['EACCES','EPERM'].includes(error?.code))return failure('access_denied','Windows가 CLI 실행을 차단했어요.','실행 파일과 프로젝트 폴더의 접근 권한을 확인하세요.');
  if(error?.killed||/timed out|timeout/i.test(diagnostic))
    return failure('timeout','제한 시간 안에 응답이 오지 않았어요'+(detail?' ('+detail+')':'')+'.','CLI에서 네트워크와 장시간 작업 여부를 확인한 뒤 다시 시도하세요.');
  if(/econn|enotfound|tls handshake|network connection|unable to connect/i.test(diagnostic))
    return failure('network','CLI가 서비스에 연결하지 못했어요.','인터넷 연결을 확인한 뒤 다시 시도하세요.');
  if(/already has an active writer/i.test(diagnostic))
    return failure('active_writer','다른 Codex 창(데스크톱 앱 또는 터미널)이 이 대화를 열고 있어 잠겨 있어요.','Codex 앱에서 해당 대화를 닫거나 다른 대화로 이동한 뒤 다시 시도하세요.');
  if(/untrusted|trust this (?:project|folder)|workspace trust/i.test(diagnostic))
    return failure('project_trust','CLI가 프로젝트 신뢰 확인을 요청했어요.','터미널에서 같은 폴더를 열고 신뢰 여부를 확인하세요.');
  const suffix=typeof error?.code==='number'?' (종료 코드 '+error.code+')':'';
  return failure('unknown','CLI에서 완성된 응답을 받지 못했어요'+suffix+(detail?': '+detail:'')+'.','같은 프로젝트에서 CLI를 직접 열어 오류를 확인하세요.');
}

const cliEnv=()=>({...process.env,CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE||'50'});
const devCommands=['node','npm','pytest','cargo test','cargo build','go test','go build','dotnet test','dotnet build','git status','git diff','git log','git show','git add','git commit','git branch','git fetch','git remote','git rev-parse','git ls-files','git blame','ls','pwd','cat','head','tail','wc','grep'];
const devPowerShellCommands=['Get-ChildItem','Get-Content','Get-Location','Test-Path','Select-String','Measure-Object'];
const devAllowedTools=[...['Bash','PowerShell'].flatMap(tool=>devCommands.map(command=>tool+'('+command+':*)')),...devPowerShellCommands.map(command=>'PowerShell('+command+':*)'),'WebSearch','WebFetch'].join(',');
function mergeLiveReplies(parts){
  const usable=parts.map(part=>String(part||'').trim()).filter(part=>part&&part!=='[[AGENT_ROOM_NO_REPLY]]');
  if(!usable.length)return '[[AGENT_ROOM_NO_REPLY]]';
  if(usable.length===1)return usable[0];
  const calls=new Set(), bodies=[];
  for(let part of usable){
    for(let call=part.match(/^\[\[CALL:([^\]\r\n]+)\]\]\s*/);call;call=part.match(/^\[\[CALL:([^\]\r\n]+)\]\]\s*/)){calls.add(call[0].trim());part=part.slice(call[0].length);}
    part=part.replace(/^\[\[TO:[^\]\r\n]+\]\]\s*/,'').trim();
    if(part)bodies.push(part);
  }
  return [...calls,bodies.join('\n\n')].join('\n');
}
function createProgressWriter(progressFile){
  if(!progressFile)return()=>{};
  let lastStep='', preview='', lastChunk='', lastAt=0, task='';
  const taskLine=/^\[\[WORK:[ \t]*([^\r\n]{1,120}?)\]\][ \t]*(?:\r?\n|$)/gm;
  const extractTask=text=>text.replace(taskLine,(_line,title)=>{if(title.trim())task=title.trim()+' 작업 중…';return '';});
  const cleanPreview=text=>String(text||'').replace(/^(?:\[\[(?:CALL|TO):[^\]\r\n]+\]\]\s*)+/,'').trim();
  const write=(step,chunk,delta=false)=>{
    let nextChunk='';
    if(delta&&chunk){
      preview=extractTask(cleanPreview((preview+String(chunk)).slice(-4000)));
      nextChunk=String(chunk);
    }else{
      const clean=chunk?cleanPreview(chunk):'';
      nextChunk=clean&&clean!=='[[AGENT_ROOM_NO_REPLY]]'&&clean!==lastChunk?clean:'';
      if(nextChunk){
        lastChunk=nextChunk;
        const output=extractTask(nextChunk);
        if(output)preview=(preview?preview+'\n\n'+output:output).slice(-4000);
      }
    }
    if(!step&&!nextChunk)return;
    const nextStep=step||lastStep||'작업 진행 중…';
    const now=Date.now();
    if(!nextChunk&&nextStep===lastStep&&now-lastAt<250)return;
    lastStep=nextStep; lastAt=now;
    try{fs.writeFileSync(progressFile,JSON.stringify({step:nextStep,task,preview,updatedAt:now}));}catch{}
  };
  write.reset=()=>{
    preview='';
    try{fs.writeFileSync(progressFile,JSON.stringify({step:lastStep||'작업 진행 중…',task,preview,updatedAt:Date.now()}));}catch{}
  };
  return write;
}
function saveProviderLimits(provider,windows,status=null,updatedAt=Date.now()){
  if(!windows||typeof windows!=='object'||!Object.keys(windows).length)return false;
  const dir=path.join(__dirname,'local');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'limits-'+provider+'.json');
  try{
    fs.writeFileSync(file+'.tmp',JSON.stringify({provider,updatedAt,status,windows}));
    fs.renameSync(file+'.tmp',file);
    return true;
  }catch{return false;}
}
function saveClaudeLimits(info){
  saveProviderLimits('claude',info?.unifiedWindows,info?.status||null);
}
function refreshCodexLimits(){
  return new Promise(resolve=>{
    const [file,...prefix]=cliCommand('codex');
    const child=spawn(file,[...prefix,'app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:cliEnv()});
    let buf='', settled=false;
    const done=ok=>{if(settled)return;settled=true;clearTimeout(timer);try{child.kill();}catch{}resolve(ok);};
    const timer=setTimeout(()=>done(false),12000);
    const send=msg=>{try{child.stdin.write(JSON.stringify(msg)+'\n');}catch{done(false);}};
    child.on('error',()=>done(false));
    child.stdin.on('error',()=>done(false));
    child.on('exit',()=>done(false));
    child.stdout.on('data',chunk=>{
      buf+=chunk;
      for(let at=buf.indexOf('\n');at>=0;at=buf.indexOf('\n')){
        const line=buf.slice(0,at);buf=buf.slice(at+1);
        let msg;try{msg=JSON.parse(line);}catch{continue;}
        if(msg.id===1&&!msg.error){send({method:'initialized'});send({id:2,method:'account/rateLimits/read'});}
        else if(msg.id===2&&!msg.error){
          const buckets=msg.result?.rateLimitsByLimitId;
          const limit=buckets&&Object.keys(buckets).length?(buckets.codex||Object.values(buckets)[0]):msg.result?.rateLimits;
          const windows={};
          for(const key of ['primary','secondary']){
            const e=limit?.[key];
            if(typeof e?.usedPercent==='number'&&Number.isFinite(e.usedPercent)){
              const winKey=e.windowDurationMins===300?'five_hour':e.windowDurationMins===10080?'seven_day':key;
              windows[winKey]={utilization:Math.max(0,Math.min(1,e.usedPercent/100)),resetsAt:e.resetsAt??null};
            }
          }
          done(saveProviderLimits('codex',windows));
        }else if(msg.error)done(false);
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'agent-room',version:appVersion}}});
  });
}
function importAgyUsageFile(usageFile){
  try{
    if(!usageFile||!fs.existsSync(usageFile))return false;
    const snap=JSON.parse(fs.readFileSync(usageFile,'utf8'));
    if(!Array.isArray(snap?.limits))return false;
    const windows={};
    for(const row of snap.limits){
      if(row?.disabled||/argon-wtu/i.test(row?.id||''))continue;
      if(typeof row?.remainingPercent==='number'&&Number.isFinite(row.remainingPercent)){
        windows[row.id||'quota']={utilization:Math.max(0,Math.min(1,(100-row.remainingPercent)/100)),resetsAt:row.resetsAt||null};
      }
    }
    const observed=Date.parse(snap.observedAt);
    return saveProviderLimits('agy',windows,null,Number.isFinite(observed)?observed:Date.now());
  }catch{return false;}
}
function refreshAgyLimits(spawnIfStale=true,force=false){
  const localUsage=path.join(__dirname,'local','agy-usage.json');
  const saved=cliSettings();
  const usageFile=process.env.AGENT_ROOM_AGY_USAGE_FILE||saved?.agyUsageFile||(fs.existsSync(localUsage)?localUsage:'');
  if(!usageFile)return Promise.resolve(false);
  const before=fs.existsSync(usageFile)?fs.statSync(usageFile).mtimeMs:0;
  if(!force&&before&&Date.now()-before<25*60*1000)return Promise.resolve(importAgyUsageFile(usageFile));
  if(!spawnIfStale)return Promise.resolve(before?importAgyUsageFile(usageFile):false);
  const [exe]=cliCommand('agy');
  if(!exe||!fs.existsSync(exe))return Promise.resolve(before?importAgyUsageFile(usageFile):false);
  return new Promise(resolve=>{
    const child=spawn(exe,[],{cwd:os.tmpdir(),windowsHide:true,stdio:'ignore',detached:false});
    const started=Date.now();
    const timer=setInterval(()=>{
      const now=fs.existsSync(usageFile)?fs.statSync(usageFile).mtimeMs:0;
      if(now>before||Date.now()-started>25000){
        clearInterval(timer);
        if(child.pid)try{spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
        resolve(now>before?importAgyUsageFile(usageFile):(before?importAgyUsageFile(usageFile):false));
      }
    },1000);
    child.on('error',()=>{clearInterval(timer);resolve(before?importAgyUsageFile(usageFile):false);});
  });
}
function cleanInterim(text){
  const clean=String(text||'').replace(/^(?:\[\[CALL:[^\]\r\n]+\]\]\s*)+/,'').trim();
  if(!clean||clean.includes('[[AGENT_ROOM_NO_REPLY]]')||/^\[\[(?:TO|HANDOFF_)/.test(clean))return '';
  return clean.slice(0,4000);
}
function toolLabel(name,input){
  const n=String(name||'');
  const rawPath=input?.file_path||input?.path||input?.Path||input?.TargetFile||'';
  const base=rawPath?path.basename(String(rawPath)):'';
  if(/^(read|read_file|view_file)$/i.test(n))return base?'파일 읽는 중: '+base:'파일 읽는 중…';
  if(/^(edit|write|edit_file|write_file|replace_file_content|multi_replace_file_content)$/i.test(n))return base?'파일 수정 중: '+base:'파일 수정 중…';
  if(/^(bash|powershell|run_command|exec)$/i.test(n))return '명령 실행 중…';
  if(/search|grep|find/i.test(n))return '코드 검색 중…';
  return n?n+' 실행 중…':'작업 진행 중…';
}
function describeStreamProgress(event){
  if(!event||typeof event!=='object')return null;
  if(event.type==='assistant'&&Array.isArray(event.message?.content)){
    let step='', text='';
    for(const b of event.message.content){
      if(b?.type==='tool_use')step=toolLabel(b.name,b.input);
      else if(b?.type==='thinking'&&!step)step='생각 중…';
      else if(b?.type==='text'&&b.text){text+=(text?'\n':'')+b.text;if(!step)step='답변 작성 중…';}
    }
    return step||text?{step,text}:null;
  }
  if(event.type==='step_update'||event.event==='step_update'){
    const su=(event.event==='step_update'&&event.step_update&&typeof event.step_update==='object')?event.step_update:event;
    const delta=typeof su.text_delta==='string'&&su.text_delta.length>0;
    const text=delta?su.text_delta:typeof su.text==='string'?su.text:typeof su.content==='string'?su.content:typeof su.response==='string'?su.response:'';
    const toolName=su.tool_info?.name||su.tool_name;
    if(toolName)return {step:toolLabel(toolName,su.tool_info?.parameters||su.tool_info?.input),text,delta};
    const st=String(su.step_type||'').toLowerCase();
    const step=st.includes('think')||st.includes('reason')?'생각 중…':st.includes('tool')||st.includes('command')?'도구 실행 중…':st.includes('resp')||st.includes('text')||st.includes('answer')?'답변 작성 중…':'작업 진행 중…';
    return {step,text,delta};
  }
  if(event.type==='item.started'||event.type==='item.completed'){
    const t=event.item?.type;
    const text=event.type==='item.completed'&&t==='agent_message'&&typeof event.item?.text==='string'?event.item.text:'';
    const step=t==='command_execution'?'명령 실행 중…':t==='file_change'?'파일 수정 중…':t==='reasoning'?'생각 중…':t==='agent_message'?'답변 작성 중…':'';
    return step||text?{step,text}:null;
  }
  if(event.type==='init'||event.event==='init'||event.type==='system')return {step:'세션 연결 중…',text:''};
  return null;
}
function buildStreamArgs(provider,session,model,effort,options={}){
  const permission=options.permission||'dev';
  if(provider==='claude'){
    const args=['--print','--output-format','stream-json','--input-format','stream-json','--verbose','--permission-mode',permission==='full'?'bypassPermissions':permission==='chat'?'plan':'acceptEdits',...(session?['--resume',session]:[])];
    if(options.rank){
      const i=args.indexOf('--permission-mode');
      if(i>=0)args[i+1]='plan';
      args.push('--tools','','--no-session-persistence','--strict-mcp-config');
    }else{
      if(permission==='chat')args.push('--allowedTools','Read,Glob,Grep,WebSearch,WebFetch');
      else if(permission==='dev')args.push('--allowedTools',devAllowedTools);
      if(permission!=='full'&&options.approvalConfig)args.push('--mcp-config',options.approvalConfig,'--permission-prompt-tool','mcp__agent-room-approval__permission_prompt');
    }
    if(model)args.push('--model',model);
    if(effort)args.push('--effort',effort);
    return args;
  }
  const agyPerm=(options.rank||permission==='chat')?['--mode','plan']:permission==='full'?['--dangerously-skip-permissions']:['--mode',permission==='edit'?'accept-edits':'auto'];
  const args=['--input-format','stream-json','--output-format','stream-json',...agyPerm,...(session?['--conversation',session]:[]),'--print-timeout','1800s'];
  if(model)args.push('--model',model);
  if(effort)args.push('--effort',effort);
  return args;
}
function createStreamHost(provider,file,prefix,args,project,session,persistent=false,onExit=null){
  const hostStarted=performance.now();
  const child=spawn(file,[...prefix,...args],{cwd:project,windowsHide:true,env:cliEnv()});
  let id=session, buffer='', stderr='', alive=true, turnsCompleted=0, active=null;
  let spawnedAt=null, attempts=0;
  child.once('spawn',()=>{spawnedAt=performance.now();});
  function trace(turn,phase){
    if(!turn.traceId||turn.tracePhases.has(phase))return;
    turn.tracePhases.add(phase);
    try{
      const log=path.join(__dirname,'local','claude-turn-timing.jsonl');
      if((fs.statSync(log,{throwIfNoEntry:false})?.size||0)>=1024*1024)fs.renameSync(log,log+'.1');
      fs.appendFileSync(log,JSON.stringify({
        at:new Date().toISOString(),turn:turn.traceId,phase,
        elapsedMs:Math.round(performance.now()-turn.startedAt),
        ...(phase==='request_sent'?{
          reusedProcess:turnsCompleted>0,resumeSession:turn.resumeSession,
          processAgeMs:Math.round(turn.startedAt-hostStarted),
          spawnMs:spawnedAt===null?null:Math.round(spawnedAt-hostStarted)
        }:{})
      })+'\n');
    }catch{}
  }
  const sendPayload=text=>{
    const payload=provider==='agy'
      ?{event:'user',message:{content:[{type:'text',text}]}}
      :{type:'user',message:{role:'user',content:[{type:'text',text}]}};
    child.stdin.write(JSON.stringify(payload)+'\n');
  };
  const finishTurn=turn=>{
    trace(turn,id&&turn.parts.length?'finished':'failed');
    clearInterval(turn.poller);clearTimeout(turn.killer);
    for(const item of [turn.closingFile,turn.liveFile])if(item)fs.rmSync(item,{force:true});
    active=null;turnsCompleted++;
    if(id&&turn.parts.length)turn.resolve({id,reply:mergeLiveReplies(turn.parts),usage:turn.usage});
    else turn.reject(diagnoseCliFailure(provider,{code:0},stderr+turn.failure));
  };
  const failTurn=(turn,err)=>{
    trace(turn,turn.timedOut?'timeout':'failed');
    clearInterval(turn.poller);clearTimeout(turn.killer);
    for(const item of [turn.inboxFile,turn.closingFile,turn.liveFile])if(item)fs.rmSync(item,{force:true});
    active=null;
    turn.reject(err);
  };
  child.stdin.on('error',()=>{});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000);});
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      let event;try{event=JSON.parse(line);}catch{continue;}
      const cid=event.conversation_id||event.session_id||event.result?.conversation_id||event.step_update?.conversation_id;
      if(cid)id=cid;
      if(provider==='claude'&&event.type==='rate_limit_event')saveClaudeLimits(event.rate_limit_info);
      const turn=active;
      if(!turn)continue;
      turn.lastEvent=Date.now();
      const kind=event.type||event.event;
      if(turn.traceId){
        trace(turn,'first_event');
        if(kind==='init'||kind==='system'&&event.subtype==='init')trace(turn,'session_init');
        const streamed=kind==='stream_event'?event.event:null;
        const blocks=kind==='assistant'?event.message?.content:null;
        const block=streamed?.content_block;
        if(block?.type==='tool_use'||blocks?.some?.(item=>item?.type==='tool_use'))trace(turn,'first_tool');
        if(block?.type==='thinking'||blocks?.some?.(item=>item?.type==='thinking'))trace(turn,'first_thinking');
        if(streamed?.delta?.type==='text_delta'||blocks?.some?.(item=>item?.type==='text'&&item.text))trace(turn,'first_reply');
        if(kind==='result')trace(turn,'result');
      }
      const info=describeStreamProgress(event);
      if(info)turn.writeProgress(info.step,info.text,info.delta);
      if(provider==='claude'&&event.type==='assistant'&&!event.parent_tool_use_id&&Array.isArray(event.message?.content)){
        for(const block of event.message.content){
          if(block?.type==='text'&&block.text){turn.flushInterim();turn.pendingInterim=block.text;}
          else if(block?.type==='tool_use'||block?.type==='thinking')turn.flushInterim();
        }
      }
      if(provider==='agy'&&(event.type==='step_update'||event.event==='step_update')){
        const su=(event.event==='step_update'&&event.step_update&&typeof event.step_update==='object')?event.step_update:event;
        const stepIdx=su.step_index??event.step_index??null;
        if(stepIdx!==null&&turn.agyStepIndex!==null&&stepIdx!==turn.agyStepIndex)turn.flushInterim();
        if(stepIdx!==null)turn.agyStepIndex=stepIdx;
        const st=String(su.step_type||'').toLowerCase();
        if(su.tool_info?.name||su.tool_name||st.includes('tool')||st.includes('command')||st.includes('think')||st.includes('reason'))turn.flushInterim();
        else if(info?.text){
          if(info.delta)turn.pendingInterim+=info.text;
          else{if(turn.pendingInterim&&info.text!==turn.pendingInterim&&!info.text.startsWith(turn.pendingInterim))turn.flushInterim();turn.pendingInterim=info.text;}
        }
        if(String(su.status||event.status||'').toUpperCase()==='DONE'&&turn.pendingInterim)turn.flushInterim();
      }
      if(kind==='result')turn.pendingInterim='';
      if(kind==='error'||event.error)turn.failure+='\n'+(event.error?.message||event.error||event.message||'');
      if(kind==='result'){
        turn.done++;
        const res=(event.event==='result'&&event.result&&typeof event.result==='object')?event.result:event;
        if(provider==='agy'){turn.usage.turns=0;turn.usage.inputTokens=0;turn.usage.outputTokens=0;turn.usage.costUsd=0;}
        sumUsage(turn.usage,res.usage||res.token_usage||{total_cost_usd:res.total_cost_usd},provider==='agy'?(res.num_turns||turn.done):1);
        if(res.total_cost_usd&&!res.usage?.total_cost_usd)turn.usage.costUsd+=Number(res.total_cost_usd)||0;
        const ok=res.status?(res.status==='SUCCESS'||res.status==='success'):!res.is_error;
        let reply=res.response??res.result;
        if(provider==='agy'&&ok&&typeof reply==='string'&&turn.flushedInterims.length){
          let trimmed=reply.trim();
          for(const sent of turn.flushedInterims){
            if(trimmed.startsWith(sent))trimmed=trimmed.slice(sent.length).trim();
          }
          if(trimmed)reply=trimmed;
        }
        if(ok&&typeof reply==='string')turn.parts.push(reply);
        else turn.failure+='\n'+(Array.isArray(res.errors)?res.errors.join('; '):'')+' '+(res.error||res.message||res.result||res.response||res.status||res.subtype||'');
        turn.poll();
      }
    }
  });
  child.once('error',error=>{
    alive=false;
    const turn=active;
    if(turn)failTurn(turn,Object.assign(diagnoseCliFailure(provider,error,stderr),{warmReused:turnsCompleted>0}));
    onExit?.();
  });
  child.once('close',code=>{
    alive=false;
    const turn=active;
    if(turn){
      if(!persistent&&id&&turn.parts.length)finishTurn(turn);
      else failTurn(turn,Object.assign(diagnoseCliFailure(provider,turn.timedOut?{killed:true}:{code},stderr+turn.failure),{warmReused:turnsCompleted>0}));
    }
    onExit?.();
  });
  return {
    get alive(){return alive;},
    get busy(){return Boolean(active);},
    get session(){return id;},
    get turnsCompleted(){return turnsCompleted;},
    close(){alive=false;try{child.stdin.end();}catch{}const t=setTimeout(()=>{try{child.kill();}catch{}},1500);t.unref?.();},
    runTurn(prompt,options={}){
      if(!alive||active)return Promise.reject(Object.assign(Error('Warm CLI unavailable.'),{warmReused:true}));
      return new Promise((resolve,reject)=>{
        const inboxFile=options.inboxFile||null, closingFile=inboxFile?inboxFile+'.closing':null, liveFile=inboxFile?inboxFile+'.live':null;
        const writeProgress=createProgressWriter(options.progressFile);
        writeProgress(turnsCompleted>0?'대기 세션에 전달 중…':'CLI 시작 중…');
        const turn={
          traceId:provider==='claude'&&options.progressFile?child.pid+':'+(++attempts):null,
          tracePhases:new Set(),startedAt:performance.now(),resumeSession:Boolean(id),
          sent:0,done:0,offset:0,parts:[],usage:{turns:0,inputTokens:0,outputTokens:0,costUsd:0},
          failure:'',pendingInterim:'',agyStepIndex:null,flushedInterims:[],lastEvent:Date.now(),timedOut:false,closing:false,
          inboxFile,closingFile,liveFile,writeProgress,resolve,reject,
          flushInterim(){
            const text=cleanInterim(turn.pendingInterim);
            turn.pendingInterim='';
            if(!text)return;
            turn.flushedInterims.push(text);
            if(options.onInterim)try{options.onInterim(text);}catch{}
            if(options.interimFile)try{fs.appendFileSync(options.interimFile,JSON.stringify(text)+'\n');writeProgress.reset?.();}catch{}
          },
          pull(source){
            if(!source||!fs.existsSync(source))return;
            const data=fs.readFileSync(source);
            if(data.length<=turn.offset)return;
            const fresh=data.subarray(turn.offset), end=fresh.lastIndexOf(10);
            if(end<0)return;
            turn.offset+=end+1;
            for(const line of fresh.subarray(0,end).toString('utf8').split('\n'))if(line.trim()){turn.sent++;sendPayload(JSON.parse(line));}
          },
          poll(){
            if(turn.closing||active!==turn)return;
            try{turn.pull(inboxFile);}catch(error){if(error.code==='ENOENT'){turn.closing=true;if(persistent)finishTurn(turn);else child.stdin.end();return;}}
            const stale=turn.done>0&&Date.now()-turn.lastEvent>90000;
            if(turn.done<turn.sent&&!stale)return;
            if(inboxFile){
              try{fs.renameSync(inboxFile,closingFile);}catch(error){if(error.code==='ENOENT'){turn.closing=true;if(persistent)finishTurn(turn);else child.stdin.end();}return;}
              try{turn.pull(closingFile);}catch{}
              if(turn.done<turn.sent&&!stale){try{fs.renameSync(closingFile,inboxFile);}catch{turn.closing=true;if(persistent)finishTurn(turn);else child.stdin.end();}return;}
            }
            turn.closing=true;
            if(persistent)finishTurn(turn);
            else{clearInterval(turn.poller);if(liveFile)fs.rmSync(liveFile,{force:true});child.stdin.end();}
          }
        };
        active=turn;
        turn.poller=setInterval(()=>turn.poll(),300);
        turn.killer=setTimeout(()=>{turn.timedOut=true;child.kill();},1800000);
        if(liveFile)fs.writeFileSync(liveFile,'1');
        turn.sent++;
        trace(turn,'request_sent');
        sendPayload(prompt);
      });
    }
  };
}
function createAcpHost(file,prefix,project,session,model,effort,options={},onExit=null){
  const child=spawn(file,[...prefix,'acp','--stdio'],{cwd:project,windowsHide:true,env:cliEnv()});
  let nextId=1, buf='', stderr='', alive=true, turnsCompleted=0, sessionId=session||null, active=null;
  const pending=new Map();
  const send=(msg)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\n');
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    if(!alive)return reject(Error('ACP process closed.'));
    const id=nextId++;
    pending.set(id,{resolve,reject});
    send({id,method,params});
  });
  const ready=(async()=>{
    await rpc('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'agent-room',version:'0.2.40'}});
    send({method:'initialized',params:{}});
    let res=null;
    if(sessionId){
      try{res=await rpc('session/resume',{sessionId,cwd:project,mcpServers:[]});}catch{sessionId=null;}
    }
    if(!res){
      res=await rpc('session/new',{cwd:project,mcpServers:[]});
    }
    sessionId=res?.sessionId||sessionId;
    if(!sessionId)throw Error('ACP session initialization failed.');
    const permission=options.permission||'dev';
    const modeId=permission==='chat'?'plan':permission==='edit'?'accept-edits':'default';
    try{await rpc('session/set_mode',{sessionId,modeId});}
    catch(error){if(permission==='chat')throw Error('대화 모드(plan) 권한 적용에 실패해 실행을 중단했습니다: '+(error?.message||error));}
    if(model)try{await rpc('session/set_model',{sessionId,modelId:model});}catch{}
    return sessionId;
  })();
  ready.catch(()=>{});
  child.stdin.on('error',()=>{});
  child.stderr.on('data',c=>{stderr=(stderr+c).slice(-8000);});
  child.stdout.on('data',chunk=>{
    buf+=chunk;
    for(let at=buf.indexOf('\n');at>=0;at=buf.indexOf('\n')){
      const line=buf.slice(0,at).trim();buf=buf.slice(at+1);
      if(!line)continue;
      let msg;try{msg=JSON.parse(line);}catch{continue;}
      if(msg.id!==undefined&&!msg.method){
        const req=pending.get(msg.id);
        if(!req)continue;
        pending.delete(msg.id);
        if(msg.error)req.reject(Object.assign(Error(msg.error.message||'ACP error'),{acpCode:msg.error.code}));
        else req.resolve(msg.result);
        continue;
      }
      if(msg.method==='session/request_permission'&&msg.id!==undefined){
        if(active)active.lastActivity=Date.now();
        const p=msg.params||{}, tc=p.toolCall||{}, opts=Array.isArray(p.options)?p.options:[];
        const handler=active?.onApproval||options.onApproval;
        Promise.resolve(handler?handler({tool:tc.title||tc.kind||'Tool',kind:tc.kind||'other',input:tc.rawInput||{},locations:tc.locations||[]}):'allow_once')
          .then(decision=>{
            const pick=decision==='allow_always'
              ?(opts.find(o=>o.kind==='allow_always')||opts.find(o=>o.kind==='allow_once'))
              :decision==='allow_once'
                ?(opts.find(o=>o.kind==='allow_once')||opts.find(o=>o.kind==='allow_always'))
                :opts.find(o=>o.kind==='reject_once'||o.kind==='reject_always');
            send({id:msg.id,result:{outcome:pick?{outcome:'selected',optionId:pick.optionId}:{outcome:'cancelled'}}});
          })
          .catch(()=>send({id:msg.id,result:{outcome:{outcome:'cancelled'}}}));
        continue;
      }
      if(msg.method==='session/update'&&active){
        active.lastActivity=Date.now();
        const u=msg.params?.update||{};
        const kind=u.sessionUpdate||u.type||'';
        if(kind==='agent_thought_chunk'){
          if(active.pendingInterim)active.flushInterim();
          active.writeProgress('생각 중…');
        }
        else if(kind==='agent_message_chunk'){
          const txt=u.content?.text||'';
          if(txt){
            if(active.needsGap&&active.text&&!/\n$/.test(active.text)&&!/^\n/.test(txt))active.text+='\n\n';
            active.needsGap=false;
            active.text+=txt;active.pendingInterim+=txt;active.writeProgress('답변 작성 중…',txt,true);
          }
        }else if(kind==='tool_call'||kind==='tool_call_update'){
          if(active.text)active.needsGap=true;
          if(kind==='tool_call')active.flushInterim();
          active.writeProgress(toolLabel(u.title||u.kind,u.rawInput));
        }
      }
    }
  });
  const failAll=err=>{
    for(const req of pending.values())req.reject(err);
    pending.clear();
  };
  child.once('error',err=>{alive=false;failAll(Object.assign(diagnoseCliFailure('agy',err,stderr),{warmReused:turnsCompleted>0}));onExit?.();});
  child.once('close',code=>{alive=false;failAll(Object.assign(diagnoseCliFailure('agy',{code},stderr),{warmReused:turnsCompleted>0}));onExit?.();});
  return {
    get alive(){return alive;},
    get busy(){return Boolean(active);},
    get session(){return sessionId;},
    get turnsCompleted(){return turnsCompleted;},
    close(){alive=false;try{child.stdin.end();}catch{}const t=setTimeout(()=>{try{child.kill();}catch{}},1500);t.unref?.();},
    async runTurn(prompt,turnOpts={}){
      if(!alive||active)throw Object.assign(Error('Warm ACP unavailable.'),{warmReused:true});
      const writeProgress=createProgressWriter(turnOpts.progressFile);
      writeProgress(turnsCompleted>0?'대기 세션에 전달 중…':'CLI 시작 중…');
      await ready;
      const liveFile=turnOpts.inboxFile?turnOpts.inboxFile+'.live':null;
      const turn={
        text:'',pendingInterim:'',emittedInterim:false,lastActivity:Date.now(),writeProgress,onApproval:turnOpts.onApproval,
        flushInterim(){
          const t=cleanInterim(turn.pendingInterim);
          turn.pendingInterim='';
          if(!t)return;
          turn.emittedInterim=true;
          if(turnOpts.onInterim)try{turnOpts.onInterim(t);}catch{}
        }
      };
      active=turn;
      if(liveFile)try{fs.writeFileSync(liveFile,'1');}catch{}
      let watchdog;
      try{
        const promptPromise=rpc('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]});
        const timeoutPromise=new Promise((_,reject)=>{
          watchdog=setInterval(()=>{
            if(Date.now()-turn.lastActivity>5*60*1000){
              clearInterval(watchdog);
              alive=false;
              try{child.kill();}catch{}
              reject(diagnoseCliFailure('agy',{killed:true},'ACP turn timed out after 5 minutes of inactivity'));
            }
          },15000);
          watchdog.unref?.();
        });
        const res=await Promise.race([promptPromise,timeoutPromise]);
        turnsCompleted++;
        const reply=(turn.emittedInterim?turn.pendingInterim.trim():turn.text.trim())||'[[AGENT_ROOM_NO_REPLY]]';
        if(/^\s*⚠?\s*(?:third-party quota reached|quota reached)/i.test(reply))throw diagnoseCliFailure('agy',null,reply);
        return {id:sessionId,reply,usage:{turns:1,inputTokens:0,outputTokens:0,costUsd:0},stopReason:res?.stopReason};
      }catch(err){
        throw Object.assign(err.cliCode?err:diagnoseCliFailure('agy',err,stderr),{warmReused:turnsCompleted>0});
      }finally{
        clearInterval(watchdog);
        active=null;
        if(liveFile)fs.rmSync(liveFile,{force:true});
        if(turnOpts.inboxFile)fs.rmSync(turnOpts.inboxFile,{force:true});
      }
    }
  };
}
function runStreamLive(provider,file,prefix,args,project,prompt,session,inboxFile,progressFile,interimFile){
  const host=createStreamHost(provider,file,prefix,args,project,session,false);
  return host.runTurn(prompt,{inboxFile,progressFile,interimFile});
}
const warmPool=new Map();
const warmJudgePool=new Map();
const warmIdleMs=30*60*1000;
function invalidateWarm(participant){
  const entry=warmPool.get(participant);
  if(!entry)return;
  warmPool.delete(participant);
  clearTimeout(entry.idleTimer);
  entry.host.close();
  if(entry.cleanupApproval)try{entry.cleanupApproval();}catch{}
}
function invalidateWarmJudge(room){
  const entry=warmJudgePool.get(room);
  if(!entry)return;
  warmJudgePool.delete(room);
  clearTimeout(entry.idleTimer);
  entry.host.close();
}
function closeAllWarm(){
  for(const participant of [...warmPool.keys()])invalidateWarm(participant);
  for(const room of [...warmJudgePool.keys()])invalidateWarmJudge(room);
}
function ensureWarmJudge(room,project,provider='codex',model=null,effort=null){
  if(module.exports.runCodex!==runCodex||!project||!fs.existsSync(project))return null;
  const cfgKey=JSON.stringify([project,provider,model||'',effort||'']);
  let entry=warmJudgePool.get(room);
  if(entry&&(!entry.host.alive||entry.cfgKey!==cfgKey)){
    invalidateWarmJudge(room);
    entry=null;
  }
  if(!entry){
    const [file,...prefix]=cliCommand(provider);
    if(!file||!fs.existsSync(file))return null;
    const onClosed=()=>{
      const cur=warmJudgePool.get(room);
      if(cur&&cur.host===host){
        warmJudgePool.delete(room);
        clearTimeout(cur.idleTimer);
      }
    };
    let host;
    if(provider==='codex'){
      const args=[...prefix,'-c','sandbox_mode="read-only"'];
      if(process.platform==='win32'&&(process.env.AGENT_ROOM_CODEX_SANDBOX||cliSettings().codexSandbox)==='mxc')args.push('-c','windows.sandbox="mxc"');
      host=require('./codex-app-server.cjs').createWarmJudgeHost({file,args,project,env:cliEnv(),model,effort,onClosed});
    }else if(provider==='claude'||provider==='agy'){
      host=createStreamHost(provider,file,prefix,buildStreamArgs(provider,null,model,effort,{rank:true}),project,null,true,onClosed);
    }else return null;
    entry={host,cfgKey,idleTimer:null};
    warmJudgePool.set(room,entry);
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer=setTimeout(()=>invalidateWarmJudge(room),warmIdleMs);
  entry.idleTimer.unref?.();
  return entry;
}
function prewarmJudge(room,project,provider='codex',model=null,effort=null){
  try{ensureWarmJudge(room,project,provider,model,effort);}catch{}
}
async function runWarmJudge(room,project,prompt,provider='codex',model=null,effort=null){
  if(module.exports.runCodex!==runCodex){
    return module.exports.runCodex(project,prompt,null,provider,model,effort,{rank:true});
  }
  const entry=ensureWarmJudge(room,project,provider,model,effort);
  if(entry&&entry.host.alive&&!entry.host.busy){
    try{
      const result=await entry.host.runTurn(prompt,{rank:true});
      if(provider!=='codex'){
        // Claude/agy stream hosts keep one conversation, so every judgement would pile up in
        // the same context. Retire the used host and start a clean spare for the next request.
        invalidateWarmJudge(room);
        setImmediate(()=>prewarmJudge(room,project,provider,model,effort));
        return result;
      }
      if(entry.host.alive){
        clearTimeout(entry.idleTimer);
        entry.idleTimer=setTimeout(()=>invalidateWarmJudge(room),warmIdleMs);
        entry.idleTimer.unref?.();
      }
      return result;
    }catch{
      invalidateWarmJudge(room);
    }
  }
  return module.exports.runCodex(project,prompt,null,provider,model,effort,{rank:true});
}
async function runWarmTurn(participant,project,prompt,session,provider,model=null,effort=null,options={}){
  if((provider!=='claude'&&provider!=='agy')||options.rank)return runCodex(project,prompt,session,provider,model,effort,options);
  const useAcp=provider==='agy'&&(options.permission||'dev')!=='full'&&typeof options.onApproval==='function';
  const cfgKey=JSON.stringify([project,provider,model||'',effort||'',options.permission||'dev',useAcp?'acp':'stream']);
  let entry=warmPool.get(participant);
  if(entry&&(!entry.host.alive||entry.host.busy||entry.cfgKey!==cfgKey||(session&&entry.host.session&&entry.host.session!==session))){
    invalidateWarm(participant);
    entry=null;
  }
  if(!entry){
    const [file,...prefix]=cliCommand(provider);
    const onClosed=()=>{
      const cur=warmPool.get(participant);
      if(cur&&cur.host===host){
        warmPool.delete(participant);
        clearTimeout(cur.idleTimer);
        if(cur.cleanupApproval)try{cur.cleanupApproval();}catch{}
      }
    };
    const host=useAcp
      ?createAcpHost(file,prefix,project,session,model,effort,options,onClosed)
      :createStreamHost(provider,file,prefix,buildStreamArgs(provider,session,model,effort,options),project,session,true,onClosed);
    entry={host,cfgKey,idleTimer:null,cleanupApproval:options.cleanupApproval||null};
    warmPool.set(participant,entry);
  }
  clearTimeout(entry.idleTimer);
  try{
    const result=await entry.host.runTurn(prompt,options);
    if(entry.host.alive){
      entry.idleTimer=setTimeout(()=>invalidateWarm(participant),warmIdleMs);
      entry.idleTimer.unref?.();
    }
    return result;
  }catch(error){
    const wasReused=Boolean(error?.warmReused);
    invalidateWarm(participant);
    if(wasReused)return runCodex(project,prompt,session,provider,model,effort,options);
    throw error;
  }
}
async function runCodex(project, prompt, session, provider='codex',model=null,effort=null,options={}) {
  const claude=provider==='claude';
  const agy=provider==='agy';
  const name=agy?'Antigravity':claude?'Claude Code':'Codex';
  const [file,...prefix]=cliCommand(provider);
  const codexArgs=session?['exec','resume','--json','--skip-git-repo-check',session,'-']:['exec','--json','--skip-git-repo-check','-'];
  if(provider==='codex'&&process.platform==='win32'&&(process.env.AGENT_ROOM_CODEX_SANDBOX||cliSettings().codexSandbox)==='mxc')codexArgs.unshift('-c','windows.sandbox="mxc"');
  const permission=options.permission||'dev';
  if(options.rank||permission==='chat')codexArgs.splice(-1,0,'--sandbox','read-only');
  const claudeArgs=['--print','--output-format','json','--permission-mode',(options.rank||permission==='chat')?'plan':permission==='full'?'bypassPermissions':'acceptEdits',...(session?['--resume',session]:[])];
  if(options.rank)claudeArgs.push('--tools','','--no-session-persistence','--strict-mcp-config');
  else{
    if(permission==='chat')claudeArgs.push('--allowedTools','Read,Glob,Grep,WebSearch,WebFetch');
    else if(permission==='dev')claudeArgs.push('--allowedTools',devAllowedTools);
    if(permission!=='full'&&options.approvalConfig)claudeArgs.push('--mcp-config',options.approvalConfig,'--permission-prompt-tool','mcp__agent-room-approval__permission_prompt');
  }
  const agyPerm=(options.rank||permission==='chat')?['--mode','plan']:permission==='full'?['--dangerously-skip-permissions']:['--mode',permission==='edit'?'accept-edits':'auto'];
  const agyArgs=['-p',prompt,'--output-format','json',...agyPerm,...(session?['--conversation',session]:[]),'--print-timeout',options.rank?'24s':'285s'];
  if(model){codexArgs.splice(-1,0,'--model',model);claudeArgs.push('--model',model);agyArgs.push('--model',model);}
  if(effort){
    codexArgs.splice(-1,0,'-c','model_reasoning_effort='+JSON.stringify(effort));
    claudeArgs.push('--effort',effort);
    agyArgs.push('--effort',effort);
  }
  if(claude&&!options.rank&&options.inboxFile){
    claudeArgs[2]='stream-json';
    claudeArgs.push('--input-format','stream-json','--verbose');
    return runStreamLive('claude',file,prefix,claudeArgs,project,prompt,session,options.inboxFile,options.progressFile,options.interimFile);
  }
  if(agy&&!options.rank&&options.inboxFile){
    const liveArgs=['--input-format','stream-json','--output-format','stream-json',...agyPerm,...(session?['--conversation',session]:[]),'--print-timeout','1800s'];
    if(model)liveArgs.push('--model',model);
    if(effort)liveArgs.push('--effort',effort);
    return runStreamLive('agy',file,prefix,liveArgs,project,prompt,session,options.inboxFile,options.progressFile,options.interimFile);
  }
  const writeProgress=createProgressWriter(options.progressFile);
  const createCodexInterim=(interimFile)=>{
    let pending='',last='';
    const flush=()=>{
      if(!interimFile||!pending)return;
      const clean=cleanInterim(pending);
      const raw=pending.trim();
      pending='';
      if(!clean)return;
      last=raw;
      try{fs.appendFileSync(interimFile,JSON.stringify(clean)+'\n');}catch{}
    };
    const onItem=(phase,type,text)=>{
      if(!interimFile)return;
      if(phase==='completed'&&type==='agent_message'&&text){
        if(pending)flush();
        pending=text;
      }else if((phase==='started'||phase==='completed')&&type&&type!=='agent_message'){
        flush();
      }
    };
    const isDuplicate=reply=>Boolean(last&&typeof reply==='string'&&reply.trim()===last);
    return {onItem,isDuplicate};
  };
  if(provider==='codex'&&!options.rank&&options.inboxFile){
    const args=[...prefix];
    if(codexArgs[0]==='-c')args.push(...codexArgs.slice(0,2));
    if(permission==='chat')args.push('-c','sandbox_mode="read-only"');
    const interim=createCodexInterim(options.interimFile);
    try{
      const result=await require('./codex-app-server.cjs').runAppServer({
        file,args,project,env:cliEnv(),session,prompt,model,effort,inbox:options.inboxFile,
        onItem(method,item){
          const type=item.type.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase());
          const progress=describeStreamProgress({type:method.replace('/','.'),item:{...item,type}});
          if(progress)writeProgress(progress.step,progress.text);
          const phase=method==='item/completed'?'completed':method==='item/started'?'started':'';
          interim.onItem(phase,type,item.text);
        }
      });
      if(interim.isDuplicate(result.reply))result.reply='[[AGENT_ROOM_NO_REPLY]]';
      return result;
    }catch(error){
      if(!error.beforeTurn)throw diagnoseCliFailure(provider,error,String(error.message));
    }
  }
  writeProgress('CLI 실행 중…');
  return new Promise((resolve,reject)=>{
    const interim=provider==='codex'?createCodexInterim(options.interimFile):null;
    const child=execFile(file,[...prefix,...(agy?agyArgs:claude?claudeArgs:codexArgs)],{
      cwd:project,windowsHide:true,env:cliEnv(),timeout:options.rank?25000:agy?300000:1800000,maxBuffer:8*1024*1024
    },(error,stdout,stderr)=>{
      let result;
      try {
        if(agy){
          const response=JSON.parse(stdout);
          const usage={turns:0,inputTokens:0,outputTokens:0,costUsd:0};
          sumUsage(usage,response.usage||response.token_usage||{total_cost_usd:response.total_cost_usd},1);
          if(response.status==='SUCCESS'||response.status==='success')result={id:response.conversation_id,reply:response.response,usage};
        }else if(claude){
          const response=JSON.parse(stdout);
          const usage={turns:0,inputTokens:0,outputTokens:0,costUsd:0};
          sumUsage(usage,response.usage||{total_cost_usd:response.total_cost_usd},1);
          if(response.total_cost_usd&&!response.usage?.total_cost_usd)usage.costUsd+=Number(response.total_cost_usd)||0;
          if(!response.is_error)result={id:response.session_id,reply:response.result,usage};
        }else{
          result=parseCodex(stdout,session);
          if(interim?.isDuplicate(result?.reply)){
            result.reply='[[AGENT_ROOM_NO_REPLY]]';
          }
        }
      }catch{}
      const diagnostic=(stderr||'')+'\n'+stdout;
      const incomplete=error||!result?.id||typeof result.reply!=='string'||!result.reply.trim();
      const detected=diagnoseCliFailure(provider,error,diagnostic);
      if(incomplete)return reject(detected);
      const toolFailure=provider==='codex'&&(
        diagnoseCliFailure(provider,null,(stderr||'')+'\n'+(result.toolDiagnostics||'')).cliCode==='windows_runtime'||
        /^Failed to create unified exec process: app runtime provisioning service/i.test(result.reply.trim())
      );
      if(toolFailure){
        const issue=diagnoseCliFailure(provider,null,'app runtime provisioning service');
        result.issue={code:issue.cliCode,message:issue.message};
      }
      delete result.toolDiagnostics;
      resolve(result);
    });
    if(provider==='codex'&&(options.progressFile||options.interimFile)){
      let codexBuf='';
      child.stdout?.on('data',chunk=>{
        codexBuf+=chunk;
        for(let at=codexBuf.indexOf('\n');at>=0;at=codexBuf.indexOf('\n')){
          const line=codexBuf.slice(0,at);codexBuf=codexBuf.slice(at+1);
          try{
            const ev=JSON.parse(line);
            const info=describeStreamProgress(ev);
            if(info)writeProgress(info.step,info.text);
            if(interim){
              const phase=ev.type==='item.completed'?'completed':ev.type==='item.started'?'started':'';
              interim.onItem(phase,ev.item?.type,ev.item?.text);
            }
          }catch{}
        }
      });
    }
    child.stdin.on('error',()=>{});
    child.stdin.end(agy?undefined:prompt);
  });
}


function discoverModels(project,provider){
  const [file,...prefix]=cliCommand(provider);
  if(provider==='agy')return new Promise((resolve,reject)=>{
    execFile(file,[...prefix,'models'],{cwd:project,timeout:20000,windowsHide:true,maxBuffer:1024*1024},(error,stdout,stderr)=>{
      if(error)return reject(Error(/sign in|not logged in/i.test(stderr)?'Antigravity CLI에 로그인한 뒤 다시 확인하세요.':'Antigravity 모델 목록을 가져오지 못했어요.'));
      const models=stdout.split(/\r?\n/).flatMap(line=>{
        const [id,label]=line.trim().split('\t');
        return id&&label?[{id,label}]:[];
      });
      resolve(models);
    });
  });
  const claude=provider==='claude';
  const args=claude?['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence']:['app-server'];
  return new Promise((resolve,reject)=>{
    const child=require('node:child_process').spawn(file,[...prefix,...args],{cwd:project,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const reader=require('node:readline').createInterface({input:child.stdout});
    let done=false, requestId=2;
    const models=[];
    const finish=(error)=>{
      if(done)return;
      done=true;clearTimeout(timer);reader.close();child.kill();
      if(error)reject(error);else resolve(models);
    };
    const timer=setTimeout(()=>finish(Error('CLI 모델 목록 응답 시간이 초과됐어요.')),15000);
    const send=data=>child.stdin.write(JSON.stringify(data)+'\n');
    child.stdin.on('error',()=>{});
    child.once('error',()=>finish(Error('CLI 실행 파일을 찾거나 실행할 수 없어요.')));
    child.once('exit',()=>finish(Error('모델 목록을 받기 전에 CLI가 종료됐어요.')));
    reader.on('line',line=>{
      let event;try{event=JSON.parse(line);}catch{return;}
      if(claude){
        if(event.type!=='control_response'||event.response?.request_id!=='models')return;
        const list=event.response.response?.models;
        if(!Array.isArray(list))return finish(Error('Claude Code 모델 목록을 가져오지 못했어요.'));
        for(const item of list)if(item.value)models.push({id:item.value,label:item.displayName||item.value});
        return finish();
      }
      if(event.id===1){
        if(event.error)return finish(Error('Codex app-server를 초기화하지 못했어요.'));
        send({method:'initialized'});
        send({id:requestId,method:'model/list',params:{limit:50}});
      }else if(event.id===requestId){
        if(!Array.isArray(event.result?.data))return finish(Error('Codex 모델 목록을 가져오지 못했어요.'));
        for(const item of event.result.data){const id=item.model||item.id;if(id)models.push({id,label:item.displayName||id});}
        if(event.result.nextCursor&&models.length<500)send({id:++requestId,method:'model/list',params:{limit:50,cursor:event.result.nextCursor}});
        else finish();
      }
    });
    if(claude)send({type:'control_request',request_id:'models',request:{subtype:'initialize'}});
    else send({id:1,method:'initialize',params:{clientInfo:{name:'agent-room',version:appVersion}}});
  });
}

module.exports={runCodex,runWarmTurn,prewarmJudge,runWarmJudge,invalidateWarm,invalidateWarmJudge,closeAllWarm,refreshCodexLimits,refreshAgyLimits,discoverModels,diagnoseCliFailure,cliCommand};
