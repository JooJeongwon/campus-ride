import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const pendingUser = '20000000-0000-4000-8000-000000000003';

async function request(path: string, options: {
  method?: string;
  origin?: string | null;
  cookie?: string;
  csrf?: string;
  body?: unknown;
} = {}): Promise<Response> {
  const headers = new Headers();
  if (options.origin !== null) headers.set('Origin', options.origin ?? origin);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return exports.default.fetch(new Request(new URL(path, origin), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const response = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'pending' } });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get('Set-Cookie');
  expect(setCookie).toContain('campus_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Lax');
  const cookie = setCookie!.split(';', 1)[0];
  const me = await request('/api/v1/me', { cookie });
  expect(me.status).toBe(200);
  const payload = await me.json() as { data: { csrfToken: string } };
  expect(payload.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { cookie, csrf: payload.data.csrfToken };
}

async function hashSessionCookie(cookie: string): Promise<string> {
  const token = cookie.slice('campus_session='.length);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

it('keeps local login synthetic and protects the session profile', async () => {
  const forgedOrigin = await request('/api/v1/auth/dev', {
    method: 'POST', origin: 'https://attacker.invalid', body: { identity: 'pending' },
  });
  expect(forgedOrigin.status).toBe(404);
  expect(forgedOrigin.headers.get('Set-Cookie')).toBeNull();

  const { cookie } = await login();
  const response = await request('/api/v1/me', { cookie });
  const body = await response.text();
  expect(body).not.toContain('students.example.invalid');
  expect(body).not.toContain('synthetic-pending');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const profile = JSON.parse(body) as { data: { id: string; affiliation: { status: string }; requiredConsents: Record<string, { accepted: boolean }> } };
  expect(profile.data.id).toBe(pendingUser);
  expect(profile.data.affiliation.status).toBe('PENDING');
  expect(profile.data.requiredConsents.TERMS.accepted).toBe(false);
  expect(profile.data.requiredConsents.PRIVACY.accepted).toBe(false);
  const tokenHash = await env.DB.prepare('SELECT token_hash AS tokenHash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1')
    .bind(pendingUser).first<{ tokenHash: string }>();
  expect(tokenHash?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(tokenHash?.tokenHash).not.toBe(cookie.slice('campus_session='.length));
});

it('enforces exact-origin CSRF, current policy consent, revocation and pending verification access', async () => {
  const { cookie, csrf } = await login();
  const profilePatch = { nickname: '로컬 확인 사용자' };
  const noConsent = await request('/api/v1/me', { method: 'PATCH', cookie, csrf, body: profilePatch });
  expect(noConsent.status).toBe(403);
  expect((await noConsent.json() as { error: { code: string } }).error.code).toBe('CONSENT_REQUIRED');
  const noCsrf = await request('/api/v1/me', { method: 'PATCH', cookie, body: profilePatch });
  expect(noCsrf.status).toBe(403);
  expect((await noCsrf.json() as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  const wrongOrigin = await request('/api/v1/me/consents', {
    method: 'POST', cookie, csrf, origin: 'https://attacker.invalid',
    body: { kind: 'TERMS', policyVersion: 'local-demo-v1', granted: true },
  });
  expect(wrongOrigin.status).toBe(403);

  const stalePolicy = await request('/api/v1/me/consents', {
    method: 'POST', cookie, csrf, body: { kind: 'TERMS', policyVersion: 'old-version', granted: true },
  });
  expect(stalePolicy.status).toBe(409);
  expect((await stalePolicy.json() as { error: { code: string } }).error.code).toBe('POLICY_VERSION_CHANGED');
  const blockedVerification = await request('/api/v1/me/verification-requests', { method: 'POST', cookie, csrf });
  expect(blockedVerification.status).toBe(403);

  for (const kind of ['TERMS', 'PRIVACY']) {
    const consent = await request('/api/v1/me/consents', {
      method: 'POST', cookie, csrf, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    });
    expect(consent.status).toBe(200);
  }
  await request('/api/v1/me/consents', {
    method: 'POST', cookie, csrf, body: { kind: 'TERMS', policyVersion: 'local-demo-v1', granted: true },
  });
  const activeCounts = await env.DB.prepare(`SELECT kind,COUNT(*) AS count FROM consents
    WHERE user_id=? AND revoked_at IS NULL GROUP BY kind ORDER BY kind`).bind(pendingUser).all<{ kind: string; count: number }>();
  expect(activeCounts.results).toEqual([{ kind: 'PRIVACY', count: 1 }, { kind: 'TERMS', count: 1 }]);

  const savedProfile = await request('/api/v1/me', { method: 'PATCH', cookie, csrf, body: profilePatch });
  expect(savedProfile.status).toBe(200);
  const verification = await request('/api/v1/me/verification-requests', { method: 'POST', cookie, csrf });
  expect(verification.status).toBe(201);
  const verificationBody = await verification.json() as { data: { id: string } };
  const duplicate = await request('/api/v1/me/verification-requests', { method: 'POST', cookie, csrf });
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json() as { data: { id: string } }).data.id).toBe(verificationBody.data.id);
  expect((await request('/api/v1/admin/verification-requests', { cookie })).status).toBe(404);
  await expect(env.DB.prepare(`INSERT INTO audit_events
    (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).bind(
    crypto.randomUUID(), pendingUser, 'STUDENT_VERIFICATION_VERIFIED', 'student_verification',
    verificationBody.data.id, JSON.stringify({ validUntil: Date.now() + 60_000 }), Date.now(),
  ).run()).rejects.toThrow(/VERIFICATION_REVIEW_FORBIDDEN/);

  const revoked = await request('/api/v1/me/consents', {
    method: 'POST', cookie, csrf, body: { kind: 'PRIVACY', policyVersion: 'local-demo-v1', granted: false },
  });
  expect(revoked.status).toBe(200);
  const deniedAgain = await request('/api/v1/me/verification-requests', { method: 'POST', cookie, csrf });
  expect(deniedAgain.status).toBe(403);
  const logout = await request('/api/v1/auth/logout', { method: 'POST', cookie, csrf });
  expect(logout.status).toBe(200);
  expect((await request('/api/v1/me', { cookie })).status).toBe(401);
});

it('rejects sessions after the idle or absolute lifetime expires', async () => {
  const idleSession = await login();
  const idleHash = await hashSessionCookie(idleSession.cookie);
  await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?')
    .bind(Date.now() - 24 * 60 * 60 * 1000 - 1000, idleHash).run();
  expect((await request('/api/v1/me', { cookie: idleSession.cookie })).status).toBe(401);

  const absoluteSession = await login();
  const absoluteHash = await hashSessionCookie(absoluteSession.cookie);
  await env.DB.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
    .bind(Date.now() - 1, absoluteHash).run();
  expect((await request('/api/v1/me', { cookie: absoluteSession.cookie })).status).toBe(401);
});
