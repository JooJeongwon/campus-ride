import * as oauth from 'oauth4webapi';
import { z } from 'zod';
import type { Bindings } from '../env';
import { allowedDomains } from '../env';
import { sha256 } from './session';

const encoder = new TextEncoder();
const issuer = new URL('https://accounts.google.com');
const redirectPath = '/api/v1/auth/google/callback';
const client = (clientId: string): oauth.Client => ({ client_id: clientId });

export function callbackUri(env: Bindings): string {
  return new URL(redirectPath, env.APP_ORIGIN).href;
}

export function isGoogleConfigured(env: Bindings): boolean {
  return env.SCHOOL_CONFIG_READY === 'true'
    && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.CSRF_HMAC_KEY)
    && environmentReady(env);
}

function environmentReady(env: Bindings): boolean {
  return Boolean(env.SCHOOL_ID && env.CAMPUS_ID
    && ['MANUAL_REVIEW', 'SCHOOL_ASSERTION'].includes(env.STUDENT_VERIFICATION_MODE ?? '')
    && allowedDomains(env.ALLOWED_EMAIL_DOMAINS).length && allowedDomains(env.ALLOWED_HOSTED_DOMAINS).length
    && env.DEPARTMENT_TEMPLATE && env.DEPARTMENT_ALIASES_JSON
    && env.POLICY_TERMS_VERSION && env.POLICY_TERMS_URL && env.POLICY_PRIVACY_VERSION && env.POLICY_PRIVACY_URL);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function derivedNonce(binding: string, state: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(binding), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(state));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function validReturnPath(value: string | undefined, origin: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })) return '/';
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

export async function authorizationUrl(env: Bindings, db: D1Database, browserBinding: string, returnPath: string): Promise<string> {
  if (!isGoogleConfigured(env) || !env.GOOGLE_CLIENT_ID) throw new Error('OIDC is not configured');
  const asResponse = await oauth.discoveryRequest(issuer);
  const as = await oauth.processDiscoveryResponse(issuer, asResponse);
  if (!as.authorization_endpoint || !as.token_endpoint || !as.jwks_uri) throw new Error('Google OIDC metadata is incomplete');

  const state = randomToken();
  const nonce = await derivedNonce(browserBinding, state);
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM oauth_states WHERE expires_at<=?').bind(now),
    db.prepare(`INSERT INTO oauth_states
      (state_hash,nonce_hash,browser_binding_hash,safe_return_path,created_at,expires_at,pkce_verifier)
      VALUES(?,?,?,?,?,?,?)`).bind(
      await sha256(state), await sha256(nonce), await sha256(browserBinding), returnPath, now, now + 10 * 60 * 1000, verifier,
    ),
  ]);

  const url = new URL(as.authorization_endpoint);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackUri(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.href;
}

export async function consumeAuthorizationResponse(
  env: Bindings,
  db: D1Database,
  callback: URL,
  state: string,
  browserBinding: string,
): Promise<{ subject: string; email: string; name: string; departmentCode: string | null; departmentStatus: 'UNVERIFIED' | 'UNKNOWN'; departmentSource: string | null; parserVersion: string | null; returnPath: string }> {
  if (!isGoogleConfigured(env) || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('OIDC is not configured');
  const now = Date.now();
  if (!/^[A-Za-z0-9_-]{43}$/.test(browserBinding)) throw new Error('OAuth browser binding is invalid');
  const request = await db.prepare(`UPDATE oauth_states SET consumed_at=?
    WHERE state_hash=? AND browser_binding_hash=? AND consumed_at IS NULL AND expires_at>?
    RETURNING nonce_hash,safe_return_path,pkce_verifier`)
    .bind(now, await sha256(state), await sha256(browserBinding), now).first<{
      nonce_hash: string; safe_return_path: string; pkce_verifier: string;
    }>();
  if (!request?.pkce_verifier) throw new Error('OAuth state is invalid or expired');
  const nonce = await derivedNonce(browserBinding, state);
  if (await sha256(nonce) !== request.nonce_hash) throw new Error('OAuth nonce binding failed');

  const asResponse = await oauth.discoveryRequest(issuer);
  const as = await oauth.processDiscoveryResponse(issuer, asResponse);
  const oauthClient = client(env.GOOGLE_CLIENT_ID);
  const parameters = oauth.validateAuthResponse(as, oauthClient, callback, state);
  const tokenResponse = await oauth.authorizationCodeGrantRequest(
    as, oauthClient, oauth.ClientSecretPost(env.GOOGLE_CLIENT_SECRET), parameters,
    callbackUri(env), request.pkce_verifier,
  );
  const tokens = await oauth.processAuthorizationCodeResponse(as, oauthClient, tokenResponse, {
    expectedNonce: nonce,
    requireIdToken: true,
  });
  await oauth.validateApplicationLevelSignature(as, tokenResponse);
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (!claims || typeof claims.sub !== 'string' || !claims.sub
    || claims.email_verified !== true || typeof claims.email !== 'string'
    || typeof claims.hd !== 'string') throw new Error('Google account claims are incomplete');

  const email = claims.email.trim().toLowerCase();
  if (!z.email().safeParse(email).success) throw new Error('Google email claim is invalid');
  const emailAt = email.lastIndexOf('@');
  const emailDomain = emailAt < 1 ? '' : email.slice(emailAt + 1);
  if (!allowedDomains(env.ALLOWED_EMAIL_DOMAINS).includes(emailDomain)
    || !allowedDomains(env.ALLOWED_HOSTED_DOMAINS).includes(claims.hd.toLowerCase())) {
    throw new Error('Google account is outside the allowed school domains');
  }
  const name = Array.from(typeof claims.name === 'string' ? claims.name : '학교 사용자')
    .filter((character) => { const code = character.codePointAt(0) ?? 0; return code >= 32 && code !== 127; })
    .join('').trim().slice(0, 30) || '학교 사용자';
  const departmentSource = env.DEPARTMENT_SOURCE_FIELD ?? null;
  const departmentInput = departmentSource === 'EMAIL_LOCAL_PART'
    ? email.slice(0, emailAt)
    : departmentSource === 'GOOGLE_NAME' && typeof claims.name === 'string' ? claims.name.slice(0, 120) : '';
  const department = await parseDepartment(db, env, departmentInput);

  return {
    subject: claims.sub,
    email,
    name,
    departmentCode: department.code,
    departmentStatus: department.status,
    departmentSource,
    parserVersion: env.DEPARTMENT_PARSER_VERSION ?? 'synthetic-v1',
    returnPath: request.safe_return_path,
  };
}

async function parseDepartment(db: D1Database, env: Bindings, input: string): Promise<{ code: string | null; status: 'UNVERIFIED' | 'UNKNOWN' }> {
  if (!input || input.length > 160 || !env.SCHOOL_ID || !env.DEPARTMENT_TEMPLATE || !env.DEPARTMENT_ALIASES_JSON) {
    return { code: null, status: 'UNKNOWN' };
  }
  try {
    const delimiter = env.DEPARTMENT_TEMPLATE.match(/[-._]/)?.[0];
    if (!delimiter) return { code: null, status: 'UNKNOWN' };
    const template = env.DEPARTMENT_TEMPLATE.split(delimiter);
    const parts = input.toLowerCase().split(delimiter);
    if (template.length !== parts.length || template.length > 20 || parts.some((part) => !part || part.length > 64)) {
      return { code: null, status: 'UNKNOWN' };
    }
    let candidate: string | undefined;
    for (const [index, segment] of template.entries()) {
      if (segment === '{department}') {
        if (candidate) return { code: null, status: 'UNKNOWN' };
        candidate = parts[index];
      } else if (segment !== '{id}' && segment !== '{*}' && segment.toLowerCase() !== parts[index]) {
        return { code: null, status: 'UNKNOWN' };
      }
    }
    if (!candidate) return { code: null, status: 'UNKNOWN' };
    const aliases = JSON.parse(env.DEPARTMENT_ALIASES_JSON) as Record<string, unknown>;
    const code = aliases[candidate];
    if (typeof code !== 'string') return { code: null, status: 'UNKNOWN' };
    const department = await db.prepare('SELECT id FROM departments WHERE school_id=? AND code=? AND active=1')
      .bind(env.SCHOOL_ID, code).first<{ id: string }>();
    return department ? { code: department.id, status: 'UNVERIFIED' } : { code: null, status: 'UNKNOWN' };
  } catch {
    return { code: null, status: 'UNKNOWN' };
  }
}
