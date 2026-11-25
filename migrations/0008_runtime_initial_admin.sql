-- Older installations never ran the new-site eligibility seed in 0001.
CREATE TABLE IF NOT EXISTS initial_admin_bootstrap (id INTEGER PRIMARY KEY CHECK (id = 1));

-- An offline or deploy-time admin may already have been created and deleted
-- before this trigger was installed. AUTOINCREMENT retains that history.
DELETE FROM initial_admin_bootstrap WHERE EXISTS (SELECT 1 FROM admins)
  OR EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='admins' AND seq>0);

CREATE TRIGGER close_initial_admin_bootstrap AFTER INSERT ON admins
BEGIN
  DELETE FROM initial_admin_bootstrap;
END;
