PRAGMA foreign_keys = ON;

CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO system_config (key, value) VALUES
  ('record_ttl_seconds', '3600'),
  ('registration_enabled', 'true'),
  ('query_enabled', 'true'),
  ('max_records_per_response', '1000');

CREATE TABLE auth_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE hostname_whitelist (
  hostname TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allow_ipv4 INTEGER NOT NULL DEFAULT 1 CHECK (allow_ipv4 IN (0, 1)),
  allow_ipv6 INTEGER NOT NULL DEFAULT 1 CHECK (allow_ipv6 IN (0, 1))
);

CREATE TABLE user_host_permissions (
  user_id INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  PRIMARY KEY (user_id, hostname),
  FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
  FOREIGN KEY (hostname) REFERENCES hostname_whitelist(hostname) ON DELETE CASCADE
);

CREATE TABLE host_records (
  hostname TEXT NOT NULL,
  ip_version INTEGER NOT NULL CHECK (ip_version IN (4, 6)),
  ip_address TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (hostname, ip_version),
  FOREIGN KEY (hostname) REFERENCES hostname_whitelist(hostname) ON DELETE CASCADE
);

CREATE INDEX idx_host_records_expires_at ON host_records(expires_at);
