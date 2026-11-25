import { randomHex } from './password.ts';
import { fail } from './common';

export type AdminRow = {
  id: number;
  username: string;
  role: 'admin' | 'super_admin';
  password_hash: string;
  session_version: number;
  created_at: string;
  updated_at: string;
};

export type MemberRow = {
  bilibili_uid: string;
  username: string;
  email: string | null;
  password_hash: string;
  bilibili_name: string;
  bilibili_avatar: string;
  verified_at: string;
  is_disabled: number;
  session_version: number;
  created_at: string;
  updated_at: string;
};

export function publicMember(row: MemberRow) {
  const { password_hash, session_version, ...user } = row;
  return { ...user, is_disabled: Boolean(user.is_disabled) };
}

export function publicAdmin(row: AdminRow) {
  const { password_hash, session_version, ...admin } = row;
  return admin;
}

export function validMemberPassword(value: unknown): value is string {
  return typeof value === 'string' && [...value].length >= 8 && new TextEncoder().encode(value).length <= 72;
}

export function validUsername(value: string) {
  return [...value].length >= 2 && [...value].length <= 32 && !/\s/u.test(value);
}

export function canonicalUID(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value.trim())) return null;
  const uid = BigInt(value.trim());
  return uid > 0n && uid <= 9223372036854775807n ? uid.toString() : null;
}

type CookieName = 'joi_admin' | 'joi_member' | 'joi_challenge';
const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
export function withCookie(response: Response, req: Request, name: CookieName, token: string, maxAge: number) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  return response;
}

export function credential(req: Request, name: CookieName): string | null {
  const entries = (req.headers.get('Cookie') || '').split(';').map(c => c.trim());
  const value = entries.find(c => c.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export async function digestKey(env: Env, scope: string, value: string) {
  if (!env.SESSION_SECRET || new TextEncoder().encode(env.SESSION_SECRET).length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(scope + ':' + value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function cookieDigest(req: Request, env: Env, name: CookieName) {
  const value = credential(req, name);
  return value ? digestKey(env, name, value) : null;
}

export async function currentAdmin(req: Request, env: Env): Promise<AdminRow | null> {
  const digest = await cookieDigest(req, env, 'joi_admin');
  if (!digest) return null;
  return env.DB.prepare(`SELECT a.* FROM identity_sessions s JOIN admins a ON a.id=s.admin_id
    WHERE s.digest=? AND s.expires_at>? AND a.session_version=s.version`).bind(digest, Date.now()).first<AdminRow>();
}

export async function currentMember(req: Request, env: Env): Promise<MemberRow | null> {
  const digest = await cookieDigest(req, env, 'joi_member');
  if (!digest) return null;
  return env.DB.prepare(`SELECT u.* FROM identity_sessions s JOIN users u ON u.bilibili_uid=s.member_uid
    WHERE s.digest=? AND s.expires_at>? AND u.session_version=s.version AND u.is_disabled=0`)
    .bind(digest, Date.now()).first<MemberRow>();
}

export async function loginSession(req: Request, env: Env, account: AdminRow | MemberRow, response: Response) {
  const admin = 'id' in account;
  const name = admin ? 'joi_admin' : 'joi_member';
  const raw = randomHex();
  const digest = await digestKey(env, name, raw);
  const now = Date.now();
  const previous = await cookieDigest(req, env, name);
  // Recheck the credential that was verified. An account may be reset, deleted,
  // or recreated while an expensive password check is in flight.
  const insert = admin
    ? env.DB.prepare(`INSERT INTO identity_sessions (digest,admin_id,version,expires_at)
        SELECT ?,id,session_version,? FROM admins WHERE id=? AND password_hash=? AND session_version=?`)
    : env.DB.prepare(`INSERT INTO identity_sessions (digest,member_uid,version,expires_at)
        SELECT ?,bilibili_uid,session_version,? FROM users
        WHERE bilibili_uid=? AND password_hash=? AND session_version=? AND is_disabled=0`);
  const [, issued] = await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_sessions WHERE expires_at<=? OR digest=?').bind(now, previous),
    insert.bind(digest, now + sessionLifetimeSeconds * 1000, admin ? account.id : account.bilibili_uid, account.password_hash, account.session_version),
  ]);
  if (!issued.meta.changes) return fail(408, '账号已变更，请重新登录');
  return withCookie(response, req, name, raw, sessionLifetimeSeconds);
}

export async function logoutSession(req: Request, env: Env, name: 'joi_admin' | 'joi_member', response: Response) {
  const digest = await cookieDigest(req, env, name);
  if (digest) await env.DB.prepare('DELETE FROM identity_sessions WHERE digest=?').bind(digest).run();
  return withCookie(response, req, name, '', 0);
}

export function requesterIP(req: Request) {
  return req.headers.get('CF-Connecting-IP') || 'local';
}

export async function rateLimit(env: Env, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const digest = await digestKey(env, 'limits', key);
  const [, update] = await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_rate_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare(`INSERT INTO identity_rate_limits(digest,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(digest) DO UPDATE SET count=count+1 WHERE count<?`).bind(digest, now + windowMs, limit),
  ]);
  return update.meta.changes === 1;
}

export class InputError extends Error { }
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => null);
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new InputError();
  return value as Record<string, unknown>;
}
export function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new InputError();
  return typeof value === 'string' ? value : '';
}

export function conflict(error: unknown) {
  return /UNIQUE constraint failed/i.test(String(error)) || /UNIQUE constraint failed/i.test(String((error as Error)?.cause));
}

export const signInRequired = () => fail(408, '请先登录');
