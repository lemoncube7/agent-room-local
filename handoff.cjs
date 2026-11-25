'use strict';
function createHandoff({db,all,one,run,member,notify}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_tasks (
      id INTEGER PRIMARY KEY, room TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      next TEXT NOT NULL, owner TEXT, offered_to TEXT, status TEXT NOT NULL,
      revision INTEGER NOT NULL, updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handoff_room ON handoff_tasks(room,id);
    CREATE TABLE IF NOT EXISTS handoff_history (
      id INTEGER PRIMARY KEY, task INTEGER NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL
    );
  `);
  const hasCol=name=>all('PRAGMA table_info(handoff_tasks)').some(c=>c.name===name);
  if(!hasCol('verifier'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN verifier TEXT');
  if(!hasCol('done_when'))db.exec("ALTER TABLE handoff_tasks ADD COLUMN done_when TEXT NOT NULL DEFAULT ''");
  if(!hasCol('files'))db.exec("ALTER TABLE handoff_tasks ADD COLUMN files TEXT NOT NULL DEFAULT ''");
  const now=()=>new Date().toISOString();
  const fail=text=>{throw Error(text);};
  function field(value,max,required=false){
    if(typeof value!=='string'||value.length>max||required&&!value.trim())fail('Check the task title, notes, and next action.');
    return value.trim();
  }
  const list=room=>room
    ?all('SELECT * FROM handoff_tasks WHERE room=? ORDER BY id DESC LIMIT 200',room)
    :all('SELECT * FROM handoff_tasks ORDER BY id DESC');
  function history(id,room){
    if(!one('SELECT id FROM handoff_tasks WHERE id=? AND room=?',id,room))fail('Task is not in this room.');
    return all('SELECT action,actor,note,created FROM handoff_history WHERE task=? ORDER BY id DESC LIMIT 100',id);
  }
  function change(input,actor,room){
    const {action}=input;
    const human=actor==='human:'+room;
    if(!one('SELECT id FROM rooms WHERE id=?',room))fail('Room not found.');
    if(!human)member(actor,room);
    if(action==='handoff_list')return {tasks:list(room)};
    if(action==='handoff_history')return {events:history(input.id,room)};
    const note=field(input.note??'',2000);
    db.exec('BEGIN IMMEDIATE');
    try{
      let id=input.id;
      let overrodeInactiveOwner=false;
      if(action==='handoff_create'){
        const owner=human?(input.target?member(input.target,room).id:null):actor;
        const verifier=input.verifier?member(input.verifier,room).id:null;
        const doneWhen=field(input.doneWhen??'',1000);
        const files=field(input.files??'',1000);
        id=Number(run("INSERT INTO handoff_tasks(room,title,summary,next,owner,verifier,done_when,files,status,revision,updated) VALUES(?,?,?,?,?,?,?,?,'open',1,?)",room,
          field(input.title,120,true),field(input.summary??'',8000),field(input.next,2000,true),owner,verifier,doneWhen,files,now()).lastInsertRowid);
      }else{
        const row=one('SELECT * FROM handoff_tasks WHERE id=? AND room=?',id,room);
        if(!row)fail('Task is not in this room.');
        if(row.revision!==input.revision)fail('Task changed. Reload and try again.');
        if(row.status==='done')fail('This task is complete.');
        if(['handoff_accept','handoff_decline'].includes(action)){
          if(row.status!=='offered'||(!human&&row.offered_to!==actor))fail('Only the receiving participant can respond to this handoff.');
          if(action==='handoff_accept')member(row.offered_to,room);
          run("UPDATE handoff_tasks SET owner=?,offered_to=NULL,status='open' WHERE id=?",action==='handoff_accept'?row.offered_to:row.owner,id);
        }else{
          const isVerifier=Boolean(row.verifier&&row.verifier===actor);
          const ownerActive=Boolean(row.owner&&one("SELECT 1 FROM members WHERE id=? AND state='approved'",row.owner));
          if(!human&&row.owner!==actor&&ownerActive&&!(action==='handoff_complete'&&isVerifier))fail('Only the task owner can make this change.');
          overrodeInactiveOwner=!human&&row.owner!==actor&&!ownerActive;
          if(action==='handoff_offer'){
            if(row.status!=='open')fail('This task already has a pending handoff.');
            const target=member(input.target,room);
            if(target.id===row.owner)fail('Choose another participant.');
            const next=field(input.next??row.next,2000,true);
            run("UPDATE handoff_tasks SET offered_to=?,status='offered',next=? WHERE id=?",target.id,next,id);
            notify(room,target.id,id,row.title,next,row.revision+1);
          }else if(action==='handoff_update'){
            const verifier=input.verifier===undefined?row.verifier:(input.verifier?member(input.verifier,room).id:null);
            run('UPDATE handoff_tasks SET title=?,summary=?,next=?,verifier=?,done_when=?,files=? WHERE id=?',field(input.title??row.title,120,true),
              field(input.summary??row.summary,8000),field(input.next??row.next,2000,true),verifier,field(input.doneWhen??row.done_when??'',1000),field(input.files??row.files??'',1000),id);
          }else if(action==='handoff_complete'){
            if(!['open','verifying'].includes(row.status))fail('Resolve the handoff before completing the task.');
            if(row.status==='open'&&row.verifier&&row.verifier!==row.owner&&!human&&!isVerifier){
              run("UPDATE handoff_tasks SET status='verifying' WHERE id=?",id);
              notify(room,row.verifier,id,'[검증 요청] '+row.title,row.done_when||row.next,row.revision+1);
            }else{
              run("UPDATE handoff_tasks SET status='done' WHERE id=?",id);
            }
          }else fail('Unknown handoff action.');
        }
        run('UPDATE handoff_tasks SET revision=revision+1,updated=? WHERE id=?',now(),id);
      }
      run('INSERT INTO handoff_history(task,action,actor,note,created) VALUES(?,?,?,?,?)',id,action,actor,(overrodeInactiveOwner?'[inactive owner override] ':'')+note,now());
      db.exec('COMMIT');
      return {task:one('SELECT * FROM handoff_tasks WHERE id=?',id)};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {list,change};
}
module.exports={createHandoff};
