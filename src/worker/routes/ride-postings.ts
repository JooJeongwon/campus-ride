import { z } from 'zod';
import type { Hono } from 'hono';
import { ridePostingCancelSchema, ridePostingCreateSchema } from '../../shared/trips';
import { requiredConsentFailure } from '../auth/access';
import { getSession, sha256, verifyMutation } from '../auth/session';
import { genderGroupAllows, type MatchMember } from '../matching/eligibility';
import { matchReasons } from '../matching/rank';
import { rateLimit } from '../rate-limit';
import { expireDriverTrip, expireRiderRequest } from '../trip-commands';
import type { AppEnv } from '../types';

const postingResultSchema = z.object({ id: z.uuid(), status: z.string(), version: z.number().int().positive() });
const acceptResultSchema = z.object({ tripId: z.uuid(), requestId: z.uuid(), status: z.literal('ACCEPTED'), version: z.number().int().positive() });

async function expireOwnPosting(db: D1Database, userId: string, now: number) {
  const expired = await db.prepare(`SELECT id,updated_at AS updatedAt FROM ride_postings
    WHERE rider_id=? AND status='OPEN' AND expires_at<=?`).bind(userId, now)
    .first<{ id: string; updatedAt: number }>();
  if (expired) await db.prepare(`UPDATE ride_postings SET status='EXPIRED',version=version+1,
      updated_at=MAX(?,updated_at+1),last_command_id=? WHERE id=? AND status='OPEN' AND expires_at<=?`)
    .bind(now, crypto.randomUUID(), expired.id, now).run();
}

export function registerRidePostingRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/ride-postings', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const input = ridePostingCreateSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    const now = Date.now();
    if (!input.success || key.length < 1 || key.length > 128) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '탑승 희망 정보와 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
      || (result.session.verifiedUntil ?? 0) <= now || input.data.desiredDepartureAt < now
      || input.data.desiredDepartureAt > now + 30 * 60_000
      || (result.session.gender === 'UNDISCLOSED' && input.data.genderFilter !== 'ANY')) {
      return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '학생 자격과 희망 출발 시각·매칭 조건을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
    }
    const rate = await rateLimit(c.env.DB, result.session.userId, 'CREATE_RIDE_POSTING', now, 5, 60_000);
    if (!rate) return c.json({ error: { code: 'RATE_LIMITED', message: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    const bodyHash = await sha256(JSON.stringify(input.data));
    await c.env.DB.prepare(`DELETE FROM idempotency_keys WHERE user_id=? AND operation='CREATE_RIDE_POSTING'
      AND key=? AND expires_at<=?`).bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='CREATE_RIDE_POSTING' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 키를 다른 탑승 희망 정보에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      const response = postingResultSchema.safeParse(JSON.parse(stored.resultJson));
      if (!response.success || !await c.env.DB.prepare("SELECT id FROM ride_postings WHERE id=? AND rider_id=?")
        .bind(response.data.id, result.session.userId).first()) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승 희망 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ data: response.data }, 201);
    };
    const replay = await storedResponse();
    if (replay) return replay;
    const route = await c.env.DB.prepare(`SELECT r.id FROM routes r JOIN users u ON u.id=?
      JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE r.id=? AND r.school_id=u.school_id AND r.campus_id=u.campus_id AND r.active=1
        AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'`)
      .bind(result.session.userId, input.data.routeId).first();
    if (!route) return c.json({ error: { code: 'INVALID_ROUTE', message: '사용할 수 있는 노선이 아닙니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    await expireOwnPosting(c.env.DB, result.session.userId, now);
    await expireDriverTrip(c.env.DB, result.session.userId, now);
    await expireRiderRequest(c.env.DB, result.session.userId, now);
    if (await c.env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(result.session.userId).first()) {
      return c.json({ error: { code: 'ALREADY_ACTIVE', message: '현재 활동이 끝난 뒤 탑승 희망을 등록해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const id = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,'CREATE_RIDE_POSTING',?,?,?,?,201,?,?)`)
          .bind(result.session.userId, key, bodyHash, commandId, '{}', now, now + 86_400_000),
        c.env.DB.prepare(`INSERT INTO ride_postings
          (id,rider_id,route_id,desired_departure_at,expires_at,gender_snapshot,gender_filter,
           department_id_snapshot,department_verified_snapshot,prefer_same_department,last_command_id,created_at,updated_at)
          SELECT ?,u.id,?,?,?,u.gender,?,u.department_id,
            CASE WHEN u.department_status='VERIFIED' AND u.department_id IS NOT NULL THEN 1 ELSE 0 END,?,?,?,?
          FROM users u WHERE u.id=?`)
          .bind(id, input.data.routeId, input.data.desiredDepartureAt, input.data.desiredDepartureAt,
            input.data.genderFilter, input.data.preferSameDepartment ? 1 : 0, commandId, now, now, result.session.userId),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',id,'status',status,'version',version) FROM ride_postings WHERE id=?
          ) WHERE user_id=? AND operation='CREATE_RIDE_POSTING' AND key=? AND command_id=?`)
          .bind(id, result.session.userId, key, commandId),
      ]);
    } catch (error) {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      if (error instanceof Error && /RIDE_POSTING_CREATE_FORBIDDEN|RIDE_POSTING_ACTIVITY_CONFLICT|UNIQUE constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'ALREADY_ACTIVE', message: '이미 등록한 탑승 희망이나 진행 중 활동이 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '탑승 희망을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id, status: 'OPEN', version: 1 }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.get('/api/v1/ride-postings/mine', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const now = Date.now();
    await expireOwnPosting(c.env.DB, result.session.userId, now);
    const posting = await c.env.DB.prepare(`SELECT p.id,p.route_id AS routeId,p.desired_departure_at AS desiredDepartureAt,
        p.expires_at AS expiresAt,p.version,origin.name AS originName,destination.name AS destinationName
      FROM ride_postings p JOIN routes r ON r.id=p.route_id JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE p.rider_id=? AND p.status='OPEN' AND p.expires_at>?`)
      .bind(result.session.userId, now).first();
    return c.json({ data: posting ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/v1/ride-postings', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const now = Date.now();
    const rows = await c.env.DB.prepare(`SELECT p.id,p.route_id AS routeId,p.desired_departure_at AS desiredDepartureAt,
        p.expires_at AS expiresAt,p.created_at AS createdAt,p.gender_snapshot AS riderGender,
        p.gender_filter AS riderFilter,p.department_id_snapshot AS riderDepartmentId,
        p.department_verified_snapshot AS riderDepartmentVerified,p.prefer_same_department AS riderPreference,
        rider.nickname AS riderNickname,origin.name AS originName,destination.name AS destinationName,
        driver.gender AS driverGender,COALESCE(currentTrip.gender_filter,'ANY') AS driverFilter,
        COALESCE(currentTrip.prefer_same_department,0) AS driverPreference,
        CASE WHEN driver.department_status='VERIFIED' AND driver.department_id IS NOT NULL
          AND p.department_verified_snapshot=1 AND p.department_id_snapshot=driver.department_id THEN 1 ELSE 0 END AS sameDepartment,
        COALESCE((SELECT json_group_array(json_object('gender',member.gender_snapshot,'filter',member.gender_filter))
          FROM ride_requests member WHERE member.trip_id=currentTrip.id AND member.status IN ('ACCEPTED','BOARDED')),'[]') AS seatedMembers
      FROM ride_postings p JOIN users rider ON rider.id=p.rider_id
      JOIN routes r ON r.id=p.route_id JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN stops destination ON destination.id=r.destination_stop_id
      JOIN users driver ON driver.id=? JOIN driver_profiles profile ON profile.user_id=driver.id
      LEFT JOIN trips currentTrip ON currentTrip.id=(SELECT trip_id FROM active_user_locks
        WHERE user_id=driver.id AND role='DRIVER') AND currentTrip.status='OPEN' AND currentTrip.expires_at>?
      WHERE p.status='OPEN' AND p.expires_at>? AND p.rider_id<>driver.id
        AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
        AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
        AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
        AND profile.verification_status='VERIFIED' AND profile.verified_until>?
        AND r.active=1 AND r.school_id=driver.school_id AND r.campus_id=driver.campus_id
        AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'
        AND (NOT EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=driver.id)
          OR (currentTrip.id IS NOT NULL AND currentTrip.route_id=p.route_id
            AND ABS(currentTrip.departure_at-p.desired_departure_at)<=600000
            AND currentTrip.seat_capacity>(SELECT COUNT(*) FROM ride_requests seated
              WHERE seated.trip_id=currentTrip.id AND seated.status IN ('ACCEPTED','BOARDED'))))
        AND NOT EXISTS (SELECT 1 FROM ride_postings own WHERE own.rider_id=driver.id AND own.status='OPEN' AND own.expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=driver.id AND b.blocked_id=rider.id)
          OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))
        AND NOT EXISTS (SELECT 1 FROM ride_requests seated JOIN user_blocks b ON
          (b.blocker_id=seated.rider_id AND b.blocked_id=rider.id)
          OR (b.blocker_id=rider.id AND b.blocked_id=seated.rider_id)
          WHERE seated.trip_id=currentTrip.id AND seated.status IN ('ACCEPTED','BOARDED'))
      ORDER BY (CASE WHEN (p.prefer_same_department=1 OR COALESCE(currentTrip.prefer_same_department,0)=1)
        AND driver.department_status='VERIFIED' AND driver.department_id IS NOT NULL
        AND p.department_verified_snapshot=1 AND p.department_id_snapshot=driver.department_id THEN 1 ELSE 0 END) DESC,
        p.desired_departure_at,p.created_at,p.id LIMIT 50`)
      .bind(result.session.userId, now, now, now, now, now, now).all<{
        id: string; routeId: string; desiredDepartureAt: number; expiresAt: number; createdAt: number;
        riderGender: MatchMember['gender']; riderFilter: MatchMember['filter']; riderDepartmentId: string | null;
        riderDepartmentVerified: number; riderPreference: number; riderNickname: string; originName: string;
        destinationName: string; driverGender: MatchMember['gender']; driverFilter: MatchMember['filter'];
        driverPreference: number; sameDepartment: number; seatedMembers: string;
      }>();
    const data = rows.results.map((row) => {
      const sameDepartment = row.sameDepartment === 1;
      const conditionsCompatible = genderGroupAllows([
        { gender: row.driverGender, filter: row.driverFilter },
        ...(JSON.parse(row.seatedMembers) as MatchMember[]),
        { gender: row.riderGender, filter: row.riderFilter },
      ]);
      return {
        id: row.id, routeId: row.routeId, desiredDepartureAt: row.desiredDepartureAt,
        expiresAt: row.expiresAt, riderNickname: row.riderNickname, originName: row.originName,
        destinationName: row.destinationName, sameDepartment, conditionsCompatible,
        matchReasons: matchReasons(sameDepartment && (row.riderPreference === 1 || row.driverPreference === 1)),
      };
    });
    return c.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.post('/api/v1/ride-postings/:postingId/accept', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const postingId = z.uuid().safeParse(c.req.param('postingId'));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    const now = Date.now();
    if (!postingId.success || key.length < 1 || key.length > 128) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '탑승 희망과 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED' || (result.session.verifiedUntil ?? 0) <= now) {
      return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    }
    const rate = await rateLimit(c.env.DB, result.session.userId, 'ACCEPT_RIDE_POSTING', now, 5, 60_000);
    if (!rate) return c.json({ error: { code: 'RATE_LIMITED', message: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    const bodyHash = await sha256(JSON.stringify({ postingId: postingId.data }));
    await c.env.DB.prepare(`DELETE FROM idempotency_keys WHERE user_id=? AND operation='ACCEPT_RIDE_POSTING'
      AND key=? AND expires_at<=?`).bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='ACCEPT_RIDE_POSTING' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 키를 다른 탑승 희망에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      const response = acceptResultSchema.safeParse(JSON.parse(stored.resultJson));
      if (!response.success || !await c.env.DB.prepare(`SELECT id FROM ride_postings WHERE id=? AND status='MATCHED'
        AND matched_driver_id=? AND matched_trip_id=? AND matched_request_id=?`)
        .bind(postingId.data, result.session.userId, response.data.tripId, response.data.requestId).first()) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '수락 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ data: response.data }, 200);
    };
    const replay = await storedResponse();
    if (replay) return replay;
    const profile = await c.env.DB.prepare(`SELECT passenger_capacity AS passengerCapacity FROM driver_profiles
      WHERE user_id=? AND verification_status='VERIFIED' AND verified_until>?`)
      .bind(result.session.userId, now).first<{ passengerCapacity: number }>();
    if (!profile) return c.json({ error: { code: 'DRIVER_PROFILE_REQUIRED', message: '승인된 운전자 차량 정보가 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    await expireDriverTrip(c.env.DB, result.session.userId, now);
    await expireRiderRequest(c.env.DB, result.session.userId, now);
    const posting = await c.env.DB.prepare(`SELECT p.route_id AS routeId,p.desired_departure_at AS desiredDepartureAt,
        p.gender_snapshot AS riderGender,p.gender_filter AS riderFilter,rider.id AS riderId
      FROM ride_postings p JOIN users rider ON rider.id=p.rider_id
      WHERE p.id=? AND p.status='OPEN' AND p.expires_at>? AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?`)
      .bind(postingId.data, now, now).first<{
        routeId: string; desiredDepartureAt: number; riderGender: MatchMember['gender'];
        riderFilter: MatchMember['filter']; riderId: string;
      }>();
    if (!posting) return c.json({ error: { code: 'RIDE_POSTING_NOT_AVAILABLE', message: '선택할 수 있는 탑승 희망이 아닙니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    const lock = await c.env.DB.prepare(`SELECT l.role,l.trip_id AS tripId,t.route_id AS routeId,
        t.departure_at AS departureAt,t.status,t.expires_at AS expiresAt,t.gender_snapshot AS driverGender,
        t.gender_filter AS driverFilter,t.seat_capacity-(SELECT COUNT(*) FROM ride_requests seated
          WHERE seated.trip_id=t.id AND seated.status IN ('ACCEPTED','BOARDED')) AS remainingSeats
      FROM active_user_locks l LEFT JOIN trips t ON t.id=l.trip_id WHERE l.user_id=?`)
      .bind(result.session.userId).first<{
        role: 'DRIVER' | 'RIDER'; tripId: string | null; routeId: string | null; departureAt: number | null;
        status: string | null; expiresAt: number | null; driverGender: MatchMember['gender'] | null;
        driverFilter: MatchMember['filter'] | null; remainingSeats: number | null;
      }>();
    if (lock && (lock.role !== 'DRIVER' || lock.status !== 'OPEN' || (lock.expiresAt ?? 0) <= now
      || lock.routeId !== posting.routeId || Math.abs((lock.departureAt ?? 0) - posting.desiredDepartureAt) > 600_000
      || (lock.remainingSeats ?? 0) < 1)) {
      return c.json({ error: { code: 'DRIVER_ACTIVITY_CONFLICT', message: '현재 운행의 노선·시각·좌석을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const seated = lock?.tripId ? await c.env.DB.prepare(`SELECT gender_snapshot AS gender,gender_filter AS filter
      FROM ride_requests WHERE trip_id=? AND status IN ('ACCEPTED','BOARDED')`).bind(lock.tripId).all<MatchMember>() : { results: [] };
    const driver = await c.env.DB.prepare(`SELECT gender FROM users WHERE id=?`).bind(result.session.userId).first<{ gender: MatchMember['gender'] }>();
    if (!driver || !genderGroupAllows([
      { gender: lock?.driverGender ?? driver.gender, filter: lock?.driverFilter ?? 'ANY' },
      ...seated.results, { gender: posting.riderGender, filter: posting.riderFilter },
    ])) return c.json({ error: { code: 'MATCH_NOT_AVAILABLE', message: '성별 매칭 조건이 맞지 않습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    const blocked = await c.env.DB.prepare(`SELECT 1 FROM user_blocks WHERE
      (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`)
      .bind(result.session.userId, posting.riderId, posting.riderId, result.session.userId).first();
    if (blocked) return c.json({ error: { code: 'MATCH_NOT_AVAILABLE', message: '현재 조건으로 선택할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);

    const tripId = lock?.tripId ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE ride_postings SET status='MATCHING',version=version+1,updated_at=?,last_command_id=?
          WHERE id=? AND status='OPEN' AND expires_at>?`)
          .bind(now + 1, commandId, postingId.data, now),
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          SELECT ?,'ACCEPT_RIDE_POSTING',?,?,?,'{}',200,?,? WHERE EXISTS (
            SELECT 1 FROM ride_postings WHERE id=? AND status='MATCHING' AND last_command_id=?)`)
          .bind(result.session.userId, key, bodyHash, commandId, now, now + 86_400_000, postingId.data, commandId),
        c.env.DB.prepare(`INSERT INTO trips
          (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
           department_id_snapshot,department_verified_snapshot,prefer_same_department,last_command_id,created_at,updated_at)
          SELECT ?,driver.id,p.route_id,p.desired_departure_at,p.desired_departure_at+900000,
            profile.passenger_capacity,driver.gender,'ANY',driver.department_id,
            CASE WHEN driver.department_status='VERIFIED' AND driver.department_id IS NOT NULL THEN 1 ELSE 0 END,
            0,?,?,? FROM ride_postings p JOIN users driver ON driver.id=?
          JOIN driver_profiles profile ON profile.user_id=driver.id
            AND profile.verification_status='VERIFIED' AND profile.verified_until>?
          WHERE p.id=? AND p.status='MATCHING' AND p.last_command_id=?
            AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=driver.id)`)
          .bind(tripId, commandId, now, now, result.session.userId, now, postingId.data, commandId),
        c.env.DB.prepare(`INSERT INTO ride_requests
          (id,trip_id,rider_id,desired_departure_at,gender_snapshot,gender_filter,department_id_snapshot,
           department_verified_snapshot,prefer_same_department,status,expires_at,last_command_id,created_at,updated_at)
          SELECT ?,t.id,p.rider_id,p.desired_departure_at,p.gender_snapshot,p.gender_filter,p.department_id_snapshot,
            p.department_verified_snapshot,p.prefer_same_department,'REQUESTED',MIN(t.expires_at,?),?, ?,?
          FROM ride_postings p JOIN trips t ON t.driver_id=? AND t.route_id=p.route_id AND t.status='OPEN'
            AND t.expires_at>? AND ABS(t.departure_at-p.desired_departure_at)<=600000
          JOIN active_user_locks driverLock ON driverLock.user_id=t.driver_id AND driverLock.role='DRIVER' AND driverLock.trip_id=t.id
          WHERE p.id=? AND p.status='MATCHING' AND p.last_command_id=?
            AND t.seat_capacity>(SELECT COUNT(*) FROM ride_requests seated WHERE seated.trip_id=t.id
              AND seated.status IN ('ACCEPTED','BOARDED'))`)
          .bind(requestId, now + 180_000, commandId, now, now, result.session.userId, now, postingId.data, commandId),
        c.env.DB.prepare(`UPDATE ride_requests SET status='ACCEPTED',version=version+1,updated_at=?,accepted_at=?,last_command_id=?
          WHERE id=? AND status='REQUESTED' AND expires_at>?`)
          .bind(now + 1, now + 1, commandId, requestId, now + 1),
        c.env.DB.prepare(`UPDATE ride_postings SET status='MATCHED',matched_trip_id=(SELECT trip_id FROM ride_requests WHERE id=?),
            matched_request_id=?,matched_driver_id=?,version=version+1,updated_at=?,last_command_id=?
          WHERE id=? AND status='MATCHING' AND last_command_id=?`)
          .bind(requestId, requestId, result.session.userId, now + 2, commandId, postingId.data, commandId),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('tripId',trip_id,'requestId',id,'status',status,'version',version)
            FROM ride_requests WHERE id=? AND status='ACCEPTED'
          ) WHERE user_id=? AND operation='ACCEPT_RIDE_POSTING' AND key=? AND command_id=?`)
          .bind(requestId, result.session.userId, key, commandId),
      ]);
    } catch (error) {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      if (error instanceof Error && /RIDE_POSTING_|RIDE_POSTING_ACTIVITY_CONFLICT|TRIP_CREATE_FORBIDDEN|REQUEST_CREATE_FORBIDDEN|REQUEST_ACCEPT_FORBIDDEN|UNIQUE constraint failed|FOREIGN KEY constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'RIDE_POSTING_NOT_AVAILABLE', message: '다른 운전자가 먼저 선택했거나 현재 운행 조건이 맞지 않습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '탑승 희망을 수락하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    const accepted = await storedResponse();
    return accepted ?? c.json({ error: { code: 'RIDE_POSTING_NOT_AVAILABLE', message: '다른 운전자가 먼저 선택했습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  });

  app.post('/api/v1/ride-postings/:postingId/cancel', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const postingId = z.uuid().safeParse(c.req.param('postingId'));
    const input = ridePostingCancelSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    const now = Date.now();
    if (!postingId.success || !input.success || key.length < 1 || key.length > 128) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '취소 정보와 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const bodyHash = await sha256(JSON.stringify({ postingId: postingId.data, ...input.data }));
    await c.env.DB.prepare(`DELETE FROM idempotency_keys WHERE user_id=? AND operation='CANCEL_RIDE_POSTING'
      AND key=? AND expires_at<=?`).bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='CANCEL_RIDE_POSTING' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 키를 다른 취소 정보에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      const response = postingResultSchema.safeParse(JSON.parse(stored.resultJson));
      if (!response.success || !await c.env.DB.prepare("SELECT id FROM ride_postings WHERE id=? AND rider_id=? AND status='CANCELLED'")
        .bind(response.data.id, result.session.userId).first()) return c.json({ error: { code: 'INVALID_TRANSITION', message: '취소 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      return c.json({ data: response.data });
    };
    const replay = await storedResponse();
    if (replay) return replay;
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          SELECT ?,'CANCEL_RIDE_POSTING',?,?,?,'{}',200,?,? WHERE EXISTS (
            SELECT 1 FROM ride_postings WHERE id=? AND rider_id=? AND status='OPEN'
              AND version=? AND expires_at>?)`)
          .bind(result.session.userId, key, bodyHash, commandId, now, now + 86_400_000,
            postingId.data, result.session.userId, input.data.expectedVersion, now),
        c.env.DB.prepare(`UPDATE ride_postings SET status='CANCELLED',version=version+1,updated_at=?,last_command_id=?
          WHERE id=? AND rider_id=? AND status='OPEN' AND version=? AND expires_at>?`)
          .bind(now + 1, commandId, postingId.data, result.session.userId, input.data.expectedVersion, now),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',id,'status',status,'version',version) FROM ride_postings
            WHERE id=? AND status='CANCELLED' AND last_command_id=?
          ) WHERE user_id=? AND operation='CANCEL_RIDE_POSTING' AND key=? AND command_id=?`)
          .bind(postingId.data, commandId, result.session.userId, key, commandId),
      ]);
    } catch {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      return c.json({ error: { code: 'RIDE_POSTING_NOT_CANCELLABLE', message: '이미 선택됐거나 만료된 탑승 희망입니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const cancelled = await storedResponse();
    return cancelled ?? c.json({ error: { code: 'RIDE_POSTING_NOT_CANCELLABLE', message: '이미 선택됐거나 만료된 탑승 희망입니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  });
}
