CREATE TABLE checkout_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  turnstile_enabled INTEGER NOT NULL CHECK (turnstile_enabled IN (0, 1))
);
