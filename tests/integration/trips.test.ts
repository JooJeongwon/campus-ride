import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const driverId = '20000000-0000-4000-8000-000000000001';
const riderId = '20000000-0000-4000-8000-000000000002';
const routeId = '40000000-0000-4000-8000-000000000002';
const profile = { vehicleModel: '합성 세단', vehicleColor: '회색', vehicleIdentifier: 'SYNTHETIC-TRIP', passengerCapacity: 2 };

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

async function login(identity: 'driver' | 'rider') {
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

it('creates, reads and idempotently locks an authorized driver trip', async () => {
  const priorRole = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(driverId).first<{ role: string }>();
  try {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM trips WHERE driver_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
    const rider = await login('rider');
    await acceptConsents(rider);
    expect((await request('/api/v1/me/driver-profile', { method: 'PUT', ...rider, body: profile })).status).toBe(200);

    await env.DB.prepare("UPDATE users SET role='ADMIN' WHERE id=?").bind(driverId).run();
    const admin = await login('driver');
    await acceptConsents(admin);
    const approval = await request(`/api/v1/admin/driver-profiles/${riderId}`, {
      method: 'PATCH', ...admin, body: { outcome: 'VERIFIED', validUntil: Date.now() + 86_400_000 },
    });
    expect(approval.status).toBe(200);

    const routes = await request('/api/v1/routes', { cookie: rider.cookie });
    expect(routes.status).toBe(200);
    expect((await routes.json() as { data: Array<{ id: string }> }).data).toContainEqual(expect.objectContaining({ id: routeId }));
    const body = {
      routeId, departureAt: Date.now() + 600_000, seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: true,
    };
    const noCsrf = await request('/api/v1/trips', { method: 'POST', cookie: rider.cookie, key: 'missing-csrf', body });
    expect(noCsrf.status).toBe(403);
    const tooManySeats = await request('/api/v1/trips', {
      method: 'POST', ...rider, key: 'too-many-seats', body: { ...body, seatCapacity: 3 },
    });
    expect(tooManySeats.status).toBe(400);

    const key = crypto.randomUUID();
    const [first, retry] = await Promise.all([
      request('/api/v1/trips', { method: 'POST', ...rider, key, body }),
      request('/api/v1/trips', { method: 'POST', ...rider, key, body }),
    ]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const firstData = (await first.json() as { data: { id: string; status: string; version: number } }).data;
    const retryData = (await retry.json() as { data: { id: string; status: string; version: number } }).data;
    expect(firstData).toEqual(retryData);
    expect(firstData).toMatchObject({ status: 'OPEN', version: 1 });

    const conflict = await request('/api/v1/trips', {
      method: 'POST', ...rider, key, body: { ...body, preferSameDepartment: false },
    });
    expect(conflict.status).toBe(409);
    const duplicateActivity = await request('/api/v1/trips', {
      method: 'POST', ...rider, key: crypto.randomUUID(), body,
    });
    expect(duplicateActivity.status).toBe(409);
    expect((await duplicateActivity.json() as { error: { code: string } }).error.code).toBe('ALREADY_ACTIVE');
    await env.DB.prepare("UPDATE idempotency_keys SET expires_at=? WHERE user_id=? AND operation='CREATE_TRIP' AND key=?")
      .bind(Date.now() - 1, riderId, key).run();
    const expiredKey = await request('/api/v1/trips', { method: 'POST', ...rider, key, body });
    expect((await expiredKey.json() as { error: { code: string } }).error.code).toBe('ALREADY_ACTIVE');
    expect(await env.DB.prepare("SELECT key FROM idempotency_keys WHERE user_id=? AND operation='CREATE_TRIP' AND key=?")
      .bind(riderId, key).first()).toBeNull();

    const me = await request('/api/v1/me', { cookie: rider.cookie });
    const meData = (await me.json() as { data: { activeActivity: { role: string; tripId: string }; activeTrip: { id: string; originName: string; destinationName: string; remainingSeats: number } } }).data;
    expect(meData.activeActivity).toMatchObject({ role: 'DRIVER', tripId: firstData.id });
    expect(meData.activeTrip).toMatchObject({ id: firstData.id, originName: 'AI공학관', destinationName: '가상 캠퍼스', remainingSeats: 2 });
    const detail = await request(`/api/v1/trips/${firstData.id}`, { cookie: rider.cookie });
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain(profile.vehicleIdentifier);
    const routeIdBad = await request(`/api/v1/trips/${crypto.randomUUID()}`, { cookie: rider.cookie });
    expect(routeIdBad.status).toBe(404);

    const expiredAt = Date.now();
    await env.DB.prepare('UPDATE trips SET departure_at=?,expires_at=? WHERE id=?')
      .bind(expiredAt - 2_000, expiredAt - 1_000, firstData.id).run();
    const nextTrip = await request('/api/v1/trips', {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { ...body, departureAt: Date.now() + 600_000 },
    });
    expect(nextTrip.status).toBe(201);
    expect((await env.DB.prepare('SELECT status FROM trips WHERE id=?').bind(firstData.id).first<{ status: string }>() )?.status).toBe('EXPIRED');
    const nextTripId = (await nextTrip.json() as { data: { id: string } }).data.id;
    const secondExpiry = Date.now();
    await env.DB.prepare('UPDATE trips SET departure_at=?,expires_at=? WHERE id=?')
      .bind(secondExpiry - 2_000, secondExpiry - 1_000, nextTripId).run();

    const concurrentBody = { ...body, departureAt: Date.now() + 700_000 };
    const competing = await Promise.all([
      request('/api/v1/trips', { method: 'POST', ...rider, key: crypto.randomUUID(), body: concurrentBody }),
      request('/api/v1/trips', { method: 'POST', ...rider, key: crypto.randomUUID(), body: concurrentBody }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM trips WHERE driver_id=? AND status='OPEN'")
      .bind(riderId).first<{ count: number }>())?.count).toBe(1);
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM trips WHERE driver_id=?').bind(riderId).run();
    await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id=? AND operation='CREATE_TRIP'").bind(riderId).run();
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM audit_events WHERE resource_type=? AND resource_id=?')
      .bind('driver_profile', riderId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(riderId, driverId).run();
    await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(priorRole?.role ?? 'STUDENT', driverId).run();
  }
});
