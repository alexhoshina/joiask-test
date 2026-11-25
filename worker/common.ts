export function ok(data: unknown = null): Response {
  return Response.json({ code: 200, message: 'success', data }, { headers: { 'Cache-Control': 'no-store' } });
}

export function fail(code: number, message: string): Response {
  return Response.json({ code, message, data: null }, { headers: { 'Cache-Control': 'no-store' } });
}

async function secretKey(secret: string): Promise<CryptoKey> {
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error('SETTINGS_KEY must be at least 32 bytes');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  if (!value) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(secret), new TextEncoder().encode(value));
  return ['v1', btoa(String.fromCharCode(...iv)), btoa(String.fromCharCode(...new Uint8Array(encrypted)))].join('.');
}

export async function decryptSecret(value: string, secret: string): Promise<string> {
  if (!value) return '';
  const [version, nonce, ciphertext] = value.split('.');
  if (version !== 'v1' || !nonce || !ciphertext) throw new Error('Unsupported settings key format');
  const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(nonce) }, await secretKey(secret), bytes(ciphertext));
  return new TextDecoder().decode(plaintext);
}
