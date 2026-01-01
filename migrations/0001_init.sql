CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen BETWEEN 100 AND 10000000),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('wechat', 'alipay')),
  nickname TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('creating','unknown','pending','paid','failed','expired')),
  provider_order_id TEXT UNIQUE,
  qr_code TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_created_at ON orders(created_at);
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
