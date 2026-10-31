import { z } from 'zod';
import type { Hono } from 'hono';
import { adminRouteCreateSchema, adminRouteUpdateSchema, adminStopSchema } from '../../shared/admin';
import { adminAccessFailure, requiredConsentFailure } from '../auth/access';
import { getSession, verifyMutation } from '../auth/session';
import type { AppEnv } from '../types';

export function registerCatalogRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/routes', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    if (result.session.affiliationStatus !== 'VERIFIED') return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const routes = await c.env.DB.prepare(`SELECT r.id,origin.name AS originName,destination.name AS destinationName
      FROM routes r JOIN users u ON u.id=? AND u.school_id=r.school_id AND u.campus_id=r.campus_id
      JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE r.active=1 AND origin.active=1 AND origin.kind='GATE'
        AND destination.active=1 AND destination.kind='DESTINATION'
      ORDER BY origin.name,r.id LIMIT 50`).bind(result.session.userId).all();
    return c.json({ data: routes.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/v1/admin/stops', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    const stops = await c.env.DB.prepare(`SELECT s.id,s.name,s.kind,s.lat,s.lng,s.active
      FROM stops s JOIN users actor ON actor.id=? AND actor.school_id=s.school_id AND actor.campus_id=s.campus_id
      ORDER BY s.kind,s.name,s.id LIMIT 100`).bind(result.session.userId).all();
    return c.json({ data: stops.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.post('/api/v1/admin/stops', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const input = adminStopSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '지점 이름·종류·좌표를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'STOP_CREATED','stop',?,?,?)`)
        .bind(crypto.randomUUID(), result.session.userId, id, JSON.stringify(input.data), Date.now()).run();
    } catch {
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '지점을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id, ...input.data } }, 201);
  });

  app.patch('/api/v1/admin/stops/:stopId', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const stopId = z.uuid().safeParse(c.req.param('stopId'));
    const input = adminStopSchema.safeParse(await c.req.json().catch(() => null));
    if (!stopId.success || !input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '지점 정보와 좌표를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'STOP_UPDATED','stop',?,?,?)`)
        .bind(crypto.randomUUID(), result.session.userId, stopId.data, JSON.stringify(input.data), Date.now()).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/STOP_NOT_FOUND/.test(message)) return c.json({ error: { code: 'NOT_FOUND', message: '지점을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      if (/STOP_HAS_ACTIVE_TRIPS/.test(message)) return c.json({ error: { code: 'CONFLICT', message: '진행 중인 운행이 끝난 뒤 지점을 수정해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '지점을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: stopId.data, ...input.data } });
  });

  app.get('/api/v1/admin/routes', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    const routes = await c.env.DB.prepare(`SELECT r.id,r.origin_stop_id AS originStopId,r.destination_stop_id AS destinationStopId,
        origin.name AS originName,destination.name AS destinationName,r.active
      FROM routes r JOIN users actor ON actor.id=? AND actor.school_id=r.school_id AND actor.campus_id=r.campus_id
      JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id
      ORDER BY origin.name,destination.name,r.id LIMIT 100`).bind(result.session.userId).all();
    return c.json({ data: routes.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.post('/api/v1/admin/routes', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const input = adminRouteCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '출발 지점과 목적지를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'ROUTE_CREATED','route',?,?,?)`)
        .bind(crypto.randomUUID(), result.session.userId, id, JSON.stringify({ ...input.data, active: true }), Date.now()).run();
    } catch (error) {
      if (error instanceof Error && /ROUTE_STOPS_INVALID|UNIQUE constraint/.test(error.message)) {
        return c.json({ error: { code: 'CONFLICT', message: '활성 승차 지점과 목적지를 고르고 중복 노선이 아닌지 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '노선을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id, ...input.data, active: 1 } }, 201);
  });

  app.patch('/api/v1/admin/routes/:routeId', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const routeId = z.uuid().safeParse(c.req.param('routeId'));
    const input = adminRouteUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!routeId.success || !input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '노선 사용 상태를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'ROUTE_UPDATED','route',?,?,?)`)
        .bind(crypto.randomUUID(), result.session.userId, routeId.data, JSON.stringify(input.data), Date.now()).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/ROUTE_NOT_FOUND/.test(message)) return c.json({ error: { code: 'NOT_FOUND', message: '노선을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      if (/ROUTE_HAS_ACTIVE_TRIPS/.test(message)) return c.json({ error: { code: 'CONFLICT', message: '진행 중인 운행이 끝난 뒤 노선을 변경해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      if (/ROUTE_STOPS_INACTIVE/.test(message)) return c.json({ error: { code: 'CONFLICT', message: '활성 승차 지점과 목적지가 있는 노선만 다시 사용할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '노선 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: routeId.data, active: input.data.active ? 1 : 0 } });
  });
}
