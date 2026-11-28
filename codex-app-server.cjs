const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');

async function runAppServer(options){
  const {file,args,project,env,session,prompt,model,effort,inbox,onItem,sandbox}=options;
  const child=spawn(file,[...args,'app-server','--listen','stdio://'],{
    cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  let nextId=0,stderr='',started=false,threadId,turnId,closing=false;
  let offset=0,poll,reply='',usage;
  const pending=new Map();
  let finish,fail;
  const finished=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  finished.catch(()=>{});
  const stop=error=>{
    if(closing)return;
    closing=true;
    for(const request of pending.values())request.reject(error);
    pending.clear();
    fail(error);
  };
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const call=(method,params)=>new Promise((resolve,reject)=>{
    const id=++nextId;
    pending.set(id,{resolve,reject});
    send({id,method,params});
  });
  child.stdout.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
  child.stdin.on('error',stop);
  child.on('error',stop);
  child.on('exit',()=>stop(Error(stderr||'Codex app-server exited.')));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let event;
    try{event=JSON.parse(line);}catch{return;}
    if(event.method&&event.id!==undefined){
      send({id:event.id,error:{code:-32601,message:'Interactive requests are unavailable in this client.'}});
      return;
    }
    const request=pending.get(event.id);
    if(request){
      pending.delete(event.id);
      if(event.error)request.reject(Object.assign(Error(event.error.message),{rpcRejected:true}));
      else request.resolve(event.result);
      return;
    }
    const data=event.params;
    if(!data||data.threadId!==threadId)return;
    const eventTurn=data.turnId??data.turn?.id;
    if(turnId&&eventTurn&&eventTurn!==turnId)return;
    if(event.method==='item/started'||event.method==='item/completed'){
      if(event.method==='item/completed'&&data.item.type==='agentMessage')reply=data.item.text;
      try{onItem(event.method,data.item);}catch(error){stop(error);}
    }
    if(event.method==='thread/tokenUsage/updated')usage=data.tokenUsage?.last;
    if(event.method==='turn/completed'){
      if(data.turn.status==='completed')finish();
      else stop(Error(data.turn.error?.message||'Codex turn '+data.turn.status));
    }
  });
  const startup=setTimeout(()=>stop(Error('Codex app-server startup timed out.')),20000);
  const timeout=setTimeout(()=>stop(Error('Codex turn timed out.')),1800000);
  const ack=(seq,state)=>fs.appendFileSync(inbox+'.ack',JSON.stringify({seq,state})+'\n');
  const pull=()=>{
    if(closing)return;
    try{
      const data=fs.readFileSync(inbox);
      const end=data.lastIndexOf(10);
      if(end<offset)return;
      const records=data.subarray(offset,end+1).toString('utf8').trimEnd().split('\n');
      offset=end+1;
      for(const line of records){
        const {seq,text}=JSON.parse(line);
        if(seq!==undefined)ack(seq,'uncertain');
        call('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text}]}).then(
          result=>{if(seq!==undefined&&result.turnId===turnId)ack(seq,'accepted');},
          error=>{if(seq!==undefined&&error.rpcRejected)ack(seq,'queued');}
        ).catch(stop);
      }
    }catch(error){stop(error);}
  };
  try{
    await call('initialize',{clientInfo:{name:'agent_room',title:'Agent Room',version:'1.0.0'}});
    send({method:'initialized'});
    const thread=await call(session?'thread/resume':'thread/start',{
      ...(session?{threadId:session}:{}),cwd:project,...(model?{model}:{}),
      // Set the sandbox on every resume: a resumed thread otherwise keeps the mode of its last turn
      // (a read-only coordination turn left Codex agents stuck read-only).
      ...(sandbox?{sandbox}:{})
    });
    threadId=thread.thread.id;
    started=true;
    const turn=await call('turn/start',{
      threadId,input:[{type:'text',text:prompt}],...(model?{model}:{}),...(effort?{effort}:{})
    });
    turnId=turn.turn.id;
    clearTimeout(startup);
    fs.writeFileSync(inbox+'.steer','',{mode:0o600});
    poll=setInterval(pull,180);
    await finished;
    return {id:threadId,reply,usage:{turns:1,inputTokens:usage?.inputTokens||0,outputTokens:usage?.outputTokens||0,costUsd:0}};
  }catch(error){
    error.beforeTurn=!started;
    throw error;
  }finally{
    closing=true;
    clearTimeout(startup);clearTimeout(timeout);clearInterval(poll);
    lines.close();
    child.kill();
    fs.rmSync(inbox+'.steer',{force:true});
  }
}

function createWarmJudgeHost({file,args,project,env,model,effort,onClosed}){
  const child=spawn(file,[...args,'app-server','--listen','stdio://'],{
    cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  let nextId=0,stderr='',closing=false,active=null;
  const pending=new Map();
  const send=message=>{if(!closing&&child.stdin.writable)child.stdin.write(JSON.stringify(message)+'\n');};
  const call=(method,params)=>new Promise((resolve,reject)=>{
    if(closing)return reject(Error('Codex warm judge closed.'));
    const id=++nextId;
    pending.set(id,{resolve,reject});
    send({id,method,params});
  });
  const close=(reason)=>{
    if(closing)return;
    closing=true;
    for(const req of pending.values())req.reject(reason||Error('Codex warm judge closed.'));
    pending.clear();
    if(active){active.reject(reason||Error('Codex warm judge closed.'));active=null;}
    lines.close();
    try{child.kill();}catch{}
    if(onClosed)try{onClosed();}catch{}
  };
  child.stdout.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
  child.stdin.on('error',err=>close(err));
  child.on('error',err=>close(err));
  child.on('exit',()=>close(Error(stderr||'Codex app-server exited.')));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let event;
    try{event=JSON.parse(line);}catch{return;}
    if(event.method&&event.id!==undefined){
      send({id:event.id,error:{code:-32601,message:'Interactive requests are unavailable in this client.'}});
      return;
    }
    const request=pending.get(event.id);
    if(request){
      pending.delete(event.id);
      if(event.error)request.reject(Object.assign(Error(event.error.message),{rpcRejected:true}));
      else request.resolve(event.result);
      return;
    }
    const data=event.params;
    if(!active||!data||data.threadId!==active.threadId)return;
    const eventTurn=data.turnId??data.turn?.id;
    if(active.turnId&&eventTurn&&eventTurn!==active.turnId)return;
    if(event.method==='item/completed'&&data.item?.type==='agentMessage')active.reply=data.item.text;
    if(event.method==='thread/tokenUsage/updated')active.usage=data.tokenUsage?.last;
    if(event.method==='turn/completed'){
      const cur=active;
      active=null;
      clearTimeout(cur.timer);
      if(data.turn?.status==='completed')cur.resolve({id:cur.threadId,reply:cur.reply,usage:{turns:1,inputTokens:cur.usage?.inputTokens||0,outputTokens:cur.usage?.outputTokens||0,costUsd:0}});
      else cur.reject(Error(data.turn?.error?.message||'Codex turn '+(data.turn?.status||'failed')));
    }
  });
  const ready=(async()=>{
    await call('initialize',{clientInfo:{name:'agent_room',title:'Agent Room',version:'1.0.0'}});
    send({method:'initialized'});
  })();
  ready.catch(()=>{});
  return {
    get alive(){return !closing&&child.exitCode===null;},
    get busy(){return Boolean(active);},
    async runTurn(prompt){
      if(closing)throw Error('Codex warm judge closed.');
      if(active)throw Error('Codex warm judge busy.');
      await ready;
      const thread=await call('thread/start',{cwd:project,...(model?{model}:{})});
      const threadId=thread.thread.id;
      return await new Promise((resolve,reject)=>{
        const cur={threadId,turnId:null,reply:'',usage:null,resolve,reject,timer:null};
        cur.timer=setTimeout(()=>{
          if(active===cur){active=null;reject(Error('Codex judge turn timed out.'));}
        },25000);
        active=cur;
        call('turn/start',{
          threadId,input:[{type:'text',text:prompt}],...(model?{model}:{}),...(effort?{effort}:{})
        }).then(t=>{
          if(active===cur)cur.turnId=t.turn.id;
        },err=>{
          clearTimeout(cur.timer);
          if(active===cur)active=null;
          reject(err);
        });
      });
    },
    close
  };
}

module.exports={runAppServer,createWarmJudgeHost};
