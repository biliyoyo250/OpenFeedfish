CREATE TABLE account_authorization (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  id TEXT NOT NULL,
  owner_sub TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','open','saving','closed')),
  sealed_flow TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
