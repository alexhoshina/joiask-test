CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE emojis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT UNIQUE,
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  bilibili_uid TEXT,
  bilibili_name TEXT NOT NULL DEFAULT '',
  bilibili_avatar TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  images_num INTEGER NOT NULL DEFAULT 0,
  images TEXT NOT NULL DEFAULT '',
  likes INTEGER NOT NULL DEFAULT 0,
  emojis TEXT NOT NULL DEFAULT '',
  is_hide INTEGER NOT NULL DEFAULT 0,
  is_rainbow INTEGER NOT NULL DEFAULT 0,
  is_archive INTEGER NOT NULL DEFAULT 0,
  is_publish INTEGER NOT NULL DEFAULT 0,
  is_spam INTEGER NOT NULL DEFAULT 0,
  is_real_name INTEGER NOT NULL DEFAULT 0,
  moderation_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX questions_tag ON questions(tag_id, id);
CREATE INDEX questions_member ON questions(bilibili_uid);
CREATE INDEX questions_public ON questions(is_publish, id);
CREATE INDEX questions_spam ON questions(is_spam, id);

-- Reserve the key before uploading. Only linked objects can be served. A
-- failed upload or deletion stays discoverable for retry by the sweeper.
CREATE TABLE question_images (
  object_key TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  discarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX question_images_submission ON question_images(submission_id);
CREATE INDEX question_images_unused ON question_images(question_id, created_at);

CREATE TABLE like_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  emoji TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(ip, question_id)
);
CREATE INDEX like_records_question ON like_records(question_id);

-- The uniqueness check and the counter update commit together. Imported Go
-- records have no emoji field; their existing totals are on the question.
CREATE TRIGGER count_new_reaction AFTER INSERT ON like_records
WHEN NEW.emoji IS NOT NULL
BEGIN
  UPDATE questions SET emojis = coalesce((
    SELECT json_set(questions.emojis, '$[' || item.key || '].count',
      json_extract(item.value,'$.count') + 1)
    FROM json_each(coalesce(nullif(questions.emojis,''),'[]')) AS item
    WHERE json_extract(item.value,'$.value') = NEW.emoji LIMIT 1
  ), json_insert(coalesce(nullif(emojis,''),'[]'), '$[#]',
     json_object('value', NEW.emoji, 'count', 1))),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id = NEW.question_id;
END;

CREATE TABLE moderation_outbox (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_enqueued_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX moderation_outbox_pending ON moderation_outbox(last_enqueued_at);

INSERT INTO tags(id, tag_name, description) VALUES (1,'提问箱','默认话题');
INSERT INTO emojis(tag,url) VALUES
 ('[轴伊Joi收藏集动态表情包_跑了]','/joi-emojis/paole.webp'),
 ('[轴伊Joi收藏集动态表情包_鞠躬]','/joi-emojis/jugong.webp'),
 ('[轴伊Joi收藏集动态表情包_摇你]','/joi-emojis/yaoni.webp'),
 ('[轴伊Joi收藏集动态表情包_愤怒]','/joi-emojis/fennu.webp'),
 ('[轴伊Joi收藏集动态表情包_猴]','/joi-emojis/hou.webp'),
 ('[轴伊Joi收藏集动态表情包_NO]','/joi-emojis/no.webp'),
 ('[轴伊Joi收藏集动态表情包_贴贴]','/joi-emojis/tietie.webp'),
 ('[轴伊Joi收藏集动态表情包_呆]','/joi-emojis/dai.webp'),
 ('[轴伊Joi收藏集动态表情包_唔唔]','/joi-emojis/wuwu.webp'),
 ('[轴伊Joi收藏集动态表情包_啊这]','/joi-emojis/azhe.webp'),
 ('[轴伊Joi收藏集动态表情包_失落]','/joi-emojis/shiluo.webp'),
 ('[轴伊Joi收藏集动态表情包_神气]','/joi-emojis/shenqi.webp'),
 ('[轴伊Joi收藏集动态表情包_怎么这样]','/joi-emojis/zenmezhyang.webp'),
 ('[轴伊Joi收藏集动态表情包_睡觉]','/joi-emojis/shuijiao.webp'),
 ('[轴伊Joi收藏集动态表情包_爆]','/joi-emojis/bao.webp');
