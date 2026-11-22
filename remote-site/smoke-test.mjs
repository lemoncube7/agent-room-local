import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleRoom} from './handler.mjs';

const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
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
const id=crypto.randomUUID();
assert.equal((await call('browser',{},undefined)).status,403);
assert.equal((await call('browser',{...browser,origin:'https://other.test'},{id,text:'rejected'})).status,403);
assert.equal((await call('device',{}, {acknowledged:[],events:[]})).status,403);
assert.equal((await call('browser',browser,{id,text:'Hello PC'})).status,200);
assert.equal((await call('browser',browser,{id,text:'Hello PC'})).status,200);
assert.equal((await call('browser',browser,{id,text:'conflict'})).status,409);
assert.deepEqual((await (await call('device',device,{acknowledged:[],events:[]})).json()).commands,[{id,text:'Hello PC'}]);
const events=[{seq:1,name:'Codex',text:'Hello remote',created:new Date().toISOString()}];
assert.deepEqual((await (await call('device',device,{acknowledged:[id],events})).json()).commands,[]);
await call('device',device,{acknowledged:[id],events});
assert.deepEqual((await (await call('browser',browser)).json()).events,events);
console.log('Passed: owner and device authorization, replay handling, two-way relay.');
