import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const driverId = '20000000-0000-4000-8000-000000000001';
const riderId = '20000000-0000-4000-8000-000000000002';
const tripId = '50000000-0000-4000-8000-000000000001';
const routeId = '40000000-0000-4000-8000-000000000002';

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

it('turns a passenger posting into an accepted ride when an approved driver selects it', async () => {
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
  await env.DB.prepare('DELETE FROM ride_postings WHERE rider_id=?').bind(riderId).run();
  await env.DB.prepare("DELETE FROM ride_requests WHERE rider_id=? AND trip_id=? AND status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')")
    .bind(riderId, tripId).run();
  await env.DB.prepare("DELETE FROM idempotency_keys WHERE user_id IN (?,?) AND operation IN ('CREATE_RIDE_POSTING','ACCEPT_RIDE_POSTING','CANCEL_RIDE_POSTING','REQUEST_CANCEL')")
    .bind(driverId, riderId).run();
  await env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation IN ('CREATE_RIDE_POSTING','ACCEPT_RIDE_POSTING')").run();

  const driver = await login('driver');
  const rider = await login('rider');
  await acceptConsents(driver);
  await acceptConsents(rider);
  const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=? AND status=\'OPEN\'')
    .bind(tripId).first<{ departureAt: number }>();
  expect(trip).not.toBeNull();
  const postingKey = crypto.randomUUID();
  const desiredDepartureAt = Math.min(trip!.departureAt, Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000);
  const posting = await request('/api/v1/ride-postings', {
    method: 'POST', ...rider, key: postingKey,
    body: { routeId, desiredDepartureAt, genderFilter: 'ANY', preferSameDepartment: true },
  });
  expect(posting.status).toBe(201);
  const postingId = (await posting.json() as { data: { id: string; status: string } }).data.id;
  expect((await request('/api/v1/ride-postings/mine', { cookie: rider.cookie })).status).toBe(200);

  const available = await request('/api/v1/ride-postings', { cookie: driver.cookie });
  expect(available.status).toBe(200);
  expect((await available.json() as { data: Array<{ id: string }> }).data.map(({ id }) => id)).toContain(postingId);

  const acceptKey = crypto.randomUUID();
  const accepted = await request(`/api/v1/ride-postings/${postingId}/accept`, {
    method: 'POST', ...driver, key: acceptKey, body: {},
  });
  expect(accepted.status).toBe(200);
  const result = (await accepted.json() as { data: { tripId: string; requestId: string; status: string; version: number } }).data;
  expect(result).toMatchObject({ tripId, status: 'ACCEPTED', version: 2 });
  expect((await request(`/api/v1/ride-postings/${postingId}/accept`, {
    method: 'POST', ...driver, key: acceptKey, body: {},
  })).status).toBe(200);
  for (let i = 0; i < 3; i++) {
    expect((await request(`/api/v1/ride-postings/${postingId}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: {},
    })).status).toBe(409);
  }
  expect((await request(`/api/v1/ride-postings/${postingId}/accept`, {
    method: 'POST', ...driver, key: crypto.randomUUID(), body: {},
  })).status).toBe(429);
  expect(await env.DB.prepare("SELECT status FROM ride_postings WHERE id=?").bind(postingId).first())
    .toMatchObject({ status: 'MATCHED' });
  expect(await env.DB.prepare('SELECT status FROM ride_requests WHERE id=?').bind(result.requestId).first())
    .toMatchObject({ status: 'ACCEPTED' });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_user_locks WHERE user_id IN (?,?)')
    .bind(driverId, riderId).first()).toMatchObject({ count: 2 });

  const cancelled = await request(`/api/v1/requests/${result.requestId}/cancel`, {
    method: 'POST', ...rider, key: crypto.randomUUID(),
    body: { expectedVersion: result.version, reasonCode: 'RIDER_CANCEL' },
  });
  expect(cancelled.status).toBe(200);
  await env.DB.prepare('DELETE FROM ride_postings WHERE id=?').bind(postingId).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(result.requestId).run();
});
