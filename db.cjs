'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const providerNames = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity' };

const normalizeEffort = value => {
  if (!value) return null;
  if (!['low', 'medium', 'high'].includes(value)) throw Error('Unsupported reasoning effort.');
  return value;
};

const normalizePermission = value => {
  if (value === undefined || value === null || value === '') return 'dev';
  if (!['edit', 'dev', 'full'].includes(value)) throw Error('Unsupported permission level.');
  return value;
};

function initDb(rootDir) {
  const local = path.join(rootDir, 'local');
  const outbox = path.join(local, 'outbox');
  const spool = path.join(local, 'spool');
  const uploads = path.join(local, 'uploads');
  const updateLog = path.join(local, 'update.log');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(outbox, { recursive: true });
  fs.mkdirSync(spool, { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });

  const db = new DatabaseSync(path.join(local, 'rooms.db'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,room TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,since INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, room TEXT NOT NULL,author TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL, UNIQUE(author,request));
    CREATE TABLE IF NOT EXISTS room_codes(code TEXT PRIMARY KEY,room TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,parent TEXT NOT NULL,room TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER NOT NULL,member TEXT NOT NULL,state TEXT NOT NULL, PRIMARY KEY(seq,member));
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room,seq);
    CREATE INDEX IF NOT EXISTS deliveries_member_state ON deliveries(member,state);
  `);

  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const hasCol = (table, name) => all(`PRAGMA table_info(${table})`).some(col => col.name === name);

  if (!hasCol('rooms', 'memo')) db.exec("ALTER TABLE rooms ADD COLUMN memo TEXT NOT NULL DEFAULT ''");
  if (!hasCol('rooms', 'folder')) db.exec("ALTER TABLE rooms ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  if (!hasCol('rooms', 'work_mode')) db.exec("ALTER TABLE rooms ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'dev'");
  if (!hasCol('rooms', 'project')) db.exec("ALTER TABLE rooms ADD COLUMN project TEXT NOT NULL DEFAULT ''");
  if (!hasCol('members', 'parent')) db.exec('ALTER TABLE members ADD COLUMN parent TEXT');
  if (!hasCol('members', 'paused')) db.exec('ALTER TABLE members ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  if (!hasCol('members', 'role')) db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT ''");
  if (!hasCol('messages', 'recipient')) db.exec('ALTER TABLE messages ADD COLUMN recipient TEXT');
  if (!hasCol('messages', 'relay_root')) db.exec('ALTER TABLE messages ADD COLUMN relay_root INTEGER');
  if (!hasCol('messages', 'retracted')) db.exec('ALTER TABLE messages ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0');
  if (!hasCol('deliveries', 'priority')) db.exec('ALTER TABLE deliveries ADD COLUMN priority INTEGER');

  db.exec('CREATE TABLE IF NOT EXISTS cli_sessions(member TEXT PRIMARY KEY, project TEXT NOT NULL, thread TEXT)');
  for (const [column, def] of [
    ['provider', "TEXT NOT NULL DEFAULT 'codex'"],
    ['prepared', 'INTEGER NOT NULL DEFAULT 0'],
    ['model', 'TEXT'],
    ['effort', 'TEXT'],
    ['last_cli_error', 'TEXT'],
    ['permission_profile', "TEXT NOT NULL DEFAULT 'dev'"],
    ['turns', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_usage', 'TEXT'],
    ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['cost_usd', 'REAL NOT NULL DEFAULT 0'],
    ['policy_version', 'INTEGER NOT NULL DEFAULT 0']
  ]) {
    if (!hasCol('cli_sessions', column)) db.exec(`ALTER TABLE cli_sessions ADD COLUMN ${column} ${def}`);
  }

  db.exec('CREATE TABLE IF NOT EXISTS approval_rules(member TEXT NOT NULL,rule TEXT NOT NULL,PRIMARY KEY(member,rule))');
  db.exec('CREATE TABLE IF NOT EXISTS approval_logs(id TEXT PRIMARY KEY,room TEXT NOT NULL,member TEXT NOT NULL,name TEXT NOT NULL,tool TEXT NOT NULL,input TEXT NOT NULL,rule TEXT,decision TEXT NOT NULL,created TEXT NOT NULL,decided TEXT); CREATE INDEX IF NOT EXISTS approval_logs_room ON approval_logs(room,created DESC);');
  db.exec('CREATE TABLE IF NOT EXISTS desktop_bindings(member TEXT PRIMARY KEY, thread TEXT NOT NULL UNIQUE, pipe TEXT, since INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS remote_rooms (room TEXT PRIMARY KEY, since INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS remote_options (enabled INTEGER NOT NULL)');
  // Rooms are private by default: only the one-time legacy migration shares existing rooms,
  // and new rooms are shared explicitly (remote_share) or when created from the Site.
  db.exec("BEGIN; INSERT OR IGNORE INTO remote_rooms(room,since) SELECT id,(SELECT COALESCE(MAX(seq),0) FROM messages WHERE messages.room=rooms.id) FROM rooms WHERE NOT EXISTS(SELECT 1 FROM remote_options); INSERT INTO remote_options(enabled) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM remote_options); DROP TRIGGER IF EXISTS enroll_new_remote_room; COMMIT;");
  // "Always share" option: when on, every room created afterwards (UI, Site, copy) is shared too.
  if (!all('PRAGMA table_info(remote_options)').some(column => column.name === 'share_all')) db.exec('ALTER TABLE remote_options ADD COLUMN share_all INTEGER NOT NULL DEFAULT 0');
  db.exec("CREATE TRIGGER IF NOT EXISTS share_new_room_when_always AFTER INSERT ON rooms WHEN (SELECT share_all FROM remote_options LIMIT 1)=1 BEGIN INSERT OR IGNORE INTO remote_rooms(room,since) VALUES(NEW.id,0); END;");

  db.exec('CREATE TABLE IF NOT EXISTS room_ranking(room TEXT PRIMARY KEY,enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS reply_plans(seq INTEGER PRIMARY KEY,room TEXT NOT NULL,state TEXT NOT NULL,coordinate_mode TEXT,round INTEGER NOT NULL DEFAULT 1,max_rounds INTEGER NOT NULL DEFAULT 3)');
  const replyPlanColumns = new Set(all('PRAGMA table_info(reply_plans)').map(column => column.name));
  if (!replyPlanColumns.has('coordinate_mode')) db.exec('ALTER TABLE reply_plans ADD COLUMN coordinate_mode TEXT');
  if (!replyPlanColumns.has('round')) db.exec('ALTER TABLE reply_plans ADD COLUMN round INTEGER NOT NULL DEFAULT 1');
  if (!replyPlanColumns.has('max_rounds')) db.exec('ALTER TABLE reply_plans ADD COLUMN max_rounds INTEGER NOT NULL DEFAULT 3');
  if (!replyPlanColumns.has('judge_ms')) db.exec('ALTER TABLE reply_plans ADD COLUMN judge_ms INTEGER');
  if (!replyPlanColumns.has('wrap_up')) db.exec('ALTER TABLE reply_plans ADD COLUMN wrap_up INTEGER NOT NULL DEFAULT 1');
  db.exec(`CREATE TABLE IF NOT EXISTS coordination_turns (
    seq INTEGER NOT NULL, member TEXT NOT NULL, position INTEGER NOT NULL,
    state TEXT NOT NULL, note TEXT, PRIMARY KEY(seq,member)
  ); UPDATE coordination_turns SET state='pending' WHERE state='working';
  UPDATE deliveries SET state='coordination_wait' WHERE state='coordination_speaking';`);
  const rankingColumns = new Set(all('PRAGMA table_info(room_ranking)').map(column => column.name));
  for (const [column, def] of [
    ['judge_provider', 'TEXT'],
    ['judge_model', 'TEXT'],
    ['judge_effort', 'TEXT'],
    ['judge_prompt', 'TEXT'],
    ['mode', 'TEXT'],
    ['main_member', 'TEXT']
  ]) {
    if (!rankingColumns.has(column)) db.exec(`ALTER TABLE room_ranking ADD COLUMN ${column} ${def}`);
  }
  run("UPDATE room_ranking SET mode=CASE WHEN enabled=1 THEN 'ranking' ELSE 'broadcast' END WHERE mode IS NULL");
  const memberColumns = new Set(all('PRAGMA table_info(members)').map(column => column.name));
  if (!memberColumns.has('position')) db.exec('ALTER TABLE members ADD COLUMN position INTEGER');

  db.exec('CREATE TABLE IF NOT EXISTS handoff_alerts (seq INTEGER PRIMARY KEY, task INTEGER NOT NULL, revision INTEGER NOT NULL)');

  run("UPDATE members SET state='start_failed' WHERE state IN ('starting','approved') AND id IN (SELECT member FROM cli_sessions WHERE thread IS NULL AND prepared=0)");
  run("UPDATE deliveries SET state='uncertain' WHERE state IN ('submitting','working') AND member IN (SELECT member FROM cli_sessions)");
  run("UPDATE deliveries SET state='uncertain' WHERE state='submitting' AND member IN (SELECT member FROM desktop_bindings)");

  const selectedRemoteRooms = () => all('SELECT room,since FROM remote_rooms');
  const remoteConfigured = () => Boolean(one('SELECT enabled FROM remote_options'));

  return {
    db, all, one, run,
    local, outbox, spool, uploads, updateLog,
    selectedRemoteRooms, remoteConfigured
  };
}

module.exports = { initDb, providerNames, normalizeEffort, normalizePermission };
