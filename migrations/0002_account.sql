CREATE TABLE account_session (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  account_id TEXT NOT NULL,
  sealed_credentials TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected','disabled','unverified')),
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  updated_by TEXT NOT NULL
);
CREATE TABLE admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE orders ADD COLUMN payment_url TEXT;
