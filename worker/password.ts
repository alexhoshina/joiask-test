const encoder = new TextEncoder();
const iterations = 100000;

export function validInitialAdminCredentials(username: unknown, password: unknown) {
  return typeof username === 'string' && username.trim().length > 0 && !username.includes('\0') &&
    typeof password === 'string' && password.length > 0 && !/[\r\n]/.test(password) && encoder.encode(password).length <= 4096;
}

export function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

function toBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

async function derive(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: toBytes(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  if (typeof password !== 'string' || !password || encoder.encode(password).length > 4096) throw new Error('无效的密码长度');
  const salt = randomHex(16);
  const result = await derive(password, salt);
  const hex = Array.from(result, n => n.toString(16).padStart(2, '0')).join('');
  return ['pbkdf2-sha256', iterations, salt, hex].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  if (!password || typeof password !== 'string' || encoder.encode(password).length > 4096) return false;
  if (typeof stored !== 'string' || !/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)) return false;
  const [, , salt, digest] = stored.split('$');
  const candidate = await derive(password, salt);
  const expected = toBytes(digest);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ candidate[i];
  return difference === 0;
}
