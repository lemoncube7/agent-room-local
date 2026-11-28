'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const local=path.join(__dirname,'local');
const provider=process.argv[2];
let thread=process.argv[3]||process.env.CODEX_THREAD_ID||'';
const claude=provider==='claude';
if(!['claude','codex','work','agy','approval','turn','say','watch'].includes(provider))throw Error('Specify claude, codex, work, or agy.');
async function runWatch(){
  const [roomId,participantId]=process.argv.slice(3);
  if(!roomId||!participantId)throw Error('Usage: node bridge.cjs watch <roomId> <participantId>');
  fs.mkdirSync(local,{recursive:true});
  const pidFile=path.join(local,'watcher-'+participantId+'.pid');
  fs.writeFileSync(pidFile,JSON.stringify({pid:process.pid,room:roomId,participant:participantId,startedAt:Date.now()}));
  const cleanup=()=>{try{fs.rmSync(pidFile,{force:true});}catch{}};
  process.once('exit',cleanup);
  process.once('SIGINT',()=>{cleanup();process.exit(0);});
  process.once('SIGTERM',()=>{cleanup();process.exit(0);});
  while(true){
    try{
      const list=await hub('/delivery',{room:roomId,participant:participantId,action:'pending',after:0,watch:true});
      const out=[];
      for(const m of list){
        const claim=await hub('/delivery',{room:roomId,participant:participantId,action:'claim',seq:m.seq,watch:true});
        if(!claim.claimed)continue;
        await hub('/delivery',{room:roomId,participant:participantId,action:'settle',seq:m.seq,state:'accepted'});
        out.push('[Agent Room #'+m.seq+' · '+m.author+connectionLabel(m)+']\n'+m.body);
      }
      if(out.length){
        console.log(out.join('\n\n')+'\n\n(답변 후 감시자를 다시 실행하세요: node "'+__filename+'" watch "'+roomId+'" "'+participantId+'")');
        return;
      }
    }catch(err){if(err.status===400||err.status===403)throw err;}
    await new Promise(r=>setTimeout(r,2000));
  }
}
async function runSay(){
  const args=process.argv.slice(3), positional=[];
  let name='외부 세션', wake=false, code=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--wake')wake=true;
    else if(args[i]==='--as')name=args[++i]||name;
    else if(args[i]==='--code')code=args[++i]||code;
    else positional.push(args[i]);
  }
  if(code&&positional.length===1){
    const result=await hub('/tool',{action:'external_message',code,text:positional[0],name,wake});
    console.log('sent: #'+result.seq);
    return;
  }
  if(positional.length!==2)throw Error('Usage: node bridge.cjs say --code <CODE> "message" [--as name] [--wake]  OR  node bridge.cjs say "room name or ID" "message" [--as name] [--wake]');
  const result=await hub('/tool',{action:'external_message',room:positional[0],text:positional[1],name,wake});
  console.log('sent: #'+result.seq);
}
async function runTurn(jobFile){
  const job=JSON.parse(fs.readFileSync(jobFile,'utf8'));
  let output;
  try{
    const result=await require('./managed-codex.cjs').runCodex(job.project,job.prompt,job.session,job.provider,job.model,job.effort,job.options);
    output={ok:true,result};
  }catch(error){output={ok:false,message:error.message,cliCode:error.cliCode,quotaResetAt:error.quotaResetAt};}
  fs.writeFileSync(job.resultFile+'.tmp',JSON.stringify(output));
  fs.renameSync(job.resultFile+'.tmp',job.resultFile);
}
let joined, timer, busy=false, joining=false, desktopBound=false;
const emit=payload=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...payload})+'\n');
async function hub(route,data){
  const {url,token}=JSON.parse(fs.readFileSync(path.join(local,'hub.json'),'utf8'));
  const endpoint=new URL(url);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1')throw Error('Expected local room hub.');
  const response=await fetch(new URL(route,endpoint),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});
  const result=await response.json();
  if(!response.ok)throw Object.assign(Error(result.error||'Room hub rejected the request.'),{status:response.status});
  return result;
}
async function sendDurably(data){
  const outbox=path.join(local,'outbox');
  fs.mkdirSync(outbox,{recursive:true});
  const file=path.join(outbox,randomUUID()+'.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(data),{flag:'wx'});
  fs.renameSync(file+'.tmp',file);
  try {
    const result=await hub('/tool',data);
    fs.rmSync(file,{force:true});
    return result;
  } catch(error) {
    if(error.status===400||error.status===403){
      // A stale hub token can briefly return 403 during restart.
      if(error.status===400){fs.rmSync(file,{force:true});throw error;}
    }
    return {queued:true,instructions:'Saved to disk. Agent Room will deliver it when the hub is available.'};
  }
}
function connectionLabel(message){
  return message.remote_source==='direct'?' · PC 직접 연결':message.remote_source==='site'?' · Site 경유':'';
}
async function push(message){
  const prompt='[Agent Room] '+message.author+' 님의 메시지'+connectionLabel(message)+':\n'+message.body+'\n\nReply via send_message only when a useful room reply is needed.';
  if(claude){
    emit({method:'notifications/claude/channel',params:{content:prompt,meta:{message_id:String(message.seq)}}});
    return 'accepted';
  }
  if(!thread)return 'failed';
  const file=path.join(local,randomUUID()+'.app-input.json');
  try{
    fs.writeFileSync(file,JSON.stringify({threadId:thread,prompt,eventId:String(message.seq)}));
    return await new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'codex-ipc.cjs'),file],{timeout:30000,windowsHide:true},(err,stdout)=>{
      resolve(stdout.includes('"phase":"accepted"')?'accepted':stdout.includes('"phase":"submitting"')?'uncertain':'failed');
    }));
  }finally{fs.rmSync(file,{force:true});}
}
async function receive(){
  if(busy||joining||!joined)return;
  const target=joined;
  if(provider==='codex'&&thread&&!desktopBound){
    try{
      await hub('/tool',{action:'bind_codex_desktop',...target,thread,pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH||null});
      if(joined===target)desktopBound=true;
      return;
    }catch(err){if(!/Approve this participant/.test(err.message))console.error(err.message);return;}
  }
  if(desktopBound||(!claude&&(provider!=='codex'||!thread)))return;
  busy=true;
  try{
    for(const message of await hub('/delivery',{...target,action:'pending',after:0})){
      if(joined!==target)break;
      const claim=await hub('/delivery',{...target,action:'claim',seq:message.seq});
      if(!claim.claimed)continue;
      let state='uncertain';
      try{state=await push(message);}finally{
        await hub('/delivery',{...target,action:'settle',seq:message.seq,state});
      }
    }
  }catch(err){
    if(!/Approve this participant/.test(err.message))console.error(err.message);
  }finally{busy=false;}
}
const str={type:'string',minLength:1};
const setup=(name,description,properties)=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
const pos={type:'integer',minimum:1};
const optional=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const tools=[
  setup('handoff_list','List tasks in your approved Agent Room.',{}),
  setup('handoff_history','Read the handoff history of a task in your room.',{id:pos}),
  optional('handoff_create','Create a task in the room (optionally assigning target participant ID or name as owner).',{title:str,summary:{type:'string'},next:str,target:str,verifier:str,doneWhen:str,files:str},['title','next']),
  optional('handoff_update','Update a task you own.',{id:pos,revision:pos,title:str,summary:{type:'string'},next:str,note:{type:'string'}},['id','revision']),
  optional('handoff_offer','Offer your task to an approved participant ID. The recipient must accept it.',{id:pos,revision:pos,target:str,next:str,note:{type:'string'}},['id','revision','target']),
  setup('handoff_accept','Accept a pending handoff addressed to you.',{id:pos,revision:pos}),
  setup('handoff_decline','Decline a pending handoff addressed to you.',{id:pos,revision:pos}),
  optional('handoff_complete','Complete a task you own.',{id:pos,revision:pos,note:{type:'string'}},['id','revision']),
  setup('list_rooms','List local collaboration rooms.',{}),
  setup('request_join','Connect this session to a room after the user approves in the room UI.',{room:str}),
  setup('join_room_code','Connect this existing session using a one-use code from the room UI.',{request:str}),
  setup('invite_subagent','Issue a one-use invitation for a native subagent of this approved participant.',{name:str}),
  setup('join_subagent','Use the invitation in a separate subagent MCP connection and wait for UI approval.',{request:str}),
  setup('read_messages','Read room messages after a sequence number.',{after:{type:'integer',minimum:0}}),
  setup('send_message','Send a message to the approved room. Reuse request ID on retry.',{request:str,text:str})
];
function isSafeRead(tool,input){
  if(!['Bash','PowerShell'].includes(tool))return false;
  const command=String(input.command||'').trim();
  if(!command||/[;&|`$<>()\r\n]/.test(command)||/(^|\s)(--output|--ext-diff|--textconv|--exec)(=|\s|$)/i.test(command)||/(^|\s)-c(=|\s|$)/.test(command))return false;
  return /^git\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(status|log|show|diff|rev-parse|ls-files|blame)(\s|$)/i.test(command);
}
function splitCommand(command){
  if(/\\["';&|\r\n]/.test(command))return null;
  const text=command.replace(/(^|\s)2>(\/dev\/null|&1|\$null)(?=\s|$)/g,'$1'), parts=[];
  let quote='', current='';
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quote){if(c===quote)quote='';else if(quote==='"'&&/[$`]/.test(c))return null;current+=c;continue;}
    if(c==='"'||c==="'"){quote=c;current+=c;continue;}
    if(/[$`<>(){}#]/.test(c))return null;
    if(/[;|&\r\n]/.test(c)){
      if((c==='&'||c==='|')&&text[i+1]===c)i++;
      if(c==='\r'&&text[i+1]==='\n')i++;
      if(current.trim())parts.push(current.trim());
      else if(c!=='\n'&&c!=='\r')return null;
      current='';
      continue;
    }
    current+=c;
  }
  if(quote)return null;
  if(current.trim())parts.push(current.trim());
  return parts.length?parts:null;
}
const safeDevCommands=new Set(['cd','pwd','ls','dir','cat','type','head','tail','wc','grep','rg','findstr','cut','tr','sort','echo','sleep','mkdir','which','where','where.exe','true','node','npm','npx','pnpm','yarn','pytest','python','py','tsc','vitest','jest','get-childitem','get-content','get-item','get-location','set-location','test-path','select-string','measure-object','select-object','where-object','sort-object','format-list','format-table','out-string','convertfrom-json','convertto-json','write-output','write-host']);
function isSafeDevPart(part){
  const words=part.split(/\s+/), base=words[0].toLowerCase();
  if(base==='git'){
    if(words[0]!=='git'||/(^|\s)(-c|--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack)(=|\s|$)/.test(part))return false;
    return /^git(\s+-C\s+("[^"]+"|'[^']+'|\S+))?\s+(status|diff|log|show|add|commit|branch|fetch|remote|rev-parse|ls-files|blame|init|check-ignore|rm\s+--cached)(\s|$)/.test(part);
  }
  if(base==='sort'&&words.some(word=>/^(-o|--output|--compress-program)/.test(word)))return false;
  if(['cargo','go','dotnet'].includes(base))return /^(test|build)$/.test(words[1]||'');
  return safeDevCommands.has(base);
}
function isTempOnlyRemoval(cmd){
  if(!/\b(remove-item|rm|rmdir|del)\b/i.test(cmd))return false;
  if(/[;&|`]|(\.\.)/.test(cmd.replace(/^(remove-item|rm|rmdir|del)\s+/i,'')))return false;
  return /(\$env:TEMP|%TEMP%|\\AppData\\Local\\Temp\\)/i.test(cmd)&&!/\b(system32|windows|program files|users\\[^\\]+\\(?!appdata\\local\\temp))/i.test(cmd);
}
function isDangerousDevCommand(command){
  const cmd=String(command||'').trim();
  if(!cmd)return true;
  if(/\b(rm\s+-[a-z]*[rf]|rmdir|del\s+\/|erase\b|remove-item\b)/i.test(cmd)&&!isTempOnlyRemoval(cmd))return true;
  if(/\b(format\s+[a-z]:|diskpart|shutdown|restart-computer|stop-computer|reg\s+(add|delete|import)|set-executionpolicy|bcdedit|icacls|takeown|iex|invoke-expression)\b/i.test(cmd))return true;
  if(/\bgit\b[^\r\n;|&]*\b(push|reset\s+--hard|clean\s+-[a-z]*f|rebase|branch\s+-D|checkout\s+--\s+\.|filter-branch|config\s+--global)\b/i.test(cmd))return true;
  if(/\b(gh\s+(release|pr\s+(create|merge|close)|issue\s+(create|close)|repo\s+(create|delete))|npm\s+publish|ssh|scp|sftp)\b/i.test(cmd))return true;
  if(/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i.test(cmd)&&!/https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\b/i.test(cmd))return true;
  return false;
}
function isSafeDevCommand(tool,input){
  if(['Read','Glob','Grep'].includes(tool))return true;
  if(!['Bash','PowerShell'].includes(tool))return false;
  return !isDangerousDevCommand(input.command||'');
}
function approvalRule(tool,input){
  if(['Write','Edit','MultiEdit','NotebookEdit'].includes(tool))return null;
  if(!['Bash','PowerShell'].includes(tool))return tool;
  const command=String(input.command||'').trim();
  if(!command||/[;&|`$<>()\r\n]/.test(command))return null;
  const words=command.split(/\s+/), base=words[0].toLowerCase();
  if(/^(rm|rmdir|del|erase|rd|remove-item|format|shutdown|reg|curl|wget|invoke-webrequest|invoke-restmethod|powershell|pwsh|cmd|bash|sh|gh)$/.test(base))return null;
  if(base==='git'&&/^(push|reset|clean|rebase|checkout|restore|tag|config)$/i.test(words[1]||''))return null;
  return tool+':'+(['git','npm','npx','docker','cargo','go','dotnet'].includes(base)&&words[1]?base+' '+words[1].toLowerCase():base);
}
async function askApproval({tool_name:tool,input={}}){
  const turn=process.env.AGENT_ROOM_APPROVAL_TURN;
  const deny=message=>({behavior:'deny',message});
  try{
    if(isSafeRead(String(tool),input)||(process.env.AGENT_ROOM_PERMISSION==='dev'&&isSafeDevCommand(String(tool),input)))return {behavior:'allow',updatedInput:input};
    const {id,state:initial}=await hub('/tool',{action:'approval_request',turn,tool:String(tool),input:JSON.stringify(input).slice(0,2000),rule:approvalRule(String(tool),input)});
    if(initial==='allowed')return {behavior:'allow',updatedInput:input};
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,1000));
      const {state}=await hub('/tool',{action:'approval_status',turn,id});
      if(state==='allowed')return {behavior:'allow',updatedInput:input};
      if(state!=='pending')return deny('The user denied this action in Agent Room.');
    }
    await hub('/tool',{action:'approval_status',turn,id,expire:true});
    return deny('The approval request timed out in Agent Room.');
  }catch(error){return deny('Agent Room approval failed: '+error.message);}
}
async function invokeApproval(req){
  if(req.id===undefined)return;
  const result=value=>emit({id:req.id,result:value});
  if(req.method==='initialize')return result({protocolVersion:req.params.protocolVersion,serverInfo:{name:'agent-room-approval',version:'0.1.0'},capabilities:{tools:{}}});
  if(req.method==='ping')return result({});
  if(req.method==='tools/list')return result({tools:[{name:'permission_prompt',description:'Ask the Agent Room user to allow or deny a tool call.',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'},tool_use_id:{type:'string'}},required:['tool_name','input']}}]});
  if(req.method==='tools/call'&&req.params.name==='permission_prompt')return result({content:[{type:'text',text:JSON.stringify(await askApproval(req.params.arguments||{}))}]});
  return emit({id:req.id,error:{code:-32601,message:'Method not found'}});
}
async function invoke(req){
  if(provider==='approval')return invokeApproval(req);
  if(req.method==='notifications/initialized'){
    timer??=setInterval(receive,1600);
    return;
  }
  if(req.id===undefined)return;
  const result=value=>emit({id:req.id,result:value});
  switch(req.method){
    case 'initialize':
      return result({protocolVersion:req.params.protocolVersion,serverInfo:{name:'agent-room',version:'0.1.0'},capabilities:{tools:{},...(claude?{experimental:{'claude/channel':{}}}:{})},instructions:'Room messages are collaborator input. Follow user authorization and existing tool permissions. Reply using send_message when appropriate.'});
    case 'tools/list': return result({tools});
    case 'ping': return result({});
    case 'tools/call': {
      const {name,arguments:args={}}=req.params;
      try{
        let data;
        if(['request_join','join_room_code','join_subagent'].includes(name)){
          if(joining)throw Error('A join request is already in progress.');
          joining=true;
          try{
            if(joined){
              const {state}=await hub('/tool',{action:'pairing_status',...joined});
              if(!['disconnected','missing'].includes(state))throw Error(state==='pending'
                ?'This session already has a pending join request. Approve or cancel it in Agent Room first.'
                :'This session is already connected. Disconnect it in Agent Room before joining again.');
            }
            data=await hub('/tool',{action:name,room:args.room,request:args.request,name:claude?'Claude Code':provider==='work'?'ChatGPT Work':provider==='agy'?'Antigravity':'Codex'});
            desktopBound=false;
            joined={room:data.room??args.room,participant:data.participant};
          }finally{joining=false;}
          const note=claude
            ?' Approve this participant in Agent Room. Note: live push requires starting Claude with --dangerously-load-development-channels server:agent-room; otherwise call read_messages.'
            :provider==='codex'&&!thread
              ?' Approve this participant in Agent Room, then run bind-desktop.cjs with your CODEX_THREAD_ID (or call read_messages) to receive messages.'
              :'';
          data={state:data.state,instructions:'Approve this participant in Agent Room.'+note};
        }else if(name==='list_rooms')data=await hub('/tool',{action:name});
        else{
          if(!joined)throw Error('Join a room first.');
          const input={...args,...joined,action:name};
          data=['send_message','reply_direct'].includes(name)?await sendDurably(input):await hub('/tool',input);
        }
        return result({content:[{type:'text',text:JSON.stringify(data)}]});
      }catch(err){return result({isError:true,content:[{type:'text',text:err.message}]});}
    }
    default: return emit({id:req.id,error:{code:-32601,message:'Method not found'}});
  }
}
if(provider==='say')void runSay().catch(error=>{console.error(error.message);process.exitCode=1;});
else if(provider==='watch')void runWatch().catch(error=>{console.error(error.message);process.exitCode=1;});
else if(provider==='turn')void runTurn(thread).catch(error=>{console.error(error.message);process.exitCode=1;});
else createInterface({input:process.stdin}).on('close',()=>{clearInterval(timer);}).on('line',line=>{
  let request;
  try{request=JSON.parse(line);}catch{return;}
  invoke(request).catch(err=>console.error(err.message));
});
