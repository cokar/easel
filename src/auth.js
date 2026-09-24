// 单管理员口令 + HMAC 签名会话 Cookie（无状态，不需要数据库）。
// AUTH_SECRET 是 Worker Secret，泄露等同于泄露后台，请用长随机串：
//   npx wrangler secret put AUTH_SECRET

export const SESSION_COOKIE = 'hh_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();
const VERSION = 'v1';

function requireSecret(env) {
  const secret = env.AUTH_SECRET;
  if (!secret || String(secret).length < 16) {
    throw new Error('AUTH_SECRET 未设置或过短：请执行 npx wrangler secret put AUTH_SECRET');
  }
  return String(secret);
}

async function importKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 用 AUTH_SECRET 派生两个等长摘要再比较，避免比较过程泄露口令长度。 */
export async function verifyPassword(env, candidate) {
  const secret = requireSecret(env);
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return false;

  const key = await importKey(`${secret}:password`, ['sign']);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(String(candidate ?? ''))),
    crypto.subtle.sign('HMAC', key, encoder.encode(String(expected))),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function issueSession(env, ttlSeconds = SESSION_TTL_SECONDS) {
  const secret = requireSecret(env);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${VERSION}.${exp}`;
  const key = await importKey(secret, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return { token: `${payload}.${toBase64Url(sig)}`, maxAge: ttlSeconds };
}

export async function verifySession(env, token) {
  if (!token) return false;
  let secret;
  try {
    secret = requireSecret(env);
  } catch {
    return false; // 配置缺失时一律当作未登录，不 fail-open
  }

  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const [version, expText] = payload.split('.');
  if (version !== VERSION) return false;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;

  let signature;
  try {
    signature = fromBase64Url(sigPart);
  } catch {
    return false;
  }

  // crypto.subtle.verify 本身是常量时间比较。
  const key = await importKey(secret, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function isAuthenticated(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return verifySession(env, cookies[SESSION_COOKIE]);
}
