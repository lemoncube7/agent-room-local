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
  if (!userId || !ownerId || userId === ownerId) return true;
  const policy = loadNodePolicy();
  return policy.mode === 'trustedUsers' && policy.trustedUsers.includes(userId);
}

async function syncFromHub({ hubUrl, nodeKey, room, nodeId, sinceSeq = 0 }) {
  const url = String(hubUrl || '').replace(/\/+$/, '') + '/api/node/sync';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-room-node-key': nodeKey || '' },
    body: JSON.stringify({ room, nodeId, sinceSeq }),
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

async function postRendezvous(site, deviceKey, endpoint, body) {
  const url = String(site || '').replace(/\/+$/, '') + '/api/room/rendezvous/' + endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-room-key': deviceKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Rendezvous HTTP ' + res.status);
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
    label: opts.label || id.label,
    lastError: null,
  };
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
      });
      registered = true;
      const prevRole = meshState.role;
      const prevEpoch = meshState.epoch;
      meshState = {
        ...meshState,
        role: data.role || 'node',
        mode: data.mode || 'hub',
        hostNodeId: data.hostNodeId || null,
        hubUrl: data.hubUrl || null,
        epoch: data.epoch || 0,
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        lastError: null,
        updatedAt: Date.now(),
      };
      if ((prevRole !== meshState.role || prevEpoch !== meshState.epoch) && typeof onRoleChange === 'function') {
        try { onRoleChange({ ...meshState }); } catch {}
      }
    } catch (err) {
      meshState.lastError = err.message || String(err);
    }
  };
  void tick();
  timer = setInterval(tick, 10000);
  timer.unref?.();
  return getMeshStatus();
}

function stopMesh() {
  if (timer) { clearInterval(timer); timer = null; }
  meshState.enabled = false;
  meshState.role = 'standalone';
}

function getMeshStatus() {
  return { ...meshState, nodes: [...meshState.nodes] };
}

module.exports = { startMesh, stopMesh, getMeshStatus, loadIdentity, loadNodePolicy, canUserRunDev, syncFromHub, submitNodeReply };
