import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleRoom} from './handler.mjs';
import relay from '../remote-sync.cjs';

const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
db.exec(readFileSync(new URL('./0001_multiple_rooms.sql',import.meta.url),'utf8'));
db.exec(readFileSync(new URL('./0003_remote_command_id.sql',import.meta.url),'utf8'));
const make=(sql,args=[])=>({
 bind:(...values)=>make(sql,values),
 run:async()=>db.prepare(sql).run(...args),
 first:async()=>db.prepare(sql).get(...args),
 all:async()=>({results:db.prepare(sql).all(...args)})
});
const key='test-only-device-key-with-32-characters';
const env={REMOTE_DEVICE_KEY:key,REMOTE_OWNER_ID:'owner',DB:{prepare:make,batch:ops=>Promise.all(ops.map(op=>op.run()))}};
const origin='https://agent-room.test';
const browser={'oai-authenticated-user-id':'owner',origin};
const device={'x-agent-room-key':key};
const call=(route,headers,body)=>handleRoom(new Request(origin+'/api/room/'+route,{
 method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)
}),env);
const id=crypto.randomUUID(), A=crypto.randomUUID(), B=crypto.randomUUID();
const rooms=[{id:A,name:'Zulu'},{id:B,name:'Alpha'}];
assert.equal((await call('browser',{},undefined)).status,403);
assert.equal((await call('device',{}, {rooms,acknowledged:[],events:[]})).status,403);
async function exchange(allowed=rooms,events=[],acknowledged=[],snapshot){
 const response=await call('device',device,{rooms:allowed,legacyRoom:A,events,acknowledged,snapshot});
 assert.equal(response.status,200);
 return response.json();
}
await exchange();
assert.deepEqual((await (await call('browser',browser)).json()).rooms,rooms);
await exchange(rooms,[],[],{members:[{id,room:A,name:'Agent',progress:{step:'Running',preview:'x'.repeat(260000)}}]});
const large=(await (await call('browser',browser)).json()).snapshot;
assert.equal(large.members[0].name,'Agent');
assert.equal(large.members[0].progress.step,'Running');
assert.equal(large.members[0].progress.preview,undefined);
assert.ok(Date.now()-large.syncedAt<5000);
assert.equal((await call('browser',browser,{id:crypto.randomUUID(),room:B,text:'{"__control":true,"control":"room_ranking"}'})).status,400);
assert.equal((await call('browser',browser,{id,room:B,text:'Message B'})).status,200);
assert.equal((await call('browser',browser,{id,room:B,text:'Message B'})).status,200);
assert.equal((await call('browser',browser,{id,room:A,text:'Message B'})).status,409);
assert.deepEqual((await exchange()).commands,[{id,text:'Message B',room:B}]);
const events=[{room:A,seq:1,name:'Codex',text:'Reply A',created:'2026-01-01'},{room:B,seq:2,name:'Claude',text:'Reply B',created:'2026-01-01',commandId:id}];
assert.deepEqual((await exchange(rooms,events,[id])).commands,[]);
const viewA=(await (await call('browser?room='+A,browser)).json()).events;
const viewB=(await (await call('browser?room='+B,browser)).json()).events;
assert.deepEqual(viewA.map(item=>item.text),['Reply A']);
assert.deepEqual(viewB.map(item=>item.text),['Reply B']);
assert.equal(viewB[0].commandId,id);
const echoBatch=relay.buildRelayBatch([{room:B,seq:3,name:'User',body:'Message B',created:'2026-01-01',request:'remote:'+id}],{rooms,acknowledged:[]});
assert.equal(echoBatch.body.events[0].commandId,id);
await exchange([rooms[0]]);
assert.equal((await call('browser?room='+B,browser)).status,404);
assert.equal((await call('browser',browser,{id:crypto.randomUUID(),room:B,text:'Disabled'})).status,404);
const pauseId=crypto.randomUUID(), rankId=crypto.randomUUID();
const participant=crypto.randomUUID(), approval=crypto.randomUUID(), approvalCommand=crypto.randomUUID();
assert.equal((await call('browser',browser,{id:pauseId,room:A,control:'pause_agent',participant,paused:true})).status,200);
assert.equal((await call('browser',browser,{id:approvalCommand,room:A,control:'approval_decide',id_target:approval,allow:true})).status,200);
assert.equal((await call('browser',browser,{id:crypto.randomUUID(),room:A,control:'approval_decide',id_target:approval,allow:'true'})).status,400);
assert.equal((await call('browser',browser,{id:rankId,room:A,control:'room_ranking',mode:'hierarchy',mainMember:'p1',enabled:false})).status,200);
const ctrlCommands=(await exchange([rooms[0]])).commands;
assert.equal(ctrlCommands.length,3);
assert.equal(JSON.parse(ctrlCommands.find(c=>c.id===approvalCommand).text).id,approval);
assert.equal(JSON.parse(ctrlCommands.find(c=>c.id===approvalCommand).text).allow,true);
const pausePayload=JSON.parse(ctrlCommands.find(c=>c.id===pauseId).text);
const rankPayload=JSON.parse(ctrlCommands.find(c=>c.id===rankId).text);
assert.equal(pausePayload.control,'pause_agent');
assert.equal(pausePayload.paused,true);
assert.equal(rankPayload.mode,'hierarchy');
assert.equal(rankPayload.mainMember,'p1');
const backlog=Array.from({length:35},(_,i)=>({room:A,seq:i+3,name:'Agent',body:'한'.repeat(30000),created:'2026-01-01'}));
const firstBatch=relay.buildRelayBatch(backlog,{rooms,acknowledged:[],snapshot:{members:[]}});
assert.ok(firstBatch.batch.length>0&&firstBatch.batch.length<35);
assert.ok(Buffer.byteLength(JSON.stringify(firstBatch.body))<1500000);
const nextBatch=relay.buildRelayBatch(backlog.slice(firstBatch.batch.length),{rooms,acknowledged:[]});
assert.equal(nextBatch.body.events[0].seq,firstBatch.batch.at(-1).seq+1);
assert.equal((await call('device',device,firstBatch.body)).status,200);
// Multi-node rendezvous, host election, host migration, and offline fallback
const reg1=await (await call('rendezvous/register',device,{room:A,nodeId:'pc-home',label:'집PC',publicUrl:'https://home.example.com',canHost:true,priority:10,electionMode:'rule'})).json();
assert.equal(reg1.role,'hub');
assert.equal(reg1.hostNodeId,'pc-home');
assert.equal(reg1.hubUrl,'https://home.example.com');
assert.equal(reg1.epoch,1);
const reg2=await (await call('rendezvous/register',device,{room:A,nodeId:'pc-laptop',label:'노트북',publicUrl:'https://laptop.example.com',canHost:true,priority:5,electionMode:'rule'})).json();
assert.equal(reg2.role,'node');
assert.equal(reg2.hostNodeId,'pc-home');
assert.equal(reg2.nodes.length,2);
db.prepare('UPDATE room_hosts SET lease_expires_at=0 WHERE room=?').run(A);
db.prepare("UPDATE room_nodes SET last_seen=0 WHERE room=? AND node_id='pc-home'").run(A);
const hb2=await (await call('rendezvous/heartbeat',device,{room:A,nodeId:'pc-laptop',label:'노트북',publicUrl:'https://laptop.example.com',canHost:true,priority:5})).json();
assert.equal(hb2.role,'hub');
assert.equal(hb2.hostNodeId,'pc-laptop');
assert.equal(hb2.hubUrl,'https://laptop.example.com');
assert.equal(hb2.epoch,2);
db.prepare('UPDATE room_hosts SET lease_expires_at=0 WHERE room=?').run(A);
db.prepare('UPDATE room_nodes SET last_seen=0 WHERE room=?').run(A);
const off=await (await call('rendezvous/room?room='+A,device)).json();
assert.equal(off.mode,'offline_queue');
assert.equal(off.hostNodeId,null);
console.log('Passed: two-way relay, room isolation, deduplication, removal from the remote allowlist, remote controls, and multi-node host election/migration.');
