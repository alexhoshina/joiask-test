ALTER TABLE config ADD COLUMN ai_vision_test_timeout_seconds INTEGER NOT NULL DEFAULT 20
  CHECK (typeof(ai_vision_test_timeout_seconds) = 'integer' AND ai_vision_test_timeout_seconds BETWEEN 1 AND 300);
