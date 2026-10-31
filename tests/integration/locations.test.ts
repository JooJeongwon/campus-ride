import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const origin = 'http://localhost:8787';

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

it('offers the three fixed pickup points and keeps live location collection disabled', async () => {
  const health = await request('/api/v1/health');
  expect(health.status).toBe(200);
  expect(health.headers.get('Permissions-Policy')).toContain('geolocation=()');

  const login = await request('/api/v1/auth/dev', { method: 'POST', body: { identity: 'driver' } });
  expect(login.status).toBe(201);
  const cookie = login.headers.get('Set-Cookie')!.split(';', 1)[0];
  const profile = await request('/api/v1/me', { cookie });
  const csrf = (await profile.json() as { data: { csrfToken: string } }).data.csrfToken;

  for (const kind of ['TERMS', 'PRIVACY']) {
    expect((await request('/api/v1/me/consents', {
      method: 'POST', cookie, csrf,
      body: { kind, policyVersion: 'local-demo-v1', granted: true },
    })).status).toBe(200);
  }

  const routes = await request('/api/v1/routes', { cookie });
  expect(routes.status).toBe(200);
  const routeRows = (await routes.json() as { data: Array<{ originName: string; destinationName: string }> }).data;
  expect(routeRows.map((route) => route.originName).sort()).toEqual([
    'AI공학관', '반도체대학', '중앙도서관',
  ].sort());
  expect(routeRows.every((route) => route.destinationName === '가상 캠퍼스')).toBe(true);

  for (const [path, method] of [
    ['/api/v1/locations/me', 'GET'],
    ['/api/v1/locations/me', 'PUT'],
    ['/api/v1/trips/50000000-0000-4000-8000-000000000001/locations', 'GET'],
  ] as const) {
    expect((await request(path, { method, cookie, csrf, body: method === 'PUT' ? { lat: 37.5, lng: 127 } : undefined })).status).toBe(404);
  }

  for (const kind of ['LOCATION_COLLECTION', 'LOCATION_SHARING']) {
    const disabled = await request('/api/v1/me/consents', {
      method: 'POST', cookie, csrf,
      body: { kind, policyVersion: 'local-location-v1', granted: true },
    });
    expect(disabled.status).toBe(409);
    expect((await disabled.json() as { error: { code: string } }).error.code).toBe('FEATURE_DISABLED');
  }

  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM latest_locations')
    .first<{ count: number }>())?.count).toBe(0);
});
