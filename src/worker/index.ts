import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { consentPolicies, cookieName, cookieOptions, environmentSchema, isStagingTestEmailAllowed, stagingTestModeActive, type Bindings } from './env';
import { adminAccessFailure, currentConsents, requiredConsentFailure } from './auth/access';
import { registerCatalogRoutes } from './routes/catalog';
import { registerModerationRoutes } from './routes/moderation';
import { registerTripRoutes } from './routes/trips';
import { registerRidePostingRoutes } from './routes/ride-postings';
import { expireDriverTrip, expireRiderRequest, tripReadSql, type TripSummary } from './trip-commands';
import type { AppEnv } from './types';
import { clearSessionCookie, createSession, csrfToken, getSession, randomToken, sha256, verifyMutation, SESSION_MAX_AGE_MS } from './auth/session';
import { authorizationUrl, consumeAuthorizationResponse, isGoogleConfigured, validReturnPath } from './auth/google';
import { consentSchema, devLoginSchema, driverProfileDecisionSchema, driverProfileSchema, profileUpdateSchema, verificationDecisionSchema } from '../shared/auth';
import { runScheduledCleanup } from './jobs/cleanup';

const app = new Hono<AppEnv>();
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    styleSrcAttr: ["'unsafe-inline'"],
    workerSrc: ["'self'"],
  },
  permissionsPolicy: { geolocation: [] },
  referrerPolicy: 'no-referrer',
}));
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('Cache-Control', 'no-store');
  if (!environmentSchema.safeParse(c.env).success) {
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '서비스 설정을 확인 중입니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  if (c.env.STAGING_AUTH_TEST_ONLY === 'true'
    && !(c.req.method === 'GET' && ['/api/v1/auth/google/start', '/api/v1/auth/google/callback'].includes(c.req.path))) {
    if (!stagingTestModeActive(c.env)) {
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '학교 계정 로그인 검증 전용 staging입니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
    const session = await getSession(c);
    const account = session && await c.env.DB.prepare("SELECT email FROM users WHERE id=? AND account_status='ACTIVE'")
      .bind(session.session.userId).first<{ email: string }>();
    if (!account || !isStagingTestEmailAllowed(c.env, account.email)) {
      return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '허용된 임시 테스트 계정만 사용할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    }
  }
  await next();
});
app.use('/api/*', bodyLimit({
  maxSize: 8 * 1024,
  onError: (c) => c.json({ error: { code: 'VALIDATION_ERROR', message: '요청 본문이 너무 큽니다.' }, meta: { requestId: c.get('requestId') } }, 413),
}));

app.get('/api/v1/health', async (c) => {
  await c.env.DB.prepare('SELECT 1 FROM users LIMIT 1').all();
  return c.json({ data: { status: 'ok' }, meta: { requestId: c.get('requestId') } });
});

app.post('/api/v1/auth/dev', async (c) => {
  if (c.env.APP_ENV !== 'development' || c.env.ALLOW_DEV_AUTH !== 'true'
    || new URL(c.req.url).origin !== c.env.APP_ORIGIN || c.req.header('Origin') !== c.env.APP_ORIGIN) {
    return c.json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  }
  const input = devLoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '입력값을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  const identity = {
    driver: '20000000-0000-4000-8000-000000000001',
    rider: '20000000-0000-4000-8000-000000000002',
    pending: '20000000-0000-4000-8000-000000000003',
    admin: '20000000-0000-4000-8000-000000000004',
  }[input.data.identity];
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND account_status='ACTIVE'").bind(identity).first<{ id: string }>();
  if (!user) return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '합성 계정을 찾을 수 없습니다. 로컬 seed를 적용해 주세요.' }, meta: { requestId: c.get('requestId') } }, 503);
  await createSession(c, user.id);
  return c.json({ data: { status: 'authenticated' }, meta: { requestId: c.get('requestId') } }, 201);
});

app.get('/api/v1/auth/google/start', async (c) => {
  if (!isGoogleConfigured(c.env) || !c.env.GOOGLE_CLIENT_ID) {
    return c.json({ error: { code: 'AUTH_PROVIDER_UNAVAILABLE', message: '학교 로그인 설정이 아직 준비되지 않았습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  try {
    const browserBinding = randomToken();
    const returnPath = validReturnPath(c.req.query('returnTo'), c.env.APP_ORIGIN);
    const target = await authorizationUrl(c.env, c.env.DB, browserBinding, returnPath);
    setCookie(c, cookieName(c.env, 'oauth'), browserBinding, { ...cookieOptions(c.env), maxAge: 600 });
    return c.redirect(target, 302);
  } catch {
    return c.json({ error: { code: 'AUTH_PROVIDER_UNAVAILABLE', message: '로그인 서비스에 연결할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
});

app.get('/api/v1/auth/google/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const browserBinding = getCookie(c, cookieName(c.env, 'oauth')) ?? '';
  const clearBrowserBinding = () => deleteCookie(c, cookieName(c.env, 'oauth'), cookieOptions(c.env));
  if (!isGoogleConfigured(c.env) || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browserBinding) {
    clearBrowserBinding();
    return c.json({ error: { code: 'INVALID_OAUTH_RESPONSE', message: '로그인을 완료할 수 없습니다. 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 401);
  }
  try {
    const claims = await consumeAuthorizationResponse(c.env, c.env.DB, new URL(c.req.url), state, browserBinding);
    if (c.env.STAGING_AUTH_TEST_ONLY === 'true' && !isStagingTestEmailAllowed(c.env, claims.email)) {
      await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?').bind(await sha256(state)).run();
      clearBrowserBinding();
      const message = stagingTestModeActive(c.env)
        ? 'Google 계정은 확인했지만 임시 테스트 허용목록에 없어 앱 계정이나 세션은 만들지 않았습니다.'
        : '검증 전용 로그인입니다. 계정·세션·학생 확인 기록은 만들지 않았고 staging API는 계속 닫혀 있습니다.';
      return c.html(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>학교 계정 확인</title><main><h1>학교 계정 확인 성공</h1><p>Google이 확인한 이메일 도메인과 Workspace 도메인이 모두 gachon.ac.kr과 일치합니다.</p><p>${message}</p><a href="/">로그인 화면으로 돌아가기</a></main></html>`);
    }
    const conflict = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND google_sub<>?').bind(claims.email, claims.subject).first();
    if (conflict) throw new Error('ACCOUNT_EMAIL_CONFLICT');
    const existing = await c.env.DB.prepare('SELECT id,school_id AS schoolId,campus_id AS campusId,account_status AS accountStatus,role FROM users WHERE google_sub=?')
      .bind(claims.subject).first<{ id: string; schoolId: string; campusId: string; accountStatus: string; role: string }>();
    if (existing && (existing.schoolId !== c.env.SCHOOL_ID || existing.campusId !== c.env.CAMPUS_ID || existing.accountStatus !== 'ACTIVE')) {
      throw new Error('ACCOUNT_NOT_ACTIVE_OR_OUT_OF_SCOPE');
    }
    const userId = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    const schoolAssertion = c.env.STUDENT_VERIFICATION_MODE === 'SCHOOL_ASSERTION';
    const statements = existing
      ? [c.env.DB.prepare('UPDATE users SET email=?,updated_at=? WHERE id=? AND account_status<>\'DELETED\'')
        .bind(claims.email, now, userId)]
      : [c.env.DB.prepare(`INSERT INTO users
        (id,google_sub,school_id,campus_id,email,nickname,department_id,department_status,
         department_source,parser_version,gender,affiliation_status,account_status,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'UNDISCLOSED','PENDING','ACTIVE','STUDENT',?,?)`)
        .bind(userId, claims.subject, c.env.SCHOOL_ID, c.env.CAMPUS_ID, claims.email, claims.name,
          claims.departmentCode, claims.departmentStatus, claims.departmentSource, claims.parserVersion, now, now)];
    if (schoolAssertion && (!existing || existing.role === 'STUDENT')) {
      statements.push(c.env.DB.prepare(`INSERT INTO student_verifications
        (id,user_id,method,outcome,department_id,verified_at,valid_until,created_at)
        VALUES(?,?,'SCHOOL_ASSERTION','VERIFIED',?,?,?,?)`)
        .bind(crypto.randomUUID(), userId, claims.departmentCode, now, now + SESSION_MAX_AGE_MS, now));
    }
    await c.env.DB.batch(statements);
    clearBrowserBinding();
    await createSession(c, userId, now);
    return c.redirect(validReturnPath(claims.returnPath, c.env.APP_ORIGIN), 302);
  } catch {
    clearBrowserBinding();
    if (c.env.STAGING_AUTH_TEST_ONLY === 'true') {
      await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?').bind(await sha256(state)).run().catch(() => undefined);
      return c.html(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>학교 계정 확인 실패</title><main><h1>학교 계정을 확인하지 못했습니다</h1><p>이메일 도메인과 Google Workspace 도메인이 gachon.ac.kr인 학교 Google 계정으로 다시 시도해 주세요. 계정이나 세션은 만들지 않았습니다.</p><a href="/api/v1/auth/google/start">다시 로그인</a></main></html>`, 401);
    }
    return c.json({ error: { code: 'INVALID_OAUTH_RESPONSE', message: '학교 계정을 확인하지 못했습니다. 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 401);
  }
});

app.get('/api/v1/me', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const { session, token } = result;
  const consents = await currentConsents(c.env.DB, c.env, session.userId);
  const driverProfile = await c.env.DB.prepare(`SELECT vehicle_model AS vehicleModel,vehicle_color AS vehicleColor,
    vehicle_identifier AS vehicleIdentifier,passenger_capacity AS passengerCapacity,
    verification_status AS verificationStatus,verified_until AS verifiedUntil,checked_at AS checkedAt
    FROM driver_profiles WHERE user_id=?`).bind(session.userId).first<{
      vehicleModel: string; vehicleColor: string; vehicleIdentifier: string; passengerCapacity: number;
      verificationStatus: string; verifiedUntil: number | null; checkedAt: number | null;
    }>();
  if (driverProfile?.verificationStatus === 'VERIFIED' && (driverProfile.verifiedUntil ?? 0) <= Date.now()) {
    driverProfile.verificationStatus = 'EXPIRED';
  }
  const now = Date.now();
  await expireDriverTrip(c.env.DB, session.userId, now);
  await expireRiderRequest(c.env.DB, session.userId, now);
  const activeActivity = await c.env.DB.prepare(`SELECT role,trip_id AS tripId,request_id AS requestId
    FROM active_user_locks WHERE user_id=?`).bind(session.userId).first<{
      role: 'DRIVER' | 'RIDER'; tripId: string | null; requestId: string | null;
    }>();
  const activeTrip = activeActivity?.role === 'DRIVER'
    ? await c.env.DB.prepare(`${tripReadSql} WHERE t.id=? AND t.driver_id=?`)
      .bind(activeActivity.tripId, session.userId).first<TripSummary>()
    : null;
  const activeRequest = activeActivity?.role === 'RIDER'
    ? await c.env.DB.prepare(`SELECT rr.id,rr.trip_id AS tripId,t.status AS tripStatus,rr.desired_departure_at AS desiredDepartureAt,
        rr.status,rr.expires_at AS expiresAt,rr.accepted_at AS acceptedAt,rr.boarded_at AS boardedAt,rr.version,
        t.driver_id AS driverId,d.nickname AS driverNickname,origin.name AS originName,destination.name AS destinationName
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id JOIN users d ON d.id=t.driver_id
      JOIN routes r ON r.id=t.route_id JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE rr.id=? AND rr.rider_id=?`)
      .bind(activeActivity.requestId, session.userId).first<{
        id: string; tripId: string; tripStatus: string; desiredDepartureAt: number; status: string; expiresAt: number;
        acceptedAt: number | null; boardedAt: number | null; version: number; driverId: string; driverNickname: string;
        originName: string; destinationName: string;
      }>()
    : null;
  if (activeTrip?.status === 'OPEN' && activeTrip.expiresAt <= Date.now()) activeTrip.status = 'EXPIRED';
  return c.json({ data: {
    id: session.userId,
    nickname: session.nickname,
    gender: session.gender,
    department: { id: session.departmentId, status: session.departmentStatus, source: session.departmentSource, parserVersion: session.parserVersion },
    affiliation: { status: session.affiliationStatus, verifiedUntil: session.verifiedUntil },
    role: session.role,
    driverProfile,
    activeActivity: activeActivity ?? null,
    activeTrip: activeTrip ?? null,
    activeRequest: activeRequest ?? null,
    requiredConsents: consents,
    csrfToken: await csrfToken(c.env, token),
  }, meta: { requestId: c.get('requestId') } });
});

app.delete('/api/v1/me', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const now = Date.now();
  if (result.session.createdAt > now || now - result.session.createdAt > 5 * 60_000) {
    return c.json({ error: { code: 'REAUTH_REQUIRED', message: '보안을 위해 최근에 다시 로그인한 뒤 탈퇴해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  try {
    await c.env.DB.prepare(`INSERT INTO audit_events
      (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
      VALUES(?,?,'USER_DELETED','user',?,?,'{}',?)`)
      .bind(crypto.randomUUID(), result.session.userId, result.session.userId, crypto.randomUUID(), now).run();
  } catch {
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '탈퇴를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  clearSessionCookie(c);
  return c.json({ data: { status: 'DELETED' }, meta: { requestId: c.get('requestId') } });
});

registerCatalogRoutes(app);

registerTripRoutes(app);
registerRidePostingRoutes(app);

app.put('/api/v1/me/driver-profile', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const consentFailure = await requiredConsentFailure(c, result.session.userId);
  if (consentFailure) return consentFailure;
  const input = driverProfileSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '차량 정보를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  const now = Date.now();
  const eligibility = await c.env.DB.prepare(`SELECT id FROM users WHERE id=? AND role='STUDENT' AND account_status='ACTIVE'
    AND affiliation_status='VERIFIED' AND verified_until>?`).bind(result.session.userId, now).first();
  if (!eligibility) return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  await expireDriverTrip(c.env.DB, result.session.userId, now);
  await expireRiderRequest(c.env.DB, result.session.userId, now);
  try {
    const saved = await c.env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      SELECT ?,?,?,?,?,'PENDING',NULL,NULL FROM users
      WHERE id=? AND role='STUDENT' AND account_status='ACTIVE' AND affiliation_status='VERIFIED' AND verified_until>?
        AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=?)
      ON CONFLICT(user_id) DO UPDATE SET
        vehicle_model=excluded.vehicle_model,vehicle_color=excluded.vehicle_color,
        vehicle_identifier=excluded.vehicle_identifier,passenger_capacity=excluded.passenger_capacity,
        verification_status=CASE WHEN driver_profiles.vehicle_model<>excluded.vehicle_model
          OR driver_profiles.vehicle_color<>excluded.vehicle_color
          OR driver_profiles.vehicle_identifier<>excluded.vehicle_identifier
          OR driver_profiles.passenger_capacity<>excluded.passenger_capacity
          OR driver_profiles.verification_status IN ('REJECTED','EXPIRED')
          OR (driver_profiles.verification_status='VERIFIED' AND driver_profiles.verified_until<=?)
          THEN 'PENDING' ELSE driver_profiles.verification_status END,
        verified_until=CASE WHEN driver_profiles.vehicle_model<>excluded.vehicle_model
          OR driver_profiles.vehicle_color<>excluded.vehicle_color
          OR driver_profiles.vehicle_identifier<>excluded.vehicle_identifier
          OR driver_profiles.passenger_capacity<>excluded.passenger_capacity
          OR driver_profiles.verification_status IN ('REJECTED','EXPIRED')
          OR (driver_profiles.verification_status='VERIFIED' AND driver_profiles.verified_until<=?)
          THEN NULL ELSE driver_profiles.verified_until END,
        checked_at=CASE WHEN driver_profiles.vehicle_model<>excluded.vehicle_model
          OR driver_profiles.vehicle_color<>excluded.vehicle_color
          OR driver_profiles.vehicle_identifier<>excluded.vehicle_identifier
          OR driver_profiles.passenger_capacity<>excluded.passenger_capacity
          OR driver_profiles.verification_status IN ('REJECTED','EXPIRED')
          OR (driver_profiles.verification_status='VERIFIED' AND driver_profiles.verified_until<=?)
          THEN NULL ELSE driver_profiles.checked_at END`).bind(
      result.session.userId, input.data.vehicleModel, input.data.vehicleColor, input.data.vehicleIdentifier,
      input.data.passengerCapacity, result.session.userId, now, result.session.userId, now, now, now,
    ).run();
    if (saved.meta.changes !== 1) return c.json({ error: { code: 'INVALID_TRANSITION', message: '활동 중에는 차량 정보를 바꿀 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  } catch {
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '차량 정보를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  const saved = await c.env.DB.prepare('SELECT verification_status AS verificationStatus FROM driver_profiles WHERE user_id=?')
    .bind(result.session.userId).first<{ verificationStatus: string }>();
  return c.json({ data: { status: saved?.verificationStatus ?? 'PENDING' }, meta: { requestId: c.get('requestId') } });
});

app.post('/api/v1/me/consents', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const input = consentSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '동의 입력을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  if (input.data.kind.startsWith('LOCATION_') && input.data.granted) {
    return c.json({ error: { code: 'FEATURE_DISABLED', message: '현재는 실시간 위치 수집·제공 기능을 사용하지 않습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  const policy = consentPolicies(c.env)[input.data.kind];
  if (input.data.policyVersion !== policy.version) {
    return c.json({ error: { code: 'POLICY_VERSION_CHANGED', message: '최신 안내를 확인한 뒤 다시 선택해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  const now = Date.now();
  try {
    if (input.data.granted) {
      const active = await c.env.DB.prepare(`SELECT id FROM consents WHERE user_id=? AND kind=?
        AND policy_version=? AND revoked_at IS NULL`).bind(result.session.userId, input.data.kind, policy.version).first();
      if (!active) await c.env.DB.batch([
        c.env.DB.prepare('UPDATE consents SET revoked_at=? WHERE user_id=? AND kind=? AND revoked_at IS NULL')
          .bind(now, result.session.userId, input.data.kind),
        c.env.DB.prepare(`INSERT INTO consents (id,user_id,kind,policy_version,granted_at)
          VALUES(?,?,?,?,?)`).bind(crypto.randomUUID(), result.session.userId, input.data.kind, policy.version, now),
      ]);
    } else {
      const statements = [
        c.env.DB.prepare('UPDATE consents SET revoked_at=? WHERE user_id=? AND kind=? AND revoked_at IS NULL')
          .bind(now, result.session.userId, input.data.kind),
        c.env.DB.prepare(`DELETE FROM latest_locations WHERE user_id=? OR trip_id IN (
          SELECT trip_id FROM active_user_locks WHERE user_id=? AND role='DRIVER' AND trip_id IS NOT NULL
          UNION SELECT rr.trip_id FROM active_user_locks l JOIN ride_requests rr ON rr.id=l.request_id
            WHERE l.user_id=? AND l.role='RIDER')`)
          .bind(result.session.userId, result.session.userId, result.session.userId),
        ...(input.data.kind.startsWith('LOCATION_') ? [
          c.env.DB.prepare('DELETE FROM location_disclosure_records WHERE owner_user_id=?')
            .bind(result.session.userId),
          c.env.DB.prepare('DELETE FROM location_access_records WHERE location_owner_user_id=?')
            .bind(result.session.userId),
          c.env.DB.prepare('DELETE FROM location_notice_presence WHERE user_id=?')
            .bind(result.session.userId),
        ] : []),
      ];
      await c.env.DB.batch(statements);
    }
  } catch {
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '동의 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  return c.json({ data: { kind: input.data.kind, accepted: input.data.granted }, meta: { requestId: c.get('requestId') } });
});

app.post('/api/v1/auth/logout', async (c) => {
  const result = await getSession(c);
  if (!result) {
    clearSessionCookie(c);
    return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  }
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  await c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(Date.now(), result.session.tokenHash).run();
  clearSessionCookie(c);
  return c.json({ data: { status: 'logged_out' }, meta: { requestId: c.get('requestId') } });
});

app.patch('/api/v1/me', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const consentFailure = await requiredConsentFailure(c, result.session.userId);
  if (consentFailure) return consentFailure;
  const input = profileUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '프로필 입력을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  const now = Date.now();
  await expireDriverTrip(c.env.DB, result.session.userId, now);
  await expireRiderRequest(c.env.DB, result.session.userId, now);
  const update = await c.env.DB.prepare(`UPDATE users SET
    nickname=COALESCE(?,nickname),gender=COALESCE(?,gender),updated_at=?
    WHERE id=? AND account_status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=?)`)
    .bind(input.data.nickname ?? null, input.data.gender ?? null, Date.now(), result.session.userId, result.session.userId).run();
  if (update.meta.changes !== 1) return c.json({ error: { code: 'INVALID_TRANSITION', message: '활동 중에는 프로필을 바꿀 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  return c.json({ data: { id: result.session.userId, status: 'updated' }, meta: { requestId: c.get('requestId') } });
});

app.post('/api/v1/me/verification-requests', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const consentFailure = await requiredConsentFailure(c, result.session.userId);
  if (consentFailure) return consentFailure;
  if (result.session.affiliationStatus === 'VERIFIED' && (result.session.verifiedUntil ?? 0) > Date.now()) {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: '학생 확인이 유효합니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  const current = await c.env.DB.prepare("SELECT id FROM student_verifications WHERE user_id=? AND outcome='PENDING'")
    .bind(result.session.userId).first<{ id: string }>();
  if (current) return c.json({ data: { id: current.id, status: 'PENDING' }, meta: { requestId: c.get('requestId') } });
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await c.env.DB.prepare(`INSERT INTO student_verifications (id,user_id,method,outcome,department_id,created_at)
      VALUES(?,?,'MANUAL_REVIEW','PENDING',?,?)`).bind(id, result.session.userId, result.session.departmentId, now).run();
  } catch {
    const raced = await c.env.DB.prepare("SELECT id FROM student_verifications WHERE user_id=? AND outcome='PENDING'")
      .bind(result.session.userId).first<{ id: string }>();
    if (!raced) return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '확인 요청을 접수하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
    return c.json({ data: { id: raced.id, status: 'PENDING' }, meta: { requestId: c.get('requestId') } });
  }
  return c.json({ data: { id, status: 'PENDING' }, meta: { requestId: c.get('requestId') } }, 201);
});

app.get('/api/v1/admin/verification-requests', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const accessFailure = await adminAccessFailure(c, result.session);
  if (accessFailure) return accessFailure;
  const requests = await c.env.DB.prepare(`SELECT v.id,v.user_id AS userId,u.nickname,u.department_status AS departmentStatus,
    u.department_id AS departmentId,v.created_at AS createdAt
    FROM student_verifications v JOIN users u ON u.id=v.user_id
    WHERE v.outcome='PENDING' ORDER BY v.created_at,v.id LIMIT 50`).all();
  return c.json({ data: requests.results }, { headers: { 'Cache-Control': 'no-store' } });
});

app.patch('/api/v1/admin/verification-requests/:verificationId', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const accessFailure = await adminAccessFailure(c, result.session);
  if (accessFailure) return accessFailure;
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const verificationId = z.uuid().safeParse(c.req.param('verificationId'));
  const input = verificationDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!verificationId.success || !input.success || (input.data.outcome === 'VERIFIED' && input.data.validUntil <= Date.now())) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '확인 결과와 만료 시각을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  }
  const decision = input.data;
  try {
    await c.env.DB.prepare(`INSERT INTO audit_events
      (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(), result.session.userId,
      decision.outcome === 'VERIFIED' ? 'STUDENT_VERIFICATION_VERIFIED' : 'STUDENT_VERIFICATION_REJECTED',
      'student_verification', verificationId.data,
      JSON.stringify(decision.outcome === 'VERIFIED' ? { validUntil: decision.validUntil } : {}), Date.now(),
    ).run();
  } catch {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: '확인 요청이 이미 처리되었거나 승인 권한이 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  return c.json({ data: { id: verificationId.data, status: decision.outcome }, meta: { requestId: c.get('requestId') } });
});

app.get('/api/v1/admin/driver-profiles', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const accessFailure = await adminAccessFailure(c, result.session);
  if (accessFailure) return accessFailure;
  const profiles = await c.env.DB.prepare(`SELECT p.user_id AS userId,u.nickname,p.vehicle_model AS vehicleModel,
    p.vehicle_color AS vehicleColor,p.vehicle_identifier AS vehicleIdentifier,
    p.passenger_capacity AS passengerCapacity,p.verification_status AS verificationStatus,
    p.verified_until AS verifiedUntil,p.checked_at AS checkedAt
    FROM driver_profiles p JOIN users u ON u.id=p.user_id
    WHERE p.verification_status='PENDING' ORDER BY p.checked_at,p.user_id LIMIT 50`).all();
  return c.json({ data: profiles.results }, { headers: { 'Cache-Control': 'no-store' } });
});

app.patch('/api/v1/admin/driver-profiles/:userId', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const accessFailure = await adminAccessFailure(c, result.session);
  if (accessFailure) return accessFailure;
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const userId = z.uuid().safeParse(c.req.param('userId'));
  const input = driverProfileDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!userId.success || !input.success || (input.data.outcome === 'VERIFIED' && input.data.validUntil <= Date.now())) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '확인 결과와 유효기간을 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  }
  const decision = input.data;
  try {
    await c.env.DB.prepare(`INSERT INTO audit_events
      (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(), result.session.userId,
      decision.outcome === 'VERIFIED' ? 'DRIVER_PROFILE_VERIFIED' : 'DRIVER_PROFILE_REJECTED',
      'driver_profile', userId.data,
      JSON.stringify(decision.outcome === 'VERIFIED' ? { validUntil: decision.validUntil } : {}), Date.now(),
    ).run();
  } catch {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: '확인 대기 차량이 아니거나 승인 권한이 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  return c.json({ data: { userId: userId.data, status: decision.outcome }, meta: { requestId: c.get('requestId') } });
});

registerModerationRoutes(app);

// Unimplemented domain API paths remain closed until their roadmap stage.
for (const path of ['trips', 'requests', 'locations', 'stops', 'routes', 'departments']) {
  app.all(`/api/v1/${path}`, (c) => c.json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404));
  app.all(`/api/v1/${path}/*`, (c) => c.json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404));
}

app.all('/api', (c) => c.notFound());
app.all('/api/*', (c) => c.notFound());
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404));
app.onError((_, c) => c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 503));

export default Object.assign(app, {
  scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledCleanup(env.DB, controller.scheduledTime));
  },
});
