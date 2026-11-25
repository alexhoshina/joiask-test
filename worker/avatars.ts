import { downloadAvatar } from './bilibili';
import type { AdminRow, MemberRow } from './identity-shared';

type NewMember = {
  uid: string;
  name: string;
  face: string;
  verifiedAt: string;
  username: string;
  passwordHash: string;
};

type RegistrationAuthority = { challenge: string; code: string } | { admin: AdminRow };
export class AvatarUnavailable extends Error {}

async function removeDiscarded(env: Env, keys: string[]) {
  if (!keys.length) return;
  await env.FILES.delete(keys);
  await env.DB.prepare(`DELETE FROM avatar_uploads WHERE state='discarded'
    AND object_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).run();
}

async function discardAttempt(env: Env, key: string) {
  // A lost D1 response can follow a successful commit. Only the transaction
  // that moves staged to discarded owns deletion. Linked keys are permanent
  // because historical questions can outlive their member.
  const claimed = await env.DB.prepare(`UPDATE avatar_uploads SET state='discarded'
    WHERE object_key=? AND state='staged' RETURNING object_key`).bind(key).first();
  if (claimed) await removeDiscarded(env, [key]);
}

export async function cleanupStaleAvatars(env: Env) {
  const claimed = await env.DB.prepare(`UPDATE avatar_uploads SET state='discarded'
    WHERE object_key IN (SELECT object_key FROM avatar_uploads WHERE state='discarded'
      OR (state='staged' AND created_at<unixepoch()-86400) LIMIT 100) RETURNING object_key`)
    .all<{ object_key: string }>();
  await removeDiscarded(env, claimed.results.map(row => row.object_key));
}

export async function createMemberWithAvatar(env: Env, member: NewMember, authority: RegistrationAuthority) {
  let image;
  try {
    image = await downloadAvatar(member.face);
  } catch {
    throw new AvatarUnavailable('下载 B 站头像失败，请重试');
  }

  const key = 'member-avatar-' + crypto.randomUUID() + image.extension;
  const url = '/upload-img/' + key;
  await env.DB.prepare('INSERT INTO avatar_uploads(object_key) VALUES (?)').bind(key).run();
  let linked = false;
  try {
    try {
      await env.FILES.put(key, image.bytes);
    } catch {
      throw new AvatarUnavailable('保存 B 站头像失败，请重试');
    }
    const eligibility = 'challenge' in authority
      ? env.DB.prepare(`INSERT INTO users(bilibili_uid,username,password_hash,bilibili_name,bilibili_avatar,verified_at)
          SELECT c.bilibili_uid,?,?,c.bilibili_name,?,?
          FROM signature_challenges c JOIN avatar_uploads a ON a.object_key=? AND a.state='staged'
          WHERE c.digest=? AND c.challenge_code=? AND c.bilibili_uid=? AND c.status='verified'
            AND c.confirmation_until>? RETURNING *`)
        .bind(member.username, member.passwordHash, url, member.verifiedAt, key, authority.challenge, authority.code, member.uid, Date.now())
      : env.DB.prepare(`INSERT INTO users(bilibili_uid,username,password_hash,bilibili_name,bilibili_avatar,verified_at)
          SELECT ?,?,?,?,?,? FROM avatar_uploads WHERE object_key=? AND state='staged'
            AND EXISTS (SELECT 1 FROM admins WHERE id=? AND session_version=?) RETURNING *`)
        .bind(member.uid, member.username, member.passwordHash, member.name, url, member.verifiedAt,
          key, authority.admin.id, authority.admin.session_version);

    const statements = [eligibility];
    if ('challenge' in authority) {
      statements.push(env.DB.prepare(`UPDATE signature_challenges SET status='consumed'
        WHERE digest=? AND changes()=1`).bind(authority.challenge));
    }
    statements.push(env.DB.prepare(`UPDATE avatar_uploads SET state='linked'
      WHERE object_key=? AND state='staged' AND changes()=1`).bind(key));
    const [inserted] = await env.DB.batch(statements);
    const user = inserted.results[0] as MemberRow | undefined;
    linked = !!user;
    return user ?? null;
  } finally {
    if (!linked) {
      try {
        await discardAttempt(env, key);
      } catch {
        // A reserved key remains discoverable even if this invocation cannot
        // reach D1 or R2. The scheduled cleanup retries both operations.
        console.warn('Avatar cleanup deferred');
      }
    }
  }
}
