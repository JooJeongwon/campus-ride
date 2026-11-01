import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Bindings } from '../env';
import { cookieName, cookieOptions } from '../env';
import { expireStudentEligibility } from '../restrictions';

type AppContext = Context<{ Bindings: Bindings; Variables: { requestId: string } }>;

export type Session = {
  tokenHash: string;
  userId: string;
  csrfHash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  nickname: string;
  gender: string;
  departmentId: string | null;
  departmentStatus: string;
  departmentSource: string | null;
  parserVersion: string | null;
  affiliationStatus: string;
  verifiedUntil: number | null;
  role: string;
};

const encoder = new TextEncoder();
const devCsrfKey = 'development-only-campus-ride-csrf-key-not-for-deploy';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function hmacKey(env: Bindings, usage: KeyUsage[]): Promise<CryptoKey> {
  const secret = env.CSRF_HMAC_KEY ?? (env.APP_ENV === 'development' ? devCsrfKey : '');
  if (secret.length < 32) throw new Error('CSRF key unavailable');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function csrfToken(env: Bindings, token: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env, ['sign']), encoder.encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function verifyCsrf(env: Bindings, token: string, csrf: string): Promise<boolean> {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(csrf)) return false;
    const signature = Uint8Array.from(atob(csrf.replaceAll('-', '+').replaceAll('_', '/') + '='), (character) => character.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await hmacKey(env, ['verify']), signature, encoder.encode(token));
  } catch {
    return false;
  }
}

export async function createSession(c: AppContext, userId: string, now = Date.now()): Promise<void> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const csrf = await csrfToken(c.env, token);
  await c.env.DB.prepare(`INSERT INTO sessions
    (token_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at)
    VALUES(?,?,?,?,?,?)`).bind(tokenHash, userId, await sha256(csrf), now, now, now + SESSION_MAX_AGE_MS).run();
  setCookie(c, cookieName(c.env, 'session'), token, { ...cookieOptions(c.env), maxAge: SESSION_MAX_AGE_MS / 1000 });
}

async function createReverificationSession(c: AppContext, session: Session, now: number) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const csrf = await csrfToken(c.env, token);
  const csrfHash = await sha256(csrf);
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const inserted = await c.env.DB.prepare(`INSERT INTO sessions
    (token_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at)
    SELECT ?,u.id,?,?,?,? FROM users u WHERE u.id=? AND u.role='STUDENT'
      AND u.account_status='ACTIVE' AND u.affiliation_status='EXPIRED'`)
    .bind(tokenHash, csrfHash, now, now, expiresAt, session.userId).run();
  if (inserted.meta.changes !== 1) return null;
  setCookie(c, cookieName(c.env, 'session'), token, { ...cookieOptions(c.env), maxAge: 7 * 24 * 60 * 60 });
  return {
    session: { ...session, tokenHash, csrfHash, createdAt: now, lastSeenAt: now, expiresAt, affiliationStatus: 'EXPIRED' },
    token,
  };
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, cookieName(c.env, 'session'), cookieOptions(c.env));
}

export async function getSession(c: AppContext): Promise<{ session: Session; token: string } | null> {
  const token = getCookie(c, cookieName(c.env, 'session'));
  if (!token || token.length !== 43) return null;
  const tokenHash = await sha256(token);
  const session = await c.env.DB.prepare(`SELECT s.token_hash AS tokenHash,s.user_id AS userId,s.csrf_hash AS csrfHash,
    s.created_at AS createdAt,s.last_seen_at AS lastSeenAt,s.expires_at AS expiresAt,
    u.nickname,u.gender,u.department_id AS departmentId,u.department_status AS departmentStatus,
    u.department_source AS departmentSource,u.parser_version AS parserVersion,
    u.affiliation_status AS affiliationStatus,u.verified_until AS verifiedUntil,u.role
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_status='ACTIVE'`)
    .bind(tokenHash, Date.now()).first<Session>();
  if (!session || Date.now() - session.lastSeenAt >= 24 * 60 * 60 * 1000) return null;
  if (session.role === 'STUDENT' && session.affiliationStatus === 'VERIFIED' && (session.verifiedUntil ?? 0) <= Date.now()) {
    const now = Date.now();
    await expireStudentEligibility(c.env.DB, session.userId, now);
    return createReverificationSession(c, session, now);
  }
  if (Date.now() - session.lastSeenAt >= 15 * 60 * 1000) {
    await c.env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .bind(Date.now(), tokenHash).run();
  }
  return { session, token };
}

export async function verifyMutation(c: AppContext, token: string, session: Session): Promise<boolean> {
  if (c.req.header('Origin') !== c.env.APP_ORIGIN) return false;
  const submitted = c.req.header('X-CSRF-Token') ?? '';
  return await sha256(submitted) === session.csrfHash && await verifyCsrf(c.env, token, submitted);
}
