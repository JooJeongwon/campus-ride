import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { cleanupExpiredData } from '../../src/worker/jobs/cleanup';
import { csrfToken, sha256 } from '../../src/worker/auth/session';

const origin = 'http://localhost:8787';
const routeId = '40000000-0000-4000-8000-000000000002';
const departmentId = '10000000-0000-4000-8000-000000000001';
type Session = { cookie: string; csrf: string };

async function request(path: string, options: {
  method?: string; cookie?: string; csrf?: string; key?: string; body?: unknown;
} = {}) {
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

async function insertUser(id: string, role: 'STUDENT' | 'ADMIN', now: number) {
  await env.DB.prepare(`INSERT INTO users
    (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,
     parser_version,gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
    VALUES(?,?,'synthetic-school','synthetic-campus',?, ?,?,'VERIFIED','DIRECTORY',
      'synthetic-v1','WOMAN',?,?, 'ACTIVE',?,?,?)`)
    .bind(id, `restriction-${id}`, `${id}@students.example.invalid`, `시험 ${role}`, departmentId,
      role === 'STUDENT' ? 'VERIFIED' : 'PENDING', role === 'STUDENT' ? now + 86_400_000 : null,
      role, now, now).run();
}

async function sessionFor(userId: string): Promise<Session> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const csrf = await csrfToken(env, token);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions
    (token_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)`)
    .bind(await sha256(token), userId, await sha256(csrf), now, now, now + 60 * 60_000).run();
  return { cookie: `campus_session=${token}`, csrf };
}

async function grantConsents(session: Session) {
  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }
}

async function cleanup(users: string[], tripIds: string[], requestIds: string[]) {
  await env.DB.prepare('DELETE FROM location_access_records WHERE user_id IN (' + users.map(() => '?').join(',') + ') OR location_owner_user_id IN (' + users.map(() => '?').join(',') + ')')
    .bind(...users, ...users).run();
  await env.DB.prepare('DELETE FROM location_notice_presence WHERE user_id IN (' + users.map(() => '?').join(',') + ')')
    .bind(...users).run();
  await env.DB.prepare('DELETE FROM audit_events WHERE actor_id IN (' + users.map(() => '?').join(',') + ') OR resource_id IN (' + [...users, ...tripIds, ...requestIds].map(() => '?').join(',') + ')')
    .bind(...users, ...users, ...tripIds, ...requestIds).run();
  await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  await env.DB.prepare('DELETE FROM latest_locations WHERE user_id IN (' + users.map(() => '?').join(',') + ') OR trip_id IN (' + tripIds.map(() => '?').join(',') + ')')
    .bind(...users, ...tripIds).run();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  await env.DB.prepare('DELETE FROM consents WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  if (requestIds.length) {
    await env.DB.prepare('DELETE FROM ride_requests WHERE id IN (' + requestIds.map(() => '?').join(',') + ')').bind(...requestIds).run();
  }
  if (tripIds.length) {
    await env.DB.prepare('DELETE FROM trips WHERE id IN (' + tripIds.map(() => '?').join(',') + ')').bind(...tripIds).run();
  }
  await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  await env.DB.prepare('DELETE FROM student_verifications WHERE user_id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
  await env.DB.prepare('DELETE FROM users WHERE id IN (' + users.map(() => '?').join(',') + ')').bind(...users).run();
}

it('suspends a student, revokes sessions and aborts a boarded trip without locations', async () => {
  const now = Date.now();
  const adminId = crypto.randomUUID();
  const driverId = crypto.randomUUID();
  const riderId = crypto.randomUUID();
  const userIds = [adminId, driverId, riderId];
  const tripIds: string[] = [];
  const requestIds: string[] = [];
  try {
    await insertUser(adminId, 'ADMIN', now);
    await insertUser(driverId, 'STUDENT', now);
    await insertUser(riderId, 'STUDENT', now);
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'시험 차량','회색','TEST-ONLY',1,'VERIFIED',?,?)`)
      .bind(driverId, now + 86_400_000, now).run();
    const admin = await sessionFor(adminId);
    const driver = await sessionFor(driverId);
    const rider = await sessionFor(riderId);
    await Promise.all([grantConsents(admin), grantConsents(driver), grantConsents(rider)]);

    const departureAt = Date.now() + 600_000;
    const createdTrip = await request('/api/v1/trips', {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { routeId, departureAt, seatCapacity: 1, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdTrip.status).toBe(201);
    const tripId = (await createdTrip.json() as { data: { id: string } }).data.id;
    tripIds.push(tripId);
    const createdRequest = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: departureAt, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdRequest.status).toBe(201);
    const requestId = (await createdRequest.json() as { data: { id: string } }).data.id;
    requestIds.push(requestId);
    expect((await request(`/api/v1/requests/${requestId}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);
    const issue = await request(`/api/v1/requests/${requestId}/boarding-code`, { method: 'POST', ...rider });
    const code = (await issue.json() as { data: { code: string } }).data.code;
    expect((await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code },
    })).status).toBe(200);
    expect((await request('/api/v1/locations/me', { cookie: driver.cookie, method: 'PUT' })).status).toBe(404);
    expect((await request('/api/v1/locations/me', { cookie: rider.cookie })).status).toBe(404);

    expect((await request(`/api/v1/admin/users/${driverId}/suspend`, {
      method: 'POST', cookie: admin.cookie, body: { reason: '관리자 확인 전용 테스트' },
    })).status).toBe(403);
    const suspended = await request(`/api/v1/admin/users/${driverId}/suspend`, {
      method: 'POST', ...admin, body: { reason: '관리자 확인 전용 테스트' },
    });
    expect(suspended.status).toBe(200);
    expect(await env.DB.prepare('SELECT account_status AS status FROM users WHERE id=?').bind(driverId).first())
      .toMatchObject({ status: 'SUSPENDED' });
    expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first())
      .toMatchObject({ status: 'ABORTED' });
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'ABORTED' });
    expect(await env.DB.prepare('SELECT 1 FROM latest_locations WHERE trip_id=?').bind(tripId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM active_user_locks WHERE user_id IN (?,?)').bind(driverId, riderId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT revoked_at FROM sessions WHERE user_id=? AND revoked_at IS NOT NULL').bind(driverId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT safe_metadata_json AS metadata FROM audit_events WHERE event_type='USER_SUSPENDED' AND resource_id=?")
      .bind(driverId).first()).toMatchObject({ metadata: JSON.stringify({ reason: '관리자 확인 전용 테스트' }) });
    expect((await request('/api/v1/me', { cookie: driver.cookie })).status).toBe(401);
    expect((await request(`/api/v1/admin/users/${driverId}/suspend`, {
      method: 'POST', ...admin, body: { reason: '다시 시도' },
    })).status).toBe(409);
  } finally {
    await cleanup(userIds, tripIds, requestIds);
  }
});

it('expires students on first session use and scheduled cleanup, ending activity and limiting re-verification sessions', async () => {
  const now = Date.now();
  const driverId = crypto.randomUUID();
  const expiredRiderId = crypto.randomUUID();
  const cronStudentId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const userIds = [driverId, expiredRiderId, cronStudentId, adminId];
  const tripIds: string[] = [];
  const requestIds: string[] = [];
  try {
    await insertUser(driverId, 'STUDENT', now);
    await insertUser(expiredRiderId, 'STUDENT', now);
    await insertUser(cronStudentId, 'STUDENT', now);
    await insertUser(adminId, 'ADMIN', now);
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'시험 차량','회색','TEST-ONLY',1,'VERIFIED',?,?)`)
      .bind(driverId, now + 86_400_000, now).run();
    const driver = await sessionFor(driverId);
    const rider = await sessionFor(expiredRiderId);
    const cronStudent = await sessionFor(cronStudentId);
    await Promise.all([grantConsents(driver), grantConsents(rider)]);

    const departureAt = Date.now() + 600_000;
    const createdTrip = await request('/api/v1/trips', {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { routeId, departureAt, seatCapacity: 1, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdTrip.status).toBe(201);
    const tripId = (await createdTrip.json() as { data: { id: string } }).data.id;
    tripIds.push(tripId);
    const createdRequest = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: departureAt, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdRequest.status).toBe(201);
    const requestId = (await createdRequest.json() as { data: { id: string } }).data.id;
    requestIds.push(requestId);

    await env.DB.prepare('UPDATE users SET verified_until=? WHERE id IN (?,?)')
      .bind(now - 1, expiredRiderId, cronStudentId).run();
    const expiredProfileResponse = await request('/api/v1/me', { cookie: rider.cookie });
    expect(expiredProfileResponse.status).toBe(200);
    const expiredProfile = await expiredProfileResponse.json() as { data: { affiliation: { status: string }; csrfToken: string } };
    expect(expiredProfile.data.affiliation.status).toBe('EXPIRED');
    const renewedCookie = expiredProfileResponse.headers.get('Set-Cookie')!.match(/campus_session=[^;,]+/)![0];
    expect((await request('/api/v1/me', { cookie: rider.cookie })).status).toBe(401);
    expect((await request('/api/v1/me/verification-requests', {
      method: 'POST', cookie: renewedCookie, csrf: expiredProfile.data.csrfToken,
    })).status).toBe(201);
    expect((await request('/api/v1/trips', {
      method: 'POST', cookie: renewedCookie, csrf: expiredProfile.data.csrfToken, body: {},
    })).status).toBe(403);
    expect(await env.DB.prepare('SELECT affiliation_status AS status FROM users WHERE id=?').bind(expiredRiderId).first())
      .toMatchObject({ status: 'EXPIRED' });
    const verification = await env.DB.prepare("SELECT id FROM student_verifications WHERE user_id=? AND outcome='PENDING'")
      .bind(expiredRiderId).first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO audit_events
      (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
      VALUES(?,?,'STUDENT_VERIFICATION_VERIFIED','student_verification',?,?,?)`)
      .bind(crypto.randomUUID(), adminId, verification!.id,
        JSON.stringify({ validUntil: Date.now() + 86_400_000 }), Date.now()).run();
    expect(await env.DB.prepare('SELECT affiliation_status AS status,last_restriction_event_id AS restrictionEvent FROM users WHERE id=?')
      .bind(expiredRiderId).first()).toMatchObject({ status: 'VERIFIED', restrictionEvent: null });
    expect(((await (await request('/api/v1/me', { cookie: renewedCookie })).json()) as { data: { affiliation: { status: string } } })
      .data.affiliation.status).toBe('VERIFIED');
    expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first())
      .toMatchObject({ status: 'CANCELLED' });
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'OPEN' });
    expect(await env.DB.prepare('SELECT 1 FROM active_user_locks WHERE user_id=?').bind(expiredRiderId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM active_user_locks WHERE user_id=?').bind(driverId).first()).not.toBeNull();

    await cleanupExpiredData(env.DB, now);
    expect(await env.DB.prepare('SELECT affiliation_status AS status FROM users WHERE id=?').bind(cronStudentId).first())
      .toMatchObject({ status: 'EXPIRED' });
    expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE user_id=?').bind(cronStudentId).first()).toBeNull();
    expect((await request('/api/v1/me', { cookie: cronStudent.cookie })).status).toBe(401);
  } finally {
    await cleanup(userIds, tripIds, requestIds);
  }
});
