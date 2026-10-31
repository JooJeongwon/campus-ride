import { z } from 'zod';
import type { Hono } from 'hono';
import {
  boardingCodeInputSchema, lifecycleCommandSchema, rideRequestCreateSchema, tripCreateSchema,
  tripSearchCursorSchema, tripSearchQuerySchema,
} from '../../shared/trips';
import { requiredConsentFailure, requireStudentMutation } from '../auth/access';
import { getSession, sha256, verifyMutation } from '../auth/session';
import { genderGroupAllows, type MatchMember } from '../matching/eligibility';
import { compareMatchRank, matchReasons } from '../matching/rank';
import { rateLimit } from '../rate-limit';
import {
  boardingCodeHash, decodeTripCursor, encodeTripCursor, expireDriverTrip, expireRiderRequest,
  expireTripRequests, newBoardingCode, replayCommand, tripReadSql, verifyBoardingCode,
  TRIP_SEARCH_PAGE_SIZE, TRIP_SEARCH_RAW_LIMIT, type TripSummary,
} from '../trip-commands';
import type { AppContext, AppEnv } from '../types';

export function registerTripRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/trips', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const input = tripSearchQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    const now = Date.now();
    if (!input.success || result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
      || (result.session.verifiedUntil ?? 0) <= now
      || (input.success && (input.data.desiredDepartureAt < now || input.data.desiredDepartureAt > now + 30 * 60_000
        || (result.session.gender === 'UNDISCLOSED' && input.data.genderFilter !== 'ANY')))) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '노선·희망 시각·매칭 조건을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const search = input.data;
    const queryHash = await sha256(JSON.stringify({
      routeId: search.routeId, desiredDepartureAt: search.desiredDepartureAt,
      genderFilter: search.genderFilter, preferSameDepartment: search.preferSameDepartment,
    }));
    let cursor: z.infer<typeof tripSearchCursorSchema> | null = null;
    if (search.cursor) {
      const decoded = decodeTripCursor(search.cursor);
      if (!decoded?.success || decoded.data.queryHash !== queryHash) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: '검색 조건을 바꾸고 다시 검색해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
      }
      cursor = decoded.data;
    }
    const rows = await c.env.DB.prepare(`WITH candidates AS (
        SELECT t.id,d.nickname AS driverNickname,t.route_id AS routeId,
          origin.name AS originName,destination.name AS destinationName,t.departure_at AS departureAt,
          t.expires_at AS expiresAt,t.seat_capacity AS seatCapacity,
          t.seat_capacity-(SELECT COUNT(*) FROM ride_requests seated WHERE seated.trip_id=t.id
            AND seated.status IN ('ACCEPTED','BOARDED')) AS remainingSeats,
          t.gender_filter AS genderFilter,t.prefer_same_department AS driverPreference,
          t.created_at AS createdAt,t.gender_snapshot AS driverGender,requester.gender AS riderGender,
          CASE WHEN requester.department_status='VERIFIED' AND requester.department_id IS NOT NULL
            AND t.department_verified_snapshot=1 AND t.department_id_snapshot=requester.department_id THEN 1 ELSE 0 END AS sameDepartment,
          ABS(t.departure_at-?) AS timeDifference,
          COALESCE((SELECT json_group_array(json_object('gender',members.gender_snapshot,'filter',members.gender_filter))
            FROM ride_requests members WHERE members.trip_id=t.id AND members.status IN ('ACCEPTED','BOARDED')), '[]') AS seatedMembers
        FROM trips t
        JOIN users requester ON requester.id=?
        JOIN users d ON d.id=t.driver_id
        JOIN driver_profiles p ON p.user_id=d.id
        JOIN routes r ON r.id=t.route_id
        JOIN stops origin ON origin.id=r.origin_stop_id
        JOIN stops destination ON destination.id=r.destination_stop_id
        WHERE t.route_id=? AND t.status='OPEN' AND t.departure_at>=? AND t.expires_at>?
        AND ABS(t.departure_at-?)<=600000
          AND requester.role='STUDENT' AND requester.account_status='ACTIVE'
          AND requester.affiliation_status='VERIFIED' AND requester.verified_until>?
          AND d.id<>requester.id AND d.role='STUDENT' AND d.account_status='ACTIVE'
          AND d.affiliation_status='VERIFIED' AND d.verified_until>?
          AND p.verification_status='VERIFIED' AND p.verified_until>?
          AND d.school_id=requester.school_id AND d.campus_id=requester.campus_id
          AND r.active=1 AND r.school_id=requester.school_id AND r.campus_id=requester.campus_id
          AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'
          AND t.seat_capacity>(SELECT COUNT(*) FROM ride_requests seated WHERE seated.trip_id=t.id
            AND seated.status IN ('ACCEPTED','BOARDED'))
          AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=requester.id)
          AND NOT EXISTS (SELECT 1 FROM ride_requests own WHERE own.trip_id=t.id AND own.rider_id=requester.id
            AND own.status IN ('REQUESTED','ACCEPTED','BOARDED'))
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=requester.id AND b.blocked_id=d.id)
            OR (b.blocker_id=d.id AND b.blocked_id=requester.id))
          AND NOT EXISTS (SELECT 1 FROM ride_requests members JOIN user_blocks b ON
            (b.blocker_id=members.rider_id AND b.blocked_id=requester.id)
            OR (b.blocker_id=requester.id AND b.blocked_id=members.rider_id)
            WHERE members.trip_id=t.id AND members.status IN ('ACCEPTED','BOARDED'))
          AND NOT EXISTS (SELECT 1 FROM ride_requests members JOIN user_blocks b ON
            (b.blocker_id=members.rider_id AND b.blocked_id=d.id)
            OR (b.blocker_id=d.id AND b.blocked_id=members.rider_id)
            WHERE members.trip_id=t.id AND members.status IN ('ACCEPTED','BOARDED'))
      ), ranked AS (
        SELECT candidates.*,CASE WHEN sameDepartment=1 AND (?=1 OR driverPreference=1) THEN 1 ELSE 0 END AS departmentPriority
        FROM candidates
      )
      SELECT * FROM ranked c
      WHERE (? IS NULL OR c.departmentPriority<?
        OR (c.departmentPriority=? AND c.timeDifference>?)
        OR (c.departmentPriority=? AND c.timeDifference=? AND c.createdAt>?)
        OR (c.departmentPriority=? AND c.timeDifference=? AND c.createdAt=? AND c.id>?))
      ORDER BY c.departmentPriority DESC,c.timeDifference,c.createdAt,c.id LIMIT ?`)
      .bind(search.desiredDepartureAt, result.session.userId, search.routeId, now, now, search.desiredDepartureAt,
        now, now, now, search.preferSameDepartment ? 1 : 0,
        cursor?.id ?? null, cursor?.departmentPriority ?? 0, cursor?.departmentPriority ?? 0,
        cursor?.timeDifference ?? 0, cursor?.departmentPriority ?? 0, cursor?.timeDifference ?? 0,
        cursor?.createdAt ?? 0, cursor?.departmentPriority ?? 0, cursor?.timeDifference ?? 0,
        cursor?.createdAt ?? 0, cursor?.id ?? '', TRIP_SEARCH_RAW_LIMIT)
      .all<{
        id: string; driverNickname: string; routeId: string; originName: string; destinationName: string;
        departureAt: number; expiresAt: number; seatCapacity: number; remainingSeats: number; genderFilter: MatchMember['filter'];
        driverPreference: number; createdAt: number; driverGender: MatchMember['gender']; riderGender: MatchMember['gender']; sameDepartment: number;
        timeDifference: number; seatedMembers: string; departmentPriority: number;
      }>();
    const candidates = rows.results.sort((a, b) => compareMatchRank({
      departmentPriority: a.departmentPriority === 1, timeDifference: a.timeDifference, createdAt: a.createdAt, id: a.id,
    }, {
      departmentPriority: b.departmentPriority === 1, timeDifference: b.timeDifference, createdAt: b.createdAt, id: b.id,
    }));
    const matches: Array<Record<string, unknown>> = [];
    let scanned = 0;
    for (const candidate of candidates) {
      scanned += 1;
      const seated = JSON.parse(candidate.seatedMembers) as MatchMember[];
      if (!genderGroupAllows([
        { gender: candidate.driverGender, filter: candidate.genderFilter },
        ...seated,
        { gender: candidate.riderGender, filter: search.genderFilter },
      ])) continue;
      const sameDepartment = candidate.sameDepartment === 1;
      matches.push({
        id: candidate.id, driverNickname: candidate.driverNickname, routeId: candidate.routeId,
        originName: candidate.originName, destinationName: candidate.destinationName,
        departureAt: candidate.departureAt, expiresAt: candidate.expiresAt, seatCapacity: candidate.seatCapacity,
        remainingSeats: candidate.remainingSeats, genderFilter: candidate.genderFilter,
        preferSameDepartment: candidate.driverPreference === 1, createdAt: candidate.createdAt,
        sameDepartment, timeDifferenceMinutes: Math.ceil(candidate.timeDifference / 60_000),
        matchReasons: matchReasons(sameDepartment),
      });
      if (matches.length === TRIP_SEARCH_PAGE_SIZE) break;
    }
    const lastScanned = candidates[scanned - 1];
    const hasMore = Boolean(lastScanned && (scanned < candidates.length || candidates.length === TRIP_SEARCH_RAW_LIMIT));
    const nextCursor = hasMore && lastScanned ? encodeTripCursor({
      queryHash, departmentPriority: lastScanned.departmentPriority,
      timeDifference: lastScanned.timeDifference, createdAt: lastScanned.createdAt, id: lastScanned.id,
    }) : null;
    return c.json({ data: matches, nextCursor, meta: { requestId: c.get('requestId') } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  });

  app.post('/api/v1/trips', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    if (!await verifyMutation(c, result.token, result.session)) {
      return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    }
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    if (result.session.affiliationStatus !== 'VERIFIED' || (result.session.verifiedUntil ?? 0) <= Date.now()) {
      return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    }
    const input = tripCreateSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    if (!input.success || key.length < 1 || key.length > 128) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '운행 정보와 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const { routeId, departureAt, seatCapacity, genderFilter, preferSameDepartment } = input.data;
    const now = Date.now();
    if (departureAt < now || departureAt > now + 30 * 60_000) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '출발 시각은 지금부터 30분 이내여야 합니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    if (result.session.gender === 'UNDISCLOSED' && genderFilter !== 'ANY') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '성별 미공개 상태에서는 제한 조건을 설정할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const bodyHash = await sha256(JSON.stringify(input.data));
    const driverProfile = await c.env.DB.prepare(`SELECT passenger_capacity AS passengerCapacity
      FROM driver_profiles WHERE user_id=? AND verification_status='VERIFIED' AND verified_until>?`)
      .bind(result.session.userId, now).first<{ passengerCapacity: number }>();
    if (!driverProfile) return c.json({ error: { code: 'DRIVER_PROFILE_REQUIRED', message: '승인된 운전자 차량 정보가 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    if (seatCapacity > driverProfile.passengerCapacity) {
      return c.json({ error: { code: 'SEAT_CAPACITY_EXCEEDS_VEHICLE', message: '차량 정원보다 좌석 수가 많습니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    await c.env.DB.prepare(`DELETE FROM idempotency_keys
      WHERE user_id=? AND operation='CREATE_TRIP' AND key=? AND expires_at<=?`)
      .bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='CREATE_TRIP' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) {
        return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 Idempotency-Key를 다른 운행 정보에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      const response = z.object({ id: z.uuid(), status: z.string(), version: z.number().int().positive() }).safeParse(JSON.parse(stored.resultJson));
      if (!response.success || !await c.env.DB.prepare('SELECT id FROM trips WHERE id=? AND driver_id=?')
        .bind(response.data.id, result.session.userId).first()) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '운행 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ data: response.data }, 201);
    };
    const replay = await storedResponse();
    if (replay) return replay;
    const route = await c.env.DB.prepare(`SELECT r.id FROM routes r JOIN users u ON u.id=?
      JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE r.id=? AND r.school_id=u.school_id AND r.campus_id=u.campus_id AND r.active=1
        AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'`)
      .bind(result.session.userId, routeId).first();
    if (!route) return c.json({ error: { code: 'INVALID_ROUTE', message: '사용할 수 있는 노선이 아닙니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    await expireDriverTrip(c.env.DB, result.session.userId, now);
    await expireRiderRequest(c.env.DB, result.session.userId, now);
    if (await c.env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(result.session.userId).first()) {
      return c.json({ error: { code: 'ALREADY_ACTIVE', message: '현재 활동이 끝난 뒤 운행을 등록해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const tripId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,'CREATE_TRIP',?,?,?,?,201,?,?)`)
          .bind(result.session.userId, key, bodyHash, commandId, '{}', now, now + 24 * 60 * 60_000),
        c.env.DB.prepare(`INSERT INTO trips
          (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
           department_id_snapshot,department_verified_snapshot,prefer_same_department,last_command_id,created_at,updated_at)
          SELECT ?,u.id,?, ?, ?, ?,u.gender,?,u.department_id,
            CASE WHEN u.department_status='VERIFIED' AND u.department_id IS NOT NULL THEN 1 ELSE 0 END,?,?,?,?
          FROM users u WHERE u.id=?`)
          .bind(tripId, routeId, departureAt, departureAt + 15 * 60_000, seatCapacity,
            genderFilter, preferSameDepartment ? 1 : 0, commandId, now, now, result.session.userId),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',id,'status',status,'version',version) FROM trips WHERE last_command_id=?
          ) WHERE user_id=? AND operation='CREATE_TRIP' AND key=? AND command_id=?`)
          .bind(commandId, result.session.userId, key, commandId),
      ]);
    } catch (error) {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      if (await c.env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(result.session.userId).first()) {
        return c.json({ error: { code: 'ALREADY_ACTIVE', message: '현재 활동이 끝난 뒤 운행을 등록해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      if (error instanceof Error && /TRIP_CREATE_FORBIDDEN|UNIQUE constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '운행을 등록할 수 없습니다. 자격과 조건을 다시 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '운행을 등록하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: tripId, status: 'OPEN', version: 1 }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.post('/api/v1/trips/:tripId/requests', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    if (!await verifyMutation(c, result.token, result.session)) return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    const now = Date.now();
    if (result.session.affiliationStatus !== 'VERIFIED' || (result.session.verifiedUntil ?? 0) <= now) {
      return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    }
    const tripId = z.uuid().safeParse(c.req.param('tripId'));
    const input = rideRequestCreateSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    if (!tripId.success || !input.success || key.length < 1 || key.length > 128) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '탑승 요청과 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    if (result.session.gender === 'UNDISCLOSED' && input.data.genderFilter !== 'ANY') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '성별 미공개 상태에서는 제한 조건을 설정할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const bodyHash = await sha256(JSON.stringify({ tripId: tripId.data, ...input.data }));
    await c.env.DB.prepare(`DELETE FROM idempotency_keys
      WHERE user_id=? AND operation='CREATE_REQUEST' AND key=? AND expires_at<=?`)
      .bind(result.session.userId, key, now).run();
    const storedResponse = async (): Promise<Response | null> => {
      const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson
        FROM idempotency_keys WHERE user_id=? AND operation='CREATE_REQUEST' AND key=? AND expires_at>?`)
        .bind(result.session.userId, key, now).first<{ requestHash: string; resultJson: string }>();
      if (!stored) return null;
      if (stored.requestHash !== bodyHash) {
        return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      const response = z.object({ id: z.uuid(), status: z.string(), version: z.number().int().positive() }).safeParse(JSON.parse(stored.resultJson));
      if (!response.success || !await c.env.DB.prepare('SELECT id FROM ride_requests WHERE id=? AND rider_id=? AND trip_id=?')
        .bind(response.data.id, result.session.userId, tripId.data).first()) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승 요청 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ data: response.data }, 201);
    };
    const replay = await storedResponse();
    if (replay) return replay;
    const rate = await rateLimit(c.env.DB, result.session.userId, 'CREATE_REQUEST', now, 5, 60_000);
    if (!rate) return c.json({ error: { code: 'RATE_LIMITED', message: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    if (input.data.desiredDepartureAt < now || input.data.desiredDepartureAt > now + 30 * 60_000) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '희망 출발 시각은 지금부터 30분 이내여야 합니다.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    await expireDriverTrip(c.env.DB, result.session.userId, now);
    await expireRiderRequest(c.env.DB, result.session.userId, now);
    if (await c.env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(result.session.userId).first()) {
      return c.json({ error: { code: 'ALREADY_ACTIVE', message: '현재 활동이 끝난 뒤 탑승을 요청해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const trip = await c.env.DB.prepare(`SELECT t.id FROM trips t JOIN users d ON d.id=t.driver_id
      JOIN driver_profiles p ON p.user_id=d.id
      WHERE t.id=? AND t.driver_id<>? AND t.status='OPEN' AND t.expires_at>?
        AND d.account_status='ACTIVE' AND d.affiliation_status='VERIFIED' AND d.verified_until>?
        AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=d.id AND l.role='DRIVER' AND l.trip_id=t.id)`)
      .bind(tripId.data, result.session.userId, now, now, now).first();
    if (!trip) return c.json({ error: { code: 'TRIP_NOT_AVAILABLE', message: '요청할 수 있는 운행이 아닙니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const requestId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,'CREATE_REQUEST',?,?,?,?,201,?,?)`)
          .bind(result.session.userId, key, bodyHash, commandId, '{}', now, now + 24 * 60 * 60_000),
        c.env.DB.prepare(`INSERT INTO ride_requests
          (id,trip_id,rider_id,desired_departure_at,gender_snapshot,gender_filter,department_id_snapshot,
           department_verified_snapshot,prefer_same_department,status,expires_at,last_command_id,created_at,updated_at)
          SELECT ?,t.id,u.id,?,u.gender,?,u.department_id,
            CASE WHEN u.department_status='VERIFIED' AND u.department_id IS NOT NULL THEN 1 ELSE 0 END,
            ?,'REQUESTED',MIN(t.expires_at,?),?,?,? FROM trips t JOIN users u ON u.id=? WHERE t.id=?`)
          .bind(requestId, input.data.desiredDepartureAt, input.data.genderFilter, input.data.preferSameDepartment ? 1 : 0,
            now + 180_000, commandId, now, now, result.session.userId, tripId.data),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',id,'status',status,'version',version) FROM ride_requests WHERE last_command_id=?
          ) WHERE user_id=? AND operation='CREATE_REQUEST' AND key=? AND command_id=?`)
          .bind(commandId, result.session.userId, key, commandId),
      ]);
    } catch (error) {
      const concurrentReplay = await storedResponse();
      if (concurrentReplay) return concurrentReplay;
      if (await c.env.DB.prepare('SELECT user_id FROM active_user_locks WHERE user_id=?').bind(result.session.userId).first()) {
        return c.json({ error: { code: 'ALREADY_ACTIVE', message: '현재 활동이 끝난 뒤 탑승을 요청해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      if (error instanceof Error && /REQUEST_CREATE_FORBIDDEN|REQUEST_CREATE_GROUP_CONFLICT|UNIQUE constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'MATCH_NOT_AVAILABLE', message: '현재 조건으로 요청할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '탑승 요청을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: requestId, status: 'REQUESTED', version: 1 }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.get('/api/v1/trips/:tripId/requests', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    if (result.session.affiliationStatus !== 'VERIFIED') return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const tripId = z.uuid().safeParse(c.req.param('tripId'));
    if (!tripId.success) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const requests = await c.env.DB.prepare(`SELECT rr.id,rr.desired_departure_at AS desiredDepartureAt,rr.status,
        rr.expires_at AS expiresAt,rr.accepted_at AS acceptedAt,rr.boarded_at AS boardedAt,rr.version,
        rr.created_at AS createdAt,rr.rider_id AS riderId,rr.gender_snapshot AS riderGender,rr.gender_filter AS riderFilter,
        rr.department_id_snapshot AS riderDepartmentId,rr.department_verified_snapshot AS riderDepartmentVerified,
        rr.prefer_same_department AS riderPreference,u.nickname AS riderNickname,
        t.gender_snapshot AS driverGender,t.gender_filter AS driverFilter,
        t.department_id_snapshot AS driverDepartmentId,t.department_verified_snapshot AS driverDepartmentVerified,
        t.prefer_same_department AS driverPreference,ABS(rr.desired_departure_at-t.departure_at) AS timeDifference
      FROM ride_requests rr JOIN users u ON u.id=rr.rider_id
      JOIN trips t ON t.id=rr.trip_id
      WHERE rr.trip_id=? AND t.driver_id=? AND t.status IN ('OPEN','IN_PROGRESS')
        AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=? AND l.role='DRIVER' AND l.trip_id=rr.trip_id)
        AND u.account_status='ACTIVE' AND u.role='STUDENT'
        AND u.affiliation_status='VERIFIED' AND u.verified_until>?
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=u.id AND b.blocked_id=t.driver_id)
          OR (b.blocker_id=t.driver_id AND b.blocked_id=u.id))
        AND NOT EXISTS (SELECT 1 FROM ride_requests seated JOIN user_blocks b ON
          (b.blocker_id=seated.rider_id AND b.blocked_id=rr.rider_id)
          OR (b.blocker_id=rr.rider_id AND b.blocked_id=seated.rider_id)
          WHERE seated.trip_id=rr.trip_id AND seated.status IN ('ACCEPTED','BOARDED'))
      ORDER BY rr.created_at,rr.id LIMIT 50`).bind(tripId.data, result.session.userId, result.session.userId, Date.now())
      .all<{
        id: string; desiredDepartureAt: number; status: string; expiresAt: number; acceptedAt: number | null;
        boardedAt: number | null; version: number; createdAt: number; riderGender: MatchMember['gender'];
        riderFilter: MatchMember['filter']; riderDepartmentId: string | null; riderDepartmentVerified: number;
        riderPreference: number; riderId: string; riderNickname: string; driverGender: MatchMember['gender'];
        driverFilter: MatchMember['filter']; driverDepartmentId: string | null; driverDepartmentVerified: number;
        driverPreference: number; timeDifference: number;
      }>();
    if (!requests.results.length && !await c.env.DB.prepare('SELECT id FROM trips WHERE id=? AND driver_id=?')
      .bind(tripId.data, result.session.userId).first()) {
      return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    }
    const members = await c.env.DB.prepare(`SELECT gender_snapshot AS gender,gender_filter AS filter FROM trips WHERE id=?
      UNION ALL SELECT gender_snapshot,gender_filter FROM ride_requests WHERE trip_id=? AND status IN ('ACCEPTED','BOARDED')`)
      .bind(tripId.data, tripId.data).all<MatchMember>();
    const data = requests.results.map((request) => {
      const sameDepartment = request.driverDepartmentVerified === 1 && request.riderDepartmentVerified === 1
        && request.driverDepartmentId !== null && request.driverDepartmentId === request.riderDepartmentId;
      const conditionsCompatible = request.status !== 'REQUESTED' || genderGroupAllows([
        ...members.results,
        { gender: request.riderGender, filter: request.riderFilter },
      ]);
      return {
        rank: {
          departmentPriority: sameDepartment && (request.driverPreference === 1 || request.riderPreference === 1),
          timeDifference: request.timeDifference, createdAt: request.createdAt, id: request.id,
        },
        data: {
          id: request.id, desiredDepartureAt: request.desiredDepartureAt, status: request.status,
          expiresAt: request.expiresAt, acceptedAt: request.acceptedAt, boardedAt: request.boardedAt,
          version: request.version, riderId: request.riderId, riderNickname: request.riderNickname, sameDepartment,
          matchReasons: matchReasons(sameDepartment), conditionsCompatible,
        },
      };
    }).sort((a, b) => compareMatchRank(a.rank, b.rank)).map(({ data: request }) => request);
    return c.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/v1/requests/:requestId', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    if (result.session.affiliationStatus !== 'VERIFIED') return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const requestId = z.uuid().safeParse(c.req.param('requestId'));
    if (!requestId.success) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const request = await c.env.DB.prepare(`SELECT rr.id,rr.trip_id AS tripId,
        rr.desired_departure_at AS desiredDepartureAt,rr.status,rr.expires_at AS expiresAt,
        rr.accepted_at AS acceptedAt,rr.boarded_at AS boardedAt,rr.version,
        t.departure_at AS departureAt,t.status AS tripStatus,d.nickname AS driverNickname,
        CASE WHEN rr.rider_id=? AND rr.status IN ('ACCEPTED','BOARDED') THEN p.vehicle_model END AS vehicleModel,
        CASE WHEN rr.rider_id=? AND rr.status IN ('ACCEPTED','BOARDED') THEN p.vehicle_color END AS vehicleColor,
        CASE WHEN rr.rider_id=? AND rr.status IN ('ACCEPTED','BOARDED') THEN p.vehicle_identifier END AS vehicleIdentifier
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id JOIN users d ON d.id=t.driver_id
      JOIN driver_profiles p ON p.user_id=d.id JOIN users rider ON rider.id=rr.rider_id
      WHERE rr.id=? AND (rr.rider_id=? OR t.driver_id=?)
        AND rider.account_status='ACTIVE' AND rider.role='STUDENT' AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
        AND d.account_status='ACTIVE' AND d.role='STUDENT' AND d.affiliation_status='VERIFIED' AND d.verified_until>?
        AND EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=rr.rider_id AND role='RIDER' AND request_id=rr.id)
        AND EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=t.driver_id AND role='DRIVER' AND trip_id=t.id)`)
      .bind(result.session.userId, result.session.userId, result.session.userId, requestId.data,
        result.session.userId, result.session.userId, Date.now(), Date.now()).first();
    if (!request) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    return c.json({ data: request }, { headers: { 'Cache-Control': 'no-store' } });
  });

  type RequestAction = 'ACCEPT' | 'REJECT' | 'CANCEL' | 'NO_SHOW';
  async function transitionRequest(c: AppContext, action: RequestAction) {
    const auth = await requireStudentMutation(c);
    if (auth.response) return auth.response;
    const { session } = auth.result;
    const requestId = z.uuid().safeParse(c.req.param('requestId'));
    const input = lifecycleCommandSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    if (!requestId.success || !input.success || key.length < 1 || key.length > 128
      || (action === 'CANCEL' && !input.data.reasonCode)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '상태 변경 정보와 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const row = await c.env.DB.prepare(`SELECT rr.id,rr.trip_id AS tripId,rr.rider_id AS riderId,rr.status,rr.version,
        rr.updated_at AS updatedAt,rr.expires_at AS expiresAt,rr.desired_departure_at AS desiredDepartureAt,
        rr.gender_snapshot AS gender,rr.gender_filter AS genderFilter,t.driver_id AS driverId,
        t.status AS tripStatus,t.departure_at AS departureAt,t.expires_at AS tripExpiresAt,t.seat_capacity AS seatCapacity,
        t.gender_snapshot AS driverGender,t.gender_filter AS driverFilter
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id
      WHERE rr.id=? AND (rr.rider_id=? OR t.driver_id=?)`)
      .bind(requestId.data, session.userId, session.userId).first<{
        id: string; tripId: string; riderId: string; status: string; version: number; updatedAt: number;
        expiresAt: number; desiredDepartureAt: number; gender: MatchMember['gender']; genderFilter: MatchMember['filter'];
        driverId: string; tripStatus: string; departureAt: number; tripExpiresAt: number; seatCapacity: number;
        driverGender: MatchMember['gender']; driverFilter: MatchMember['filter'];
      }>();
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const isDriver = row.driverId === session.userId;
    if ((action !== 'CANCEL' && !isDriver) || (action === 'CANCEL' && !isDriver && row.riderId !== session.userId)) {
      return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    }
    const operation = `REQUEST_${action}`;
    const now = Date.now();
    const bodyHash = await sha256(JSON.stringify({ requestId: row.id, action, ...input.data }));
    const replay = await replayCommand(c, session.userId, operation, key, bodyHash, now);
    if (replay) return replay;

    await expireTripRequests(c.env.DB, row.tripId, now);
    await expireDriverTrip(c.env.DB, row.driverId, now);
    if (action === 'CANCEL' && !isDriver) await expireRiderRequest(c.env.DB, row.riderId, now);
    const current = await c.env.DB.prepare(`SELECT rr.status,rr.version,rr.updated_at AS updatedAt,rr.expires_at AS expiresAt,
        t.status AS tripStatus,t.departure_at AS departureAt,t.expires_at AS tripExpiresAt,t.seat_capacity AS seatCapacity,
        t.gender_snapshot AS driverGender,t.gender_filter AS driverFilter
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id WHERE rr.id=? AND rr.trip_id=?`)
      .bind(row.id, row.tripId).first<{
        status: string; version: number; updatedAt: number; expiresAt: number; tripStatus: string;
        departureAt: number; tripExpiresAt: number; seatCapacity: number;
        driverGender: MatchMember['gender']; driverFilter: MatchMember['filter'];
      }>();
    const allowedStatuses: Record<RequestAction, string[]> = {
      ACCEPT: ['REQUESTED'], REJECT: ['REQUESTED'], CANCEL: ['REQUESTED', 'ACCEPTED'], NO_SHOW: ['ACCEPTED'],
    };
    if (!current || !allowedStatuses[action].includes(current.status)) {
      return c.json({ error: { code: current?.status === 'EXPIRED' ? 'REQUEST_EXPIRED' : 'INVALID_TRANSITION', message: '요청 상태가 변경되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (current.version !== input.data.expectedVersion) {
      return c.json({ error: { code: 'VERSION_CONFLICT', message: '요청 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const status = { ACCEPT: 'ACCEPTED', REJECT: 'REJECTED', CANCEL: 'CANCELLED', NO_SHOW: 'NO_SHOW' }[action];
    if (action === 'ACCEPT') {
      if (current.expiresAt <= now || current.tripExpiresAt <= now || current.tripStatus !== 'OPEN') {
        return c.json({ error: { code: 'REQUEST_EXPIRED', message: '요청 유효시간이 지났습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      const seated = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM ride_requests
        WHERE trip_id=? AND status IN ('ACCEPTED','BOARDED')`).bind(row.tripId).first<{ count: number }>();
      if ((seated?.count ?? current.seatCapacity) >= current.seatCapacity) {
        return c.json({ error: { code: 'NO_SEATS', message: '남은 좌석이 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      const members = await c.env.DB.prepare(`SELECT gender_snapshot AS gender,gender_filter AS filter
        FROM trips WHERE id=? UNION ALL SELECT gender_snapshot,gender_filter FROM ride_requests
        WHERE trip_id=? AND status IN ('ACCEPTED','BOARDED') UNION ALL
        SELECT gender_snapshot,gender_filter FROM ride_requests WHERE id=?`)
        .bind(row.tripId, row.tripId, row.id).all<MatchMember>();
      if (!genderGroupAllows(members.results)) {
        return c.json({ error: { code: 'MATCH_CONDITION_CHANGED', message: '현재 매칭 조건을 충족하지 않습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
    } else if (action === 'REJECT' && (current.status !== 'REQUESTED' || current.expiresAt <= now || current.tripStatus !== 'OPEN')) {
      return c.json({ error: { code: 'REQUEST_EXPIRED', message: '요청 유효시간이 지났습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    } else if (action === 'CANCEL' && (current.status !== 'REQUESTED' && current.status !== 'ACCEPTED')) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '취소할 수 없는 요청 상태입니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    } else if (action === 'CANCEL' && (current.tripStatus !== 'OPEN' || current.departureAt <= now)) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '출발 전 요청만 취소할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    } else if (action === 'NO_SHOW' && (current.status !== 'ACCEPTED' || current.tripStatus !== 'OPEN' || current.departureAt + 180_000 > now)) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '예정 출발 3분 후부터 노쇼 처리할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (current.status !== 'REQUESTED' && action !== 'CANCEL' && action !== 'NO_SHOW') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '요청 상태가 변경되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    const commandId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const updatedAt = Math.max(now, current.updatedAt + 1);
    const terminal = ['REJECTED', 'CANCELLED', 'NO_SHOW'].includes(status);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,?,?,?,?,'{}',200,?,?)`)
          .bind(session.userId, operation, key, bodyHash, commandId, now, now + 24 * 60 * 60_000),
        c.env.DB.prepare(`UPDATE ride_requests SET status=?,version=version+1,updated_at=?,last_command_id=?,
            accepted_at=CASE WHEN ?='ACCEPTED' THEN ? ELSE accepted_at END,
            boarding_code_hash=CASE WHEN ?=1 THEN NULL ELSE boarding_code_hash END,
            boarding_code_expires_at=CASE WHEN ?=1 THEN NULL ELSE boarding_code_expires_at END
          WHERE id=? AND trip_id=? AND status=? AND version=?`)
          .bind(status, updatedAt, commandId, status, updatedAt, terminal ? 1 : 0, terminal ? 1 : 0,
            row.id, row.tripId, current.status, input.data.expectedVersion),
        c.env.DB.prepare(`INSERT INTO audit_events
          (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
          SELECT ?,?,?, 'ride_request',id,?,?,? FROM ride_requests WHERE id=? AND last_command_id=?`)
          .bind(eventId, session.userId, `RIDE_REQUEST_${status}`, commandId,
            JSON.stringify(input.data.reasonCode ? { reasonCode: input.data.reasonCode } : {}), updatedAt, row.id, commandId),
        c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
            SELECT json_object('id',id,'status',status,'version',version) FROM ride_requests WHERE id=? AND last_command_id=?
          ) WHERE user_id=? AND operation=? AND key=? AND command_id=?`)
          .bind(row.id, commandId, session.userId, operation, key, commandId),
      ]);
    } catch (error) {
      const retry = await replayCommand(c, session.userId, operation, key, bodyHash, now);
      if (retry) return retry;
      const latest = await c.env.DB.prepare('SELECT status,version FROM ride_requests WHERE id=?').bind(row.id).first<{ status: string; version: number }>();
      if (latest?.version !== input.data.expectedVersion) return c.json({ error: { code: 'VERSION_CONFLICT', message: '요청 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      if (error instanceof Error && /REQUEST_ACCEPT_FORBIDDEN/.test(error.message)) return c.json({ error: { code: 'MATCH_CONDITION_CHANGED', message: '현재 매칭 조건이나 좌석을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
      if (error instanceof Error && /REQUEST_EXPIRED|REQUEST_NOT_AVAILABLE|REQUEST_NOT_CANCELLABLE|REQUEST_NO_SHOW_EARLY/.test(error.message)) return c.json({ error: { code: 'INVALID_TRANSITION', message: '요청 상태나 유효시간이 변경되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '요청 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: row.id, status, version: current.version + 1 }, meta: { requestId: c.get('requestId') } });
  }

  app.post('/api/v1/requests/:requestId/accept', (c) => transitionRequest(c, 'ACCEPT'));
  app.post('/api/v1/requests/:requestId/reject', (c) => transitionRequest(c, 'REJECT'));
  app.post('/api/v1/requests/:requestId/cancel', (c) => transitionRequest(c, 'CANCEL'));
  app.post('/api/v1/requests/:requestId/no-show', (c) => transitionRequest(c, 'NO_SHOW'));

  app.post('/api/v1/requests/:requestId/boarding-code', async (c) => {
    const auth = await requireStudentMutation(c);
    if (auth.response) return auth.response;
    const { session } = auth.result;
    const requestId = z.uuid().safeParse(c.req.param('requestId'));
    if (!requestId.success) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const now = Date.now();
    const request = await c.env.DB.prepare(`SELECT rr.id FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id
      JOIN users driver ON driver.id=t.driver_id JOIN driver_profiles p ON p.user_id=driver.id
      WHERE rr.id=? AND rr.rider_id=? AND rr.status='ACCEPTED' AND t.status='OPEN' AND t.expires_at>?
        AND driver.account_status='ACTIVE' AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
        AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=rr.rider_id AND role='RIDER' AND request_id=rr.id)
        AND EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=t.driver_id AND role='DRIVER' AND trip_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=rr.rider_id AND b.blocked_id=t.driver_id)
          OR (b.blocker_id=t.driver_id AND b.blocked_id=rr.rider_id))`)
      .bind(requestId.data, session.userId, now, now, now).first<{ id: string }>();
    if (!request) return c.json({ error: { code: 'INVALID_TRANSITION', message: '확정된 탑승 요청만 코드를 발급할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (!await rateLimit(c.env.DB, session.userId, 'BOARDING_CODE', now, 3, 60_000)) {
      return c.json({ error: { code: 'RATE_LIMITED', message: '코드를 자주 발급했습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    }
    const code = newBoardingCode();
    const expiresAt = now + 10 * 60_000;
    const codeHash = await boardingCodeHash(c.env, request.id, code);
    const updated = await c.env.DB.prepare(`UPDATE ride_requests SET boarding_code_hash=?,boarding_code_expires_at=?,boarding_attempt_count=0
      WHERE id=? AND rider_id=? AND status='ACCEPTED'
        AND EXISTS (SELECT 1 FROM trips t JOIN users driver ON driver.id=t.driver_id JOIN driver_profiles p ON p.user_id=driver.id
          WHERE t.id=ride_requests.trip_id AND t.status='OPEN' AND t.expires_at>?
            AND driver.account_status='ACTIVE' AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
            AND p.verification_status='VERIFIED' AND p.verified_until>?
            AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
              (b.blocker_id=ride_requests.rider_id AND b.blocked_id=driver.id)
              OR (b.blocker_id=driver.id AND b.blocked_id=ride_requests.rider_id)))
        AND EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=ride_requests.rider_id AND role='RIDER' AND request_id=ride_requests.id)`)
      .bind(codeHash, expiresAt, request.id, session.userId, now, now, now).run();
    if (updated.meta.changes !== 1) return c.json({ error: { code: 'INVALID_TRANSITION', message: '요청 상태가 변경되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    return c.json({ data: { code, expiresAt }, meta: { requestId: c.get('requestId') } }, { headers: { 'Cache-Control': 'no-store' } });
  });

  app.post('/api/v1/requests/:requestId/board', async (c) => {
    const auth = await requireStudentMutation(c);
    if (auth.response) return auth.response;
    const { session } = auth.result;
    const requestId = z.uuid().safeParse(c.req.param('requestId'));
    const input = z.object({ expectedVersion: z.number().int().positive(), code: boardingCodeInputSchema }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!requestId.success || !input.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '요청 ID, 버전, 6자리 코드를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const now = Date.now();
    const row = await c.env.DB.prepare(`SELECT rr.id,rr.trip_id AS tripId,rr.status,rr.version,
        rr.updated_at AS updatedAt,rr.boarding_code_hash AS codeHash,rr.boarding_code_expires_at AS codeExpiresAt,
        rr.boarding_attempt_count AS attempts,t.driver_id AS driverId
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id
      WHERE rr.id=? AND t.driver_id=? AND EXISTS (
        SELECT 1 FROM active_user_locks WHERE user_id=t.driver_id AND role='DRIVER' AND trip_id=t.id
      )`).bind(requestId.data, session.userId).first<{
        id: string; tripId: string; status: string; version: number; updatedAt: number;
        codeHash: string | null; codeExpiresAt: number | null; attempts: number; driverId: string;
      }>();
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    if (row.status !== 'ACCEPTED') return c.json({ error: { code: 'INVALID_TRANSITION', message: '확정된 요청만 탑승 처리할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (row.version !== input.data.expectedVersion) return c.json({ error: { code: 'VERSION_CONFLICT', message: '요청 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (!row.codeHash || row.codeExpiresAt === null) return c.json({ error: { code: 'BOARDING_CODE_REQUIRED', message: '탑승자가 발급한 코드를 입력해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (row.codeExpiresAt <= now) return c.json({ error: { code: 'BOARDING_CODE_EXPIRED', message: '탑승 코드가 만료되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (row.attempts >= 5) return c.json({ error: { code: 'BOARDING_CODE_LOCKED', message: '코드 입력 횟수를 초과했습니다. 탑승자에게 재발급을 요청해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
    const valid = await verifyBoardingCode(c.env, row.id, input.data.code, row.codeHash);
    const attempted = await c.env.DB.prepare(`UPDATE ride_requests SET boarding_attempt_count=boarding_attempt_count+1
      WHERE id=? AND status='ACCEPTED' AND version=? AND boarding_code_hash=?
        AND boarding_code_expires_at>? AND boarding_attempt_count=? AND boarding_attempt_count<5`)
      .bind(row.id, row.version, row.codeHash, now, row.attempts).run();
    if (attempted.meta.changes !== 1) return c.json({ error: { code: 'VERSION_CONFLICT', message: '요청 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    if (!valid) return c.json({
      error: { code: row.attempts + 1 >= 5 ? 'BOARDING_CODE_LOCKED' : 'INVALID_BOARDING_CODE', message: row.attempts + 1 >= 5 ? '코드 입력 횟수를 초과했습니다. 탑승자에게 재발급을 요청해 주세요.' : '탑승 코드를 확인해 주세요.' },
      meta: { requestId: c.get('requestId') },
    }, row.attempts + 1 >= 5 ? 429 : 409);

    const commandId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const updatedAt = Math.max(now, row.updatedAt + 1);
    let results: D1Result[];
    try {
      results = await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE ride_requests SET status='BOARDED',version=version+1,updated_at=?,boarded_at=?,last_command_id=?,
            boarding_code_hash=NULL,boarding_code_expires_at=NULL
          WHERE id=? AND trip_id=? AND status='ACCEPTED' AND version=? AND boarding_code_hash=?
            AND boarding_code_expires_at>? AND boarding_attempt_count=?`)
          .bind(updatedAt, updatedAt, commandId, row.id, row.tripId, row.version, row.codeHash, now, row.attempts + 1),
        c.env.DB.prepare(`INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
          SELECT ?,?,'RIDE_REQUEST_BOARDED','ride_request',id,?,'{}',? FROM ride_requests WHERE id=? AND last_command_id=?`)
          .bind(eventId, session.userId, commandId, updatedAt, row.id, commandId),
      ]);
    } catch {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승을 확인하지 못했습니다. 요청 상태와 자격을 다시 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (results[0].meta.changes !== 1) return c.json({ error: { code: 'VERSION_CONFLICT', message: '요청 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    return c.json({ data: { id: row.id, status: 'BOARDED', version: row.version + 1 }, meta: { requestId: c.get('requestId') } });
  });

  type TripAction = 'START' | 'COMPLETE' | 'CANCEL' | 'ABORT';
  async function transitionTrip(c: AppContext, action: TripAction) {
    const auth = await requireStudentMutation(c);
    if (auth.response) return auth.response;
    const { session } = auth.result;
    const tripId = z.uuid().safeParse(c.req.param('tripId'));
    const input = lifecycleCommandSchema.safeParse(await c.req.json().catch(() => null));
    const key = c.req.header('Idempotency-Key')?.trim() ?? '';
    if (!tripId.success || !input.success || key.length < 1 || key.length > 128
      || (['CANCEL', 'ABORT'].includes(action) && !input.data.reasonCode)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '상태 변경 정보와 Idempotency-Key를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
    }
    const operation = `TRIP_${action}`;
    const now = Date.now();
    const bodyHash = await sha256(JSON.stringify({ tripId: tripId.data, action, ...input.data }));
    const replay = await replayCommand(c, session.userId, operation, key, bodyHash, now);
    if (replay) return replay;

    await expireTripRequests(c.env.DB, tripId.data, now);
    await expireDriverTrip(c.env.DB, session.userId, now);
    const row = await c.env.DB.prepare(`SELECT id,status,version,updated_at AS updatedAt,created_at AS createdAt,
        departure_at AS departureAt,expires_at AS expiresAt
      FROM trips WHERE id=? AND driver_id=?`)
      .bind(tripId.data, session.userId).first<{
        id: string; status: string; version: number; updatedAt: number; createdAt: number;
        departureAt: number; expiresAt: number;
      }>();
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: '운행을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    if (row.version !== input.data.expectedVersion) return c.json({ error: { code: 'VERSION_CONFLICT', message: '운행 상태가 변경되었습니다. 새로고침해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);

    const counts = await c.env.DB.prepare(`SELECT
        SUM(CASE WHEN status='BOARDED' THEN 1 ELSE 0 END) AS boarded,
        SUM(CASE WHEN status='ACCEPTED' THEN 1 ELSE 0 END) AS accepted
      FROM ride_requests WHERE trip_id=?`).bind(row.id).first<{ boarded: number | null; accepted: number | null }>();
    const boarded = counts?.boarded ?? 0;
    const accepted = counts?.accepted ?? 0;
    if (action === 'START' && (row.status !== 'OPEN' || row.departureAt > now || row.expiresAt <= now || boarded === 0 || accepted > 0)) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승 확인과 출발 시각, 미탑승 요청을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (action === 'COMPLETE' && (row.status !== 'IN_PROGRESS' || boarded === 0)) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '진행 중인 운행만 완료할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (action === 'CANCEL' && (row.status !== 'OPEN' || boarded > 0)) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승자가 없는 모집 중 운행만 취소할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    if (action === 'ABORT' && (!['OPEN', 'IN_PROGRESS'].includes(row.status) || (row.status === 'OPEN' && boarded === 0))) {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: '탑승자가 있는 진행 가능한 운행만 중단할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    }

    const status = { START: 'IN_PROGRESS', COMPLETE: 'COMPLETED', CANCEL: 'CANCELLED', ABORT: 'ABORTED' }[action];
    const expectedStatus = row.status;
    const commandId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const updatedAt = Math.max(now, row.updatedAt + 1);
    const setTripCommand = action === 'CANCEL' || action === 'ABORT';
    try {
      const statements: D1PreparedStatement[] = [
        c.env.DB.prepare(`INSERT INTO idempotency_keys
          (user_id,operation,key,request_hash,command_id,result_json,http_status,created_at,expires_at)
          VALUES(?,?,?,?,?,'{}',200,?,?)`)
          .bind(session.userId, operation, key, bodyHash, commandId, now, now + 24 * 60 * 60_000),
      ];
      if (setTripCommand) statements.push(c.env.DB.prepare(`UPDATE trips SET last_command_id=?
        WHERE id=? AND driver_id=? AND status=? AND version=?`)
        .bind(commandId, row.id, session.userId, expectedStatus, input.data.expectedVersion));
      if (action === 'START') statements.push(c.env.DB.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status='REQUESTED'`)
        .bind(now, commandId, row.id));
      if (action === 'CANCEL') statements.push(c.env.DB.prepare(`UPDATE ride_requests SET status='CANCELLED',version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status IN ('REQUESTED','ACCEPTED')`)
        .bind(now, commandId, row.id));
      if (action === 'COMPLETE') statements.push(c.env.DB.prepare(`UPDATE ride_requests SET status='COMPLETED',version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status='BOARDED'`)
        .bind(now, commandId, row.id));
      if (action === 'ABORT') statements.push(c.env.DB.prepare(`UPDATE ride_requests SET
        status=CASE WHEN status='BOARDED' THEN 'ABORTED' ELSE 'CANCELLED' END,version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status IN ('REQUESTED','ACCEPTED','BOARDED')`)
        .bind(now, commandId, row.id));
      statements.push(c.env.DB.prepare(`UPDATE trips SET status=?,version=version+1,updated_at=?,last_command_id=?,
          started_at=CASE WHEN ?='IN_PROGRESS' THEN ? ELSE started_at END,
          ended_at=CASE WHEN ? IN ('COMPLETED','CANCELLED','ABORTED') THEN ? ELSE ended_at END
        WHERE id=? AND driver_id=? AND status=? AND version=?`)
        .bind(status, updatedAt, commandId, status, updatedAt, status, updatedAt,
          row.id, session.userId, expectedStatus, input.data.expectedVersion));
      statements.push(c.env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        SELECT ?,?,?,'trip',id,?,?,? FROM trips WHERE id=? AND last_command_id=? AND status=? AND version=?`)
        .bind(eventId, session.userId, `TRIP_${status}`, commandId,
          JSON.stringify(input.data.reasonCode ? { reasonCode: input.data.reasonCode } : {}), updatedAt,
          row.id, commandId, status, input.data.expectedVersion + 1));
      statements.push(c.env.DB.prepare(`UPDATE idempotency_keys SET result_json=(
          SELECT json_object('id',id,'status',status,'version',version) FROM trips
          WHERE id=? AND last_command_id=? AND status=? AND version=?
        ) WHERE user_id=? AND operation=? AND key=? AND command_id=?`)
        .bind(row.id, commandId, status, input.data.expectedVersion + 1,
          session.userId, operation, key, commandId));
      await c.env.DB.batch(statements);
    } catch (error) {
      const retry = await replayCommand(c, session.userId, operation, key, bodyHash, now);
      if (retry) return retry;
      if (error instanceof Error && /TRIP_|REQUEST_|UNIQUE constraint failed/.test(error.message)) {
        return c.json({ error: { code: 'INVALID_TRANSITION', message: '운행 상태나 동승자 요청이 변경되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '운행 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    return c.json({ data: { id: row.id, status, version: row.version + 1 }, meta: { requestId: c.get('requestId') } });
  }

  app.post('/api/v1/trips/:tripId/start', (c) => transitionTrip(c, 'START'));
  app.post('/api/v1/trips/:tripId/complete', (c) => transitionTrip(c, 'COMPLETE'));
  app.post('/api/v1/trips/:tripId/cancel', (c) => transitionTrip(c, 'CANCEL'));
  app.post('/api/v1/trips/:tripId/abort', (c) => transitionTrip(c, 'ABORT'));

  app.get('/api/v1/trips/:tripId', async (c) => {
    const result = await getSession(c);
    if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
    const consentFailure = await requiredConsentFailure(c, result.session.userId);
    if (consentFailure) return consentFailure;
    if (result.session.affiliationStatus !== 'VERIFIED') return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
    const tripId = z.uuid().safeParse(c.req.param('tripId'));
    if (!tripId.success) return c.json({ error: { code: 'NOT_FOUND', message: '운행을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    const now = Date.now();
    const trip = await c.env.DB.prepare(`${tripReadSql}
      WHERE t.id=? AND (t.driver_id=? OR (t.status='OPEN' AND t.expires_at>?
        AND d.account_status='ACTIVE' AND d.affiliation_status='VERIFIED' AND d.verified_until>?
        AND d.school_id=(SELECT school_id FROM users WHERE id=?)
        AND d.campus_id=(SELECT campus_id FROM users WHERE id=?)
        AND r.active=1 AND origin.active=1 AND destination.active=1
        AND EXISTS (SELECT 1 FROM driver_profiles p WHERE p.user_id=d.id
          AND p.verification_status='VERIFIED' AND p.verified_until>?)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=d.id)
          OR (b.blocker_id=d.id AND b.blocked_id=?))))`)
      .bind(tripId.data, result.session.userId, now, now, result.session.userId, result.session.userId,
        now, result.session.userId, result.session.userId).first<TripSummary>();
    if (!trip) return c.json({ error: { code: 'NOT_FOUND', message: '운행을 찾을 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
    if (trip.status === 'OPEN' && trip.expiresAt <= now) trip.status = 'EXPIRED';
    return c.json({ data: trip }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
