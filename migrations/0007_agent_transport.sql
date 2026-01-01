ALTER TABLE orders ADD COLUMN provider_transport TEXT NOT NULL DEFAULT 'worker' CHECK (provider_transport IN ('worker', 'agent'));
