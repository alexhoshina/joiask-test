CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_version INTEGER NOT NULL DEFAULT 0,
  site_name TEXT NOT NULL DEFAULT 'JoiAsk 提问箱',
  site_description TEXT NOT NULL DEFAULT 'JoiAsk 提问箱',
  logo_url TEXT NOT NULL DEFAULT '/favicon.png',
  favicon_url TEXT NOT NULL DEFAULT '/favicon.png',
  announcement TEXT NOT NULL DEFAULT '提问内容将在审核后公开',
  custom_css TEXT NOT NULL DEFAULT '',
  require_verified_user_to_post INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  smtp_host TEXT NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_security TEXT NOT NULL DEFAULT 'starttls',
  smtp_username TEXT NOT NULL DEFAULT '',
  smtp_password TEXT NOT NULL DEFAULT '',
  smtp_from_email TEXT NOT NULL DEFAULT '',
  smtp_from_name TEXT NOT NULL DEFAULT '',
  email_site_url TEXT NOT NULL DEFAULT '',
  ai_base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  ai_model TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
  ai_api_key TEXT NOT NULL DEFAULT '',
  spam_prompt TEXT NOT NULL DEFAULT '广告或恶意引流
重复灌水
诈骗或其他欺骗性内容
明显无意义、无法理解或与提问无关的内容'
);
INSERT INTO config (id) VALUES (1);

-- Only a new site receives the one-time right to provision its first admin.
CREATE TABLE initial_admin_bootstrap (id INTEGER PRIMARY KEY CHECK (id = 1));
INSERT INTO initial_admin_bootstrap (id) VALUES (1);
