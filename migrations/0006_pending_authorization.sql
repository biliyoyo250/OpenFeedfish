CREATE TABLE account_pending_authorization (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  id TEXT NOT NULL,
  owner_sub TEXT NOT NULL,
  sealed_credentials TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0
);
