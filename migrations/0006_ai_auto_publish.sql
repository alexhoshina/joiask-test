ALTER TABLE config ADD COLUMN ai_auto_publish INTEGER NOT NULL DEFAULT 0
  CHECK (ai_auto_publish IN (0, 1));
ALTER TABLE config ADD COLUMN ai_supports_vision INTEGER NOT NULL DEFAULT 0
  CHECK (ai_supports_vision IN (0, 1));
