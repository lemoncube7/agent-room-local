'use strict';
function createHandoff({db,all,one,run,member,notify,checkEditor=()=>{},nodesForRoom=()=>[]}){
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
  if(!hasCol('offered_node'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN offered_node TEXT');
  if(!hasCol('owner_node'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN owner_node TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS handoff_changes ON handoff_history(task,id);
    CREATE TABLE IF NOT EXISTS mesh_task_copy(room TEXT,source TEXT,task INTEGER,change_id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room,source,task));`);
  if(!hasCol('mesh_uid'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN mesh_uid TEXT');
  if(!hasCol('mesh_run'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN mesh_run TEXT');
  db.exec("UPDATE handoff_tasks SET mesh_uid=lower(hex(randomblob(16))) WHERE mesh_uid IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS handoff_uid ON handoff_tasks(mesh_uid)");
  if(!hasCol('run_on_accept'))db.exec('ALTER TABLE handoff_tasks ADD COLUMN run_on_accept INTEGER NOT NULL DEFAULT 0');
  const runKey=uid=>uid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
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
  function change(input,actor,room,onCreate){
    const {action}=input;
    checkEditor(room,action);
    const human=actor==='human:'+room;
    if(!one('SELECT id FROM rooms WHERE id=?',room))fail('Room not found.');
    if(!human)member(actor,room);
    if(action==='handoff_list')return {tasks:list(room)};
    if(action==='handoff_history')return {events:history(input.id,room)};
    const node=input.ownerNode===undefined?undefined:field(input.ownerNode||'',80)||null;
    if(node&&!nodesForRoom(room).some(n=>n.node_id===node))fail('The selected PC is no longer registered in this room.');
    let note=field(input.note??'',2000);
    db.exec('BEGIN IMMEDIATE');
    try{
      let id=input.id;
      let overrodeInactiveOwner=false;
      if(action==='handoff_restore'){
        if(!human)fail('Only a room owner can restore a task copy.');
        const copy=one('SELECT data FROM mesh_task_copy WHERE room=? AND source=? AND task=?',room,field(input.source,80,true),id);
        if(!copy)fail('Task copy not found.');
        const t=JSON.parse(copy.data);
        if(t.revision!==input.revision||!t.mesh_uid)fail('Refresh the task copy before restoring.');
        if(copies(room).some(other=>other.mesh_uid===t.mesh_uid&&other.revision>t.revision))fail('A newer synchronized copy is available.');
        const existing=one('SELECT id,revision FROM handoff_tasks WHERE mesh_uid=? AND room=?',t.mesh_uid,room);
        if(existing)fail('This task already exists here as #'+existing.id+'.');
        id=Number(run("INSERT INTO handoff_tasks(room,title,summary,next,done_when,files,status,revision,updated,mesh_uid) VALUES(?,?,?,?,?,?,?,?,?,?)",room,t.title,t.summary,t.next,t.done_when||'',t.files||'',t.status==='done'?'done':'open',t.revision+1,now(),t.mesh_uid).lastInsertRowid);
        note='복구 원본 '+input.source+' #'+t.id+' · 개정 '+t.revision+' · 이전 상태 '+t.status+' · 이전 담당 '+(t.owner_name||'미배정');
      }else if(action==='handoff_create'){
        const resolveMemberId=ref=>{try{return member(ref,room).id;}catch{const byName=one("SELECT id FROM members WHERE room=? AND name=? AND state='approved'",room,String(ref||'').trim());if(!byName)throw Error('Target participant is not in this room.');return byName.id;}};
        const owner=input.target?resolveMemberId(input.target):(human?null:actor);
        const verifier=input.verifier?resolveMemberId(input.verifier):null;
        const doneWhen=field(input.doneWhen??'',1000);
        const files=field(input.files??'',1000);
        id=Number(run("INSERT INTO handoff_tasks(room,title,summary,next,owner,verifier,done_when,files,status,revision,updated) VALUES(?,?,?,?,?,?,?,?,'open',1,?)",room,
          field(input.title,120,true),field(input.summary??'',8000),field(input.next,2000,true),owner,verifier,doneWhen,files,now()).lastInsertRowid);
        onCreate?.(id,owner);
      }else{
        const row=one('SELECT * FROM handoff_tasks WHERE id=? AND room=?',id,room);
        if(!row)fail('Task is not in this room.');
        if(row.revision!==input.revision)fail('Task changed. Reload and try again.');
        if(row.status==='done')fail('This task is complete.');
        if(row.status==='verifying'&&!human&&row.verifier!==actor)fail('Awaiting the assigned verifier.');
        if(action==='handoff_update'&&row.status!=='open')fail('Resolve the pending handoff or verification before editing.');
        if(['handoff_accept','handoff_decline'].includes(action)){
          if(row.status!=='offered'||(!human&&row.offered_to!==actor))fail('Only the receiving participant can respond to this handoff.');
          if(action==='handoff_accept')member(row.offered_to,room);
          run("UPDATE handoff_tasks SET owner=?,owner_node=?,offered_to=NULL,offered_node=NULL,status='open' WHERE id=?",action==='handoff_accept'?row.offered_to:row.owner,action==='handoff_accept'?row.offered_node??row.owner_node:row.owner_node,id);
        }else{
          const isVerifier=Boolean(row.verifier&&row.verifier===actor);
          const ownerActive=Boolean(row.owner&&one("SELECT 1 FROM members WHERE id=? AND state='approved'",row.owner));
          if(!human&&row.owner!==actor&&ownerActive&&!(action==='handoff_complete'&&isVerifier))fail('Only the task owner can make this change.');
          overrodeInactiveOwner=!human&&row.owner!==actor&&!ownerActive;
          if(overrodeInactiveOwner&&action==='handoff_update')run('UPDATE handoff_tasks SET owner=? WHERE id=?',actor,id);
          if(action==='handoff_schedule'){
            if(!human||row.status!=='open'||!row.owner_node||!row.owner||row.mesh_run)fail('Assign an owner and PC to an open, unscheduled task first.');
            run('UPDATE handoff_tasks SET mesh_run=? WHERE id=?',runKey(row.mesh_uid),id);
          }else if(action==='handoff_offer'){
            if(row.status!=='open')fail('This task already has a pending handoff.');
            const target=member(input.target,room);
            if(target.id===row.owner)fail('Choose another participant.');
            const next=field(input.next??row.next,2000,true);
            run("UPDATE handoff_tasks SET offered_to=?,offered_node=?,run_on_accept=?,status='offered',next=? WHERE id=?",target.id,node??row.owner_node,human&&input.runOnAccept===true?1:0,next,id);
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
        if(action!=='handoff_schedule')run('UPDATE handoff_tasks SET mesh_run=? WHERE id=?',action==='handoff_accept'&&row.run_on_accept&&(row.offered_node||row.owner_node)?runKey(row.mesh_uid):null,id);
        run('UPDATE handoff_tasks SET revision=revision+1,updated=? WHERE id=?',now(),id);
      }
      run('UPDATE handoff_tasks SET mesh_uid=lower(hex(randomblob(16))) WHERE id=? AND mesh_uid IS NULL',id);
      if(node!==undefined&&['handoff_create','handoff_update'].includes(action)){
        run('UPDATE handoff_tasks SET owner_node=? WHERE id=?',node,id);
        note=[note,'담당 PC: '+(node||'미지정')].filter(Boolean).join(' · ');
      }
      run('INSERT INTO handoff_history(task,action,actor,note,created) VALUES(?,?,?,?,?)',id,action,actor,(overrodeInactiveOwner?'[inactive owner override] ':'')+note,now());
      db.exec('COMMIT');
      return {task:one('SELECT * FROM handoff_tasks WHERE id=?',id)};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function changes(room,after=0){
    return all(`SELECT t.*,MAX(h.id) AS change_id,o.name AS owner_name,v.name AS verifier_name,p.name AS offered_name
      FROM handoff_tasks t JOIN handoff_history h ON h.task=t.id
      LEFT JOIN members o ON o.id=t.owner LEFT JOIN members v ON v.id=t.verifier LEFT JOIN members p ON p.id=t.offered_to
      WHERE t.room=? GROUP BY t.id HAVING MAX(h.id)>? ORDER BY change_id LIMIT 20`,room,after);
  }
  const copyCursor=(room,source)=>one('SELECT MAX(change_id) AS n FROM mesh_task_copy WHERE room=? AND source=?',room,source)?.n||0;
  function saveCopies(room,source,rows){
    if(!Array.isArray(rows)||rows.length>20)fail('Invalid task snapshot.');
    for(const task of rows){
      if(task.room!==room||!Number.isSafeInteger(task.id)||task.id<1||!Number.isSafeInteger(task.change_id)||task.change_id<1||!Number.isSafeInteger(task.revision)||task.revision<1)fail('Invalid task snapshot.');
      run(`INSERT INTO mesh_task_copy(room,source,task,change_id,data) VALUES(?,?,?,?,?)
        ON CONFLICT(room,source,task) DO UPDATE SET change_id=excluded.change_id,data=excluded.data
        WHERE excluded.change_id>mesh_task_copy.change_id`,room,source,task.id,task.change_id,JSON.stringify(task));
    }
  }
  function copies(room){
    const rows=room?all('SELECT source,data FROM mesh_task_copy WHERE room=? ORDER BY change_id DESC',room):all('SELECT source,data FROM mesh_task_copy ORDER BY change_id DESC');
    return rows.map(r=>({...JSON.parse(r.data),source:r.source}));
  }
  return {list,change,changes,copyCursor,saveCopies,copies};
}
module.exports={createHandoff};
