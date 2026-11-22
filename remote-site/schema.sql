CREATE TABLE IF NOT EXISTS remote_events (
  seq INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_commands (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS remote_commands_pending ON remote_commands(delivered,created);
