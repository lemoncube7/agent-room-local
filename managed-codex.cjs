'use strict';
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function cliSettings(){
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname,'local','cli.json'),'utf8').replace(/^\uFEFF/,''));
  } catch (error) {
    if(error.code!=='ENOENT')throw error;
    return {};
  }
}
function cliCommand(provider) {
  const env=process.env['AGENT_ROOM_'+provider.toUpperCase()];
  const saved=cliSettings();
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA,'npm','node_modules') : null;
  const defaults = provider==='claude'
    ? [path.join(os.homedir(),'.local','bin','claude.exe'), npm && path.join(npm,'@anthropic-ai','claude-code','cli.js')]
    : provider==='agy'?[process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'agy','bin','agy.exe')]:[npm && path.join(npm,'@openai','codex','bin','codex.js')];
  const executable = env || [saved?.[provider],...defaults].find(candidate=>candidate&&fs.existsSync(candidate));
  if(executable && /\.(?:cjs|mjs|js)$/i.test(executable))return [process.execPath, executable];
  return [executable || provider];
}

function parseCodex(stdout, session) {
  const events = stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return {
    toolDiagnostics: events.filter(event=>event.type==='item.completed'&&event.item?.type==='command_execution'&&event.item.exit_code!==0).map(event=>event.item.aggregated_output||'').join('\n'),
    id: session || events.find(event => event.type === 'thread.started')?.thread_id,
    reply: events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
      .map(event => event.item.text).filter(Boolean).at(-1)
  };
}

function diagnoseCliFailure(provider,error,diagnostic){
  const name={codex:'Codex',claude:'Claude Code',agy:'Antigravity'}[provider]||'CLI';
  const failure=(code,message,action)=>Object.assign(new Error(name+' · '+message+' '+action),{cliCode:code});
  if(/app runtime provisioning service|failed to create unified exec process|appx.*provision/i.test(diagnostic))
    return failure('windows_runtime','Windows에서 작업 명령을 실행하는 환경이 시작되지 않았어요.','기존 데스크톱 대화를 연결하거나 독립 CLI 설치를 확인하세요.');
  if(/oauth.{0,35}(?:expired|refresh)|failed to authenticate|not logged in|please log in|authentication failed|not authenticated|login required/i.test(diagnostic))
    return failure('auth_expired','로그인이 만료됐거나 인증에 실패했어요.',provider==='claude'?'터미널에서 claude auth login을 실행한 뒤 다시 보내세요.':provider==='codex'?'터미널에서 codex login을 실행한 뒤 다시 보내세요.':'Antigravity를 열어 로그인한 뒤 다시 보내세요.');
  if(/rate limit|resource_exhausted|usage limit|quota exceeded|(?:http|status)s*429/i.test(diagnostic))
    return failure('usage_limit','요청 또는 사용량 한도에 걸렸어요.','한도 초기화 후 다시 시도하거나 사용 가능한 모델을 선택하세요.');
  if(/model.{0,100}(?:invalid|not available|not found|not supported)|invalid model/i.test(diagnostic))
    return failure('model_unavailable','선택한 모델을 사용할 수 없어요.','모델 목록에서 다른 모델을 선택하세요.');
  if(error?.code==='ENOENT')return failure('cli_missing','실행 파일이나 작업 폴더를 찾지 못했어요.','CLI를 설치하고 시작 화면에서 프로젝트를 다시 선택하세요.');
  if(['EACCES','EPERM'].includes(error?.code))return failure('access_denied','Windows가 CLI 실행을 차단했어요.','실행 파일과 프로젝트 폴더의 접근 권한을 확인하세요.');
  if(error?.killed||/timed out|timeout/i.test(diagnostic))return failure('timeout','제한 시간 안에 응답이 오지 않았어요.','CLI에서 네트워크와 장시간 작업 여부를 확인한 뒤 다시 시도하세요.');
  if(/econn|enotfound|tls handshake|network connection|unable to connect/i.test(diagnostic))
    return failure('network','CLI가 서비스에 연결하지 못했어요.','인터넷 연결을 확인한 뒤 다시 시도하세요.');
  if(/untrusted|trust this (?:project|folder)|workspace trust/i.test(diagnostic))
    return failure('project_trust','CLI가 프로젝트 신뢰 확인을 요청했어요.','터미널에서 같은 폴더를 열고 신뢰 여부를 확인하세요.');
  const suffix=typeof error?.code==='number'?' (종료 코드 '+error.code+')':'';
  return failure('unknown','CLI에서 완성된 응답을 받지 못했어요'+suffix+'.','같은 프로젝트에서 CLI를 직접 열어 오류를 확인하세요.');
}

const devCommands=['node','npm','git status','git diff','git log','git show','git add','git commit','git branch','git fetch'];
const devAllowedTools=['Bash','PowerShell'].flatMap(tool=>devCommands.map(command=>tool+'('+command+':*)')).join(',');
function runCodex(project, prompt, session, provider='codex',model=null,effort=null,options={}) {
  const claude=provider==='claude';
  const agy=provider==='agy';
  const name=agy?'Antigravity':claude?'Claude Code':'Codex';
  const [file,...prefix]=cliCommand(provider);
  const codexArgs=session?['exec','resume','--json','--skip-git-repo-check',session,'-']:['exec','--json','--skip-git-repo-check','-'];
  if(provider==='codex'&&process.platform==='win32'&&(process.env.AGENT_ROOM_CODEX_SANDBOX||cliSettings().codexSandbox)==='mxc')codexArgs.unshift('-c','windows.sandbox="mxc"');
  if(options.rank)codexArgs.splice(-1,0,'--sandbox','read-only');
  const permission=options.permission||'dev';
  const claudeArgs=['--print','--output-format','json','--permission-mode',options.rank?'plan':permission==='full'?'bypassPermissions':'acceptEdits',...(session?['--resume',session]:[])];
  if(options.rank)claudeArgs.push('--tools','','--no-session-persistence','--strict-mcp-config');
  else{
    if(permission==='dev')claudeArgs.push('--allowedTools',devAllowedTools);
    if(permission!=='full'&&options.approvalConfig)claudeArgs.push('--mcp-config',options.approvalConfig,'--permission-prompt-tool','mcp__agent-room-approval__permission_prompt');
  }
  const agyArgs=['-p',prompt,'--output-format','json',...(session?['--conversation',session]:[]),'--print-timeout','285s'];
  if(model){codexArgs.splice(-1,0,'--model',model);claudeArgs.push('--model',model);agyArgs.push('--model',model);}
  if(effort){
    codexArgs.splice(-1,0,'-c','model_reasoning_effort='+JSON.stringify(effort));
    claudeArgs.push('--effort',effort);
    agyArgs.push('--effort',effort);
  }
  return new Promise((resolve,reject)=>{
    const child=execFile(file,[...prefix,...(agy?agyArgs:claude?claudeArgs:codexArgs)],{
      cwd:project,windowsHide:true,timeout:options.rank?25000:300000,maxBuffer:8*1024*1024
    },(error,stdout,stderr)=>{
      let result;
      try {
        if(agy){
          const response=JSON.parse(stdout);
          if(response.status==='SUCCESS'||response.status==='success')result={id:response.conversation_id,reply:response.response};
        }else if(claude){
          const response=JSON.parse(stdout);
          if(!response.is_error)result={id:response.session_id,reply:response.result};
        }else result=parseCodex(stdout,session);
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
    else send({id:1,method:'initialize',params:{clientInfo:{name:'agent-room',version:'0.2.20'}}});
  });
}

module.exports={runCodex,discoverModels,diagnoseCliFailure};
