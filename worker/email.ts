import nodemailer from 'nodemailer';
import { decryptSecret, fail, ok } from './common';
import type { Settings } from './settings';
import { hashPassword, randomHex, verifyPassword } from './password.ts';
import {
  conflict, currentMember, digestKey, jsonObject, publicMember, requesterIP, signInRequired,
  stringField, validMemberPassword, type MemberRow
} from './identity-shared';

export function normalizeEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (email.length > 254 || !local || local.length > 64 || !domain || extra !== undefined
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return email;
}

async function permitEmail(req: Request, env: Env, email: string) {
  const now = Date.now();
  const [ip, recipient, daily] = await Promise.all([
    digestKey(env, 'mail-ip', requesterIP(req)), digestKey(env, 'mail-recipient', email), digestKey(env, 'mail-daily', email),
  ]);
  const [, reservation] = await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_rate_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare(`WITH limits(digest,maximum,expiry) AS (VALUES (?,5,?),(?,1,?),(?,10,?))
      INSERT INTO identity_rate_limits(digest,count,expires_at)
      SELECT digest,1,expiry FROM limits WHERE NOT EXISTS (
        SELECT 1 FROM limits l JOIN identity_rate_limits used ON l.digest=used.digest WHERE used.count>=l.maximum)
      ON CONFLICT(digest) DO UPDATE SET count=count+1`)
      .bind(ip, now + 60000, recipient, now + 60000, daily, now + 86400000),
  ]);
  return reservation.meta.changes === 3;
}

async function deliver(env: Env, config: Settings, member: MemberRow, to: string, purpose: 'bind' | 'reset') {
  const raw = randomHex(), digest = await digestKey(env, 'email-token', raw);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_tokens WHERE expires_at<=?').bind(now),
    env.DB.prepare(`INSERT INTO email_tokens(digest,bilibili_uid,purpose,email,previous_email,password_snapshot,expires_at)
      VALUES (?,?,?,?,?,?,?)`).bind(digest, member.bilibili_uid, purpose, to, member.email, member.password_hash, now + 1800000),
  ]);
  try {
    const password = config.smtp_password ? await decryptSecret(config.smtp_password, env.SETTINGS_KEY) : '';
    const transport = nodemailer.createTransport({
      host: config.smtp_host, port: config.smtp_port, secure: config.smtp_security === 'tls',
      requireTLS: config.smtp_security === 'starttls',
      auth: config.smtp_username ? { user: config.smtp_username, pass: password } : undefined,
      tls: { minVersion: 'TLSv1.2' }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    const subject = purpose === 'bind' ? '确认绑定邮箱' : '重置密码';
    const url = config.email_site_url.replace(/\/+$/, '') + '/account/email/#' + new URLSearchParams({ purpose, token: raw });
    try {
      await transport.sendMail({
        from: { name: config.smtp_from_name, address: config.smtp_from_email }, to,
        subject: config.site_name.replace(/[\r\n]/g, ' ') + ' - ' + subject,
        text: '请打开以下链接' + subject + '：\n\n' + url + '\n\n链接在 30 分钟内有效，且只能使用一次。如果你没有发起此操作，请忽略此邮件。',
      });
    } finally { transport.close(); }
  } catch (error) {
    await env.DB.prepare('DELETE FROM email_tokens WHERE digest=?').bind(digest).run();
    throw error;
  }
}

async function confirm(env: Env, purpose: 'bind' | 'reset', raw: string, member: MemberRow | null, password: string) {
  const invalid = () => fail(400, '邮件链接已失效、已使用或不适用于当前账号');
  if (!/^[0-9a-f]{64}$/.test(raw)) return invalid();
  if (purpose === 'reset' && !validMemberPassword(password)) return fail(400, '密码至少需要 8 个字符，且不能超过 72 字节');
  const digest = await digestKey(env, 'email-token', raw);
  const update = purpose === 'bind' ? 'email=t.email' : 'password_hash=?,session_version=session_version+1';
  const hash = purpose === 'reset' ? [await hashPassword(password)] : [];
  const scope = purpose === 'bind' ? 'u.bilibili_uid=? AND u.email IS NULL' : 'u.email=t.email';
  const uid = purpose === 'bind' ? [member!.bilibili_uid] : [];
  try {
    const [updated] = await env.DB.batch([
      env.DB.prepare(`UPDATE users AS u SET ${update},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM email_tokens t WHERE t.digest=? AND t.purpose=? AND t.expires_at>? AND t.bilibili_uid=u.bilibili_uid
        AND u.is_disabled=0 AND u.password_hash=t.password_snapshot AND u.email IS t.previous_email AND ${scope} RETURNING *`)
        .bind(...hash, digest, purpose, Date.now(), ...uid),
      env.DB.prepare('DELETE FROM email_tokens WHERE digest=? AND changes()=1').bind(digest),
    ]);
    const row = updated.results[0] as MemberRow | undefined;
    if (!row) return invalid();
    return purpose === 'bind' ? ok(publicMember(row)) : ok({ message: '密码已重置，请使用新密码登录' });
  } catch (error) {
    if (conflict(error)) return invalid();
    throw error;
  }
}

export async function emailRoute(req: Request, env: Env, path: string) {
  const config = await env.DB.prepare('SELECT * FROM config WHERE id=1').first<Settings>();
  if (!config) return fail(503, '邮件服务暂不可用');
  if (!config.email_enabled) return fail(404, '邮件功能未开启');
  if (config.smtp_security !== 'tls' && config.smtp_security !== 'starttls') return fail(503, 'SMTP 需要启用 TLS 或 STARTTLS');
  const purpose = path.includes('/password-reset') ? 'reset' : 'bind';
  const member = purpose === 'bind' ? await currentMember(req, env) : null;
  if (!member && purpose === 'bind') return signInRequired();
  const body = await jsonObject(req);
  if (path.endsWith('/confirm')) return confirm(env, purpose, stringField(body, 'token'), member, stringField(body, 'password'));
  if (member?.email) return fail(409, '账号已绑定邮箱，不支持更换');
  const email = normalizeEmail(stringField(body, 'email'));
  if (!email) return fail(400, '请输入有效的邮箱地址');
  if (!await permitEmail(req, env, email)) return fail(429, '请求过于频繁，请稍后重试');
  if (member) {
    if (!await verifyPassword(stringField(body, 'password'), member.password_hash)) return fail(403, '当前密码错误');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) return fail(409, '该邮箱已被绑定');
    try { await deliver(env, config, member, email, 'bind'); }
    catch { return fail(502, '邮件发送失败，请稍后重试或联系管理员'); }
    return ok({ message: '确认邮件已发送，请打开邮件中的链接完成绑定' });
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE email=? AND is_disabled=0').bind(email).first<MemberRow>();
  if (user) {
    try { await deliver(env, config, user, email, 'reset'); }
    catch { console.warn('Password reset email delivery failed'); }
  }
  return ok({ message: '如果该邮箱已绑定可用账号，你将收到重置密码邮件，请检查收件箱和垃圾邮件' });
}
