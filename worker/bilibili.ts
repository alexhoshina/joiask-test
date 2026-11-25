import { MAX_IMAGE_SIZE, rasterExtension, readLimited } from './uploads';
import { canonicalUID } from './identity-shared';

export type Profile = { uid: string; name: string; face: string; signature: string };

type FailureStage = 'http' | 'business' | 'stale' | 'format' | 'identity' | 'configuration';
const restrictedHTTP = new Set([403, 412, 429]);
const restrictedBusiness = new Set([-352, -403, -412, -509, -799]);

function publicHost(hostname: string) {
  const host = hostname.replace(/\.$/, '');
  if (host.startsWith('[')) {
    // URL canonicalizes IPv6. Allow ordinary global unicast addresses.
    return /^\[[23][0-9a-f]{3}:/.test(host) && !/^\[(?:2001:(?:0?:|db8:)|2002:)/.test(host);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  return host.includes('.') && !/(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home\.arpa)$/.test(host);
}

export function validateProfileURL(value: string): string {
  const input = value.trim();
  const url = URL.canParse(input) ? new URL(input) : undefined;
  if (!url || !/^https:\/\/[^/?#@]+(?:[/?#]|$)/i.test(input) || url.protocol !== 'https:' || url.username || url.password ||
      /[#\\\s]/.test(input) || input.length > 2048 || !publicHost(url.hostname)) {
    throw new Error('请输入有效的公网 HTTPS 资料接口地址');
  }
  return url.href;
}

class ProfileReadError extends Error {
  readonly stage: FailureStage;
  readonly code?: number;
  constructor(stage: FailureStage, code?: number) {
    super('Bilibili public card unavailable');
    this.stage = stage;
    this.code = code;
  }
}

export function profileFailureMessage(error: unknown) {
  const stage = error instanceof ProfileReadError ? error.stage : 'transport';
  const code = error instanceof ProfileReadError ? error.code : undefined;
  // JSON parsing and network errors may include an upstream response or URL.
  // Log only our stage and an optional numeric status.
  console.warn('Bilibili public card unavailable', code === undefined ? { stage } : { stage, code });
  if (code !== undefined && ((stage === 'http' && restrictedHTTP.has(code)) ||
      (stage === 'business' && restrictedBusiness.has(code)))) {
    return 'B 站资料接口限制了本次请求，请稍后再试';
  }
  if (stage === 'stale') return 'B 站资料服务暂时只返回了过期缓存，请稍后再试';
  return '暂时无法读取 B 站公开资料，请稍后重试';
}

export function parseProfile(json: string, uid: string): Profile {
  let result;
  try {
    result = JSON.parse(json, (key, value, context?: { source?: string }) => {
      // Preserve the original integer literal when a UID exceeds Number.MAX_SAFE_INTEGER.
      if (key === 'mid' && typeof value === 'number') {
        return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null);
      }
      return value;
    });
  } catch {
    throw new ProfileReadError('format');
  }
  if (!Number.isSafeInteger(result?.code)) throw new ProfileReadError('format');
  if (result.code !== 0) throw new ProfileReadError('business', result.code);
  const card = result.data?.card;
  if (!card || typeof card.name !== 'string' || !card.name || typeof card.face !== 'string' ||
      !card.face || typeof card.sign !== 'string') throw new ProfileReadError('format');
  if (card.mid !== uid) throw new ProfileReadError('identity');
  return { uid, name: card.name, face: card.face, signature: card.sign };
}

export async function fetchConfiguredProfile(env: Env, uid: string, freshSince?: number): Promise<Profile> {
  const endpoint = await env.DB.prepare('SELECT bilibili_profile_url FROM config WHERE id=1').first<string>('bilibili_profile_url');
  if (!endpoint) throw new ProfileReadError('configuration');
  return fetchProfile(uid, { endpoint, freshSince });
}

export async function fetchProfile(uid: string, { endpoint, freshSince }: { endpoint: string; freshSince?: number }): Promise<Profile> {
  if (canonicalUID(uid) !== uid) throw new Error('B 站 UID 无效');
  const url = new URL(validateProfileURL(endpoint));
  url.searchParams.set('mid', uid);
  const response = await fetch(url, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProfileReadError('http', response.status);
  }
  if (freshSince !== undefined) {
    const cachedSeconds = Number(response.headers.get('Age'));
    const predatesChallenge = cachedSeconds > 0 && Date.now() - cachedSeconds * 1000 < freshSince;
    if (predatesChallenge) {
      await response.body?.cancel().catch(() => {});
      throw new ProfileReadError('stale');
    }
  }
  if (!response.body) throw new ProfileReadError('format');
  const bytes = await readLimited(response.body, 1024 * 1024);
  return parseProfile(new TextDecoder().decode(bytes), uid);
}

export async function downloadAvatar(face: string) {
  let url = new URL(face.startsWith('//') ? 'https:' + face : face);
  // Profiles can list an HTTP avatar; all requests, including redirects, must
  // still pass the HTTPS/host checks below before fetching any bytes.
  if (url.protocol === 'http:') url.protocol = 'https:';
  const signal = AbortSignal.timeout(15000);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (url.hostname !== 'hdslb.com' && !url.hostname.endsWith('.hdslb.com'))) throw new Error('B 站头像地址无效');
    const response = await fetch(url.toString(), { redirect: 'manual', signal });
    const location = response.headers.get('Location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error('下载 B 站头像失败');
    const bytes = await readLimited(response.body, MAX_IMAGE_SIZE);
    const ext = rasterExtension(bytes);
    if (!ext) throw new Error('B 站头像格式无效');
    return { bytes, extension: ext };
  }
  throw new Error('B 站头像重定向过多');
}
