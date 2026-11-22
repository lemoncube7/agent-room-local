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

function runCodex(project, prompt, session, provider='codex',model=null) {
  const claude=provider==='claude';
  const agy=provider==='agy';
  const name=agy?'Antigravity':claude?'Claude Code':'Codex';
  const [file,...prefix]=cliCommand(provider);
  const codexArgs=session?['exec','resume','--json','--skip-git-repo-check',session,'-']:['exec','--json','--skip-git-repo-check','-'];
  const claudeArgs=['--print','--output-format','json',...(session?['--resume',session]:[])];
  const agyArgs=['-p',prompt,'--output-format','json',...(session?['--conversation',session]:[]),'--print-timeout','285s'];
  if(model){codexArgs.splice(-1,0,'--model',model);claudeArgs.push('--model',model);agyArgs.push('--model',model);}
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

module.exports={runCodex};
