import { createHash, timingSafeEqual } from 'node:crypto';
import { ok, fail } from './common';
import { hashPassword, validInitialAdminCredentials, verifyPassword } from './password.ts';
import { fetchConfiguredProfile, profileFailureMessage } from './bilibili';
import { AvatarUnavailable, createMemberWithAvatar } from './avatars';
import { signature } from './signature';
import { emailRoute } from './email';
import {
  canonicalUID, conflict, currentAdmin, currentMember, InputError, jsonObject, loginSession, logoutSession,
  publicAdmin, publicMember, rateLimit, requesterIP, signInRequired, stringField, validMemberPassword,
  validUsername, type AdminRow, type MemberRow
} from './identity-shared';

export { currentAdmin, currentMember } from './identity-shared';
const nowISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const allowedActor = 'EXISTS (SELECT 1 FROM admins actor WHERE actor.id=? AND actor.session_version=? AND actor.role=?)';
const hasOtherSuper = "EXISTS (SELECT 1 FROM admins other WHERE other.role='super_admin' AND other.id<>admins.id)";

interface InitialAdminBindings {
  JOIASK_INITIAL_ADMIN_USERNAME?: string;
  JOIASK_INITIAL_ADMIN_PASSWORD?: string;
}

function credentialDigest(username: string, password: string) {
  return createHash('sha256').update(JSON.stringify([username, password])).digest();
}

async function authenticateAdmin(env: Env & InitialAdminBindings, username: string, password: string) {
  const lookup = env.DB.prepare('SELECT * FROM admins WHERE username=?').bind(username);
  let admin = await lookup.first<AdminRow>();
  const { JOIASK_INITIAL_ADMIN_USERNAME: owner = '', JOIASK_INITIAL_ADMIN_PASSWORD: secret = '' } = env;
  if (!admin && validInitialAdminCredentials(owner, secret)) {
    const eligible = await env.DB.prepare('SELECT id FROM initial_admin_bootstrap WHERE id=1').first();
    if (eligible) {
      if (!timingSafeEqual(credentialDigest(username, password), credentialDigest(owner, secret))) return null;
      // The insert and its trigger consume the site's single eligibility row atomically.
      const created = await env.DB.prepare(`INSERT INTO admins(username,password_hash,role)
        SELECT ?,?,'super_admin' FROM initial_admin_bootstrap WHERE id=1 AND NOT EXISTS (SELECT 1 FROM admins)
        RETURNING *`).bind(username, await hashPassword(password)).first<AdminRow>();
      if (created) return created;
    }
    // Another login or the operator CLI may have provisioned this username.
    admin = await lookup.first<AdminRow>();
  }
  return admin && await verifyPassword(password, admin.password_hash) ? admin : null;
}

async function adminAccounts(req: Request, env: Env, path: string, actor: AdminRow) {
  const isSuper = actor.role === 'super_admin';
  if (path === '/api/info' && req.method === 'GET') return ok(publicAdmin(actor));
  if (path === '/api/logout' && req.method === 'GET') return logoutSession(req, env, 'joi_admin', ok());
  if (!isSuper && req.method !== 'PUT') return fail(403, '仅超级管理员可管理后台账号');
  if (path === '/api/user' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id,username,role,created_at,updated_at FROM admins ORDER BY id').all();
    return ok(results);
  }
  const authority = [actor.id, actor.session_version, actor.role];
  if (path === '/api/user' && req.method === 'POST') {
    const body = await jsonObject(req);
    const username = stringField(body, 'username');
    const password = stringField(body, 'password');
    const role = stringField(body, 'role') || 'admin';
    if (!username || !password || new TextEncoder().encode(password).length > 4096) return fail(400, '请输入有效的用户名和密码');
    if (role !== 'admin' && role !== 'super_admin') return fail(400, '管理员角色无效');
    const created = await env.DB.prepare(`INSERT INTO admins(username,password_hash,role) SELECT ?,?,? WHERE ${allowedActor} RETURNING *`)
      .bind(username, await hashPassword(password), role, ...authority).first<AdminRow>();
    return created ? ok(publicAdmin(created)) : signInRequired();
  }
  const rawID = path.slice('/api/user/'.length);
  const id = Number(rawID);
  if (!/^\d+$/.test(rawID) || !Number.isSafeInteger(id) || id < 1) return fail(400, '无效的 ID');
  if (req.method === 'DELETE' && actor.id === id) return fail(403, '不能删除当前登录账号');
  if (!isSuper && actor.id !== id) return fail(403, '仅超级管理员可管理后台账号');
  if (req.method === 'DELETE') {
    const row = await env.DB.prepare(`DELETE FROM admins WHERE id=? AND ${allowedActor} AND
      (role<>'super_admin' OR ${hasOtherSuper}) RETURNING id`).bind(id, ...authority).first();
    if (row) return ok();
  } else if (req.method === 'PUT') {
    const body = await jsonObject(req);
    const username = stringField(body, 'username');
    const password = stringField(body, 'password');
    const role = body.role ?? null;
    if (!isSuper && role !== null) return fail(403, '仅超级管理员可管理后台账号及角色');
    if (role !== null && role !== 'admin' && role !== 'super_admin') return fail(400, '管理员角色无效');
    if (new TextEncoder().encode(password).length > 4096) return fail(400, '密码过长');
    const hash = password ? await hashPassword(password) : null;
    const result = await env.DB.prepare(`UPDATE admins SET username=COALESCE(?,username),password_hash=COALESCE(?,password_hash),
      session_version=session_version+CASE WHEN ? IS NOT NULL OR (? IS NOT NULL AND ?!=role) THEN 1 ELSE 0 END,
      role=COALESCE(?,role),updated_at=${nowISO} WHERE id=? AND ${allowedActor}
      AND (? IS NOT 'admin' OR role!='super_admin' OR ${hasOtherSuper}) RETURNING *`)
      .bind(username || null, hash, hash, role, role, role, id, ...authority, role).first<AdminRow>();
    if (result) return ok(publicAdmin(result));
  } else return null;
  if (!await currentAdmin(req, env)) return signInRequired();
  if (!await env.DB.prepare('SELECT 1 FROM admins WHERE id=?').bind(id).first()) return fail(404, '用户不存在');
  return fail(403, '必须保留至少一个超级管理员');
}

async function members(req: Request, env: Env, path: string, actor: AdminRow) {
  if (path === '/api/member' && req.method === 'GET') {
    const params = new URL(req.url).searchParams;
    const page = Math.max(1, Math.min(2147483647, Number.parseInt(params.get('page') || '', 10) || 1));
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(params.get('page_size') || '', 10) || 10));
    const [count, list] = await env.DB.batch([
      env.DB.prepare('SELECT count(*) AS total FROM users'),
      env.DB.prepare('SELECT * FROM users ORDER BY created_at DESC,bilibili_uid LIMIT ? OFFSET ?').bind(pageSize, (page - 1) * pageSize),
    ]);
    return ok({ users: (list.results as MemberRow[]).map(publicMember), total: (count.results[0] as { total: number }).total, page, page_size: pageSize });
  }
  if (path === '/api/member' && req.method === 'POST') {
    const body = await jsonObject(req);
    const uid = canonicalUID(body.bilibili_uid);
    const username = stringField(body, 'username').trim();
    const password = stringField(body, 'password');
    if (!uid || !validUsername(username) || !validMemberPassword(password)) return fail(400, '请输入有效的 UID、登录名和密码');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE bilibili_uid=? OR username=?').bind(uid, username).first()) return fail(409, '该 UID 或登录名已注册');
    let profile;
    try {
      profile = await fetchConfiguredProfile(env, uid);
    } catch (error) {
      return fail(502, profileFailureMessage(error));
    }
    const user = await createMemberWithAvatar(env, {
      uid,
      name: profile.name,
      face: profile.face,
      verifiedAt: new Date().toISOString(),
      username,
      passwordHash: await hashPassword(password),
    }, { admin: actor });
    return user ? ok(publicMember(user)) : signInRequired();
  }
  const uid = canonicalUID(path.slice('/api/member/'.length));
  if (!uid) return fail(400, 'B 站 UID 无效');
  if (req.method === 'PUT') {
    const body = await jsonObject(req);
    if (typeof body.is_disabled !== 'boolean') return fail(400, '请求无效');
    const value = Number(body.is_disabled);
    const row = await env.DB.prepare(`UPDATE users SET is_disabled=?,session_version=session_version+CASE WHEN is_disabled<>? THEN 1 ELSE 0 END,
      updated_at=${nowISO} WHERE bilibili_uid=? RETURNING *`).bind(value, value, uid).first<MemberRow>();
    return row ? ok(publicMember(row)) : fail(404, '用户不存在');
  }
  if (req.method === 'DELETE') {
    const row = await env.DB.prepare('DELETE FROM users WHERE bilibili_uid=? RETURNING bilibili_uid').bind(uid).first();
    return row ? ok() : fail(404, '用户不存在');
  }
  return null;
}

export async function identity(req: Request, env: Env): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  try {
    if (path === '/api/login' && req.method === 'POST') {
      if (!await rateLimit(env, 'admin:' + requesterIP(req), 10, 60000)) {
        return Response.json({ code: 429, message: '请求过于频繁，请稍后重试', data: null }, {
          status: 429,
          headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
        });
      }
      const body = await jsonObject(req);
      const username = stringField(body, 'username');
      const password = stringField(body, 'password');
      if (!username || !password) return fail(400, '用户名和密码不能为空');
      const admin = await authenticateAdmin(env, username, password);
      if (!admin) return fail(401, '用户名或密码错误');
      return loginSession(req, env, admin, ok());
    }
    if (/^\/api\/(?:member|user)(?:\/[^/]+)?$/.test(path) || path === '/api/info' || path === '/api/logout') {
      const actor = await currentAdmin(req, env);
      if (!actor) return signInRequired();
      return path.startsWith('/api/member') ? await members(req, env, path, actor) : await adminAccounts(req, env, path, actor);
    }
    if (!path.startsWith('/api/account/')) return null;
    if (['/api/account/verification', '/api/account/verification/check', '/api/account/register'].includes(path)) {
      return await signature(req, env, path);
    }
    if (req.method === 'POST' && ['/api/account/email', '/api/account/email/confirm', '/api/account/password-reset', '/api/account/password-reset/confirm'].includes(path)) {
      return await emailRoute(req, env, path);
    }
    if (path === '/api/account/login' && req.method === 'POST') {
      const body = await jsonObject(req);
      const identifier = stringField(body, 'username').trim();
      const password = stringField(body, 'password');
      if (!identifier || identifier.length > 254) return fail(401, '登录名、邮箱或密码错误');
      const { results } = await env.DB.prepare('SELECT * FROM users WHERE username=? OR email=? LIMIT 2')
        .bind(identifier, identifier.toLowerCase()).all<MemberRow>();
      let match: MemberRow | null = null;
      for (const row of results) {
        if (!await verifyPassword(password, row.password_hash)) continue;
        if (match) return fail(401, '登录名、邮箱或密码错误');
        match = row;
      }
      if (!match) return fail(401, '登录名、邮箱或密码错误');
      if (match.is_disabled) return fail(403, '账号已被禁用');
      return loginSession(req, env, match, ok(publicMember(match)));
    }
    if (path === '/api/account/info' && req.method === 'GET') {
      const row = await currentMember(req, env);
      return row ? ok(publicMember(row)) : signInRequired();
    }
    if (path === '/api/account/logout' && req.method === 'POST') return logoutSession(req, env, 'joi_member', ok());
    return null;
  } catch (error) {
    if (error instanceof AvatarUnavailable) return fail(502, error.message);
    if (error instanceof InputError) return fail(400, '请求无效');
    if (conflict(error)) return fail(409, '账号或登录名已存在');
    throw error;
  }
}
