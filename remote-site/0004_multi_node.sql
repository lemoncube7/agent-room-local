CREATE TABLE IF NOT EXISTS room_nodes (
  room TEXT NOT NULL,
  node_id TEXT NOT NULL,
  label TEXT NOT NULL,
  public_url TEXT NOT NULL DEFAULT '',
  can_host INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room, node_id)
);

CREATE TABLE IF NOT EXISTS room_hosts (
  room TEXT PRIMARY KEY,
  host_node_id TEXT,
  hub_url TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  election_mode TEXT NOT NULL DEFAULT 'rule',
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
