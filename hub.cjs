'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {runCodex} = require('./managed-codex.cjs');
const {spawn}=require('node:child_process');
const version=fs.readFileSync(path.join(__dirname,'VERSION'),'utf8').trim();
const {randomUUID, randomBytes, timingSafeEqual} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const local = path.join(__dirname,'local');
fs.mkdirSync(local,{recursive:true});
const db = new DatabaseSync(path.join(local,'rooms.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,room TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,since INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, room TEXT NOT NULL,author TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL, UNIQUE(author,request));
  CREATE TABLE IF NOT EXISTS room_codes(code TEXT PRIMARY KEY,room TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,parent TEXT NOT NULL,room TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER NOT NULL,member TEXT NOT NULL,state TEXT NOT NULL, PRIMARY KEY(seq,member));
`);
const all = (sql,...args)=>db.prepare(sql).all(...args);
const one = (sql,...args)=>db.prepare(sql).get(...args);
const run = (sql,...args)=>db.prepare(sql).run(...args);
if(!db.prepare('PRAGMA table_info(members)').all().some(column=>column.name==='parent')) db.exec('ALTER TABLE members ADD COLUMN parent TEXT');
if(!db.prepare('PRAGMA table_info(messages)').all().some(column=>column.name==='recipient')) db.exec('ALTER TABLE messages ADD COLUMN recipient TEXT');
db.exec('CREATE TABLE IF NOT EXISTS cli_sessions(member TEXT PRIMARY KEY, project TEXT NOT NULL, thread TEXT)');
if(!all('PRAGMA table_info(cli_sessions)').some(column=>column.name==='provider')) db.exec("ALTER TABLE cli_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'");
if(!all('PRAGMA table_info(cli_sessions)').some(column=>column.name==='model'))db.exec('ALTER TABLE cli_sessions ADD COLUMN model TEXT');
const providerNames={codex:'Codex CLI',claude:'Claude Code CLI',agy:'Antigravity'};
run("UPDATE members SET state='start_failed' WHERE state IN ('starting','approved') AND id IN (SELECT member FROM cli_sessions WHERE thread IS NULL)");
run("UPDATE deliveries SET state='uncertain' WHERE state IN ('submitting','working') AND member IN (SELECT member FROM cli_sessions)");
if(!all('PRAGMA table_info(messages)').some(column=>column.name==='relay_root'))db.exec('ALTER TABLE messages ADD COLUMN relay_root INTEGER');
const cliBusy=new Set();
let draining=false, updating=false, updaterProcess;
const outbox=path.join(local,'outbox');
const updateLog=path.join(local,'update.log');
fs.mkdirSync(outbox,{recursive:true});
function storeMessage(room,author,body,root=null,recipient=null){
  return Number(run('INSERT INTO messages(room,author,request,body,created,relay_root,recipient) VALUES(?,?,?,?,?,?,?)',
    room,author,randomUUID(),body,new Date().toISOString(),root,recipient).lastInsertRowid);
}
function queueForRoom(room,author,seq,recipient=null){
  run("INSERT INTO deliveries(seq,member,state) SELECT ?,members.id,'queued' FROM members JOIN cli_sessions ON cli_sessions.member=members.id WHERE room=? AND state='approved' AND members.id<>? AND (? IS NULL OR members.id=?)",seq,room,author,recipient,recipient);
}
async function cliTurn(participant, prompt, inputSeq){
  const session=one('SELECT * FROM cli_sessions WHERE member=?',participant);
  const row=one("SELECT room,state FROM members WHERE id=? AND state IN ('approved','starting')",participant);
  if(!session||!row||cliBusy.has(participant))return;
  cliBusy.add(participant);
  const input=inputSeq?one('SELECT relay_root,author,recipient FROM messages WHERE seq=?',inputSeq):null;
  try{
    if(inputSeq)run("UPDATE deliveries SET state='working' WHERE seq=? AND member=?",inputSeq,participant);
    const peers=all("SELECT id,name FROM members WHERE room=? AND state='approved' AND id<>?",row.room,participant);
    const context='You are in a shared Agent Room chat. Your normal response goes to the whole room. Keep the default so other agents can follow progress. Only when a specific reply really needs a single recipient, put [[TO:participant-id]] on its own first line, using an exact ID from this room roster: '+JSON.stringify(peers)+'. Never invent a reply from another agent.';
    const audience=!input?'This is the first turn.':input.author.startsWith('human:')?'The user posted to the whole room.':'Another agent posted to the whole room.';
    const replyPolicy='Only reply when addressed, asked to do work, or when you can contribute a useful answer. If it is FYI, meant for someone else, or no useful reply is needed, respond exactly [[AGENT_ROOM_NO_REPLY]]. Avoid courtesy acknowledgments and unnecessary agent-to-agent chatter.';
    const history=all("SELECT members.name,messages.body FROM messages JOIN members ON members.id=messages.author WHERE messages.room=? AND (messages.recipient IS NULL OR messages.recipient=? OR messages.author=?) AND messages.seq<? ORDER BY messages.seq DESC LIMIT 10",row.room,participant,participant,inputSeq??0).reverse();
    const result=await runCodex(session.project,context+' '+audience+' '+replyPolicy+'\nRecent shared room messages (context only): '+JSON.stringify(history.map(message=>({name:message.name,body:message.body.slice(0,800)})))+'\n\n'+prompt,session.thread,session.provider,session.model);
    const match=result.reply.trim().match(/^\[\[TO:([^\]\r\n]+)\]\]\s*\r?\n([\s\S]*)$/);
    const recipient=match&&peers.some(peer=>peer.id===match[1])?match[1]:null;
    const body=recipient?match[2].trim():result.reply.trim();
    const silent=!body||body==='[[AGENT_ROOM_NO_REPLY]]';
    run('UPDATE cli_sessions SET thread=? WHERE member=?',result.id,participant);
    if(row.state==='starting')run("UPDATE members SET state='approved' WHERE id=? AND state='starting'",participant);
    if(!silent&&one("SELECT id FROM members WHERE id=? AND state='approved'",participant)){
      const root=input?.relay_root??inputSeq??null;
      const count=root?one('SELECT COUNT(*) AS count FROM messages WHERE relay_root=?',root).count:0;
      db.exec('BEGIN');
      try{
        const seq=storeMessage(row.room,participant,body,root,recipient);
        if(root&&count<4)queueForRoom(row.room,participant,seq,recipient);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    if(inputSeq)run('UPDATE deliveries SET state=? WHERE seq=? AND member=?',silent?'no_reply':'answered',inputSeq,participant);
  }catch(error){
    if(row.state==='starting')run("UPDATE members SET state='start_failed' WHERE id=? AND state='starting'",participant);
    if(inputSeq)run("UPDATE deliveries SET state='failed' WHERE seq=? AND member=?",inputSeq,participant);
    storeMessage(row.room,participant,error.message);
  }finally{cliBusy.delete(participant);}
}
async function checkUpdate(){
  const response=await fetch('https://api.github.com/repos/lemoncube7/agent-room-local/releases?per_page=20',{
    headers:{Accept:'application/vnd.github+json','User-Agent':'Agent-Room'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('GitHub에서 업데이트를 확인하지 못했어요 ('+response.status+').');
  const newer=(a,b)=>{
    const x=a.split('.').map(Number),y=b.split('.').map(Number);
    return x.findIndex((n,i)=>n!==y[i])>=0 && x[x.findIndex((n,i)=>n!==y[i])]>y[x.findIndex((n,i)=>n!==y[i])];
  };
  const releases=(await response.json()).filter(item=>!item.draft&&/^v\d+\.\d+\.\d+$/.test(item.tag_name));
  const latest=releases.reduce((best,item)=>!best||newer(item.tag_name.slice(1),best.tag_name.slice(1))?item:best,null);
  const available=Boolean(latest&&newer(latest.tag_name.slice(1),version));
  const tag=latest?.tag_name;
  const zip=latest?.assets.find(asset=>asset.name==='Agent-Room-'+tag+'-Windows.zip');
  return {version,available,latest:tag,download:available&&zip?'https://github.com/lemoncube7/agent-room-local/releases/download/'+tag+'/'+zip.name:null};
}
const token = randomBytes(32).toString('hex');
const str = (value,max)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max) throw Error('Invalid text input.');
  return value.trim();
};
function member(id,room){
  const result=one("SELECT * FROM members WHERE id=? AND room=? AND state='approved'",id,room);
  if(!result) throw Error('Approve this participant in the room first.');
  if(result.parent&&!one("SELECT id FROM members WHERE id=? AND room=? AND state='approved'",result.parent,room)) throw Error('The parent participant is disconnected.');
  return result;
}
function task({action,room,participant,name,text,request,replyTo,after=0}){
  if(action==='list_rooms') return {rooms:all('SELECT * FROM rooms ORDER BY rowid')};
  if(action==='join_room_code'){
    const code=str(request,100).toUpperCase();
    const match=one('DELETE FROM room_codes WHERE code=? AND expires>? RETURNING room',code,Date.now());
    if(!match) throw Error('This room code expired or was already used.');
    const id=randomUUID();
    run("INSERT INTO members(id,room,name,state) VALUES(?,?,?,'pending')",id,match.room,str(name,50));
    return {room:match.room,participant:id,state:'pending'};
  }
  if(action==='request_join'){
    if(!one('SELECT id FROM rooms WHERE id=?',room)) throw Error('Room not found.');
    const id=randomUUID();
    run("INSERT INTO members(id,room,name,state) VALUES(?,?,?,'pending')",id,room,str(name,50));
    return {participant:id,state:'pending'};
  }
  if(action==='join_subagent'){
    const invite=one('DELETE FROM invites WHERE token=? AND expires>? RETURNING parent,room,name',str(request,100),Date.now());
    if(!invite) throw Error('Invitation is expired or already used.');
    member(invite.parent,invite.room);
    const id=randomUUID();
    run("INSERT INTO members(id,room,name,state,parent) VALUES(?,?,?,'pending',?)",id,invite.room,invite.name,invite.parent);
    return {room:invite.room,participant:id,state:'pending'};
  }
  const author=member(participant,room);
  if(action==='invite_subagent'){
    if(author.parent) throw Error('Only a primary participant can invite a subagent.');
    const invitation=randomBytes(24).toString('hex');
    const expires=Date.now()+600000;
    run('DELETE FROM invites WHERE expires<=?',Date.now());
    run('INSERT INTO invites VALUES(?,?,?,?,?)',invitation,author.id,room,str(name,50),expires);
    return {invitation,expires:new Date(expires).toISOString()};
  }
  if(action==='read_messages'){
    if(!Number.isSafeInteger(after)||after<0) throw Error('Invalid cursor.');
    return {messages:all('SELECT messages.seq,name AS author,body,created,recipient IS NOT NULL AS direct FROM messages JOIN members ON members.id=messages.author WHERE messages.room=? AND seq>? AND (recipient IS NULL OR recipient=? OR messages.author=?) ORDER BY seq LIMIT 100',room,after,author.id,author.id)};
  }
  if(!['send_message','reply_direct'].includes(action)) throw Error('Unknown tool.');
  const key=str(request,100), body=str(text,8000);
  const existing=one('SELECT seq,room,body FROM messages WHERE author=? AND request=?',author.id,key);
  if(existing){
    if(existing.room!==room||existing.body!==body)throw Error('Request ID already used for different input.');
    return {seq:existing.seq};
  }
  db.exec('BEGIN');
  try{
    const result=run('INSERT INTO messages(room,author,request,body,created) VALUES(?,?,?,?,?)',room,author.id,key,body,new Date().toISOString());
    const seq=Number(result.lastInsertRowid);
    queueForRoom(room,author.id,seq);
    db.exec('COMMIT');
    return {seq};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function state(){
  return {version,updateStatus:fs.existsSync(updateLog)?fs.readFileSync(updateLog,'utf8').trim().split(/\r?\n/).at(-1):null,rooms:all('SELECT * FROM rooms ORDER BY rowid'),
    members:all("SELECT members.id,room,name,state,parent,cli_sessions.provider,cli_sessions.model FROM members LEFT JOIN cli_sessions ON cli_sessions.member=members.id WHERE state<>'human'").map(row=>({...row,busy:cliBusy.has(row.id)})),
    messages:all('SELECT messages.*,members.name FROM messages JOIN members ON messages.author=members.id ORDER BY seq'),
    deliveries:all('SELECT deliveries.seq,deliveries.member,members.name,deliveries.state FROM deliveries JOIN members ON deliveries.member=members.id')};
}
function deliver(args){
  const target=member(args.participant,args.room);
  if(args.action==='pending') return all(`
    SELECT m.seq,a.name author,m.body,m.recipient IS NOT NULL AS direct FROM messages m
    JOIN members a ON a.id=m.author
    LEFT JOIN deliveries d ON d.seq=m.seq AND d.member=?
    WHERE m.room=? AND m.author<>? AND m.seq>? AND (m.recipient IS NULL OR m.recipient=?) AND d.seq IS NULL ORDER BY m.seq LIMIT 10
  `,target.id,target.room,target.id,Math.max(target.since,args.after),target.id);
  if(!Number.isSafeInteger(args.seq)||!one('SELECT seq FROM messages WHERE seq=? AND room=? AND author<>? AND (recipient IS NULL OR recipient=?)',args.seq,target.room,target.id,target.id)) throw Error('Invalid delivery.');
  if(args.action==='claim'){
    const result=run("INSERT OR IGNORE INTO deliveries VALUES(?,?,'submitting')",args.seq,target.id);
    return {claimed:result.changes===1};
  }
  if(!['accepted','uncertain','failed'].includes(args.state)) throw Error('Invalid delivery state.');
  run("UPDATE deliveries SET state=? WHERE seq=? AND member=? AND state='submitting'",args.state,args.seq,target.id);
  return {ok:true};
}
function dispatchQueuedTurns(){
  if(draining)return;
  const rows=all("SELECT deliveries.seq,deliveries.member,messages.body,messages.relay_root,messages.author,authors.name AS sender FROM deliveries JOIN messages USING(seq) JOIN members AS authors ON authors.id=messages.author JOIN members ON members.id=deliveries.member WHERE deliveries.state='queued' AND members.state='approved' ORDER BY deliveries.seq");
  for(const row of rows){
    if(cliBusy.has(row.member))continue;
    run("UPDATE deliveries SET state='submitting' WHERE seq=? AND member=?",row.seq,row.member);
    const prompt='Message from '+row.sender+' in the room:\n'+row.body;
    void cliTurn(row.member,prompt,row.seq);
  }
}
function drainOutbox(){
  for(const name of fs.readdirSync(outbox).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))){
    const filename=path.join(outbox,name);
    try {
      const data=JSON.parse(fs.readFileSync(filename,'utf8'));
      if(!['send_message','reply_direct'].includes(data.action))continue;
      task(data);
      fs.rmSync(filename,{force:true});
    } catch(error) {
      if(error.code!=='ENOENT')console.error('Agent Room outbox entry retained:',name,error.message);
    }
  }
}
function authorized(req){
  const a=Buffer.from(req.headers.authorization||''), b=Buffer.from('Bearer '+token);
  return a.length===b.length&&timingSafeEqual(a,b);
}
const server=http.createServer(async(req,res)=>{
  const origin='http://127.0.0.1:'+server.address().port;
  if(req.headers.host!==new URL(origin).host) return res.writeHead(403).end();
  if(req.method==='GET'&&req.url==='/'){
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(fs.readFileSync(path.join(__dirname,'index.html')));
  }
  if(req.method==='GET'&&req.url==='/state'){
    return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(state()));
  }
  const browser = req.url==='/control';
  if(req.method!=='POST'||(!browser&&!['/tool','/delivery','/shutdown_for_update'].includes(req.url))) return res.writeHead(404).end();
  if(browser?req.headers.origin!==origin:!authorized(req)) return res.writeHead(403).end();
  try{
    const chunks=[]; let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>32768)return res.writeHead(413).end();chunks.push(chunk);}
    const args=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(req.url==='/shutdown_for_update'){
      if(draining||cliBusy.size)return res.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Agent Room is busy. Wait for the active reply before updating.'}));
      draining=true;
      drainOutbox();
      res.writeHead(200).end('Ready');
      updaterProcess?.unref();
      server.close(()=>db.close());
      return;
    }
    let result;
    if(browser){
      if(args.action==='create')run('INSERT INTO rooms VALUES(?,?)',randomUUID(),str(args.name,70));
      else if(args.action==='check_update')result=await checkUpdate();
      else if(args.action==='apply_update'){
        if(process.platform!=='win32')throw Error('자동 설치는 Windows에서 사용할 수 있어요.');
        if(updating)throw Error('이미 업데이트를 준비하고 있어요.');
        if(cliBusy.size)throw Error('CLI 답변이 끝난 후 업데이트해 주세요.');
        const update=await checkUpdate();
        if(!update.download||update.latest!==args.tag)throw Error('업데이트를 다시 확인해 주세요.');
        fs.writeFileSync(updateLog,'업데이트 프로그램을 시작하는 중…\n');
        const log=fs.openSync(updateLog,'a');
        const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        let worker;
        try{worker=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'update.ps1'),'-Tag',update.latest,'-HubId',String(process.pid),'-NodePath',process.execPath],{detached:true,stdio:['ignore',log,log],windowsHide:true});}
        finally{fs.closeSync(log);}
        updating=true;
        updaterProcess=worker;
        worker.once('exit',(code,signal)=>{
          updating=false;
          updaterProcess=undefined;
          if(code!==0)fs.appendFileSync(updateLog,'\n업데이트 실패 (종료 상태 '+(signal??code)+'). Windows ZIP으로 다시 시도해 주세요.\n');
        });
        try{await new Promise((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject);});}
        catch(error){updating=false;fs.appendFileSync(updateLog,'업데이트 실패: '+error.message+'\n');throw error;}
        result={started:true};
      }
      else if(['new_agent','new_codex','new_claude'].includes(args.action)){
        if(draining)throw Error('업데이트 중이에요. 잠시 후 다시 시도하세요.');
        if(!one('SELECT id FROM rooms WHERE id=?',args.room))throw Error('Room not found.');
        const activeProject=path.join(local,'project.txt');
        const project=process.env.AGENT_ROOM_PROJECT||(fs.existsSync(activeProject)?fs.readFileSync(activeProject,'utf8').trim():null);
        if(!project||!fs.existsSync(path.join(project,'.codex','config.toml')))throw Error('시작 파일에서 프로젝트를 선택하고 이 방을 다시 열어 주세요.');
        const id=randomUUID(), provider=args.action==='new_agent'?args.provider:args.action==='new_claude'?'claude':'codex';
        if(!Object.hasOwn(providerNames,provider))throw Error('Unknown agent provider.');
        const model=args.model?.trim()?str(args.model,120):null;
        const name=args.name?.trim()?str(args.name,120):model||providerNames[provider];
        run("INSERT INTO members(id,room,name,state) VALUES(?,?,?,'starting')",id,args.room,name);
        run('INSERT INTO cli_sessions(member,project,provider,model) VALUES(?,?,?,?)',id,project,provider,model);
        run("INSERT OR IGNORE INTO members(id,room,name,state) VALUES(?,?,?,'human')",'human:'+args.room,args.room,'나');
        void cliTurn(id,'You are connected to Agent Room. Briefly say hello in Korean. Do not change any project files.');
      }
      else if(args.action==='edit_agent'){
        if(cliBusy.has(args.participant))throw Error('답변이 끝난 뒤 에이전트 설정을 변경하세요.');
        const agent=one("SELECT provider FROM cli_sessions JOIN members ON members.id=cli_sessions.member WHERE member=? AND room=? AND state='approved'",args.participant,args.room);
        if(!agent)throw Error('Connected CLI agent not found.');
        const model=args.model?.trim()?str(args.model,120):null;
        const name=args.name?.trim()?str(args.name,120):model||providerNames[agent.provider];
        run('UPDATE cli_sessions SET model=? WHERE member=?',model,args.participant);
        run('UPDATE members SET name=? WHERE id=?',name,args.participant);
      }
      else if(args.action==='user_message'){
        if(draining)throw Error('업데이트 중이에요. 잠시 후 다시 시도하세요.');
        if(!one('SELECT id FROM rooms WHERE id=?',args.room))throw Error('Room not found.');
        const body=str(args.text,8000), human='human:'+args.room;
        db.exec('BEGIN');
        try{
          run("INSERT OR IGNORE INTO members(id,room,name,state) VALUES(?,?,?,'human')",human,args.room,'나');
          const seq=storeMessage(args.room,human,body);
          queueForRoom(args.room,human,seq);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        dispatchQueuedTurns();
      }
      else if(args.action==='room_code'){
        if(!one('SELECT id FROM rooms WHERE id=?',args.room))throw Error('Room not found.');
        run('DELETE FROM room_codes WHERE expires<=?',Date.now());
        const code=randomBytes(8).toString('hex').toUpperCase();
        const expires=Date.now()+600000;
        run('INSERT INTO room_codes VALUES(?,?,?)',code,args.room,expires);
        return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({code,expires}));
      }
      else if(args.action==='approve'||args.action==='disconnect'){
        const old=args.action==='approve'?'pending':one('SELECT state FROM members WHERE id=?',args.participant)?.state;
        const target=one('SELECT room,parent FROM members WHERE id=?',args.participant);
        if(args.action==='disconnect'&&!['approved','start_failed'].includes(old))throw Error('Disconnect is unavailable for this participant.');
        if(args.action==='approve'&&target?.parent)member(target.parent,target.room);
        run('UPDATE members SET state=?, since=(SELECT COALESCE(MAX(seq),0) FROM messages WHERE messages.room=members.room) WHERE id=? AND state=?',args.action==='approve'?'approved':'disconnected',args.participant,old);
        if(args.action==='disconnect'){
          run("UPDATE members SET state='disconnected' WHERE parent=?",args.participant);
          run('DELETE FROM invites WHERE parent=?',args.participant);
        }
      } else throw Error('Unknown control.');
      result??=state();
    } else result=req.url==='/tool'?task(args):deliver(args);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));
  } catch(error){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));}
});
server.listen(Number(process.env.ROOM_PORT||4317),'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(path.join(local,'hub.json'),JSON.stringify({url,token}),{mode:0o600});
  drainOutbox();
  dispatchQueuedTurns();
  setInterval(()=>{if(!draining){drainOutbox();dispatchQueuedTurns();}},1000).unref();
  console.log(url);
});
