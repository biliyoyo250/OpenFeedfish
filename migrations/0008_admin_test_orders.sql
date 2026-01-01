ALTER TABLE orders ADD COLUMN is_admin_test INTEGER NOT NULL DEFAULT 0 CHECK (is_admin_test IN (0,1));
-- Before public agent checkout opens, all existing agent orders are admin tests.
UPDATE orders SET is_admin_test=1 WHERE provider_transport='agent';
