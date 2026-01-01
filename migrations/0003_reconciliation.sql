ALTER TABLE orders ADD COLUMN provider_status TEXT;
ALTER TABLE orders ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE orders ADD COLUMN channel_order_id TEXT;
ALTER TABLE orders ADD COLUMN confirmed_at INTEGER;
ALTER TABLE orders ADD COLUMN last_check_error TEXT;
ALTER TABLE orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET payment_state=CASE status WHEN 'pending' THEN 'waiting' ELSE status END;
-- Earlier local demo builds used paid_at as observation time. Retain the distinction.
UPDATE orders SET confirmed_at=paid_at,paid_at=NULL WHERE is_demo=1;
CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  state TEXT NOT NULL,
  provider_status TEXT,
  source TEXT NOT NULL CHECK(source IN ('poll','scheduled','demo')),
  observed_at INTEGER NOT NULL
);
CREATE INDEX orders_reconcile ON orders(is_demo,status,last_checked_at);
CREATE INDEX payment_events_order ON payment_events(order_id,observed_at);
