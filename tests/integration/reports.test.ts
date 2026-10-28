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

it('accepts reports only from trip participants and audits admin status changes', async () => {
  const previousRole = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(driverId).first<{ role: string }>();
  await env.DB.prepare('DELETE FROM reports WHERE reporter_id IN (?,?)').bind(driverId, riderId).run();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(riderId).run();
  await env.DB.prepare("DELETE FROM idempotency_keys WHERE operation='CREATE_REQUEST'").run();
  await env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation IN ('CREATE_REQUEST','REPORT_CREATE')").run();
  await env.DB.prepare("UPDATE users SET role='STUDENT' WHERE id=?").bind(driverId).run();
  const rider = await login('rider');
  let reportId: string | null = null;
  try {
    await acceptConsents(rider);
    expect((await request('/api/v1/admin/reports', { cookie: rider.cookie })).status).toBe(404);
    expect((await request('/api/v1/reports', { method: 'POST', cookie: rider.cookie, body: {} })).status).toBe(403);
    expect((await request('/api/v1/reports', {
      method: 'POST', ...rider, body: { requestId: crypto.randomUUID(), category: ' ', description: ' ' },
    })).status).toBe(400);

    const trip = await env.DB.prepare('SELECT departure_at AS departureAt FROM trips WHERE id=?').bind(tripId).first<{ departureAt: number }>();
    const createdRequest = await request(`/api/v1/trips/${tripId}/requests`, {
      method: 'POST', ...rider, key: crypto.randomUUID(),
      body: { desiredDepartureAt: trip!.departureAt, genderFilter: 'ANY', preferSameDepartment: true },
    });
    expect(createdRequest.status).toBe(201);
    const requestId = (await createdRequest.json() as { data: { id: string } }).data.id;
    expect(await env.DB.prepare(`SELECT rr.id,rr.trip_id,t.driver_id,rr.rider_id FROM ride_requests rr
      JOIN trips t ON t.id=rr.trip_id WHERE rr.id=?`).bind(requestId).first())
      .toMatchObject({ id: requestId, trip_id: tripId, driver_id: driverId, rider_id: riderId });
    expect((await request('/api/v1/reports', {
      method: 'POST', ...rider, body: { requestId, category: '안전', description: '키가 없습니다.' },
    })).status).toBe(400);

    const invalidRelation = await request('/api/v1/reports', {
      method: 'POST', ...rider, key: crypto.randomUUID(), body: { requestId: crypto.randomUUID(), category: '안전', description: '관련 요청이 아닙니다.' },
    });
    expect(invalidRelation.status).toBe(404);
    const submitted = await request('/api/v1/reports', {
      method: 'POST', ...rider, key: 'report-retry-1', body: { requestId, category: '안전', description: '합성 신고 내용' },
    });
    const submittedBody = await submitted.json() as { data?: { id: string; status: string }; error?: { message: string } };
    expect(submitted.status, submittedBody.error?.message).toBe(201);
    const receipt = submittedBody.data!;
    reportId = receipt.id;
    expect(receipt.status).toBe('OPEN');
    expect((await request('/api/v1/reports', {
      method: 'POST', ...rider, key: 'report-retry-1', body: { requestId, category: '안전', description: '합성 신고 내용' },
    })).status).toBe(201);
    expect((await request('/api/v1/reports', {
      method: 'POST', ...rider, key: 'report-retry-1', body: { requestId, category: '안전', description: '다른 본문' },
    })).status).toBe(409);
    const stored = await env.DB.prepare(`SELECT reporter_id AS reporterId,reported_user_id AS reportedUserId,
      trip_id AS tripId,request_id AS requestId,description,status FROM reports WHERE id=?`)
      .bind(reportId).first<{ reporterId: string; reportedUserId: string; tripId: string; requestId: string; description: string; status: string }>();
    expect(stored).toMatchObject({ reporterId: riderId, reportedUserId: driverId, tripId, requestId, description: '합성 신고 내용', status: 'OPEN' });
    expect(await env.DB.prepare("SELECT id FROM audit_events WHERE event_type='REPORT_SUBMITTED' AND resource_id=?")
      .bind(reportId).first()).not.toBeNull();

    await env.DB.prepare("UPDATE users SET role='ADMIN' WHERE id=?").bind(driverId).run();
    const admin = await login('driver');
    await acceptConsents(admin);
    const queue = await request('/api/v1/admin/reports', { cookie: admin.cookie });
    expect(queue.status).toBe(200);
    expect(queue.headers.get('Cache-Control')).toBe('no-store');
    expect((await queue.json() as { data: Array<{ id: string; description: string }> }).data)
      .toContainEqual(expect.objectContaining({ id: reportId, description: '합성 신고 내용' }));

    expect((await request(`/api/v1/admin/reports/${reportId}`, {
      method: 'PATCH', ...admin, body: { status: 'IN_REVIEW' },
    })).status).toBe(200);
    expect((await request(`/api/v1/admin/reports/${reportId}`, {
      method: 'PATCH', ...admin, body: { status: 'RESOLVED' },
    })).status).toBe(200);
    expect((await request(`/api/v1/admin/reports/${reportId}`, {
      method: 'PATCH', ...admin, body: { status: 'DISMISSED' },
    })).status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM reports WHERE id=?').bind(reportId).first())
      .toMatchObject({ status: 'RESOLVED' });
    await expect(env.DB.prepare("UPDATE reports SET status='DISMISSED' WHERE id=?").bind(reportId).run())
      .rejects.toThrow(/REPORT_STATUS_AUDIT_REQUIRED/);
  } finally {
    if (reportId) {
      await env.DB.prepare('DELETE FROM audit_events WHERE resource_type=? AND resource_id=?').bind('report', reportId).run();
      await env.DB.prepare('DELETE FROM reports WHERE id=?').bind(reportId).run();
    }
    await env.DB.prepare(`DELETE FROM audit_events WHERE resource_type='report' AND resource_id IN
      (SELECT id FROM reports WHERE request_id IN (SELECT id FROM ride_requests WHERE rider_id=?))`).bind(riderId).run();
    await env.DB.prepare('DELETE FROM reports WHERE request_id IN (SELECT id FROM ride_requests WHERE rider_id=?)').bind(riderId).run();
    await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(riderId).run();
    await env.DB.prepare('DELETE FROM consents WHERE user_id IN (?,?)').bind(driverId, riderId).run();
    await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(previousRole?.role ?? 'STUDENT', driverId).run();
    await env.DB.prepare("DELETE FROM rate_limit_buckets WHERE operation IN ('CREATE_REQUEST','REPORT_CREATE')").run();
  }
});
