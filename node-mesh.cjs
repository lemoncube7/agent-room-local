'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const localDir = path.join(__dirname, 'local');
const identityFile = path.join(localDir, 'node-identity.json');
const policyFile = path.join(localDir, 'node-policy.json');

function loadNodePolicy() {
  try {
    const p = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    return {
      mode: p?.mode === 'trustedUsers' ? 'trustedUsers' : 'ownerOnly',
      trustedUsers: Array.isArray(p?.trustedUsers) ? p.trustedUsers.filter(u => typeof u === 'string' && u.trim()) : [],
    };
  } catch {
    return { mode: 'ownerOnly', trustedUsers: [] };
  }
}

function canUserRunDev(userId, ownerId) {
  if (!userId || !ownerId) return false;
  if (userId === ownerId) return true;
  const policy = loadNodePolicy();
  return policy.mode === 'trustedUsers' && policy.trustedUsers.includes(userId);
}

async function syncFromHub({ hubUrl, nodeKey, room, nodeId, sinceSeq = 0, taskSince = 0 }) {
  const url = String(hubUrl || '').replace(/\/+$/, '') + '/api/node/sync';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-room-node-key': nodeKey || '' },
    redirect: 'error',signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ room, nodeId, sinceSeq, taskSince, publicHistory:true }),
  });
  if (!res.ok) throw new Error('Node sync HTTP ' + res.status);
  return res.json();
}

async function submitNodeReply({ hubUrl, nodeKey, room, member, body, recipient = null }) {
  const url = String(hubUrl || '').replace(/\/+$/, '') + '/api/node/reply';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-room-node-key': nodeKey || '' },
    body: JSON.stringify({ room, member, body, recipient }),
  });
  if (!res.ok) throw new Error('Node reply HTTP ' + res.status);
  return res.json();
}

let meshState = {
  enabled: false,
  nodeId: null,
  label: os.hostname(),
  role: 'standalone',
  mode: 'standalone',
  hostNodeId: null,
  hubUrl: null,
  epoch: 0,
  nodes: [],
  lastError: null,
  updatedAt: null,
};
let timer = null;
let generation = 0;

function loadIdentity() {
  try {
    const saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    if (saved && typeof saved.nodeId === 'string' && saved.nodeId.length >= 8) {
      return { nodeId: saved.nodeId, label: saved.label || os.hostname() };
    }
  } catch {}
  const id = { nodeId: randomUUID(), label: os.hostname() };
  try {
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(identityFile, JSON.stringify(id, null, 2));
  } catch {}
  return id;
}

async function postRendezvous(site, deviceKey, endpoint, body, siteAccess) {
  const url = String(site || '').replace(/\/+$/, '') + '/api/room/rendezvous/' + endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-room-key': deviceKey,
      ...(siteAccess ? {'OAI-Sites-Authorization': 'Bearer '+siteAccess} : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error('Rendezvous HTTP ' + res.status),{status:res.status});
  return res.json();
}

function startMesh(opts = {}) {
  stopMesh();
  const { site, deviceKey, room, publicUrl = '', canHost = false, priority = 0, electionMode = 'rule', onRoleChange } = opts;
  if (!site || !deviceKey || !room) return getMeshStatus();
  const id = loadIdentity();
  meshState = {
    ...meshState,
    enabled: true,
    nodeId: id.nodeId,
    label: opts.label || id.label,room,
    lastError: null,
  };
  const active = generation;
  let registered = false;
  const tick = async () => {
    try {
      const endpoint = registered ? 'heartbeat' : 'register';
      const data = await postRendezvous(site, deviceKey, endpoint, {
        room,
        nodeId: meshState.nodeId,
        label: meshState.label,
        publicUrl,
        canHost: Boolean(canHost && publicUrl),
        priority,
        electionMode,
        report: await opts.report?.(meshState.hostNodeId),
      }, opts.siteAccess);
      if (active !== generation) return;
      registered = true;
      const prevRole = meshState.role;
      const prevEpoch = meshState.epoch;
      meshState = {
        ...meshState,
        role: data.role || 'node',
        mode: data.mode || 'hub',
        hostNodeId: data.hostNodeId || null,
        hubUrl: data.hubUrl || null,
        epoch: data.epoch || 0,leaseExpiresAt:data.leaseExpiresAt||0,
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        lastError: null,
        updatedAt: Date.now(),
      };
      let currentRuns=data.role==='hub'?null:[];
      if(data.role==='node' && opts.mirror && data.hubUrl && (opts.trustedHubs||[]).includes(data.hubUrl)){
        const origin=new URL(data.hubUrl);
        if(origin.protocol!=='https:'||origin.origin!==data.hubUrl)throw Error('Trusted hub must be an HTTPS origin');
        const source=data.hostNodeId;
        const page=await syncFromHub({hubUrl:origin.origin,nodeKey:deviceKey,room,nodeId:id.nodeId,sinceSeq:opts.cursor(source),taskSince:opts.taskCursor(source)});
        if(active===generation && page.room===room && page.mesh?.nodeId===source && page.mesh?.epoch===data.epoch && page.mesh?.role==='hub'){opts.mirror(source,page.messages,page.tasks);currentRuns=Array.isArray(page.runs)?page.runs:[];}
      }
      for(const task of opts.pendingRuns?.()||[]){
        if(active!==generation||Date.now()>=data.leaseExpiresAt)break;
        if(currentRuns&&!currentRuns.some(r=>r.run===task.mesh_run&&r.revision===task.revision))continue;
        const claim=await postRendezvous(site,deviceKey,'claim',{room,host:data.hostNodeId,epoch:data.epoch,nodeId:id.nodeId,run:task.mesh_run,ticket:opts.ticket(task.mesh_run)},opts.siteAccess).catch(error=>{if(error.status===409)return {claimed:false};throw error;});
        if(claim.claimed&&active===generation&&Date.now()<data.leaseExpiresAt)opts.enqueueRun(task);
      }
      if ((prevRole !== meshState.role || prevEpoch !== meshState.epoch) && typeof onRoleChange === 'function') {
        try { onRoleChange({ ...meshState }); } catch {}
      }
    } catch (err) {
      if (active === generation) meshState.lastError = err.message || String(err);
    }
  };
  let running=false;
  const poll=async()=>{if(running)return;running=true;try{await tick();}finally{running=false;}};
  void poll();
  timer = setInterval(poll, 10000);
  timer.unref?.();
  return getMeshStatus();
}

function stopMesh() {
  if (timer) { clearInterval(timer); timer = null; }
  generation++;
  Object.assign(meshState,{enabled:false,mode:'standalone',hostNodeId:null,hubUrl:null,epoch:0,nodes:[],lastError:null,updatedAt:null});
  meshState.role = 'standalone';
}

function getMeshStatus() {
  return { ...meshState, nodes: [...meshState.nodes] };
}

module.exports = { startMesh, stopMesh, getMeshStatus, loadIdentity, loadNodePolicy, canUserRunDev, syncFromHub, submitNodeReply };
