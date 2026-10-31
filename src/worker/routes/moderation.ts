import { z } from 'zod';
import type { Hono } from 'hono';
import { blockCreateSchema, reportCreateSchema, reportDecisionSchema, suspendUserSchema } from '../../shared/moderation';
import { adminAccessFailure, requireStudentMutation, studentAccessFailure } from '../auth/access';
import { getSession, sha256, verifyMutation } from '../auth/session';
import { rateLimit } from '../rate-limit';
import type { AppEnv } from '../types';

export function registerModerationRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/reports', async (c) => {
    const guard = await requireStudentMutation(c);
    if (guard.response) return guard.response;
    const result = guard.result!;
    const input = reportCreateSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    if (!input.success || key.length < 1 || key.length > 128) return c.json({ error: { code: 'VALIDATION_ERROR', message: '신고 내용과 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const now = Date.now();
    const bodyHash = await sha256(JSON.stringify(input.data));
    await c.env.DB.prepare(`DELETE FROM idempotency_keys
      WHERE user_id=? AND operation='CREATE_REPORT' AND key=? AND expires_at<=?`)
      .bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='CREATE_REPORT' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 Idempotency-Key를 다른 신고 내용에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      let body: unknown;
      try { body = JSON.parse(stored.resultJson); } catch { body = null; }
      const parsed = z.object({ id: z.uuid(), status: z.literal('OPEN') }).safeParse(body);
      if (!parsed.success || !await c.env.DB.prepare('SELECT id FROM reports WHERE id=? AND reporter_id=?')
        .bind(parsed.data.id, result.session.userId).first()) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '신고 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ data: parsed.data, meta: { requestId: c.get('requestId') } }, 201);
    };
    const replay = await storedResponse();
    if (replay) return replay;
    if (!await rateLimit(c.env.DB, result.session.userId, 'REPORT_CREATE', now, 5, 60 * 60_000)) {
      return c.json({ error: { code: 'RATE_LIMITED', message: '신고 접수가 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    }
    const id = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,'CREATE_REPORT',?,?,?,?,201,?,?)`)
          .bind(result.session.userId, key, bodyHash, commandId, '{}', now, now + 24 * 60 * 60_000),
        c.env.DB.prepare(`INSERT INTO reports
          (id,reporter_id,reported_user_id,trip_id,request_id,category,description,created_at)
          SELECT ?,?,CASE WHEN t.driver_id=? THEN rr.rider_id ELSE t.driver_id END,
            rr.trip_id,rr.id,?,?,?
          FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id
          WHERE rr.id=? AND (t.driver_id=? OR rr.rider_id=?)`)
          .bind(id, result.session.userId, result.session.userId, input.data.category, input.data.description, now,
            input.data.requestId, result.session.userId, result.session.userId),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',r.id,'status',r.status) FROM reports r WHERE r.id=? AND r.reporter_id=?
          ) WHERE user_id=? AND operation='CREATE_REPORT' AND key=? AND command_id=?`)
          .bind(id, result.session.userId, result.session.userId, key, commandId),
      ]);
    } catch (error) {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      if (error instanceof Error && /REPORT_RELATION_REQUIRED/.test(error.message)) {
        return c.json({ error: { code: 'NOT_FOUND', message: '신고할 수 있는 운행 관계를 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      }
      if (error instanceof Error && /NOT NULL constraint failed: idempotency_keys\.result_json/.test(error.message)) {
        return c.json({ error: { code: 'NOT_FOUND', message: '신고할 수 있는 운행 관계를 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 Idempotency-Key를 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '신고를 접수하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id, status: 'OPEN' }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.get('/api/v1/me/reportable-requests', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const studentFailure = await studentAccessFailure(c, result.session);
    if (studentFailure) return studentFailure;
    const reports = await c.env.DB.prepare(`SELECT rr.id AS requestId,rr.trip_id AS tripId,
        CASE WHEN t.driver_id=? THEN rider.id ELSE driver.id END AS otherUserId,
        CASE WHEN t.driver_id=? THEN rider.nickname ELSE driver.nickname END AS otherNickname,
        rr.status AS requestStatus,t.status AS tripStatus,t.updated_at AS endedAt
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id
      JOIN users driver ON driver.id=t.driver_id JOIN users rider ON rider.id=rr.rider_id
      WHERE (t.driver_id=? OR rr.rider_id=?)
        AND (rr.status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')
          OR t.status IN ('COMPLETED','CANCELLED','EXPIRED','ABORTED'))
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.reporter_id=? AND r.request_id=rr.id)
      ORDER BY MAX(rr.updated_at,t.updated_at) DESC,rr.id DESC LIMIT 20`)
      .bind(result.session.userId, result.session.userId, result.session.userId, result.session.userId, result.session.userId)
      .all();
    return c.json({ data: reports.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/v1/me/active-peers', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const studentFailure = await studentAccessFailure(c, result.session);
    if (studentFailure) return studentFailure;
    const peers = await c.env.DB.prepare(`WITH active_trip AS (
        SELECT l.role,l.request_id AS requestId,
          CASE WHEN l.role='DRIVER' THEN l.trip_id
            ELSE (SELECT rr.trip_id FROM ride_requests rr WHERE rr.id=l.request_id AND rr.status IN ('ACCEPTED','BOARDED')) END AS tripId
        FROM active_user_locks l WHERE l.user_id=?
      )
      SELECT DISTINCT peer.id AS userId,peer.nickname,
        CASE WHEN peer.id=t.driver_id THEN 'DRIVER' ELSE 'RIDER' END AS role
      FROM active_trip a JOIN trips t ON t.id=a.tripId
      JOIN users peer ON peer.id=t.driver_id OR peer.id IN (
        SELECT rr.rider_id FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')
      )
      WHERE t.status IN ('OPEN','IN_PROGRESS') AND peer.id<>?
        AND (peer.id=t.driver_id OR EXISTS (
          SELECT 1 FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.rider_id=peer.id AND rr.status IN ('ACCEPTED','BOARDED')
        ))
        AND (a.role='DRIVER' OR EXISTS (
          SELECT 1 FROM ride_requests own WHERE own.id=a.requestId AND own.status IN ('ACCEPTED','BOARDED')
        ))
        AND peer.account_status='ACTIVE' AND peer.role='STUDENT'
      ORDER BY peer.nickname,peer.id LIMIT 10`)
      .bind(result.session.userId, result.session.userId).all();
    return c.json({ data: peers.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/v1/blocks', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const studentFailure = await studentAccessFailure(c, result.session);
    if (studentFailure) return studentFailure;
    const blocks = await c.env.DB.prepare(`SELECT b.blocked_id AS userId,u.nickname,b.created_at AS createdAt
      FROM user_blocks b JOIN users u ON u.id=b.blocked_id
      WHERE b.blocker_id=? ORDER BY b.created_at DESC,b.blocked_id LIMIT 50`)
      .bind(result.session.userId).all();
    return c.json({ data: blocks.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.post('/api/v1/blocks', async (c) => {
    const guard = await requireStudentMutation(c);
    if (guard.response) return guard.response;
    const input = blockCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '차단할 상대를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const result = guard.result!;
    const eventId = crypto.randomUUID();
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_BLOCKED','user_block',?,?, '{}',?)`)
        .bind(eventId, result.session.userId, input.data.blockedUserId, eventId, Date.now()).run();
    } catch (error) {
      if (error instanceof Error && /BLOCK_RELATION_REQUIRED/.test(error.message)) {
        return c.json({ error: { code: 'NOT_FOUND', message: '차단할 수 있는 동승 관계를 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      }
      if (error instanceof Error && /BLOCK_EXISTS/.test(error.message)) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '이미 차단한 사용자입니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '차단을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { userId: input.data.blockedUserId }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.delete('/api/v1/blocks/:userId', async (c) => {
    const guard = await requireStudentMutation(c);
    if (guard.response) return guard.response;
    const userId = z.uuid().safeParse(c.req.param('userId'));
    if (!userId.success) return c.json({ error: { code: 'NOT_FOUND', message: '차단 항목을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const result = guard.result!;
    const eventId = crypto.randomUUID();
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_UNBLOCKED','user_block',?,?, '{}',?)`)
        .bind(eventId, result.session.userId, userId.data, eventId, Date.now()).run();
    } catch (error) {
      if (error instanceof Error && /BLOCK_NOT_FOUND/.test(error.message)) {
        return c.json({ error: { code: 'NOT_FOUND', message: '차단 항목을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '차단을 해제하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { userId: userId.data }, meta: { requestId: c.get('requestId') } });
  });

  app.get('/api/v1/admin/reports', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    const status = z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']).safeParse(c.req.query('status'));
    if (c.req.query('status') && !status.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '신고 상태를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const reports = await c.env.DB.prepare(`SELECT r.id,r.reporter_id AS reporterId,reporter.nickname AS reporterNickname,
        r.reported_user_id AS reportedUserId,reported.nickname AS reportedNickname,
        reported.role AS reportedRole,reported.account_status AS reportedAccountStatus,
        r.trip_id AS tripId,r.request_id AS requestId,r.category,r.description,r.status,
        r.assigned_to AS assignedTo,r.created_at AS createdAt,r.resolved_at AS resolvedAt
      FROM reports r JOIN users reporter ON reporter.id=r.reporter_id
      JOIN users reported ON reported.id=r.reported_user_id
      WHERE (? IS NULL OR r.status=?) ORDER BY r.created_at,r.id LIMIT 50`)
      .bind(status.success ? status.data : null, status.success ? status.data : null).all();
    return c.json({ data: reports.results }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.patch('/api/v1/admin/reports/:reportId', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const reportId = z.uuid().safeParse(c.req.param('reportId'));
    const input = reportDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!reportId.success || !input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '신고 처리 입력을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'REPORT_STATUS_CHANGED','report',?,?,?)`)
        .bind(crypto.randomUUID(), result.session.userId, reportId.data, JSON.stringify({ status: input.data.status }), Date.now()).run();
    } catch (error) {
      if (error instanceof Error && /REPORT_REVIEW_FORBIDDEN/.test(error.message)) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '신고가 이미 처리되었거나 처리 권한이 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '신고 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: reportId.data, status: input.data.status }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/api/v1/admin/users/:userId/suspend', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const accessFailure = await adminAccessFailure(c, result.session);
    if (accessFailure) return accessFailure;
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const userId = z.uuid().safeParse(c.req.param('userId'));
    const input = suspendUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!userId.success || !input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '정지 대상과 사유를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    const target = await c.env.DB.prepare('SELECT role,account_status AS accountStatus FROM users WHERE id=?')
      .bind(userId.data).first<{ role: string; accountStatus: string }>();
    if (!target || target.role !== 'STUDENT') return c.json({ error: { code: 'NOT_FOUND', message: '정지할 학생을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    if (target.accountStatus !== 'ACTIVE') return c.json({ error: { code: 'INVALID_TRANSITION', message: '이미 이용할 수 없는 계정입니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    const eventId = crypto.randomUUID();
    try {
      await c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        VALUES(?,?,'USER_SUSPENDED','user',?,?,?,?)`)
        .bind(eventId, result.session.userId, userId.data, crypto.randomUUID(), JSON.stringify({ reason: input.data.reason }), Date.now()).run();
    } catch (error) {
      if (error instanceof Error && /USER_SUSPEND_FORBIDDEN/.test(error.message)) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '계정 상태가 변경되어 정지할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '계정을 정지하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: userId.data, status: 'SUSPENDED' }, meta: { requestId: c.get('requestId') } });
  });
}
