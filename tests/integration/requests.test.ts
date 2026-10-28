import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../../src/worker';

const origin = 'http://localhost:8787';
const riderId = '20000000-0000-4000-8000-000000000002';
const tripId = '50000000-0000-4000-8000-000000000001';
const routeId = '40000000-0000-4000-8000-000000000001';
const vehicle = { vehicleModel: '합성 차량', vehicleColor: '회색', vehicleIdentifier: 'SYNTHETIC-REQUEST', passengerCapacity: 2 };

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

async function login(identity: 'rider' | 'driver' | 'pending' = 'rider') {
  const response = await request('/api/v1/auth/dev', { method: 'POST', body: { identity } });
  expect(response.status).toBe(201);
  const cookie = response.headers.get('Set-Cookie')!.split(';', 1)[0];
  const me = await request('/api/v1/me', { cookie });
  return { cookie, csrf: (await me.json() as { data: { csrfToken: string } }).data.csrfToken };
}

async function acceptConsents(session: { cookie: string; csrf: string }) {
  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }
}

async function acceptLocationConsents(session: { cookie: string; csrf: string }) {
  for (const kind of ['LOCATION_COLLECTION', 'LOCATION_SHARING']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-location-v1', granted: true },
    })).status).toBe(200);
  }
}

async function clearRiderActivity() {
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(riderId).run();
  await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id=? AND operation='CREATE_REQUEST'").bind(riderId).run();
  await env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation IN ('CREATE_REQUEST','BOARDING_CODE')").run();
}

async function requestBody() {
  const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=?').bind(tripId).first<{ departureAt: number }>();
  return { desiredDepartureAt: trip!.departureAt, genderFilter: 'ANY', preferSameDepartment: true };
}

async function createTrip(session: { cookie: string; csrf: string }, departureAt: number) {
  const response = await request('/api/v1/trips', {
    method: 'POST', ...session, key: crypto.randomUUID(),
    body: { routeId, departureAt, seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: false },
  });
  expect(response.status).toBe(201);
  return (await response.json() as { data: { id: string } }).data.id;
}

async function createRiderRequest(session: { cookie: string; csrf: string }, id: string, desiredDepartureAt: number) {
  const response = await request(`/api/v1/trips/${id}/requests`, {
    method: 'POST', ...session, key: crypto.randomUUID(),
    body: { desiredDepartureAt, genderFilter: 'ANY', preferSameDepartment: false },
  });
  expect(response.status).toBe(201);
  return (await response.json() as { data: { id: string; version: number } }).data;
}

it('searches eligible trips and ranks the verified same department in both views', async () => {
  await clearRiderActivity();
  const riderId = '20000000-0000-4000-8000-000000000002';
  const previousGender = await env.DB.prepare('SELECT gender FROM users WHERE id=?').bind(riderId).first<{ gender: string }>();
  const rider = await login();
  const driver = await login('driver');
  await acceptConsents(rider);
  await acceptConsents(driver);
  const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=?')
    .bind(tripId).first<{ departureAt: number }>();
  expect(trip).not.toBeNull();
  const search = (genderFilter = 'ANY', preferSameDepartment = true, cursor?: string) => {
    const query = new URLSearchParams({
      routeId, desiredDepartureAt: String(trip!.departureAt), genderFilter,
      preferSameDepartment: String(preferSameDepartment), ...(cursor ? { cursor } : {}),
    });
    return request(`/api/v1/trips?${query}`, { cookie: rider.cookie });
  };
  let requestId: string | null = null;
  try {
    const recommendations = await search();
    expect(recommendations.status).toBe(200);
    const match = (await recommendations.json() as { data: Array<Record<string, unknown>> }).data[0];
    expect(match).toMatchObject({
      id: tripId, sameDepartment: true, matchReasons: ['SAME_DEPARTMENT', 'DEPARTURE_TIME'],
      remainingSeats: 2, timeDifferenceMinutes: 0,
    });
    expect(Object.keys(match)).not.toEqual(expect.arrayContaining(['driverGender', 'departmentId', 'email', 'vehicleIdentifier']));
    expect(await (await search('MAN')).json()).toMatchObject({ data: [] });
    expect((await search('ANY', true, 'invalid')).status).toBe(400);

    expect((await request('/api/v1/me', { method: 'PATCH', ...rider, body: { gender: 'UNDISCLOSED' } })).status).toBe(200);
    expect((await search()).status).toBe(200);
    expect((await search('WOMAN')).status).toBe(400);
    expect((await request('/api/v1/me', { method: 'PATCH', ...rider, body: { gender: previousGender!.gender } })).status).toBe(200);

    const created = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: trip!.departureAt, genderFilter: 'WOMAN', preferSameDepartment: true },
    });
    expect(created.status).toBe(201);
    requestId = (await created.json() as { data: { id: string } }).data.id;
    const inbox = await request(`/api/v1/trips/${tripId}/requests`, { cookie: driver.cookie });
    expect((await inbox.json() as { data: unknown }).data).toMatchObject([{
      id: requestId, sameDepartment: true, conditionsCompatible: true,
      matchReasons: ['SAME_DEPARTMENT', 'DEPARTURE_TIME'],
    }]);
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    if (requestId) await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(requestId).run();
    await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id=? AND operation='CREATE_REQUEST'").bind(riderId).run();
    if (previousGender) await env.DB.prepare('UPDATE users SET gender=? WHERE id=?').bind(previousGender.gender, riderId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(riderId, '20000000-0000-4000-8000-000000000001').run();
  }
});

it('hides and rejects a request that conflicts with an existing passenger filter', async () => {
  await clearRiderActivity();
  const riderId = '20000000-0000-4000-8000-000000000002';
  const pendingId = '20000000-0000-4000-8000-000000000003';
  const original = await env.DB.prepare(`SELECT gender,department_status AS departmentStatus,department_source AS departmentSource,
    parser_version AS parserVersion,affiliation_status AS affiliationStatus,verified_until AS verifiedUntil
    FROM users WHERE id=?`).bind(pendingId).first<{
    gender: string; departmentStatus: string; departmentSource: string; parserVersion: string;
    affiliationStatus: string; verifiedUntil: number | null;
  }>();
  expect(original).not.toBeNull();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(pendingId).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(pendingId).run();
  const driver = await login('driver');
  const rider = await login();
  await env.DB.prepare(`UPDATE users SET gender='MAN',department_status='UNVERIFIED',department_source='EMAIL_LOCAL_PART',
    affiliation_status='VERIFIED',verified_until=? WHERE id=?`).bind(Date.now() + 86_400_000, pendingId).run();
  const otherRider = await login('pending');
  await acceptConsents(driver);
  await acceptConsents(rider);
  await acceptConsents(otherRider);
  const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=?')
    .bind(tripId).first<{ departureAt: number }>();
  let firstRequestId: string | null = null;
  try {
    const first = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: trip!.departureAt, genderFilter: 'WOMAN', preferSameDepartment: false },
    });
    expect(first.status).toBe(201);
    firstRequestId = (await first.json() as { data: { id: string } }).data.id;
    expect((await request(`/api/v1/requests/${firstRequestId}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);

    const query = new URLSearchParams({
      routeId, desiredDepartureAt: String(trip!.departureAt), genderFilter: 'ANY', preferSameDepartment: 'false',
    });
    expect(await (await request(`/api/v1/trips?${query}`, { cookie: otherRider.cookie })).json())
      .toMatchObject({ data: [] });
    const rejected = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...otherRider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: trip!.departureAt, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as { error: { code: string } }).error.code).toBe('MATCH_NOT_AVAILABLE');
    expect(await env.DB.prepare('SELECT id FROM ride_requests WHERE rider_id=?').bind(pendingId).first()).toBeNull();
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(riderId, pendingId).run();
    if (firstRequestId) await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(firstRequestId).run();
    await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id IN (?,?,?) AND operation IN ('CREATE_REQUEST','REQUEST_ACCEPT')")
      .bind(riderId, pendingId, '20000000-0000-4000-8000-000000000001').run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?,?)')
      .bind(riderId, pendingId, '20000000-0000-4000-8000-000000000001').run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id IN (?,?,?)')
      .bind(riderId, pendingId, '20000000-0000-4000-8000-000000000001').run();
    if (original) await env.DB.prepare(`UPDATE users SET gender=?,department_status=?,department_source=?,parser_version=?,
      affiliation_status=?,verified_until=? WHERE id=?`)
      .bind(original.gender, original.departmentStatus, original.departmentSource, original.parserVersion,
        original.affiliationStatus, original.verifiedUntil, pendingId).run();
  }
});

it('paginates recommendations with a stable rank cursor', async () => {
  await clearRiderActivity();
  const rider = await login();
  await acceptConsents(rider);
  const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=?')
    .bind(tripId).first<{ departureAt: number }>();
  const now = Date.now();
  const driverIds = Array.from({ length: 21 }, () => crypto.randomUUID());
  const tripIds = driverIds.map(() => crypto.randomUUID());
  const cleanup = () => env.DB.batch([
    env.DB.prepare(`DELETE FROM active_user_locks WHERE user_id IN (${driverIds.map(() => '?').join(',')})`).bind(...driverIds),
    env.DB.prepare(`DELETE FROM trips WHERE id IN (${tripIds.map(() => '?').join(',')})`).bind(...tripIds),
    env.DB.prepare(`DELETE FROM driver_profiles WHERE user_id IN (${driverIds.map(() => '?').join(',')})`).bind(...driverIds),
    env.DB.prepare(`DELETE FROM users WHERE id IN (${driverIds.map(() => '?').join(',')})`).bind(...driverIds),
    env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId),
  ]);
  try {
    await env.DB.batch([
      ...driverIds.map((id, index) => env.DB.prepare(`INSERT INTO users
        (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,parser_version,
         gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
        VALUES(?,?,'synthetic-school','synthetic-campus',?,'cursor driver',?,'VERIFIED','DIRECTORY','synthetic-v1',
          'WOMAN','VERIFIED',?,'ACTIVE','STUDENT',?,?)`).bind(
        id, `cursor-${id}`, `cursor-${id}@students.example.invalid`, index % 2 ? '10000000-0000-4000-8000-000000000002' : '10000000-0000-4000-8000-000000000001',
        now + 86_400_000, now, now)),
      ...driverIds.map((id) => env.DB.prepare(`INSERT INTO driver_profiles
        (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
        VALUES(?,'synthetic','gray',?,1,'VERIFIED',?,?)`).bind(id, `SYN-${id.slice(0, 20)}`, now + 86_400_000, now)),
      ...driverIds.map((id, index) => {
        const departureAt = trip!.departureAt + ((index % 11) - 5) * 60_000;
        return env.DB.prepare(`INSERT INTO trips
          (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
           department_id_snapshot,department_verified_snapshot,prefer_same_department,created_at)
          VALUES(?,?,?, ?,?,1,'WOMAN','ANY',?,1,0,?)`)
          .bind(tripIds[index], id, routeId, departureAt, departureAt + 900_000,
            index % 2 ? '10000000-0000-4000-8000-000000000002' : '10000000-0000-4000-8000-000000000001', now);
      }),
    ]);
    const makeSearch = (cursor?: string, preferSameDepartment = true) => {
      const params = new URLSearchParams({
        routeId, desiredDepartureAt: String(trip!.departureAt), genderFilter: 'ANY',
        preferSameDepartment: String(preferSameDepartment), ...(cursor ? { cursor } : {}),
      });
      return request(`/api/v1/trips?${params}`, { cookie: rider.cookie });
    };
    const first = await makeSearch();
    const pageOne = await first.json() as { data: Array<{ id: string; timeDifferenceMinutes: number; sameDepartment: boolean }>; nextCursor: string | null };
    expect(pageOne.data).toHaveLength(20);
    expect(pageOne.nextCursor).not.toBeNull();
    expect((await makeSearch(pageOne.nextCursor!, false)).status).toBe(400);
    const second = await makeSearch(pageOne.nextCursor!);
    const pageTwo = await second.json() as { data: Array<{ id: string; timeDifferenceMinutes: number; sameDepartment: boolean }>; nextCursor: string | null };
    expect(pageTwo.data).toHaveLength(2);
    expect(pageTwo.nextCursor).toBeNull();
    const ids = [...pageOne.data, ...pageTwo.data].map((match) => match.id);
    expect(new Set(ids).size).toBe(22);
    expect(ids).toEqual(expect.arrayContaining([tripId, ...tripIds]));
    const ordered = [...pageOne.data, ...pageTwo.data];
    expect(ordered.slice(0, 12).every((match) => match.sameDepartment)).toBe(true);
    expect(ordered.slice(12).every((match) => !match.sameDepartment)).toBe(true);
    for (const group of [ordered.slice(0, 12), ordered.slice(12)]) {
      const timeDifferences = group.map((match) => match.timeDifferenceMinutes);
      expect(timeDifferences).toEqual([...timeDifferences].sort((a, b) => a - b));
    }
    const withoutPreference = await makeSearch(undefined, false);
    const plainPage = await withoutPreference.json() as { data: Array<{ id: string; timeDifferenceMinutes: number }> };
    const plainDifferences = plainPage.data.map((match) => match.timeDifferenceMinutes);
    expect(plainDifferences).toEqual([...plainDifferences].sort((a, b) => a - b));
  } finally {
    await cleanup();
  }
});

it('creates one rider lock idempotently and blocks switching to driver activity', async () => {
  await clearRiderActivity();
  const previous = await env.DB.prepare(`SELECT vehicle_model AS vehicleModel,vehicle_color AS vehicleColor,
    vehicle_identifier AS vehicleIdentifier,passenger_capacity AS passengerCapacity,verification_status AS verificationStatus,
    verified_until AS verifiedUntil,checked_at AS checkedAt FROM driver_profiles WHERE user_id=?`)
    .bind(riderId).first<{ vehicleModel: string; vehicleColor: string; vehicleIdentifier: string; passengerCapacity: number; verificationStatus: string; verifiedUntil: number | null; checkedAt: number | null }>();
  const session = await login();
  await acceptConsents(session);
  try {
    const body = await requestBody();
    const noCsrf = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', cookie: session.cookie, key: crypto.randomUUID(), body,
    });
    expect(noCsrf.status).toBe(403);
    const genderMismatch = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...session, key: crypto.randomUUID(), body: { ...body, genderFilter: 'MAN' },
    });
    expect(genderMismatch.status).toBe(409);
    expect((await genderMismatch.json() as { error: { code: string } }).error.code).toBe('MATCH_NOT_AVAILABLE');
    const key = crypto.randomUUID();
    const [first, retry] = await Promise.all([
      request(`/api/v1/trips/${tripId}/requests`, { method: 'POST', ...session, key, body }),
      request(`/api/v1/trips/${tripId}/requests`, { method: 'POST', ...session, key, body }),
    ]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const created = (await first.json() as { data: { id: string; status: string; version: number } }).data;
    expect((await retry.json() as { data: unknown }).data).toEqual(created);
    expect(created).toMatchObject({ status: 'REQUESTED', version: 1 });
    expect(await env.DB.prepare('SELECT role,trip_id AS tripId,request_id AS requestId FROM active_user_locks WHERE user_id=?')
      .bind(riderId).first()).toEqual({ role: 'RIDER', tripId: null, requestId: created.id });

    const secondRequest = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...session, key: crypto.randomUUID(), body,
    });
    expect(secondRequest.status).toBe(409);
    expect((await secondRequest.json() as { error: { code: string } }).error.code).toBe('ALREADY_ACTIVE');

    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,?,?,?,?,'VERIFIED',?,?) ON CONFLICT(user_id) DO UPDATE SET
        vehicle_model=excluded.vehicle_model,vehicle_color=excluded.vehicle_color,
        vehicle_identifier=excluded.vehicle_identifier,passenger_capacity=excluded.passenger_capacity,
        verification_status='VERIFIED',verified_until=excluded.verified_until,checked_at=excluded.checked_at`)
      .bind(riderId, vehicle.vehicleModel, vehicle.vehicleColor, vehicle.vehicleIdentifier, vehicle.passengerCapacity,
        Date.now() + 86_400_000, Date.now()).run();
    const driverActivity = await request('/api/v1/trips', {
      method: 'POST', ...session, key: crypto.randomUUID(),
      body: { routeId, departureAt: Date.now() + 600_000, seatCapacity: 1, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(driverActivity.status).toBe(409);
    expect((await driverActivity.json() as { error: { code: string } }).error.code).toBe('ALREADY_ACTIVE');
  } finally {
    await clearRiderActivity();
    if (previous) {
      await env.DB.prepare(`UPDATE driver_profiles SET vehicle_model=?,vehicle_color=?,vehicle_identifier=?,passenger_capacity=?,
        verification_status=?,verified_until=?,checked_at=? WHERE user_id=?`)
        .bind(previous.vehicleModel, previous.vehicleColor, previous.vehicleIdentifier, previous.passengerCapacity,
          previous.verificationStatus, previous.verifiedUntil, previous.checkedAt, riderId).run();
    } else {
      await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
    }
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
  }
});

it('allows only one concurrent active request and replaces an expired request lock', async () => {
  await clearRiderActivity();
  const session = await login();
  await acceptConsents(session);
  try {
    const body = await requestBody();
    const competing = await Promise.all([
      request(`/api/v1/trips/${tripId}/requests`, { method: 'POST', ...session, key: crypto.randomUUID(), body }),
      request(`/api/v1/trips/${tripId}/requests`, { method: 'POST', ...session, key: crypto.randomUUID(), body }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    const active = await env.DB.prepare(`SELECT r.id FROM ride_requests r WHERE r.rider_id=? AND r.status='REQUESTED'`)
      .bind(riderId).first<{ id: string }>();
    expect(active).not.toBeNull();
    expect((await env.DB.prepare('SELECT request_id AS requestId FROM active_user_locks WHERE user_id=?')
      .bind(riderId).first<{ requestId: string }>())?.requestId).toBe(active!.id);

    await env.DB.prepare("UPDATE ride_requests SET expires_at=? WHERE id=? AND status='REQUESTED'")
      .bind(Date.now() - 1, active!.id).run();
    const replacement = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...session, key: crypto.randomUUID(), body,
    });
    expect(replacement.status).toBe(201);
    const newId = (await replacement.json() as { data: { id: string } }).data.id;
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(active!.id).first<{ status: string }>())?.status).toBe('EXPIRED');
    expect(await env.DB.prepare('SELECT role,request_id AS requestId FROM active_user_locks WHERE user_id=?')
      .bind(riderId).first()).toEqual({ role: 'RIDER', requestId: newId });
  } finally {
    await clearRiderActivity();
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
  }
});

it('serializes a request racing with the same user creating a driver trip', async () => {
  await clearRiderActivity();
  await env.DB.prepare('DELETE FROM trips WHERE driver_id=?').bind(riderId).run();
  const previous = await env.DB.prepare(`SELECT vehicle_model AS vehicleModel,vehicle_color AS vehicleColor,
    vehicle_identifier AS vehicleIdentifier,passenger_capacity AS passengerCapacity,verification_status AS verificationStatus,
    verified_until AS verifiedUntil,checked_at AS checkedAt FROM driver_profiles WHERE user_id=?`)
    .bind(riderId).first<{ vehicleModel: string; vehicleColor: string; vehicleIdentifier: string; passengerCapacity: number; verificationStatus: string; verifiedUntil: number | null; checkedAt: number | null }>();
  const session = await login();
  await acceptConsents(session);
  try {
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,?,?,?,?,'VERIFIED',?,?) ON CONFLICT(user_id) DO UPDATE SET
        vehicle_model=excluded.vehicle_model,vehicle_color=excluded.vehicle_color,
        vehicle_identifier=excluded.vehicle_identifier,passenger_capacity=excluded.passenger_capacity,
        verification_status='VERIFIED',verified_until=excluded.verified_until,checked_at=excluded.checked_at`)
      .bind(riderId, vehicle.vehicleModel, vehicle.vehicleColor, vehicle.vehicleIdentifier, vehicle.passengerCapacity,
        Date.now() + 86_400_000, Date.now()).run();
    const body = await requestBody();
    const [driverTrip, riderRequest] = await Promise.all([
      request('/api/v1/trips', {
        method: 'POST', ...session, key: crypto.randomUUID(),
        body: { routeId, departureAt: Date.now() + 600_000, seatCapacity: 1, genderFilter: 'ANY', preferSameDepartment: false },
      }),
      request(`/api/v1/trips/${tripId}/requests`, { method: 'POST', ...session, key: crypto.randomUUID(), body }),
    ]);
    expect([driverTrip.status, riderRequest.status].sort()).toEqual([201, 409]);
    const lock = await env.DB.prepare('SELECT role,trip_id AS tripId,request_id AS requestId FROM active_user_locks WHERE user_id=?')
      .bind(riderId).first<{ role: string; tripId: string | null; requestId: string | null }>();
    expect(lock).not.toBeNull();
    if (lock?.role === 'DRIVER') {
      expect(lock.tripId).not.toBeNull();
      expect(lock.requestId).toBeNull();
      expect(await env.DB.prepare("SELECT id FROM ride_requests WHERE rider_id=? AND status='REQUESTED'")
        .bind(riderId).first()).toBeNull();
    } else {
      expect(lock?.role).toBe('RIDER');
      expect(lock?.tripId).toBeNull();
      expect(lock?.requestId).not.toBeNull();
      expect(await env.DB.prepare("SELECT id FROM trips WHERE driver_id=? AND status='OPEN'")
        .bind(riderId).first()).toBeNull();
    }
  } finally {
    await clearRiderActivity();
    await env.DB.prepare('DELETE FROM trips WHERE driver_id=?').bind(riderId).run();
    await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id=? AND operation='CREATE_TRIP'").bind(riderId).run();
    if (previous) {
      await env.DB.prepare(`UPDATE driver_profiles SET vehicle_model=?,vehicle_color=?,vehicle_identifier=?,passenger_capacity=?,
        verification_status=?,verified_until=?,checked_at=? WHERE user_id=?`)
        .bind(previous.vehicleModel, previous.vehicleColor, previous.vehicleIdentifier, previous.passengerCapacity,
          previous.verificationStatus, previous.verifiedUntil, previous.checkedAt, riderId).run();
    } else {
      await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
    }
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
  }
});

it('limits request creation to five attempts per account each minute', async () => {
  await clearRiderActivity();
  const session = await login();
  await acceptConsents(session);
  try {
    const body = await requestBody();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(`/api/v1/trips/${tripId}/requests`, {
        method: 'POST', ...session, key: crypto.randomUUID(), body,
      });
      expect(response.status).toBe(201);
      const requestId = (await response.json() as { data: { id: string } }).data.id;
      await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
      await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(requestId).run();
    }
    const limited = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...session, key: crypto.randomUUID(), body,
    });
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  } finally {
    await clearRiderActivity();
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
  }
});

it('accepts, verifies boarding, starts and completes a trip with replay-safe commands', async () => {
  await clearRiderActivity();
  const original = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(tripId).first<{
    id: string; driver_id: string; route_id: string; departure_at: number; expires_at: number; seat_capacity: number;
    gender_snapshot: string; gender_filter: string; department_id_snapshot: string | null;
    department_verified_snapshot: number; prefer_same_department: number; status: string; version: number;
    last_command_id: string | null; started_at: number | null; ended_at: number | null; created_at: number; updated_at: number;
  }>();
  expect(original).not.toBeNull();
  const driverId = '20000000-0000-4000-8000-000000000001';
  let createdTripId: string | null = null;
  let requestId: string | null = null;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(driverId),
    env.DB.prepare('DELETE FROM ride_requests WHERE trip_id=?').bind(tripId),
    env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId),
  ]);
  const driver = await login('driver');
  const rider = await login();
  await acceptConsents(driver);
  await acceptConsents(rider);
  try {
    await acceptLocationConsents(driver);
    await acceptLocationConsents(rider);
    const departureAt = Date.now() + 60_000;
    const tripResponse = await request('/api/v1/trips', {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { routeId, departureAt, seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(tripResponse.status).toBe(201);
    createdTripId = (await tripResponse.json() as { data: { id: string } }).data.id;
    const requestResponse = await request(`/api/v1/trips/${createdTripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: departureAt, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(requestResponse.status).toBe(201);
    requestId = (await requestResponse.json() as { data: { id: string } }).data.id;
    const acceptKey = crypto.randomUUID();
    const acceptBody = { expectedVersion: 1 };
    const accepted = await request(`/api/v1/requests/${requestId}/accept`, {
      method: 'POST', ...driver, key: acceptKey, body: acceptBody,
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as { data: unknown }).data).toMatchObject({ id: requestId, status: 'ACCEPTED', version: 2 });
    const acceptedReplay = await request(`/api/v1/requests/${requestId}/accept`, {
      method: 'POST', ...driver, key: acceptKey, body: acceptBody,
    });
    expect((await acceptedReplay.json() as { data: unknown }).data).toMatchObject({ id: requestId, status: 'ACCEPTED', version: 2 });
    const bodyConflict = await request(`/api/v1/requests/${requestId}/accept`, {
      method: 'POST', ...driver, key: acceptKey, body: { ...acceptBody, reasonCode: 'DIFFERENT_BODY' },
    });
    expect(bodyConflict.status).toBe(409);
    expect((await bodyConflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const issued = await request(`/api/v1/requests/${requestId}/boarding-code`, { method: 'POST', ...rider });
    expect(issued.status).toBe(200);
    const code = (await issued.json() as { data: { code: string; expiresAt: number } }).data;
    expect(code.code).toMatch(/^\d{6}$/);
    const stored = await env.DB.prepare('SELECT boarding_code_hash AS codeHash FROM ride_requests WHERE id=?')
      .bind(requestId).first<{ codeHash: string }>();
    expect(stored?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.codeHash).not.toBe(code.code);
    const wrongCode = code.code === '999999' ? '000000' : '999999';
    const wrong = await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code: wrongCode },
    });
    expect(wrong.status).toBe(409);
    expect((await env.DB.prepare('SELECT boarding_attempt_count AS attempts FROM ride_requests WHERE id=?')
      .bind(requestId).first<{ attempts: number }>())?.attempts).toBe(1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invalid = await request(`/api/v1/requests/${requestId}/board`, {
        method: 'POST', ...driver, body: { expectedVersion: 2, code: wrongCode },
      });
      expect(invalid.status).toBe(409);
    }
    const locked = await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code: wrongCode },
    });
    expect(locked.status).toBe(429);
    expect((await env.DB.prepare('SELECT boarding_attempt_count AS attempts FROM ride_requests WHERE id=?')
      .bind(requestId).first<{ attempts: number }>())?.attempts).toBe(5);
    const reissued = await request(`/api/v1/requests/${requestId}/boarding-code`, { method: 'POST', ...rider });
    expect(reissued.status).toBe(200);
    const newCode = (await reissued.json() as { data: { code: string; expiresAt: number } }).data;
    expect(newCode.expiresAt).toBeGreaterThan(Date.now());
    await env.DB.prepare('UPDATE ride_requests SET boarding_code_expires_at=? WHERE id=?')
      .bind(Date.now() - 1, requestId).run();
    const expiredCode = await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code: newCode.code },
    });
    expect(expiredCode.status).toBe(409);
    expect((await expiredCode.json() as { error: { code: string } }).error.code).toBe('BOARDING_CODE_EXPIRED');
    const finalCodeResponse = await request(`/api/v1/requests/${requestId}/boarding-code`, { method: 'POST', ...rider });
    expect(finalCodeResponse.status).toBe(200);
    const finalCode = (await finalCodeResponse.json() as { data: { code: string } }).data.code;
    const boarded = await request(`/api/v1/requests/${requestId}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code: finalCode },
    });
    expect(boarded.status).toBe(200);
    expect((await boarded.json() as { data: unknown }).data).toMatchObject({ status: 'BOARDED', version: 3 });

    for (const [session, requestIdForLocation, lat, sequence] of [
      [driver, null, 37.5, 1], [rider, requestId, 37.51, 1],
    ] as const) {
      const uploaded = await request('/api/v1/locations/me', {
        method: 'PUT', ...session,
        body: { tripId: createdTripId, requestId: requestIdForLocation, lat, lng: 127, accuracyM: 8,
          capturedAt: Date.now(), sequence },
      });
      expect(uploaded.status).toBe(200);
    }

    await env.DB.prepare('UPDATE trips SET departure_at=?,expires_at=? WHERE id=?')
      .bind(Date.now() - 1, Date.now() + 900_000, createdTripId).run();
    const startKey = crypto.randomUUID();
    const startBody = { expectedVersion: 1 };
    const started = await request(`/api/v1/trips/${createdTripId}/start`, {
      method: 'POST', ...driver, key: startKey, body: startBody,
    });
    expect(started.status).toBe(200);
    expect((await started.json() as { data: unknown }).data).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM latest_locations WHERE trip_id=?')
      .bind(createdTripId).first<{ count: number }>())?.count).toBe(0);
    const mismatchedAbort = crypto.randomUUID();
    const abortTime = Date.now() + 1_000;
    await expect(env.DB.batch([
      env.DB.prepare(`UPDATE ride_requests SET status='ABORTED',version=version+1,updated_at=MAX(?,updated_at+1),
          last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE id=? AND status='BOARDED'`).bind(abortTime, crypto.randomUUID(), requestId),
      env.DB.prepare(`UPDATE trips SET status='ABORTED',version=version+1,ended_at=MAX(?,updated_at+1),
          updated_at=MAX(?,updated_at+1),last_command_id=? WHERE id=? AND status='IN_PROGRESS'`)
        .bind(abortTime, abortTime, mismatchedAbort, createdTripId),
    ])).rejects.toThrow(/TRIP_ABORT_REQUEST_MISMATCH/);
    expect((await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(createdTripId).first<{ status: string }>())?.status)
      .toBe('IN_PROGRESS');
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(requestId).first<{ status: string }>())?.status)
      .toBe('BOARDED');
    const completeKey = crypto.randomUUID();
    const completeBody = { expectedVersion: 2 };
    const completed = await request(`/api/v1/trips/${createdTripId}/complete`, {
      method: 'POST', ...driver, key: completeKey, body: completeBody,
    });
    expect(completed.status).toBe(200);
    expect((await completed.json() as { data: unknown }).data).toMatchObject({ status: 'COMPLETED', version: 3 });
    const completionReplay = await request(`/api/v1/trips/${createdTripId}/complete`, {
      method: 'POST', ...driver, key: completeKey, body: completeBody,
    });
    expect((await completionReplay.json() as { data: unknown }).data).toMatchObject({ status: 'COMPLETED', version: 3 });
    expect((await env.DB.prepare('SELECT status,version FROM ride_requests WHERE id=?').bind(requestId).first()))
      .toEqual({ status: 'COMPLETED', version: 4 });
    const locks = await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id IN (?,?)').bind(driverId, riderId).all();
    expect(locks.results).toEqual([]);
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM latest_locations WHERE trip_id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(driverId, riderId),
      env.DB.prepare('DELETE FROM ride_requests WHERE trip_id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM trips WHERE id=?').bind(createdTripId ?? ''),
      env.DB.prepare("DELETE FROM idempotency_keys WHERE (user_id=? AND operation IN ('CREATE_TRIP','TRIP_START','TRIP_COMPLETE')) OR (user_id=? AND operation IN ('CREATE_REQUEST','REQUEST_ACCEPT'))")
        .bind(driverId, riderId),
      env.DB.prepare('DELETE FROM audit_events WHERE resource_id IN (?,?)').bind(createdTripId ?? '', requestId ?? ''),
      env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation='LOCATION_UPDATE'"),
      env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(driverId, riderId),
    ]);
    if (createdTripId) await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(createdTripId).run();
    if (original) await env.DB.prepare(`INSERT INTO trips
      (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
       department_id_snapshot,department_verified_snapshot,prefer_same_department,status,version,last_command_id,
       started_at,ended_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(original.id, original.driver_id, original.route_id, original.departure_at, original.expires_at,
        original.seat_capacity, original.gender_snapshot, original.gender_filter, original.department_id_snapshot,
        original.department_verified_snapshot, original.prefer_same_department, original.status, original.version,
        original.last_command_id, original.started_at, original.ended_at, original.created_at, original.updated_at).run();
  }
});

it('rejects and cancels requests, handles no-shows, and cascades trip cancellation and abort', async () => {
  await clearRiderActivity();
  const original = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(tripId).first<{
    id: string; driver_id: string; route_id: string; departure_at: number; expires_at: number; seat_capacity: number;
    gender_snapshot: string; gender_filter: string; department_id_snapshot: string | null;
    department_verified_snapshot: number; prefer_same_department: number; status: string; version: number;
    last_command_id: string | null; started_at: number | null; ended_at: number | null; created_at: number; updated_at: number;
  }>();
  expect(original).not.toBeNull();
  const driverId = '20000000-0000-4000-8000-000000000001';
  const createdTripIds: string[] = [];
  const requestIds: string[] = [];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(driverId),
    env.DB.prepare('DELETE FROM ride_requests WHERE trip_id=?').bind(tripId),
    env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId),
  ]);
  try {
    const driver = await login('driver');
    const rider = await login();
    await acceptConsents(driver);
    await acceptConsents(rider);

    const firstTrip = await createTrip(driver, Date.now() + 120_000);
    createdTripIds.push(firstTrip);
    const rejectedRequest = await createRiderRequest(rider, firstTrip, Date.now() + 120_000);
    requestIds.push(rejectedRequest.id);
    const rejected = await request(`/api/v1/requests/${rejectedRequest.id}/reject`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    });
    expect((await rejected.json() as { data: unknown }).data).toMatchObject({ status: 'REJECTED', version: 2 });

    const cancelledRequest = await createRiderRequest(rider, firstTrip, Date.now() + 120_000);
    requestIds.push(cancelledRequest.id);
    const riderCancelled = await request(`/api/v1/requests/${cancelledRequest.id}/cancel`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { expectedVersion: 1, reasonCode: 'RIDER_CANCEL' },
    });
    expect((await riderCancelled.json() as { data: unknown }).data).toMatchObject({ status: 'CANCELLED', version: 2 });

    const cascadeRequest = await createRiderRequest(rider, firstTrip, Date.now() + 120_000);
    requestIds.push(cascadeRequest.id);
    const cascadeAccepted = await request(`/api/v1/requests/${cascadeRequest.id}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    });
    expect(cascadeAccepted.status).toBe(200);
    const tripCancelled = await request(`/api/v1/trips/${firstTrip}/cancel`, {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { expectedVersion: 1, reasonCode: 'DRIVER_CANCEL' },
    });
    expect((await tripCancelled.json() as { data: unknown }).data).toMatchObject({ status: 'CANCELLED', version: 2 });
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(cascadeRequest.id).first<{ status: string }>())?.status)
      .toBe('CANCELLED');

    const secondTrip = await createTrip(driver, Date.now() + 120_000);
    createdTripIds.push(secondTrip);
    const noShowRequest = await createRiderRequest(rider, secondTrip, Date.now() + 120_000);
    requestIds.push(noShowRequest.id);
    const noShowAccepted = await request(`/api/v1/requests/${noShowRequest.id}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    });
    expect(noShowAccepted.status).toBe(200);
    await env.DB.prepare('UPDATE trips SET departure_at=? WHERE id=?').bind(Date.now() - 240_000, secondTrip).run();
    const noShow = await request(`/api/v1/requests/${noShowRequest.id}/no-show`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 2 },
    });
    expect((await noShow.json() as { data: unknown }).data).toMatchObject({ status: 'NO_SHOW', version: 3 });
    const noShowTripCancel = await request(`/api/v1/trips/${secondTrip}/cancel`, {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { expectedVersion: 1, reasonCode: 'DRIVER_CANCEL' },
    });
    expect(noShowTripCancel.status).toBe(200);

    const thirdTrip = await createTrip(driver, Date.now() + 120_000);
    createdTripIds.push(thirdTrip);
    const abortRequest = await createRiderRequest(rider, thirdTrip, Date.now() + 120_000);
    requestIds.push(abortRequest.id);
    expect((await request(`/api/v1/requests/${abortRequest.id}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);
    const issue = await request(`/api/v1/requests/${abortRequest.id}/boarding-code`, { method: 'POST', ...rider });
    const code = (await issue.json() as { data: { code: string } }).data.code;
    const board = await request(`/api/v1/requests/${abortRequest.id}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code },
    });
    expect(board.status).toBe(200);
    const aborted = await request(`/api/v1/trips/${thirdTrip}/abort`, {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { expectedVersion: 1, reasonCode: 'DRIVER_ABORT' },
    });
    expect((await aborted.json() as { data: unknown }).data).toMatchObject({ status: 'ABORTED', version: 2 });
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(abortRequest.id).first<{ status: string }>())?.status)
      .toBe('ABORTED');
    const locks = await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id IN (?,?)')
      .bind(driverId, riderId).all();
    expect(locks.results).toEqual([]);
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(driverId, riderId).run();
    if (createdTripIds.length) {
      const placeholders = createdTripIds.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM ride_requests WHERE trip_id IN (${placeholders})`).bind(...createdTripIds).run();
      await env.DB.prepare(`DELETE FROM trips WHERE id IN (${placeholders})`).bind(...createdTripIds).run();
    }
    await env.DB.prepare(`DELETE FROM idempotency_keys WHERE user_id IN (?,?) AND operation IN
      ('CREATE_TRIP','CREATE_REQUEST','REQUEST_REJECT','REQUEST_CANCEL','REQUEST_ACCEPT','REQUEST_NO_SHOW','TRIP_CANCEL','TRIP_ABORT')`)
      .bind(driverId, riderId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(driverId, riderId).run();
    if (original) await env.DB.prepare(`INSERT INTO trips
      (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
       department_id_snapshot,department_verified_snapshot,prefer_same_department,status,version,last_command_id,
       started_at,ended_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(original.id, original.driver_id, original.route_id, original.departure_at, original.expires_at,
        original.seat_capacity, original.gender_snapshot, original.gender_filter, original.department_id_snapshot,
        original.department_verified_snapshot, original.prefer_same_department, original.status, original.version,
        original.last_command_id, original.started_at, original.ended_at, original.created_at, original.updated_at).run();
  }
});

it('allows exactly one of twenty concurrent requests to take the final seat', async () => {
  await clearRiderActivity();
  const previous = await env.DB.prepare('SELECT seat_capacity AS seatCapacity,departure_at AS departureAt,expires_at AS expiresAt FROM trips WHERE id=?')
    .bind(tripId).first<{ seatCapacity: number; departureAt: number; expiresAt: number }>();
  expect(previous).not.toBeNull();
  const driver = await login('driver');
  await acceptConsents(driver);
  const now = Date.now();
  const departureAt = now + 600_000;
  const userIds = Array.from({ length: 20 }, () => crypto.randomUUID());
  const requestIds = userIds.map(() => crypto.randomUUID());
  const keys = userIds.map(() => crypto.randomUUID());
  await env.DB.prepare('UPDATE trips SET seat_capacity=1 WHERE id=?').bind(tripId).run();
  try {
    await env.DB.batch(userIds.map((id) => env.DB.prepare(`INSERT INTO users
      (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,department_source,parser_version,
       gender,affiliation_status,verified_until,account_status,role,created_at,updated_at)
      VALUES(?,?, 'synthetic-school','synthetic-campus',?,'race rider','10000000-0000-4000-8000-000000000001',
        'VERIFIED','DIRECTORY','synthetic-v1','WOMAN','VERIFIED',?,'ACTIVE','STUDENT',?,?)`)
      .bind(id, `test-last-seat-${id}`, `last-seat-${id}@students.example.invalid`, now + 86_400_000, now, now)));
    await env.DB.batch(requestIds.map((id, index) => env.DB.prepare(`INSERT INTO ride_requests
      (id,trip_id,rider_id,desired_departure_at,gender_snapshot,gender_filter,department_id_snapshot,
       department_verified_snapshot,prefer_same_department,status,expires_at,last_command_id,created_at,updated_at)
      SELECT ?,t.id,u.id,?,'WOMAN','ANY',u.department_id,1,0,'REQUESTED',MIN(?,t.expires_at),?,?,?
      FROM trips t JOIN users u ON u.id=? WHERE t.id=?`)
      .bind(id, departureAt, now + 180_000, crypto.randomUUID(), now, now, userIds[index], tripId)));
    const responses = await Promise.all(requestIds.map((id, index) => request(`/api/v1/requests/${id}/accept`, {
      method: 'POST', ...driver, key: keys[index], body: { expectedVersion: 1 },
    })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ride_requests WHERE trip_id=? AND status IN ('ACCEPTED','BOARDED')`)
      .bind(tripId).first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM idempotency_keys WHERE user_id=? AND operation='REQUEST_ACCEPT'
      AND key IN (${keys.map(() => '?').join(',')})`)
      .bind('20000000-0000-4000-8000-000000000001', ...keys).first<{ count: number }>())?.count).toBe(1);
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (' + userIds.map(() => '?').join(',') + ')')
      .bind(...userIds).run();
    await env.DB.prepare('DELETE FROM ride_requests WHERE id IN (' + requestIds.map(() => '?').join(',') + ')')
      .bind(...requestIds).run();
    await env.DB.prepare('DELETE FROM users WHERE id IN (' + userIds.map(() => '?').join(',') + ')')
      .bind(...userIds).run();
    await env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id=? AND operation=? AND key IN (' + keys.map(() => '?').join(',') + ')')
      .bind('20000000-0000-4000-8000-000000000001', 'REQUEST_ACCEPT', ...keys).run();
    await env.DB.prepare('DELETE FROM audit_events WHERE resource_type=? AND resource_id IN (' + requestIds.map(() => '?').join(',') + ')')
      .bind('ride_request', ...requestIds).run();
    if (previous) await env.DB.prepare('UPDATE trips SET seat_capacity=?,departure_at=?,expires_at=? WHERE id=?')
      .bind(previous.seatCapacity, previous.departureAt, previous.expiresAt, tripId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind('20000000-0000-4000-8000-000000000001').run();
  }
});

it('scheduled cleanup expires inactive activity and aborts a trip after ninety minutes', async () => {
  await clearRiderActivity();
  const driverId = '20000000-0000-4000-8000-000000000001';
  const riderId = '20000000-0000-4000-8000-000000000002';
  const tripIds: string[] = [];
  const original = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(tripId).first<{
    id: string; driver_id: string; route_id: string; departure_at: number; expires_at: number; seat_capacity: number;
    gender_snapshot: string; gender_filter: string; department_id_snapshot: string | null;
    department_verified_snapshot: number; prefer_same_department: number; status: string; version: number;
    last_command_id: string | null; started_at: number | null; ended_at: number | null; created_at: number; updated_at: number;
  }>();
  expect(original).not.toBeNull();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(driverId).run();
  const driver = await login('driver');
  const rider = await login();
  await acceptConsents(driver);
  await acceptConsents(rider);
  const runCleanup = async () => {
    const jobs: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} }, env, {
      waitUntil: (promise: Promise<unknown>) => { jobs.push(Promise.resolve(promise)); },
    } as unknown as ExecutionContext);
    await Promise.all(jobs);
  };

  try {
    const old = Date.now() - 1_000;
    await env.DB.prepare('UPDATE trips SET departure_at=?,expires_at=? WHERE id=?')
      .bind(old - 900_000, old, tripId).run();
    await runCleanup();
    const expiredTrip = await createTrip(driver, Date.now() + 120_000);
    tripIds.push(expiredTrip);
    const expiredRequest = await createRiderRequest(rider, expiredTrip, Date.now() + 120_000);
    await env.DB.prepare('UPDATE ride_requests SET created_at=?,expires_at=? WHERE id=?')
      .bind(old - 120_000, old, expiredRequest.id).run();
    await env.DB.prepare('UPDATE trips SET departure_at=?,expires_at=? WHERE id=?')
      .bind(old - 900_000, old, expiredTrip).run();
    await runCleanup();
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(expiredRequest.id).first<{ status: string }>())?.status)
      .toBe('EXPIRED');
    expect((await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(expiredTrip).first<{ status: string }>())?.status)
      .toBe('EXPIRED');

    const timedOutTrip = await createTrip(driver, Date.now() + 120_000);
    tripIds.push(timedOutTrip);
    const timedOutRequest = await createRiderRequest(rider, timedOutTrip, Date.now() + 120_000);
    expect((await request(`/api/v1/requests/${timedOutRequest.id}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);
    const issue = await request(`/api/v1/requests/${timedOutRequest.id}/boarding-code`, { method: 'POST', ...rider });
    const code = (await issue.json() as { data: { code: string } }).data.code;
    expect((await request(`/api/v1/requests/${timedOutRequest.id}/board`, {
      method: 'POST', ...driver, body: { expectedVersion: 2, code },
    })).status).toBe(200);
    const timeoutAt = Date.now() - 90 * 60_000 - 1_000;
    await env.DB.prepare('UPDATE trips SET created_at=?,departure_at=?,expires_at=? WHERE id=?')
      .bind(timeoutAt, timeoutAt, timeoutAt + 900_000, timedOutTrip).run();
    const cleanupTime = Date.now();
    const stale = cleanupTime - 120_000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO latest_locations (user_id,trip_id,lat,lng,accuracy_m,captured_at,received_at,expires_at,sequence)
        VALUES(?,?,0,0,10,?,?,?,1)`).bind(riderId, tripId, stale, stale, stale + 60_000),
      env.DB.prepare(`INSERT INTO sessions (token_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at)
        VALUES(?,?,?,?,?,?)`).bind('a'.repeat(64), driverId, 'b'.repeat(64), stale - 1, stale - 1, stale),
      env.DB.prepare(`INSERT INTO oauth_states (state_hash,nonce_hash,browser_binding_hash,created_at,expires_at)
        VALUES(?,?,?,?,?)`).bind('c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), stale - 1, stale),
      env.DB.prepare(`INSERT INTO idempotency_keys
        (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
        VALUES(?,'CRON_TEST','expired-key',?,?, '{}',200,?,?)`)
        .bind(driverId, 'f'.repeat(64), crypto.randomUUID(), stale - 1, stale),
      env.DB.prepare(`INSERT INTO rate_limit_buckets (subject_hash,operation,window_start,count,expires_at)
        VALUES(?,'CRON_TEST',?,1,?)`).bind('g'.repeat(64), stale - 60_000, stale),
    ]);
    await runCleanup();
    expect((await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(timedOutRequest.id).first<{ status: string }>())?.status)
      .toBe('ABORTED');
    expect((await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(timedOutTrip).first<{ status: string }>())?.status)
      .toBe('ABORTED');
    expect((await env.DB.prepare(`SELECT safe_metadata_json AS metadata FROM audit_events
      WHERE resource_id=? AND event_type='TRIP_ABORTED'`).bind(timedOutTrip).first<{ metadata: string }>())?.metadata)
      .toBe('{"reasonCode":"SYSTEM_TIMEOUT"}');
    expect((await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id IN (?,?)')
      .bind(driverId, riderId).all()).results).toEqual([]);
    const cleaned = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM latest_locations WHERE user_id=?) AS locations,
      (SELECT COUNT(*) FROM sessions WHERE token_hash=?) AS sessions,
      (SELECT COUNT(*) FROM oauth_states WHERE state_hash=?) AS states,
      (SELECT COUNT(*) FROM idempotency_keys WHERE user_id=? AND operation='CRON_TEST') AS idempotency,
      (SELECT COUNT(*) FROM rate_limit_buckets WHERE subject_hash=? AND operation='CRON_TEST') AS rateLimits`)
      .bind(riderId, 'a'.repeat(64), 'c'.repeat(64), driverId, 'g'.repeat(64))
      .first<{ locations: number; sessions: number; states: number; idempotency: number; rateLimits: number }>();
    expect(cleaned).toEqual({ locations: 0, sessions: 0, states: 0, idempotency: 0, rateLimits: 0 });
  } finally {
    const cleanup = [
      env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?)').bind(driverId, riderId),
      env.DB.prepare(`DELETE FROM ride_requests WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`).bind(...tripIds),
      env.DB.prepare(`DELETE FROM trips WHERE id IN (${tripIds.map(() => '?').join(',')})`).bind(...tripIds),
      env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id IN (?,?) AND operation IN ('CREATE_TRIP','CREATE_REQUEST','REQUEST_ACCEPT')")
        .bind(driverId, riderId),
      env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(driverId, riderId),
    ];
    for (const statement of cleanup) await statement.run();
    if (tripIds.length) await env.DB.prepare(`DELETE FROM audit_events WHERE resource_id IN (${tripIds.map(() => '?').join(',')})`)
      .bind(...tripIds).run();
    if (original) {
      await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(driverId).run();
      await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
      await env.DB.prepare(`INSERT INTO trips
        (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
         department_id_snapshot,department_verified_snapshot,prefer_same_department,status,version,last_command_id,
         started_at,ended_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(original.id, original.driver_id, original.route_id, original.departure_at, original.expires_at,
          original.seat_capacity, original.gender_snapshot, original.gender_filter, original.department_id_snapshot,
          original.department_verified_snapshot, original.prefer_same_department, original.status, original.version,
          original.last_command_id, original.started_at, original.ended_at, original.created_at, original.updated_at).run();
    }
  }
});
