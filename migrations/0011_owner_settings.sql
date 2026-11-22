CREATE TABLE owner_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  nickname TEXT NOT NULL DEFAULT '',
  homepage_url TEXT NOT NULL DEFAULT '',
  homepage_description TEXT NOT NULL DEFAULT ''
);
