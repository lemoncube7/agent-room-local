'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
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
function task({action,room,participant,name,text,request,after=0}){
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
    return {messages:all('SELECT messages.seq,name AS author,body,created FROM messages JOIN members ON members.id=messages.author WHERE messages.room=? AND seq>? ORDER BY seq LIMIT 100',room,after)};
  }
  if(action!=='send_message') throw Error('Unknown tool.');
  const key=str(request,100), body=str(text,8000);
  const existing=one('SELECT seq,room,body FROM messages WHERE author=? AND request=?',author.id,key);
  if(existing){
    if(existing.room!==room||existing.body!==body) throw Error('Request ID already used for different input.');
    return {seq:existing.seq};
  }
  const result=run('INSERT INTO messages(room,author,request,body,created) VALUES(?,?,?,?,?)',room,author.id,key,body,new Date().toISOString());
  return {seq:Number(result.lastInsertRowid)};
}
function state(){
  return {rooms:all('SELECT * FROM rooms ORDER BY rowid'),
    members:all('SELECT id,room,name,state,parent FROM members'),
    messages:all('SELECT messages.*,members.name FROM messages JOIN members ON messages.author=members.id ORDER BY seq'),
    deliveries:all('SELECT deliveries.seq,members.name,deliveries.state FROM deliveries JOIN members ON deliveries.member=members.id')};
}
function deliver(args){
  const target=member(args.participant,args.room);
  if(args.action==='pending') return all(`
    SELECT m.seq,a.name author,m.body FROM messages m
    JOIN members a ON a.id=m.author
    LEFT JOIN deliveries d ON d.seq=m.seq AND d.member=?
    WHERE m.room=? AND m.author<>? AND m.seq>? AND d.seq IS NULL ORDER BY m.seq LIMIT 10
  `,target.id,target.room,target.id,Math.max(target.since,args.after));
  if(!Number.isSafeInteger(args.seq)||!one('SELECT seq FROM messages WHERE seq=? AND room=? AND author<>?',args.seq,target.room,target.id)) throw Error('Invalid delivery.');
  if(args.action==='claim'){
    const result=run("INSERT OR IGNORE INTO deliveries VALUES(?,?,'submitting')",args.seq,target.id);
    return {claimed:result.changes===1};
  }
  if(!['accepted','uncertain','failed'].includes(args.state)) throw Error('Invalid delivery state.');
  run("UPDATE deliveries SET state=? WHERE seq=? AND member=? AND state='submitting'",args.state,args.seq,target.id);
  return {ok:true};
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
  if(req.method!=='POST'||(!browser&&!['/tool','/delivery'].includes(req.url))) return res.writeHead(404).end();
  if(browser?req.headers.origin!==origin:!authorized(req)) return res.writeHead(403).end();
  try{
    const chunks=[]; let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>32768)return res.writeHead(413).end();chunks.push(chunk);}
    const args=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result;
    if(browser){
      if(args.action==='create')run('INSERT INTO rooms VALUES(?,?)',randomUUID(),str(args.name,70));
      else if(args.action==='room_code'){
        if(!one('SELECT id FROM rooms WHERE id=?',args.room))throw Error('Room not found.');
        run('DELETE FROM room_codes WHERE expires<=?',Date.now());
        const code=randomBytes(8).toString('hex').toUpperCase();
        const expires=Date.now()+600000;
        run('INSERT INTO room_codes VALUES(?,?,?)',code,args.room,expires);
        return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({code,expires}));
      }
      else if(args.action==='approve'||args.action==='disconnect'){
        const old=args.action==='approve'?'pending':'approved';
        const target=one('SELECT room,parent FROM members WHERE id=?',args.participant);
        if(args.action==='approve'&&target?.parent)member(target.parent,target.room);
        run('UPDATE members SET state=?, since=(SELECT COALESCE(MAX(seq),0) FROM messages WHERE messages.room=members.room) WHERE id=? AND state=?',args.action==='approve'?'approved':'disconnected',args.participant,old);
        if(args.action==='disconnect'){
          run("UPDATE members SET state='disconnected' WHERE parent=?",args.participant);
          run('DELETE FROM invites WHERE parent=?',args.participant);
        }
      } else throw Error('Unknown control.');
      result=state();
    } else result=req.url==='/tool'?task(args):deliver(args);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(result));
  } catch(error){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));}
});
server.listen(Number(process.env.ROOM_PORT||4317),'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(path.join(local,'hub.json'),JSON.stringify({url,token}),{mode:0o600});
  console.log(url);
});
