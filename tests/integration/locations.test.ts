import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const driverId = '20000000-0000-4000-8000-000000000001';
const riderId = '20000000-0000-4000-8000-000000000002';
const pendingId = '20000000-0000-4000-8000-000000000003';
const tripId = '50000000-0000-4000-8000-000000000001';
const routeId = '40000000-0000-4000-8000-000000000001';

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

async function login(identity: 'driver' | 'rider' | 'pending') {
  const response = await request('/api/v1/auth/dev', { method: 'POST', body: { identity } });
  expect(response.status).toBe(201);
  const cookie = response.headers.get('Set-Cookie')!.split(';', 1)[0];
  const me = await request('/api/v1/me', { cookie });
  return { cookie, csrf: (await me.json() as { data: { csrfToken: string } }).data.csrfToken };
}

async function grantConsents(session: { cookie: string; csrf: string }, location = true) {
  const kinds = location ? ['TERMS', 'PRIVACY', 'LOCATION_COLLECTION', 'LOCATION_SHARING'] : ['TERMS', 'PRIVACY'];
  for (const kind of kinds) {
    const policyVersion = kind.startsWith('LOCATION_') ? 'local-location-v1' : 'local-demo-v1';
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion, granted: true },
    })).status).toBe(200);
  }
}

it('shares only fresh locations inside a mutually consented accepted trip', async () => {
  const originalTrip = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(tripId).first<{
    id: string; driver_id: string; route_id: string; departure_at: number; expires_at: number; seat_capacity: number;
    gender_snapshot: string; gender_filter: string; department_id_snapshot: string | null;
    department_verified_snapshot: number; prefer_same_department: number; status: string; version: number;
    last_command_id: string | null; started_at: number | null; ended_at: number | null; created_at: number; updated_at: number;
  }>();
  const originalPending = await env.DB.prepare(`SELECT affiliation_status AS affiliationStatus,verified_until AS verifiedUntil
    FROM users WHERE id=?`).bind(pendingId).first<{ affiliationStatus: string; verifiedUntil: number | null }>();
  expect(originalTrip).not.toBeNull();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM location_notice_presence WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
    env.DB.prepare('DELETE FROM location_disclosure_records WHERE trip_id=?').bind(tripId),
    env.DB.prepare('DELETE FROM location_access_records WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
    env.DB.prepare('DELETE FROM latest_locations WHERE trip_id=?').bind(tripId),
    env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
    env.DB.prepare('DELETE FROM ride_requests WHERE trip_id=?').bind(tripId),
    env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId),
    env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
  ]);
  let createdTripId: string | null = null;
  try {
    await env.DB.prepare(`UPDATE users SET affiliation_status='VERIFIED',verified_until=? WHERE id=?`)
      .bind(Date.now() + 86_400_000, pendingId).run();
    const driver = await login('driver');
    const rider = await login('rider');
    const pending = await login('pending');
    await grantConsents(driver, false);
    await grantConsents(rider, false);
    await grantConsents(pending, false);
    const departureAt = Date.now() + 600_000;
    const createdTrip = await request('/api/v1/trips', {
      method: 'POST', ...driver, key: crypto.randomUUID(),
      body: { routeId, departureAt, seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: false },
    });
    expect(createdTrip.status).toBe(201);
    createdTripId = (await createdTrip.json() as { data: { id: string } }).data.id;
    const createRequest = async (session: typeof rider) => {
      const response = await request(`/api/v1/trips/${createdTripId}/requests`, {
        method: 'POST', ...session, key: crypto.randomUUID(),
        body: { desiredDepartureAt: departureAt, genderFilter: 'ANY', preferSameDepartment: false },
      });
      expect(response.status).toBe(201);
      return (await response.json() as { data: { id: string } }).data.id;
    };
    const firstRequestId = await createRequest(rider);
    expect((await request(`/api/v1/requests/${firstRequestId}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);
    const noConsent = await request('/api/v1/locations/me', {
      method: 'PUT', ...driver,
      body: { tripId: createdTripId, requestId: null, lat: 37.5, lng: 127, accuracyM: 8, capturedAt: Date.now(), sequence: 1 },
    });
    expect(noConsent.status).toBe(403);

    await grantConsents(driver);
    await grantConsents(rider);
    await grantConsents(pending);
    expect((await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: pending.cookie })).status).toBe(404);
    const secondRequestId = await createRequest(pending);
    expect((await request(`/api/v1/requests/${secondRequestId}/accept`, {
      method: 'POST', ...driver, key: crypto.randomUUID(), body: { expectedVersion: 1 },
    })).status).toBe(200);

    const upload = (session: typeof rider, requestId: string | null, lat: number, sequence = 1, capturedAt = Date.now()) =>
      request('/api/v1/locations/me', {
        method: 'PUT', ...session,
        body: { tripId: createdTripId, requestId, lat, lng: 127, accuracyM: 8, capturedAt, sequence },
      });
    expect((await upload(driver, null, 37.5)).status).toBe(200);
    expect((await upload(rider, firstRequestId, 37.51)).status).toBe(200);
    expect((await upload(pending, secondRequestId, 37.52)).status).toBe(200);
    expect((await upload(driver, null, 37.5, 1)).status).toBe(409);
    expect((await upload(driver, null, 37.5, 2)).status).toBe(429);
    expect((await upload(driver, null, 37.5, 3, Date.now() + 31_000)).status).toBe(400);
    expect((await upload(rider, crypto.randomUUID(), 37.51, 1)).status).toBe(409);

    const own = await request('/api/v1/locations/me', { cookie: rider.cookie });
    expect(own.headers.get('Cache-Control')).toBe('no-store');
    expect(await own.json()).toMatchObject({ data: { sequence: 1, location: { lat: 37.51 } } });
    await env.DB.prepare('UPDATE location_notice_presence SET expires_at=? WHERE user_id=?')
      .bind(Date.now(), driverId).run();
    const providerOffline = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await providerOffline.json() as { data: { locations: unknown[] } }).data.locations).toEqual([]);
    expect((await request('/api/v1/locations/me', { cookie: driver.cookie })).status).toBe(200);
    expect((await request('/api/v1/locations/me', { cookie: pending.cookie })).status).toBe(200);
    const asDriver = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: driver.cookie });
    const driverData = (await asDriver.json() as { data: { stop: { name: string }; locations: Array<{ role: string; lat: number }> } }).data;
    expect(asDriver.headers.get('Cache-Control')).toBe('no-store');
    expect(driverData.stop.name).toBe('가상 교문');
    expect(driverData.locations).toEqual([]);
    const riderHistory = await request('/api/v1/locations/me', { cookie: rider.cookie });
    const riderDisclosures = (await riderHistory.json() as { data: { disclosures: Array<{
      id: string; recipientNickname: string; recipientRole: string; purpose: string; requestedAt: number;
      providedAt: number | null; noticeAcknowledgedAt: number | null; postNoticeAcknowledgedAt: number | null;
    }> } }).data.disclosures;
    expect(riderDisclosures).toEqual([expect.objectContaining({
      recipientNickname: '가상 운전자', recipientRole: 'DRIVER', purpose: 'MEETING',
      providedAt: null, noticeAcknowledgedAt: null, postNoticeAcknowledgedAt: null,
    })]);
    const noCsrfAck = await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', cookie: rider.cookie, body: { disclosureIds: [riderDisclosures[0].id] },
    });
    expect(noCsrfAck.status).toBe(403);
    const ack = await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', ...rider, body: { disclosureIds: [riderDisclosures[0].id] },
    });
    expect(ack.status).toBe(200);
    expect((await ack.json() as { data: { disclosureIds: string[] } }).data.disclosureIds).toEqual([riderDisclosures[0].id]);
    const pendingRequestHistory = await request('/api/v1/locations/me', { cookie: pending.cookie });
    const pendingDisclosures = (await pendingRequestHistory.json() as { data: { disclosures: Array<{ id: string; providedAt: number | null }> } }).data.disclosures;
    expect(pendingDisclosures).toHaveLength(1);
    expect(pendingDisclosures[0].providedAt).toBeNull();
    expect((await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', ...pending, body: { disclosureIds: [pendingDisclosures[0].id] },
    })).status).toBe(200);
    const sharedToRiders = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: driver.cookie });
    const sharedLocations = (await sharedToRiders.json() as { data: { locations: Array<{ role: string; lat: number }> } }).data.locations;
    expect(sharedLocations).toHaveLength(2);
    expect(sharedLocations.map((point) => point.role)).toEqual(['RIDER', 'RIDER']);
    const repeated = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: driver.cookie });
    expect((await repeated.json() as { data: { locations: unknown[] } }).data.locations).toEqual([]);
    const providedHistory = await request('/api/v1/locations/me', { cookie: rider.cookie });
    const providedDisclosure = (await providedHistory.json() as { data: { disclosures: Array<{
      id: string; providedAt: number | null; postNoticeAcknowledgedAt: number | null;
    }> } }).data.disclosures[0];
    expect(providedDisclosure.providedAt).not.toBeNull();
    expect(providedDisclosure.postNoticeAcknowledgedAt).toBeNull();
    expect((await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', ...rider, body: { disclosureIds: [providedDisclosure.id] },
    })).status).toBe(200);
    const acknowledged = await request('/api/v1/locations/me', { cookie: rider.cookie });
    expect((await acknowledged.json() as { data: { disclosures: Array<{ postNoticeAcknowledgedAt: number | null }> } })
      .data.disclosures[0].postNoticeAcknowledgedAt).not.toBeNull();
    const firstDriverLocation = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await firstDriverLocation.json() as { data: { locations: unknown[] } }).data.locations).toEqual([]);
    const driverHistory = await request('/api/v1/locations/me', { cookie: driver.cookie });
    const driverDisclosure = (await driverHistory.json() as { data: { disclosures: Array<{ id: string; providedAt: number | null }> } }).data.disclosures[0];
    expect(driverDisclosure.providedAt).toBeNull();
    expect((await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', ...driver, body: { disclosureIds: [driverDisclosure.id] },
    })).status).toBe(200);
    const asRider = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await asRider.json() as { data: { locations: Array<{ role: string; lat: number }> } }).data.locations)
      .toEqual([expect.objectContaining({ role: 'DRIVER', lat: 37.5 })]);
    const unknown = await request(`/api/v1/trips/${crypto.randomUUID()}/locations`, { cookie: rider.cookie });
    expect(unknown.status).toBe(404);

    const staleAt = Date.now() - 31_000;
    await env.DB.prepare(`UPDATE latest_locations SET sequence=2,received_at=?,expires_at=? WHERE user_id=?`)
      .bind(staleAt, staleAt + 60_000, driverId).run();
    const staleRequest = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await staleRequest.json() as { data: { locations: unknown[] } }).data.locations).toEqual([]);
    const staleNoticeResponse = await request('/api/v1/locations/me', { cookie: driver.cookie });
    const staleNotice = (await staleNoticeResponse.json() as { data: { disclosures: Array<{ id: string; providedAt: number | null }> } })
      .data.disclosures.find(({ providedAt }) => providedAt === null);
    expect(staleNotice).toBeDefined();
    expect((await request('/api/v1/locations/me/disclosures/ack', {
      method: 'POST', ...driver, body: { disclosureIds: [staleNotice!.id] },
    })).status).toBe(200);
    const stale = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await stale.json() as { data: { locations: Array<{ sequence: number; receivedAt: number }> } }).data.locations)
      .toEqual([expect.objectContaining({ sequence: 2, receivedAt: staleAt })]);
    const expiredAt = Date.now() - 61_000;
    await env.DB.prepare('UPDATE latest_locations SET received_at=?,expires_at=? WHERE user_id=?')
      .bind(expiredAt, expiredAt + 60_000, driverId).run();
    const expired = await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: rider.cookie });
    expect((await expired.json() as { data: { locations: unknown[] } }).data.locations).toEqual([]);

    expect((await request(`/api/v1/requests/${firstRequestId}/cancel`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { expectedVersion: 2, reasonCode: 'RIDER_CANCEL' },
    })).status).toBe(200);
    expect(await env.DB.prepare('SELECT user_id FROM latest_locations WHERE user_id=?').bind(riderId).first())
      .toBeNull();

    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...pending, body: { kind: 'LOCATION_SHARING', policyVersion: 'local-location-v1', granted: false },
    })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM latest_locations WHERE trip_id=?')
      .bind(createdTripId).first<{ count: number }>()).toMatchObject({ count: 0 });
    expect((await request(`/api/v1/trips/${createdTripId}/locations`, { cookie: pending.cookie })).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM location_disclosure_records WHERE owner_user_id=?')
      .bind(pendingId).first<{ count: number }>()).toMatchObject({ count: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM location_access_records WHERE location_owner_user_id=?')
      .bind(pendingId).first<{ count: number }>()).toMatchObject({ count: 0 });
    const pendingHistory = await request('/api/v1/locations/me', { cookie: pending.cookie });
    expect((await pendingHistory.json() as { data: { disclosures: Array<{ purpose: string }> } }).data.disclosures)
      .toEqual([]);
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM location_notice_presence WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
      env.DB.prepare('DELETE FROM location_disclosure_records WHERE trip_id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM location_access_records WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
      env.DB.prepare('DELETE FROM latest_locations WHERE trip_id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM active_user_locks WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
      env.DB.prepare('DELETE FROM ride_requests WHERE trip_id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM trips WHERE id=?').bind(createdTripId ?? ''),
      env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
      env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation='LOCATION_UPDATE'"),
      env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?,?)').bind(driverId, riderId, pendingId),
      env.DB.prepare('UPDATE users SET affiliation_status=?,verified_until=? WHERE id=?')
        .bind(originalPending?.affiliationStatus, originalPending?.verifiedUntil, pendingId),
    ]);
    await env.DB.prepare('DELETE FROM trips WHERE id=?').bind(tripId).run();
    if (originalTrip) await env.DB.prepare(`INSERT INTO trips
      (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
       department_id_snapshot,department_verified_snapshot,prefer_same_department,status,version,last_command_id,
       started_at,ended_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(originalTrip.id, originalTrip.driver_id, originalTrip.route_id, originalTrip.departure_at, originalTrip.expires_at,
        originalTrip.seat_capacity, originalTrip.gender_snapshot, originalTrip.gender_filter, originalTrip.department_id_snapshot,
        originalTrip.department_verified_snapshot, originalTrip.prefer_same_department, originalTrip.status, originalTrip.version,
        originalTrip.last_command_id, originalTrip.started_at, originalTrip.ended_at, originalTrip.created_at, originalTrip.updated_at).run();
  }
});
