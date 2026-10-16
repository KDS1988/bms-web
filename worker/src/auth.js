/**
 * Авторизация отдела: вход через Google (ID-токен проверяется по ключам Google),
 * затем Worker выдаёт собственный короткий сессионный токен (HS256, 12 ч).
 * Права — по спискам email в переменных окружения Worker'а.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const jsonPart = s => JSON.parse(dec.decode(b64urlDecode(s)));

export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Проверка Google ID-токена (RS256). fetchJwks — async () => {keys:[...]} (подменяется в тестах). */
export async function verifyGoogleIdToken(idToken, { clientId, fetchJwks, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('bad_token');
  const [h, p, s] = parts;
  const header = jsonPart(h);
  const payload = jsonPart(p);
  if (header.alg !== 'RS256') throw new Error('bad_alg');

  const jwks = await fetchJwks();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown_key');
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new Error('bad_signature');

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error('bad_issuer');
  if (payload.aud !== clientId) throw new Error('bad_audience');
  if (!payload.exp || payload.exp * 1000 < now) throw new Error('expired');
  if (!payload.email || payload.email_verified !== true) throw new Error('email_not_verified');
  return { email: String(payload.email).toLowerCase(), name: payload.name || payload.email };
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload, secret, ttlSec = 12 * 3600, now = Date.now()) {
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSec };
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64urlEncode(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = jsonPart(p);
    if (!payload.exp || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

const parseList = v => String(v || '').split(/[,\s;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
const matches = (list, email) => list.some(x => x === email || (x.startsWith('@') && email.endsWith(x)));

/** admin ⊃ editor ⊃ viewer. Запись вида «@vsporte.ru» пускает весь домен. */
export function roleFor(email, env) {
  const e = String(email || '').toLowerCase();
  if (matches(parseList(env.ADMIN_EMAILS), e)) return 'admin';
  if (matches(parseList(env.EDITOR_EMAILS), e)) return 'editor';
  if (matches(parseList(env.VIEWER_EMAILS), e)) return 'viewer';
  return null;
}

export const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };
export const hasRole = (role, need) => (ROLE_LEVEL[role] || 0) >= ROLE_LEVEL[need];
