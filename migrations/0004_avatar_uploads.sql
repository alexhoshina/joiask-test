CREATE TABLE avatar_uploads (
  object_key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','linked','discarded')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX avatar_uploads_cleanup ON avatar_uploads(state, created_at);
