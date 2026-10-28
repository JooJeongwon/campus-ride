import { env } from 'cloudflare:workers';
import { beforeAll, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { sha256 } from '../../src/worker/auth/session';

const clientId = 'ci-client.apps.googleusercontent.com';
const issuer = 'https://accounts.google.com';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const tokenUrl = 'https://oauth2.googleapis.com/token';
const jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
const encoder = new TextEncoder();
let signingKey: CryptoKey;
let wrongSigningKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const wrongPair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  signingKey = keyPair.privateKey;
  wrongSigningKey = wrongPair.privateKey;
  publicJwk = Object.assign(await crypto.subtle.exportKey('jwk', keyPair.publicKey), { kid: 'test-key', alg: 'RS256', use: 'sig' });
});

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

async function signIdToken(claims: Record<string, unknown>, key = signingKey): Promise<string> {
  const signingInput = `${encodeJson({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

const providerMetadata = {
  issuer,
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: tokenUrl,
  jwks_uri: jwksUrl,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code'],
};

async function beginLogin(
  overrides: Record<string, unknown> = {},
  invalidSignature = false,
  departmentSource: 'EMAIL_LOCAL_PART' | 'GOOGLE_NAME' = 'EMAIL_LOCAL_PART',
  authTestOnly = false,
) {
  const configuredEnv = {
    ...env,
    APP_ENV: authTestOnly ? 'staging' : env.APP_ENV,
    APP_ORIGIN: authTestOnly ? 'https://campus-ride-staging.jwjoo0512.workers.dev' : env.APP_ORIGIN,
    SCHOOL_CONFIG_READY: authTestOnly ? 'false' : 'true',
    ALLOW_DEV_AUTH: authTestOnly ? 'false' : env.ALLOW_DEV_AUTH,
    STAGING_AUTH_TEST_ONLY: authTestOnly ? 'true' : 'false',
    SCHOOL_ID: authTestOnly ? 'gachon-university' : 'synthetic-school',
    CAMPUS_ID: authTestOnly ? 'gachon-global-campus' : 'synthetic-campus',
    ALLOWED_EMAIL_DOMAINS: 'gachon.ac.kr',
    ALLOWED_HOSTED_DOMAINS: 'gachon.ac.kr',
    STUDENT_VERIFICATION_MODE: 'SCHOOL_ASSERTION',
    DEPARTMENT_SOURCE_FIELD: authTestOnly ? undefined : departmentSource,
    DEPARTMENT_TEMPLATE: authTestOnly ? undefined : 'student-{id}-{department}',
    DEPARTMENT_PARSER_VERSION: authTestOnly ? undefined : 'test-v1',
    DEPARTMENT_ALIASES_JSON: authTestOnly ? undefined : '{"cs":"CS"}',
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: 'local-ci-secret-that-is-not-a-credential',
    CSRF_HMAC_KEY: 'local-ci-csrf-key-that-is-long-enough-123',
    POLICY_TERMS_VERSION: authTestOnly ? undefined : 'terms-test-v1',
    POLICY_TERMS_URL: authTestOnly ? undefined : 'https://policy.school.edu/terms',
    POLICY_PRIVACY_VERSION: authTestOnly ? undefined : 'privacy-test-v1',
    POLICY_PRIVACY_URL: authTestOnly ? undefined : 'https://policy.school.edu/privacy',
  };
  let tokenClaims: Record<string, unknown> | undefined;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === discoveryUrl) return Response.json(providerMetadata);
    if (request.url === jwksUrl) return Response.json({ keys: [publicJwk] });
    if (request.url === tokenUrl && request.method === 'POST' && tokenClaims) {
      return Response.json({
        access_token: 'synthetic-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
        id_token: await signIdToken(tokenClaims, invalidSignature ? wrongSigningKey : signingKey),
      });
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  });
  const request = (path: string, init?: RequestInit) => worker.request(new URL(path, configuredEnv.APP_ORIGIN).href, init, configuredEnv);

  try {
    const start = await request('/api/v1/auth/google/start?returnTo=%2Fprofile%3Ftab%3Dconsent');
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get('Location')!);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorization.searchParams.get('state')!;
    const nonce = authorization.searchParams.get('nonce')!;
    const oauthCookie = start.headers.get('Set-Cookie')!.split(';', 1)[0];
    const suffix = crypto.randomUUID().slice(0, 8);
    const now = Math.floor(Date.now() / 1000);
    tokenClaims = {
      iss: issuer,
      aud: clientId,
      sub: `test-sub-${crypto.randomUUID()}`,
      email: `student-${suffix}-cs@gachon.ac.kr`,
      email_verified: true,
      hd: 'gachon.ac.kr',
      name: '합성 테스트 학생',
      iat: now,
      exp: now + 600,
      nonce,
      ...overrides,
    };
    return {
      oauthCookie,
      state,
      tokenClaims,
      callback: (cookie = oauthCookie, callbackState = state) => request(
        `/api/v1/auth/google/callback?code=synthetic-code&state=${encodeURIComponent(callbackState)}`,
        { headers: { Cookie: cookie } },
      ),
      profile: (cookie: string) => request('/api/v1/me', { headers: { Cookie: cookie } }),
      request,
      close: () => fetchSpy.mockRestore(),
    };
  } catch (error) {
    fetchSpy.mockRestore();
    throw error;
  }
}

it('validates Google OIDC and immediately verifies a Gachon account with a bound browser session', async () => {
  const flow = await beginLogin();
  try {
    const callback = await flow.callback();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/profile?tab=consent');
    expect(callback.headers.get('Set-Cookie')).toContain('campus_session=');
    const user = await env.DB.prepare(`SELECT id,affiliation_status AS affiliation,verified_until AS verifiedUntil,gender,department_status AS department,
      department_id AS departmentId,department_source AS departmentSource,parser_version AS parserVersion
      FROM users WHERE google_sub=?`).bind(flow.tokenClaims.sub)
      .first<{ id: string; affiliation: string; verifiedUntil: number; gender: string; department: string; departmentId: string; departmentSource: string; parserVersion: string }>();
    expect(user).toMatchObject({ affiliation: 'VERIFIED', gender: 'UNDISCLOSED', department: 'UNVERIFIED',
      departmentId: '10000000-0000-4000-8000-000000000001', departmentSource: 'EMAIL_LOCAL_PART', parserVersion: 'test-v1' });
    expect(user?.verifiedUntil).toBeGreaterThan(Date.now());
    expect(user?.verifiedUntil).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(await env.DB.prepare(`SELECT method,outcome FROM student_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(user?.id).first()).toEqual({ method: 'SCHOOL_ASSERTION', outcome: 'VERIFIED' });
    await expect(env.DB.prepare(`INSERT INTO student_verifications
      (id,user_id,method,outcome,verified_at,valid_until,created_at)
      VALUES(?,?,'SCHOOL_ASSERTION','VERIFIED',?,?,?)`)
      .bind(crypto.randomUUID(), '20000000-0000-4000-8000-000000000003', Date.now(), Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()).run())
      .rejects.toThrow('SCHOOL_GOOGLE_ASSERTION_INVALID');
    const replay = await flow.callback();
    expect(replay.status).toBe(401);
    expect((await replay.text())).not.toContain(flow.tokenClaims.email as string);
  } finally {
    flow.close();
  }
});

it('verifies a real-account claim in closed staging without creating an app account or session', async () => {
  const flow = await beginLogin({}, false, 'EMAIL_LOCAL_PART', true);
  try {
    const callback = await flow.callback();
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain('학교 계정 확인 성공');
    expect(page).toContain('staging API는 계속 닫혀 있습니다');
    expect(page).not.toContain(flow.tokenClaims.email as string);
    expect(await env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(flow.tokenClaims.sub).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.google_sub=?`)
      .bind(flow.tokenClaims.sub).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT v.id FROM student_verifications v JOIN users u ON u.id=v.user_id WHERE u.google_sub=?`)
      .bind(flow.tokenClaims.sub).first()).toBeNull();
    expect(await env.DB.prepare('SELECT state_hash FROM oauth_states WHERE state_hash=?').bind(await sha256(flow.state)).first()).toBeNull();
    expect((await flow.request('/api/v1/health')).status).toBe(503);
    expect((await flow.request('/api/v1/auth/dev', { method: 'POST' })).status).toBe(503);
  } finally {
    flow.close();
  }
});

it.each([
  ['unverified email', { email_verified: false }],
  ['unapproved email domain', { email: 'student-123-cs@outside.example.com' }],
  ['unapproved hosted domain', { hd: 'outside.example.com' }],
  ['wrong issuer', { iss: 'https://outside.example.com' }],
  ['wrong audience', { aud: 'another-client.apps.googleusercontent.com' }],
  ['wrong nonce', { nonce: 'not-the-request-nonce' }],
  ['expired ID token', { exp: 1 }],
  ['missing stable subject', { sub: '' }],
])('rejects %s and does not create an account', async (_caseName, claims) => {
  const flow = await beginLogin(claims);
  try {
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(flow.tokenClaims.sub).first()).toBeNull();
    expect(await response.text()).not.toContain(flow.tokenClaims.email as string);
    expect((await flow.callback()).status).toBe(401);
  } finally {
    flow.close();
  }
});

it('keeps unknown departments unverified and supports the configured Google-name parser input', async () => {
  const unknown = await beginLogin({ email: 'student-123-unknown@gachon.ac.kr' });
  try {
    expect((await unknown.callback()).status).toBe(302);
    const user = await env.DB.prepare('SELECT department_id AS departmentId,department_status AS status FROM users WHERE google_sub=?')
      .bind(unknown.tokenClaims.sub).first<{ departmentId: string | null; status: string }>();
    expect(user).toEqual({ departmentId: null, status: 'UNKNOWN' });
  } finally {
    unknown.close();
  }

  const fromName = await beginLogin({ name: 'student-123-cs' }, false, 'GOOGLE_NAME');
  try {
    expect((await fromName.callback()).status).toBe(302);
    const user = await env.DB.prepare('SELECT department_status AS status,department_source AS source FROM users WHERE google_sub=?')
      .bind(fromName.tokenClaims.sub).first<{ status: string; source: string }>();
    expect(user).toEqual({ status: 'UNVERIFIED', source: 'GOOGLE_NAME' });
  } finally {
    fromName.close();
  }
});

it('blocks suspended identities and projects expired student status on reauthentication', async () => {
  const rider = '20000000-0000-4000-8000-000000000002';
  await env.DB.prepare("UPDATE users SET account_status='SUSPENDED' WHERE id=?").bind(rider).run();
  const suspended = await beginLogin({ sub: 'synthetic-rider' });
  try {
    expect((await suspended.callback()).status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').bind(rider).first('count')).toBe(0);
  } finally {
    suspended.close();
  }

  await env.DB.prepare("UPDATE users SET account_status='ACTIVE',affiliation_status='VERIFIED',verified_until=? WHERE id=?")
    .bind(Date.now() - 1000, rider).run();
  await env.DB.prepare(`INSERT INTO student_verifications (id,user_id,method,outcome,created_at)
    VALUES(?,?,'MANUAL_REVIEW','PENDING',?)`).bind(crypto.randomUUID(), rider, Date.now()).run();
  const expired = await beginLogin({ sub: 'synthetic-rider' });
  try {
    const callback = await expired.callback();
    expect(callback.status).toBe(302);
    const cookie = callback.headers.get('Set-Cookie')!.match(/campus_session=[^;,]+/)?.[0];
    expect(cookie).toBeDefined();
    const profileResponse = await expired.profile(cookie!);
    const profile = await profileResponse.json() as { data: { affiliation: { status: string } } };
    expect(profile.data.affiliation.status).toBe('VERIFIED');
    expect(await env.DB.prepare('SELECT verified_until FROM users WHERE id=?').bind(rider).first<number>('verified_until'))
      .toBeGreaterThan(Date.now());
    expect(await env.DB.prepare("SELECT outcome FROM student_verifications WHERE user_id=? AND method='MANUAL_REVIEW'")
      .bind(rider).first<string>('outcome')).toBe('EXPIRED');
  } finally {
    expired.close();
  }
});

it('rejects a mismatched signature and binds OAuth state to the starting browser', async () => {
  const invalidSignature = await beginLogin({}, true);
  try {
    const response = await invalidSignature.callback();
    expect(response.status).toBe(401);
    expect(await env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(invalidSignature.tokenClaims.sub).first()).toBeNull();
  } finally {
    invalidSignature.close();
  }

  const flow = await beginLogin();
  try {
    const wrongBrowser = await flow.callback('campus_oauth=wrong-browser-binding');
    expect(wrongBrowser.status).toBe(401);
    const wrongState = await flow.callback(flow.oauthCookie, `${flow.state}x`);
    expect(wrongState.status).toBe(401);
    const originalBrowser = await flow.callback();
    expect(originalBrowser.status).toBe(302);
  } finally {
    flow.close();
  }
});
