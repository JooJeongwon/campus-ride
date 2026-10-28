import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const riderId = '20000000-0000-4000-8000-000000000002';
const adminId = '20000000-0000-4000-8000-000000000001';
const profile = { vehicleModel: '합성 해치백', vehicleColor: '파랑', vehicleIdentifier: 'SYNTHETIC-TEST', passengerCapacity: 3 };

async function request(path: string, options: { method?: string; cookie?: string; csrf?: string; body?: unknown } = {}) {
  const headers = new Headers({ Origin: origin });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
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
  const body = await me.json() as { data: { csrfToken: string } };
  return { cookie, csrf: body.data.csrfToken };
}

async function acceptConsents(session: { cookie: string; csrf: string }) {
  for (const kind of ['TERMS', 'PRIVACY']) {
    const response = await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    });
    expect(response.status).toBe(200);
  }
}

it('registers a private vehicle profile and requires audited admin review', async () => {
  const priorRole = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(adminId).first<{ role: string }>();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(riderId).run();
  await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
  const rider = await login('rider');
  await acceptConsents(rider);
  try {
    const noCsrf = await request('/api/v1/me/driver-profile', { method: 'PUT', cookie: rider.cookie, body: profile });
    expect(noCsrf.status).toBe(403);
    expect((await request('/api/v1/me/driver-profile', {
      method: 'PUT', ...rider, body: { ...profile, verificationStatus: 'VERIFIED', verifiedUntil: Date.now() + 60_000 },
    })).status).toBe(400);

    const submitted = await request('/api/v1/me/driver-profile', { method: 'PUT', ...rider, body: profile });
    expect(submitted.status).toBe(200);
    expect((await submitted.json() as { data: { status: string } }).data.status).toBe('PENDING');
    const ownProfile = await request('/api/v1/me', { cookie: rider.cookie });
    expect(ownProfile.headers.get('Cache-Control')).toBe('no-store');
    expect((await ownProfile.json() as { data: { driverProfile: { vehicleIdentifier: string; verificationStatus: string } } })
      .data.driverProfile).toMatchObject({ vehicleIdentifier: profile.vehicleIdentifier, verificationStatus: 'PENDING' });
    expect((await request('/api/v1/admin/driver-profiles', { cookie: rider.cookie })).status).toBe(404);

    await env.DB.prepare("UPDATE users SET role='ADMIN' WHERE id=?").bind(adminId).run();
    const admin = await login('driver');
    await acceptConsents(admin);
    const queue = await request('/api/v1/admin/driver-profiles', { cookie: admin.cookie });
    expect(queue.status).toBe(200);
    expect((await queue.json() as { data: Array<{ userId: string; vehicleIdentifier: string }> }).data)
      .toContainEqual(expect.objectContaining({ userId: riderId, vehicleIdentifier: profile.vehicleIdentifier }));

    const invalidDecision = await request(`/api/v1/admin/driver-profiles/${riderId}`, {
      method: 'PATCH', ...admin, body: { outcome: 'VERIFIED', validUntil: Date.now() - 1 },
    });
    expect(invalidDecision.status).toBe(400);
    const approval = await request(`/api/v1/admin/driver-profiles/${riderId}`, {
      method: 'PATCH', ...admin, body: { outcome: 'VERIFIED', validUntil: Date.now() + 86_400_000 },
    });
    expect(approval.status).toBe(200);
    await env.DB.prepare('UPDATE driver_profiles SET verified_until=? WHERE user_id=?').bind(Date.now() - 1, riderId).run();
    const expired = await request('/api/v1/me', { cookie: rider.cookie });
    expect((await expired.json() as { data: { driverProfile: { verificationStatus: string } } }).data.driverProfile.verificationStatus).toBe('EXPIRED');

    const renewed = await request('/api/v1/me/driver-profile', { method: 'PUT', ...rider, body: profile });
    expect(renewed.status).toBe(200);
    const rejected = await request(`/api/v1/admin/driver-profiles/${riderId}`, {
      method: 'PATCH', ...admin, body: { outcome: 'REJECTED' },
    });
    expect(rejected.status).toBe(200);
    expect((await request('/api/v1/me/driver-profile', { method: 'PUT', ...rider, body: profile })).status).toBe(200);
    await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(priorRole?.role ?? 'STUDENT', adminId).run();

    const now = Date.now();
    const requestId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO ride_requests
      (id,trip_id,rider_id,desired_departure_at,gender_snapshot,gender_filter,department_id_snapshot,
       department_verified_snapshot,prefer_same_department,expires_at,last_command_id,created_at)
      VALUES(?, '50000000-0000-4000-8000-000000000001', ?, ?, 'WOMAN', 'ANY',
        '10000000-0000-4000-8000-000000000001', 1, 1, ?, ?, ?)`)
      .bind(requestId, riderId, now + 60_000, now + 180_000, crypto.randomUUID(), now).run();
    const lockedEdit = await request('/api/v1/me/driver-profile', {
      method: 'PUT', ...rider, body: { ...profile, vehicleColor: '초록' },
    });
    expect(lockedEdit.status).toBe(409);
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM ride_requests WHERE id=?').bind(requestId).run();
  } finally {
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(priorRole?.role ?? 'STUDENT', adminId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(adminId).run();
  }
});
