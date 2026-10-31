import { env, exports } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { runScheduledCleanup } from '../../src/worker/jobs/cleanup';
import { healthResponse } from '../../src/shared/api';

const driver = '20000000-0000-4000-8000-000000000001';
const rider = '20000000-0000-4000-8000-000000000002';
const trip = '50000000-0000-4000-8000-000000000001';

it('serves safe health and JSON errors through the Worker runtime', async () => {
  const health = await exports.default.fetch('http://localhost/api/v1/health');
  expect(health.status).toBe(200);
  expect(healthResponse.safeParse(await health.json()).success).toBe(true);
  expect(health.headers.get('Cache-Control')).toBe('no-store');
  expect(health.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  expect(health.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(health.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  expect(health.headers.get('Content-Security-Policy')).toContain("img-src 'self'");
  expect(health.headers.get('Content-Security-Policy')).toContain("style-src-attr 'unsafe-inline'");
  expect(health.headers.get('Permissions-Policy')).toContain('geolocation=()');
  expect(health.headers.get('X-Content-Type-Options')).toBe('nosniff');
  for (const path of ['/api', '/api/unknown', '/api/v1/missing']) {
    const missing = await exports.default.fetch(`http://localhost${path}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toContain('application/json');
  }
});

it('keeps unimplemented domain APIs closed and requires auth for trip APIs', async () => {
  const unauthenticatedProfile = await exports.default.fetch('http://localhost:8787/api/v1/me');
  expect(unauthenticatedProfile.status).toBe(401);
  const unauthenticatedConsent = await exports.default.fetch('http://localhost:8787/api/v1/me/consents', { method: 'POST' });
  expect(unauthenticatedConsent.status).toBe(401);
  for (const path of ['stops', 'departments', 'admin/users/id']) {
    for (const method of ['GET', 'POST']) {
      const response = await exports.default.fetch(`http://localhost/api/v1/${path}`, { method, headers: { Cookie: 'campus_session=forged' } });
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  }
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await exports.default.fetch(`http://localhost/api/v1/blocks${method === 'DELETE' ? '/00000000-0000-4000-8000-000000000001' : ''}`, {
      method, headers: { Cookie: 'campus_session=forged' },
    });
    expect(response.status).toBe(401);
  }
  expect((await exports.default.fetch('http://localhost/api/v1/reports', { method: 'POST' })).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/reports', { method: 'GET' })).status).toBe(404);
  expect((await exports.default.fetch('http://localhost/api/v1/me/reportable-requests')).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/admin/reports')).status).toBe(401);
  expect((await exports.default.fetch('http://localhost:8787/api/v1/locations/me', { headers: { Cookie: 'campus_session=forged' } })).status).toBe(404);
  expect((await exports.default.fetch('http://localhost:8787/api/v1/locations/me', { method: 'PUT', headers: { Cookie: 'campus_session=forged' } })).status).toBe(404);
  expect((await exports.default.fetch('http://localhost:8787/api/v1/trips/50000000-0000-4000-8000-000000000001/locations')).status).toBe(404);
  expect((await exports.default.fetch('http://localhost/api/v1/requests/id', { headers: { Cookie: 'campus_session=forged' } })).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/requests/00000000-0000-4000-8000-000000000001', { headers: { Cookie: 'campus_session=forged' } })).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/routes')).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/trips', { method: 'POST' })).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/trips/50000000-0000-4000-8000-000000000001')).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/trips')).status).toBe(401);
  expect((await exports.default.fetch('http://localhost/api/v1/auth/google/start')).status).toBe(503);
});

it('fails closed for remote configuration without leaking configuration values', async () => {
  const response = await worker.request('/api/v1/health', {}, { ...env, APP_ENV: 'production' });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic');
});

it('sanitizes database exceptions', async () => {
  const response = await worker.request('/api/v1/health', {}, {
    ...env,
    DB: { prepare() { throw new Error('SECRET SQL details'); } } as unknown as D1Database,
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('SECRET');
});

it('retries one bounded cleanup pass and reports only safe run metadata', async () => {
  let failOnce = true;
  const flakyDb = {
    prepare(query: string) {
      if (failOnce && query.includes("FROM users WHERE role='STUDENT'")) {
        failOnce = false;
        throw new Error('SECRET SQL details');
      }
      return env.DB.prepare(query);
    },
    batch: env.DB.batch.bind(env.DB),
  } as unknown as D1Database;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const result = await runScheduledCleanup(flakyDb, Date.now() - 10_000);
    expect(result).toMatchObject({
      outcome: 'RECOVERED', attempts: 2, firstFailureStage: 'EXPIRE_STUDENTS',
    });
    expect(result.scheduledDelayMs).toBeGreaterThanOrEqual(10_000);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(log).toHaveBeenCalledWith(result);
  } finally {
    log.mockRestore();
  }
});

it('stops after two failed cleanup passes without logging the D1 error', async () => {
  let attempts = 0;
  const brokenDb = {
    prepare(query: string) {
      if (query.includes("FROM users WHERE role='STUDENT'")) {
        attempts++;
        throw new Error('SECRET SQL details');
      }
      return env.DB.prepare(query);
    },
    batch: env.DB.batch.bind(env.DB),
  } as unknown as D1Database;
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(runScheduledCleanup(brokenDb, Date.now())).rejects.toThrow('scheduled cleanup failed');
    expect(attempts).toBe(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'scheduled_cleanup', outcome: 'FAILED', attempts: 2,
      firstFailureStage: 'EXPIRE_STUDENTS', failureStage: 'EXPIRE_STUDENTS',
    }));
  } finally {
    log.mockRestore();
  }
});

it('applies all 18 domain tables, relational constraints and synthetic seed', async () => {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = tables.results.map((row) => row.name);
  for (const name of ['users', 'student_verifications', 'departments', 'stops', 'routes', 'driver_profiles', 'trips', 'ride_requests', 'active_user_locks', 'latest_locations', 'sessions', 'oauth_states', 'consents', 'user_blocks', 'reports', 'audit_events', 'idempotency_keys', 'rate_limit_buckets']) {
    expect(names).toContain(name);
  }
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(4);
  expect((await env.DB.prepare("SELECT role FROM users WHERE id='20000000-0000-4000-8000-000000000004'").first<{ role: string }>())?.role).toBe('ADMIN');
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await expect(env.DB.prepare("INSERT INTO departments (id,school_id,code,name) VALUES (NULL,'test','NULL_ID','invalid')").run()).rejects.toThrow(/NOT NULL/);
  await expect(env.DB.prepare('INSERT INTO user_blocks (blocker_id,blocked_id,created_at,last_event_id) VALUES (?, ?, ?, NULL)')
    .bind(driver, 'missing-user', Date.now()).run()).rejects.toThrow(/BLOCK_AUDIT_REQUIRED/);
  await expect(env.DB.prepare('UPDATE trips SET seat_capacity = 5 WHERE id = ?').bind(trip).run()).rejects.toThrow(/CHECK/);
  await expect(env.DB.prepare("UPDATE trips SET gender_snapshot = 'UNDISCLOSED', gender_filter = 'WOMAN' WHERE id = ?").bind(trip).run()).rejects.toThrow(/CHECK/);
  await expect(env.DB.prepare("INSERT INTO active_user_locks VALUES (?, 'RIDER', NULL, NULL, ?)").bind(rider, Date.now()).run()).rejects.toThrow(/CHECK/);
});

it('enforces partial unique indexes in D1', async () => {
  const now = Date.now();
  await expect(env.DB.batch([
    env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(driver),
    env.DB.prepare(`INSERT INTO trips (
      id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
      department_id_snapshot,department_verified_snapshot,prefer_same_department,created_at
    ) SELECT ?,driver_id,route_id,?,?,seat_capacity,gender_snapshot,gender_filter,
      department_id_snapshot,department_verified_snapshot,prefer_same_department,? FROM trips WHERE id=?`)
      .bind(crypto.randomUUID(), now + 600_000, now + 1_500_000, now, trip),
  ])).rejects.toThrow(/UNIQUE/);
  expect(await env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(driver).first()).not.toBeNull();
  const requestId = crypto.randomUUID();
  const requestNow = Date.now();
  const insert = (id: string, status: string) => env.DB.prepare(`INSERT INTO ride_requests (
    id,trip_id,rider_id,desired_departure_at,gender_snapshot,gender_filter,department_id_snapshot,
    department_verified_snapshot,prefer_same_department,status,expires_at,last_command_id,created_at
  ) SELECT ?,t.id,u.id,?,u.gender,'ANY',u.department_id,
    CASE WHEN u.department_status='VERIFIED' AND u.department_id IS NOT NULL THEN 1 ELSE 0 END,
    1,?,?,?,? FROM trips t JOIN users u ON u.id=? WHERE t.id=?`)
    .bind(id, requestNow + 600_000, status, Math.min(requestNow + 180_000, requestNow + 1_500_000), crypto.randomUUID(), requestNow, rider, trip);
  await insert(requestId, 'REQUESTED').run();
  expect(await env.DB.prepare('SELECT role,request_id AS requestId FROM active_user_locks WHERE user_id=?').bind(rider)
    .first<{ role: string; requestId: string }>()).toMatchObject({ role: 'RIDER', requestId });
  await expect(insert(crypto.randomUUID(), 'REQUESTED').run()).rejects.toThrow(/REQUEST_CREATE_FORBIDDEN/);
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(rider).run();
  await expect(insert(crypto.randomUUID(), 'REQUESTED').run()).rejects.toThrow(/UNIQUE/);
  const expiredAt = Date.now() - 1;
  await env.DB.prepare('UPDATE ride_requests SET expires_at=? WHERE id=?').bind(expiredAt, requestId).run();
  await env.DB.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,updated_at=MAX(?,updated_at+1),last_command_id=?
    WHERE id=?`).bind(Date.now(), crypto.randomUUID(), requestId).run();
  await insert(crypto.randomUUID(), 'REQUESTED').run();
  await env.DB.prepare('DELETE FROM active_user_locks WHERE user_id=?').bind(rider).run();
  await env.DB.prepare('DELETE FROM ride_requests WHERE rider_id=?').bind(rider).run();
});

it('rolls the entire D1 batch back when a trigger aborts', async () => {
  await env.DB.exec('CREATE TABLE batch_probe (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0));');
  await env.DB.exec("CREATE TRIGGER probe_abort BEFORE UPDATE ON batch_probe WHEN NEW.value = 2 BEGIN SELECT RAISE(ABORT, 'PROBE_ABORT'); END;");
  await env.DB.prepare('INSERT INTO batch_probe VALUES (?, 0)').bind('initial').run();
  await expect(env.DB.batch([
    env.DB.prepare('INSERT INTO batch_probe VALUES (?, 1)').bind('must-rollback'),
    env.DB.prepare('UPDATE batch_probe SET value = 2 WHERE id = ?').bind('initial'),
  ])).rejects.toThrow(/PROBE_ABORT/);
  expect(await env.DB.prepare('SELECT * FROM batch_probe WHERE id = ?').bind('must-rollback').first()).toBeNull();
  expect(await env.DB.prepare('SELECT value FROM batch_probe WHERE id = ?').bind('initial').first('value')).toBe(0);
});

it('demonstrates that zero-row updates commit unless an explicit constraint fails', async () => {
  const id = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO audit_events (id,event_type,resource_type,resource_id,created_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'P1_PROBE', 'test', id, Date.now()),
    env.DB.prepare('UPDATE trips SET version = version + 1 WHERE id = ?').bind('missing'),
  ]);
  expect(results[1].meta.changes).toBe(0);
  expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id = ?').bind(id).first('id')).toBe(id);

  const commandId = crypto.randomUUID();
  await expect(env.DB.batch([
    env.DB.prepare(`INSERT INTO idempotency_keys VALUES (?, 'P1_PROBE', ?, ?, ?, '{}', 200, ?, ?)`)
      .bind(rider, commandId, 'a'.repeat(64), commandId, Date.now(), Date.now() + 86400000),
    env.DB.prepare('UPDATE trips SET version = version + 1, last_command_id = ? WHERE id = ?').bind(commandId, 'missing'),
    env.DB.prepare(`UPDATE idempotency_keys SET result_json = (
      SELECT json_object('id', id, 'status', status, 'version', version) FROM trips WHERE last_command_id = ?
    ) WHERE command_id = ?`).bind(commandId, commandId),
  ])).rejects.toThrow(/NOT NULL/);
  expect(await env.DB.prepare('SELECT command_id FROM idempotency_keys WHERE command_id = ?').bind(commandId).first()).toBeNull();
});
