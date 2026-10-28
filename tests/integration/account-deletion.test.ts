import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const driverId = '20000000-0000-4000-8000-000000000001';
const riderId = '20000000-0000-4000-8000-000000000002';
const tripId = '50000000-0000-4000-8000-000000000001';

async function request(path: string, options: { method?: string; cookie?: string; csrf?: string; key?: string; body?: unknown } = {}) {
  const headers = new Headers({ Origin: origin });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
  if (options.key) headers.set('Idempotency-Key', options.key);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(new Request(new URL(path, origin), {
    method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

it('requires a recent session and pseudonymizes the account while ending active data access', async () => {
  const authenticated = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'driver' } });
  expect(authenticated.status).toBe(201);
  const cookie = authenticated.headers.get('Set-Cookie')!.split(';', 1)[0];
  const profileResponse = await request('/api/v1/me', { cookie });
  const profile = await profileResponse.json() as { data: { csrfToken: string } };
  const session = { cookie, csrf: profile.data.csrfToken };

  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }

  const riderAuth = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'rider' } });
  const riderCookie = riderAuth.headers.get('Set-Cookie')!.split(';', 1)[0];
  const riderMe = await request('/api/v1/me', { cookie: riderCookie });
  const riderSession = { cookie: riderCookie, csrf: (await riderMe.json() as { data: { csrfToken: string } }).data.csrfToken };
  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...riderSession, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO latest_locations
    (user_id,trip_id,request_id,lat,lng,accuracy_m,captured_at,received_at,expires_at,sequence)
    VALUES(?,?,NULL,37.5,127,10,?,?,?,1)`).bind(driverId, tripId, now, now, now + 60_000).run();
  const activeRequest = await request(`/api/v1/trips/${tripId}/requests`, {
    method: 'POST', ...riderSession, key: crypto.randomUUID(),
    body: { desiredDepartureAt: Date.now() + 600_000, genderFilter: 'ANY', preferSameDepartment: true },
  });
  expect(activeRequest.status).toBe(201);
  const requestId = (await activeRequest.json() as { data: { id: string } }).data.id;
  const blocked = await request('/api/v1/blocks', {
    method: 'POST', ...session, body: { blockedUserId: riderId },
  });
  expect(blocked.status).toBe(201);
  await env.DB.prepare(`INSERT INTO location_disclosure_records
    (id,owner_user_id,recipient_user_id,recipient_nickname,recipient_role,trip_id,request_id,sequence,purpose,provided_at)
    VALUES(?,?,?,'가상 운전자','DRIVER',?,?,1,'MEETING',?)`)
    .bind(crypto.randomUUID(), riderId, driverId, tripId, requestId, Date.now()).run();
  const ownedDisclosureId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO location_disclosure_records
    (id,owner_user_id,recipient_user_id,recipient_nickname,recipient_role,trip_id,request_id,sequence,purpose,provided_at)
    VALUES(?,?,?,'가상 탑승자','RIDER',?,?,1,'MEETING',?)`)
    .bind(ownedDisclosureId, driverId, riderId, tripId, requestId, Date.now()).run();
  await env.DB.prepare(`INSERT INTO location_access_records
    (id,user_id,location_owner_user_id,action,trip_id,request_id,accessed_at)
    VALUES(?,?,?,'UPLOAD',?,?,?)`)
    .bind(crypto.randomUUID(), driverId, driverId, tripId, requestId, Date.now()).run();

  await expect(env.DB.prepare("UPDATE users SET account_status='DELETED' WHERE id=?").bind(riderId).run())
    .rejects.toThrow(/USER_DELETION_AUDIT_REQUIRED/);

  expect((await request('/api/v1/me', { method: 'DELETE', cookie: session.cookie })).status).toBe(403);

  await env.DB.prepare('UPDATE sessions SET created_at=? WHERE user_id=?').bind(now - 6 * 60_000, driverId).run();
  const stale = await request('/api/v1/me', { method: 'DELETE', ...session });
  expect(stale.status).toBe(403);
  expect((await stale.json() as { error: { code: string } }).error.code).toBe('REAUTH_REQUIRED');

  await env.DB.prepare('UPDATE sessions SET created_at=? WHERE user_id=?').bind(Date.now(), driverId).run();
  const deleted = await request('/api/v1/me', { method: 'DELETE', ...session });
  expect(deleted.status).toBe(200);
  expect((await deleted.json() as { data: { status: string } }).data.status).toBe('DELETED');
  expect(deleted.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect((await request('/api/v1/me', { cookie: session.cookie })).status).toBe(401);

  const user = await env.DB.prepare(`SELECT account_status AS accountStatus,email,google_sub AS googleSub,nickname,gender,
      department_id AS departmentId,affiliation_status AS affiliationStatus
    FROM users WHERE id=?`).bind(driverId).first<{
      accountStatus: string; email: string; googleSub: string; nickname: string; gender: string;
      departmentId: string | null; affiliationStatus: string;
    }>();
  expect(user).toMatchObject({ accountStatus: 'DELETED', email: `deleted+${driverId}@example.invalid`,
    googleSub: `deleted:${driverId}`, nickname: '탈퇴한 사용자', gender: 'UNDISCLOSED', departmentId: null, affiliationStatus: 'REJECTED' });
  expect((await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first<{ status: string }>())?.status).toBe('CANCELLED');
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM active_user_locks WHERE user_id=?').bind(driverId).first<{ count: number }>())?.count).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM latest_locations WHERE user_id=?').bind(driverId).first<{ count: number }>())?.count).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').bind(driverId).first<{ count: number }>())?.count).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM consents WHERE user_id=? AND revoked_at IS NOT NULL')
    .bind(driverId).first<{ count: number }>())?.count).toBe(2);
  expect((await env.DB.prepare(`SELECT vehicle_identifier AS identifier FROM driver_profiles WHERE user_id=?`)
    .bind(driverId).first<{ identifier: string }>())?.identifier).toBe('삭제됨');
  expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE actor_id=? AND event_type='USER_DELETED'`)
    .bind(driverId).first<{ count: number }>())?.count).toBe(1);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM user_blocks WHERE blocker_id=? OR blocked_id=?')
    .bind(driverId, driverId).first<{ count: number }>())?.count).toBe(0);
  expect((await env.DB.prepare(`SELECT recipient_nickname FROM location_disclosure_records WHERE owner_user_id=? AND request_id=?`)
    .bind(riderId, requestId).first<{ recipient_nickname: string }>())?.recipient_nickname).toBe('탈퇴한 사용자');
  expect(await env.DB.prepare('SELECT id FROM location_disclosure_records WHERE id=?').bind(ownedDisclosureId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM location_access_records WHERE location_owner_user_id=?')
    .bind(driverId).first<{ count: number }>()).toMatchObject({ count: 0 });
});
