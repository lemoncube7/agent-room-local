import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleRoom} from './handler.mjs';

const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
db.exec(readFileSync(new URL('./0001_multiple_rooms.sql',import.meta.url),'utf8'));
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
const rooms=[{id:A,name:'Room A'},{id:B,name:'Room B'}];
assert.equal((await call('browser',{},undefined)).status,403);
assert.equal((await call('device',{}, {rooms,acknowledged:[],events:[]})).status,403);
async function exchange(allowed=rooms,events=[],acknowledged=[]){
 const response=await call('device',device,{rooms:allowed,legacyRoom:A,events,acknowledged});
 assert.equal(response.status,200);
 return response.json();
}
await exchange();
assert.deepEqual((await (await call('browser',browser)).json()).rooms,rooms);
assert.equal((await call('browser',browser,{id,room:B,text:'Message B'})).status,200);
assert.equal((await call('browser',browser,{id,room:B,text:'Message B'})).status,200);
assert.equal((await call('browser',browser,{id,room:A,text:'Message B'})).status,409);
assert.deepEqual((await exchange()).commands,[{id,text:'Message B',room:B}]);
const events=[{room:A,seq:1,name:'Codex',text:'Reply A',created:'2026-01-01'},{room:B,seq:2,name:'Claude',text:'Reply B',created:'2026-01-01'}];
assert.deepEqual((await exchange(rooms,events,[id])).commands,[]);
const viewA=(await (await call('browser?room='+A,browser)).json()).events;
const viewB=(await (await call('browser?room='+B,browser)).json()).events;
assert.deepEqual(viewA.map(item=>item.text),['Reply A']);
assert.deepEqual(viewB.map(item=>item.text),['Reply B']);
await exchange([rooms[0]]);
assert.equal((await call('browser?room='+B,browser)).status,404);
assert.equal((await call('browser',browser,{id:crypto.randomUUID(),room:B,text:'Disabled'})).status,404);
console.log('Passed: two-way relay, room isolation, deduplication, and removal from the remote allowlist.');
