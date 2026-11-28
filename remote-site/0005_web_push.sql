CREATE TABLE IF NOT EXISTS remote_push_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  private_jwk TEXT NOT NULL,
  public_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
