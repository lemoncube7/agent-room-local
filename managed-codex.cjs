'use strict';
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function cliCommand(provider) {
  const env=process.env['AGENT_ROOM_'+provider.toUpperCase()];
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(__dirname,'local','cli.json'),'utf8').replace(/^\uFEFF/,''));
  } catch (error) {
    if(error.code!=='ENOENT')throw error;
  }
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
    id: session || events.find(event => event.type === 'thread.started')?.thread_id,
    reply: events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
      .map(event => event.item.text).filter(Boolean).at(-1)
  };
}

function runCodex(project, prompt, session, provider='codex',model=null,effort=null) {
  const claude=provider==='claude';
  const agy=provider==='agy';
  const name=agy?'Antigravity':claude?'Claude Code':'Codex';
  const [file,...prefix]=cliCommand(provider);
  const codexArgs=session?['exec','resume','--json','--skip-git-repo-check',session,'-']:['exec','--json','--skip-git-repo-check','-'];
  const claudeArgs=['--print','--output-format','json',...(session?['--resume',session]:[])];
  const agyArgs=['-p',prompt,'--output-format','json',...(session?['--conversation',session]:[]),'--print-timeout','285s'];
  if(model){codexArgs.splice(-1,0,'--model',model);claudeArgs.push('--model',model);agyArgs.push('--model',model);}
  if(effort){
    codexArgs.splice(-1,0,'-c','model_reasoning_effort='+JSON.stringify(effort));
    claudeArgs.push('--effort',effort);
    agyArgs.push('--effort',effort);
  }
  return new Promise((resolve,reject)=>{
    const child=execFile(file,[...prefix,...(agy?agyArgs:claude?claudeArgs:codexArgs)],{
      cwd:project,windowsHide:true,timeout:300000,maxBuffer:8*1024*1024
    },(error,stdout)=>{
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
      if(error||!result?.id||typeof result.reply!=='string'||!result.reply.trim()){
        return reject(new Error(['ENOENT','EACCES','EPERM'].includes(error?.code)
          ? name+' CLI를 실행할 수 없어요. CLI를 설치한 뒤 Agent Room 시작 창에서 프로젝트를 다시 설정하세요.'
          : name+' CLI가 답변을 완료하지 못했어요. CLI 로그인과 프로젝트 접근 설정을 확인하세요.'));
      }
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

module.exports={runCodex,discoverModels};
