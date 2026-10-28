import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';
const adminId = '20000000-0000-4000-8000-000000000004';

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

async function adminSession() {
  const login = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'admin' } });
  expect(login.status).toBe(201);
  const cookie = login.headers.get('Set-Cookie')!.split(';', 1)[0];
  const me = await request('/api/v1/me', { cookie });
  const profile = await me.json() as { data: { csrfToken: string } };
  const session = { cookie, csrf: profile.data.csrfToken };
  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', ...session, body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }
  return session;
}

it('manages stops and routes through admin permissions and audited D1 changes', async () => {
  const admin = await adminSession();
  try {
    expect((await request('/api/v1/admin/stops')).status).toBe(401);
    expect((await request('/api/v1/admin/stops', { cookie: admin.cookie })).status).toBe(200);
    expect((await request('/api/v1/admin/routes', { cookie: admin.cookie })).status).toBe(200);
    expect((await request('/api/v1/admin/stops/30000000-0000-4000-8000-000000000001', {
      method: 'PATCH', ...admin, body: { name: '변경 금지', kind: 'GATE', lat: 0, lng: 0, active: true },
    })).status).toBe(409);
    expect((await request('/api/v1/admin/routes/40000000-0000-4000-8000-000000000001', {
      method: 'PATCH', ...admin, body: { active: false },
    })).status).toBe(409);
    expect((await request('/api/v1/admin/stops', {
      method: 'POST', cookie: admin.cookie,
      body: { name: '지점', kind: 'GATE', lat: 37.5, lng: 127, active: true },
    })).status).toBe(403);
    expect((await request('/api/v1/admin/stops', {
      method: 'POST', ...admin, body: { name: '잘못된 좌표', kind: 'GATE', lat: 91, lng: 127, active: true },
    })).status).toBe(400);

    const gateResponse = await request('/api/v1/admin/stops', {
      method: 'POST', ...admin, body: { name: '합성 교문 A', kind: 'GATE', lat: 37.5, lng: 127, active: true },
    });
    expect(gateResponse.status).toBe(201);
    const gate = (await gateResponse.json() as { data: { id: string } }).data;
    const destinationResponse = await request('/api/v1/admin/stops', {
      method: 'POST', ...admin, body: { name: '합성 목적지 A', kind: 'DESTINATION', lat: 37.51, lng: 127.01, active: true },
    });
    expect(destinationResponse.status).toBe(201);
    const destination = (await destinationResponse.json() as { data: { id: string } }).data;

    const invalidRoute = await request('/api/v1/admin/routes', {
      method: 'POST', ...admin, body: { originStopId: destination.id, destinationStopId: gate.id },
    });
    expect(invalidRoute.status).toBe(409);
    const routeResponse = await request('/api/v1/admin/routes', {
      method: 'POST', ...admin, body: { originStopId: gate.id, destinationStopId: destination.id },
    });
    expect(routeResponse.status).toBe(201);
    const route = (await routeResponse.json() as { data: { id: string } }).data;
    expect((await request('/api/v1/admin/routes', {
      method: 'POST', ...admin, body: { originStopId: gate.id, destinationStopId: destination.id },
    })).status).toBe(409);

    expect((await request(`/api/v1/admin/stops/${gate.id}`, {
      method: 'PATCH', ...admin, body: { name: '합성 교문 A 변경', kind: 'GATE', lat: 37.5, lng: 127, active: true },
    })).status).toBe(200);
    expect((await request(`/api/v1/admin/stops/${gate.id}`, {
      method: 'PATCH', ...admin, body: { name: '합성 교문 A 변경', kind: 'GATE', lat: 37.5, lng: 127, active: false },
    })).status).toBe(200);
    expect((await request(`/api/v1/admin/routes/${route.id}`, {
      method: 'PATCH', ...admin, body: { active: true },
    })).status).toBe(409);
    expect((await request(`/api/v1/admin/routes/${route.id}`, {
      method: 'PATCH', ...admin, body: { active: false },
    })).status).toBe(200);

    await expect(env.DB.prepare('UPDATE routes SET active=1 WHERE id=?').bind(route.id).run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM routes WHERE id=?').bind(route.id).run()).rejects.toThrow();
    const audit = await env.DB.prepare(`SELECT event_type AS eventType FROM audit_events
      WHERE resource_id IN (?,?) ORDER BY created_at`).bind(gate.id, route.id).all<{ eventType: string }>();
    expect(audit.results.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'STOP_CREATED', 'STOP_UPDATED', 'ROUTE_CREATED', 'ROUTE_UPDATED',
    ]));
  } finally {
    await env.DB.prepare('DELETE FROM consents WHERE user_id=?').bind(adminId).run();
  }
});
