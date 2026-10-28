import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { csrfToken, sha256 } from '../../src/worker/auth/session';

const origin = 'http://localhost:8787';
const riderId = '20000000-0000-4000-8000-000000000002';
const routeId = '40000000-0000-4000-8000-000000000001';
const departmentId = '10000000-0000-4000-8000-000000000001';

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

async function login() {
  const response = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'rider' } });
  expect(response.status).toBe(201);
  const cookie = response.headers.get('Set-Cookie')!.split(';', 1)[0];
  const me = await request('/api/v1/me', { cookie });
  return { cookie, csrf: (await me.json() as { data: { csrfToken: string } }).data.csrfToken };
}

async function sessionFor(userId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const csrf = await csrfToken(env, token);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions
    (token_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)`)
    .bind(await sha256(token), userId, await sha256(csrf), now, now, now + 60 * 60_000).run();
  return { cookie: `campus_session=${token}`, csrf };
}

async function acceptConsents(session: { cookie: string; csrf: string }, kinds: string[]) {
  for (const kind of kinds) {
    const policyVersion = kind.startsWith('LOCATION_') ? 'local-location-v1' : 'local-demo-v1';
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion, granted: true },
    })).status).toBe(200);
  }
}

async function insertTestStudent(userId: string, nickname: string, now: number) {
  await env.DB.prepare(`INSERT INTO users
    (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,
     parser_version,gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
    VALUES(?,?,'synthetic-school','synthetic-campus',?,?,?,'VERIFIED','DIRECTORY',
      'synthetic-v1','WOMAN','VERIFIED',?,'ACTIVE','STUDENT',?,?)`)
    .bind(userId, `block-user-${userId}`, `${userId}@students.example.invalid`, nickname, departmentId,
      now + 86_400_000, now, now).run();
}

it('audits a peer block, ends the active relation, and does not reopen it on unblock', async () => {
  const now = Date.now();
  const driverId = crypto.randomUUID();
  const tripId = crypto.randomUUID();
  const session = await login();
  let requestId: string | null = null;
  try {
    for (const kind of ['TERMS', 'PRIVACY']) {
      expect((await request('/api/v1/me/consents', {
        method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
      })).status).toBe(200);
    }
    await env.DB.prepare(`INSERT INTO users
      (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,
       parser_version,gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
      VALUES(?,?,'synthetic-school','synthetic-campus',?,'차단 시험 운전자',?,'VERIFIED','DIRECTORY',
        'synthetic-v1','WOMAN','VERIFIED',?,'ACTIVE','STUDENT',?,?)`)
      .bind(driverId, `block-driver-${driverId}`, `${driverId}@students.example.invalid`, departmentId,
        now + 86_400_000, now, now).run();
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'가상 차량','회색','TEST-ONLY',2,'VERIFIED',?,?)`).bind(driverId, now + 86_400_000, now).run();
    await env.DB.prepare(`INSERT INTO trips
      (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
       department_id_snapshot,department_verified_snapshot,prefer_same_department,created_at)
      VALUES(?,?,?, ?, ?,1,'WOMAN','ANY',?,1,0,?)`)
      .bind(tripId, driverId, routeId, now + 600_000, now + 1_500_000, departmentId, now).run();

    const created = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...session, key: crypto.randomUUID(),
      body: { desiredDepartureAt: now + 600_000, genderFilter: 'ANY', preferSameDepartment: true },
    });
    expect(created.status).toBe(201);
    requestId = (await created.json() as { data: { id: string } }).data.id;
    const peers = await request('/api/v1/me/active-peers', { cookie: session.cookie });
    expect((await peers.json() as { data: unknown[] }).data).toEqual([]);

    const unrelated = await request('/api/v1/blocks', {
      method: 'POST', ...session, body: { blockedUserId: '20000000-0000-4000-8000-000000000003' },
    });
    expect(unrelated.status).toBe(404);
    const blocked = await request('/api/v1/blocks', {
      method: 'POST', ...session, body: { blockedUserId: driverId },
    });
    expect(blocked.status).toBe(201);
    expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first())
      .toMatchObject({ status: 'CANCELLED' });
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'CANCELLED' });
    expect(await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id IN (?,?)')
      .bind(riderId, driverId).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM audit_events
      WHERE event_type='USER_BLOCKED' AND actor_id=? AND resource_id=?`).bind(riderId, driverId).first()).not.toBeNull();
    await expect(env.DB.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(riderId, driverId).run()).rejects.toThrow(/UNBLOCK_AUDIT_REQUIRED/);
    const blockList = await request('/api/v1/blocks', { cookie: session.cookie });
    expect((await blockList.json() as { data: Array<{ userId: string }> }).data)
      .toContainEqual(expect.objectContaining({ userId: driverId }));

    expect((await request(`/api/v1/blocks/${driverId}`, { method: 'DELETE', ...session })).status).toBe(200);
    expect(await env.DB.prepare('SELECT blocker_id FROM user_blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(riderId, driverId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first())
      .toMatchObject({ status: 'CANCELLED' });
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'CANCELLED' });
  } finally {
    const existing = await env.DB.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(riderId, driverId).first();
    if (existing) {
      const eventId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_UNBLOCKED','user_block',?,?, '{}',?)`)
        .bind(eventId, riderId, driverId, eventId, Date.now()).run();
    }
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(riderId, driverId).run();
    if (requestId) {
      await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id=? AND operation=?')
        .bind(riderId, 'CREATE_REQUEST').run();
      await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(requestId).run();
    }
    await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(driverId).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(driverId).run();
    await env.DB.prepare(`DELETE FROM audit_events WHERE resource_type='user_block' AND actor_id=? AND resource_id=?`)
      .bind(riderId, driverId).run();
  }
});

it('aborts a boarded trip and deletes both parties’ locations after a block', async () => {
  const now = Date.now();
  const driverId = crypto.randomUUID();
  const riderSession = await login();
  let driverSession!: { cookie: string; csrf: string };
  let tripId: string | null = null;
  let requestId: string | null = null;
  try {
    await env.DB.prepare(`INSERT INTO users
      (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,
       parser_version,gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
      VALUES(?,?,'synthetic-school','synthetic-campus',?,'차단 시험 운전자',?,'VERIFIED','DIRECTORY',
        'synthetic-v1','WOMAN','VERIFIED',?,'ACTIVE','STUDENT',?,?)`)
      .bind(driverId, `block-driver-${driverId}`, `${driverId}@students.example.invalid`, departmentId,
        now + 86_400_000, now, now).run();
    driverSession = await sessionFor(driverId);
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'가상 차량','회색','TEST-ONLY',2,'VERIFIED',?,?)`).bind(driverId, now + 86_400_000, now).run();
    await acceptConsents(riderSession, ['TERMS', 'PRIVACY', 'LOCATION_COLLECTION', 'LOCATION_SHARING']);
    await acceptConsents(driverSession, ['TERMS', 'PRIVACY', 'LOCATION_COLLECTION', 'LOCATION_SHARING']);

    const createdTrip = await request('/api/v1/trips', {
      method: 'POST', ...driverSession, key: crypto.randomUUID(),
      body: { routeId, departureAt: now + 600_000, seatCapacity: 1, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdTrip.status).toBe(201);
    tripId = (await createdTrip.json() as { data: { id: string } }).data.id;
    const createdRequest = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...riderSession, key: crypto.randomUUID(),
      body: { desiredDepartureAt: now + 600_000, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdRequest.status).toBe(201);
    requestId = (await createdRequest.json() as { data: { id: string } }).data.id;

    expect((await request(`/api/v1/requests/${requestId}/accept`, {
      method: 'POST', ...driverSession, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);
    const issued = await request(`/api/v1/requests/${requestId}/boarding-code`, { method: 'POST', ...riderSession });
    expect(issued.status).toBe(200);
    const code = (await issued.json() as { data: { code: string } }).data.code;
    expect((await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driverSession, body: { expectedVersion: 2, code },
    })).status).toBe(200);
    for (const [session, ownRequestId] of [[riderSession, requestId], [driverSession, null]] as const) {
      expect((await request('/api/v1/locations/me', {
        method: 'PUT', ...session, body: {
          tripId, requestId: ownRequestId, lat: 37.5, lng: 127, accuracyM: 8,
          capturedAt: Date.now(), sequence: 1,
        },
      })).status).toBe(200);
    }
    const peers = await request('/api/v1/me/active-peers', { cookie: riderSession.cookie });
    expect((await peers.json() as { data: Array<{ userId: string }> }).data)
      .toContainEqual(expect.objectContaining({ userId: driverId }));

    expect((await request('/api/v1/blocks', {
      method: 'POST', ...riderSession, body: { blockedUserId: driverId },
    })).status).toBe(201);
    expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first())
      .toMatchObject({ status: 'ABORTED' });
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'ABORTED' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM latest_locations WHERE trip_id=?')
      .bind(tripId).first<{ count: number }>())?.count).toBe(0);
  } finally {
    const existing = await env.DB.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(riderId, driverId).first();
    if (existing) {
      const eventId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_UNBLOCKED','user_block',?,?, '{}',?)`)
        .bind(eventId, riderId, driverId, eventId, Date.now()).run();
    }
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(riderId, driverId).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(driverId).run();
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(riderId, driverId).run();
    if (requestId) {
      await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id=?').bind(riderId).run();
      await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(requestId).run();
    }
    if (tripId) {
      await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id=?').bind(driverId).run();
      await env.DB.prepare('DELETE FROM latest_locations WHERE trip_id=?').bind(tripId).run();
      await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
    }
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(driverId).run();
    await env.DB.prepare('DELETE FROM audit_events WHERE actor_id=? OR resource_id=?').bind(driverId, tripId).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(driverId).run();
    await env.DB.prepare(`DELETE FROM audit_events WHERE resource_type='user_block' AND actor_id=? AND resource_id=?`)
      .bind(riderId, driverId).run();
  }
});

it('cancels both unboarded peers’ requests while leaving their driver trip open', async () => {
  const now = Date.now();
  const driverId = crypto.randomUUID();
  const secondRiderId = crypto.randomUUID();
  const firstRiderSession = await login();
  let driverSession!: { cookie: string; csrf: string };
  let secondRiderSession!: { cookie: string; csrf: string };
  let tripId: string | null = null;
  const requestIds: string[] = [];
  try {
    await insertTestStudent(driverId, '동승 운전자', now);
    await insertTestStudent(secondRiderId, '동승 탑승자', now);
    driverSession = await sessionFor(driverId);
    secondRiderSession = await sessionFor(secondRiderId);
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'가상 차량','회색','TEST-ONLY',2,'VERIFIED',?,?)`).bind(driverId, now + 86_400_000, now).run();
    await acceptConsents(firstRiderSession, ['TERMS', 'PRIVACY']);
    await acceptConsents(driverSession, ['TERMS', 'PRIVACY']);
    await acceptConsents(secondRiderSession, ['TERMS', 'PRIVACY']);

    const createdTrip = await request('/api/v1/trips', {
      method: 'POST', ...driverSession, key: crypto.randomUUID(),
      body: { routeId, departureAt: now + 600_000, seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdTrip.status).toBe(201);
    tripId = (await createdTrip.json() as { data: { id: string } }).data.id;

    for (const session of [firstRiderSession, secondRiderSession]) {
      const created = await request(`/api/v1/trips/${tripId}/requests`, {
        method: 'POST', ...session, key: crypto.randomUUID(),
        body: { desiredDepartureAt: now + 600_000, genderFilter: 'ANY', preferSameDepartment: false },
      });
      expect(created.status).toBe(201);
      requestIds.push((await created.json() as { data: { id: string } }).data.id);
    }
    for (const requestId of requestIds) {
      expect((await request(`/api/v1/requests/${requestId}/accept`, {
        method: 'POST', ...driverSession, key: crypto.randomUUID(), body: { expectedVersion: 1 },
      })).status).toBe(200);
    }
    const peers = await request('/api/v1/me/active-peers', { cookie: firstRiderSession.cookie });
    expect((await peers.json() as { data: Array<{ userId: string }> }).data)
      .toContainEqual(expect.objectContaining({ userId: secondRiderId }));
    expect((await request('/api/v1/blocks', {
      method: 'POST', ...firstRiderSession, body: { blockedUserId: secondRiderId },
    })).status).toBe(201);
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id IN (?,?) ORDER BY id')
      .bind(...requestIds).all<{ status: string }>()).results.map(({ status }) => status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(tripId).first())
      .toMatchObject({ status: 'OPEN' });
    expect(await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(driverId).first())
      .not.toBeNull();
    expect(await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id IN (?,?)')
      .bind(riderId, secondRiderId).first()).toBeNull();
  } finally {
    const blocked = await env.DB.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(riderId, secondRiderId).first();
    if (blocked) {
      const eventId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_UNBLOCKED','user_block',?,?, '{}',?)`)
        .bind(eventId, riderId, secondRiderId, eventId, Date.now()).run();
    }
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?,?)')
      .bind(riderId, driverId, secondRiderId).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id IN (?,?)').bind(driverId, secondRiderId).run();
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?,?)')
      .bind(riderId, driverId, secondRiderId).run();
    await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id IN (?,?,?)')
      .bind(riderId, driverId, secondRiderId).run();
    if (requestIds.length) await env.DB.prepare(`DELETE FROM ride_requests WHERE id IN (${requestIds.map(() => '?').join(',')})`)
      .bind(...requestIds).run();
    if (tripId) {
      await env.DB.prepare('DELETE FROM latest_locations WHERE trip_id=?').bind(tripId).run();
      await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
    }
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(driverId).run();
    await env.DB.prepare('DELETE FROM audit_events WHERE actor_id=? OR resource_id=?').bind(driverId, tripId).run();
    await env.DB.prepare("DELETE FROM audit_events WHERE resource_type='user_block' AND actor_id=? AND resource_id=?")
      .bind(riderId, secondRiderId).run();
    await env.DB.prepare('DELETE FROM users WHERE id IN (?,?)').bind(driverId, secondRiderId).run();
  }
});
