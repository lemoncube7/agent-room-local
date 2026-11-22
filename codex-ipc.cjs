// Local desktop IPC adapter. Only the registered Codex recipient is supported.
// No HTTP listener, API key, transcript injection, or app installation changes.
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const base = __dirname;
const MAX = 8 * 1024 * 1024;
function connect(pipe, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC connection timeout')); }, timeout);
    socket.once('error', e => { clearTimeout(timer); reject(e); });
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
  });
}
function rpc(socket, method, params, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let data = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); socket.off('data', receive); socket.off('error', fail); socket.off('close', closed); };
    const fail = e => { cleanup(); reject(e); };
    const closed = () => fail(new Error('IPC closed before response; delivery uncertain'));
    const timer = setTimeout(() => fail(new Error('IPC response timeout; delivery uncertain')), timeout);
    function receive(chunk) {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4) {
        const size = data.readUInt32LE(0);
        if (size > MAX) return fail(new Error('IPC frame too large'));
        if (data.length < size + 4) return;
        let response;
        try { response = JSON.parse(data.subarray(4, size + 4).toString('utf8')); }
        catch (e) { return fail(e); }
        data = data.subarray(size + 4);
        if (response.id !== id) continue;
        cleanup();
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
        return;
      }
    }
    socket.on('data', receive); socket.once('error', fail); socket.once('close', closed);
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    socket.write(Buffer.concat([header, payload]));
  });
}
async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  const sessions = JSON.parse(fs.readFileSync(path.join(base, 'local', 'sessions.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!sessions.codex || input.threadId !== sessions.codex) throw new Error('Recipient is not the registered Codex session');
  const configFile = path.join(base, 'local', 'app-message.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  const candidates = [...new Set([process.env.CODEX_APP_TOOLS_PIPE_PATH, config.pipePath, ...(input.pipes || [])])]
    .filter(p => typeof p === 'string' && p.startsWith('\\\\.\\pipe\\codex-app-tools-'));
  let socket, catalog, failure;
  for (const pipe of candidates) {
    let candidate;
    try {
      candidate = await connect(pipe);
      catalog = await rpc(candidate, 'tools/list', { threadStartKind: 'all' });
      socket = candidate; break;
    } catch (e) { candidate?.destroy(); failure = e; }
  }
  if (!socket) throw failure || new Error('Codex desktop app pipe is not configured');
  try {
    const tool = catalog.tools.find(t => t.name === 'send_message_to_thread');
    if (!tool) throw new Error('Desktop message tool unavailable');
    if (input.probeOnly) { console.log(JSON.stringify({ available: true, tool: tool.name })); return; }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Empty message');
    // From here onward a lost reply may mean delivery succeeded. Never blindly queue a duplicate.
    console.log(JSON.stringify({ phase: 'submitting' }));
    const response = await rpc(socket, 'tools/call', {
      arguments: { hostId: 'local', threadId: input.threadId, prompt: input.prompt },
      callerSource: 'codex', hostId: 'local', namespace: tool.namespace,
      threadId: input.threadId, turnId: `handoff-${input.eventId || crypto.randomUUID()}`,
      callId: `handoff-${crypto.randomUUID()}`, tool: tool.name,
    });
    if (!response.success) throw new Error('Desktop rejected message: ' + JSON.stringify(response.contentItems));
    console.log(JSON.stringify({ phase: 'accepted', threadId: input.threadId }));
  } finally { socket.destroy(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
