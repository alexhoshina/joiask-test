CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'super_admin')),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  bilibili_uid TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  bilibili_name TEXT NOT NULL,
  bilibili_avatar TEXT NOT NULL,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE identity_sessions (
  digest TEXT PRIMARY KEY NOT NULL,
  admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  member_uid TEXT REFERENCES users(bilibili_uid) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((admin_id IS NULL) != (member_uid IS NULL))
);
CREATE INDEX identity_sessions_expiry ON identity_sessions(expires_at);
CREATE INDEX identity_sessions_admin ON identity_sessions(admin_id);
CREATE INDEX identity_sessions_member ON identity_sessions(member_uid);

CREATE TABLE signature_challenges (
  digest TEXT PRIMARY KEY NOT NULL,
  bilibili_uid TEXT NOT NULL UNIQUE,
  challenge_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'consumed')),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_check INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  confirmation_until INTEGER,
  bilibili_name TEXT,
  bilibili_avatar TEXT
);
CREATE INDEX signature_challenges_expiry ON signature_challenges(expires_at);

CREATE TABLE email_tokens (
  digest TEXT PRIMARY KEY NOT NULL,
  bilibili_uid TEXT NOT NULL REFERENCES users(bilibili_uid) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('bind', 'reset')),
  email TEXT NOT NULL,
  previous_email TEXT,
  password_snapshot TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_expiry ON email_tokens(expires_at);
CREATE INDEX email_tokens_member ON email_tokens(bilibili_uid);

CREATE TABLE identity_rate_limits (
  digest TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX identity_rate_limits_expiry ON identity_rate_limits(expires_at);
