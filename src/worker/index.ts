import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { consentPolicies, environmentSchema, type Bindings } from './env';
import { cookieName, cookieOptions } from './env';
import { createSession, csrfToken, getSession, sha256, verifyMutation, clearSessionCookie, SESSION_MAX_AGE_MS } from './auth/session';
import { authorizationUrl, consumeAuthorizationResponse, isGoogleConfigured, validReturnPath } from './auth/google';
import { consentSchema, devLoginSchema, driverProfileDecisionSchema, driverProfileSchema, profileUpdateSchema, verificationDecisionSchema } from '../shared/auth';
import { adminRouteCreateSchema, adminRouteUpdateSchema, adminStopSchema } from '../shared/admin';
import { locationUploadSchema } from '../shared/location';
import { blockCreateSchema, reportCreateSchema, reportDecisionSchema, suspendUserSchema } from '../shared/moderation';
import { boardingCodeInputSchema, lifecycleCommandSchema, rideRequestCreateSchema, tripCreateSchema, tripSearchCursorSchema, tripSearchQuerySchema } from '../shared/trips';
import { genderGroupAllows, type MatchMember } from './matching/eligibility';
import { compareMatchRank, matchReasons } from './matching/rank';
import { runScheduledCleanup } from './jobs/cleanup';

type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
type AppContext = Context<AppEnv>;
const app = new Hono<AppEnv>();
type TripSummary = {
  id: string; driverNickname: string; routeId: string; originName: string; destinationName: string;
  departureAt: number; expiresAt: number; seatCapacity: number; remainingSeats: number;
  genderFilter: string; preferSameDepartment: number; status: string; version: number; createdAt: number;
};
const tripReadSql = `SELECT t.id,d.nickname AS driverNickname,t.route_id AS routeId,
  origin.name AS originName,destination.name AS destinationName,t.departure_at AS departureAt,
  t.expires_at AS expiresAt,t.seat_capacity AS seatCapacity,
  t.seat_capacity-(SELECT COUNT(*) FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')) AS remainingSeats,
  t.gender_filter AS genderFilter,t.prefer_same_department AS preferSameDepartment,
  t.status,t.version,t.created_at AS createdAt
  FROM trips t JOIN users d ON d.id=t.driver_id JOIN routes r ON r.id=t.route_id
  JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id`;
const TRIP_SEARCH_RAW_LIMIT = 50;
const TRIP_SEARCH_PAGE_SIZE = 20;

function encodeTripCursor(cursor: z.infer<typeof tripSearchCursorSchema>) {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeTripCursor(cursor: string) {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    return tripSearchCursorSchema.safeParse(JSON.parse(atob(base64)));
  } catch {
    return null;
  }
}

async function expireDriverTrip(db: D1Database, userId: string, now: number) {
  const commandId = crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
      WHERE trip_id=(SELECT trip_id FROM active_user_locks WHERE user_id=? AND role='DRIVER')
        AND status='REQUESTED' AND expires_at<=?`)
      .bind(now, commandId, userId, now),
    db.prepare(`UPDATE ride_requests SET status=CASE status WHEN 'REQUESTED' THEN 'EXPIRED' ELSE 'CANCELLED' END,
        version=version+1,updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
      WHERE trip_id=(SELECT trip_id FROM active_user_locks WHERE user_id=? AND role='DRIVER')
        AND status IN ('REQUESTED','ACCEPTED')
        AND EXISTS (SELECT 1 FROM trips WHERE id=ride_requests.trip_id AND status='OPEN' AND expires_at<=?)
        AND NOT EXISTS (SELECT 1 FROM ride_requests boarded WHERE boarded.trip_id=ride_requests.trip_id AND boarded.status='BOARDED')`)
      .bind(now, commandId, userId, now),
    db.prepare(`UPDATE trips SET status='EXPIRED',ended_at=MAX(?,updated_at+1),updated_at=MAX(?,updated_at+1),
        version=version+1,last_command_id=?
      WHERE id=(SELECT trip_id FROM active_user_locks WHERE user_id=? AND role='DRIVER')
        AND status='OPEN' AND expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=trips.id AND status IN ('REQUESTED','ACCEPTED','BOARDED'))`)
      .bind(now, now, commandId, userId, now),
    db.prepare(`DELETE FROM active_user_locks WHERE user_id=? AND role='DRIVER'
      AND trip_id=(SELECT id FROM trips WHERE driver_id=? AND status='EXPIRED' AND last_command_id=?)`)
      .bind(userId, userId, commandId),
  ]);
}

async function expireRiderRequest(db: D1Database, userId: string, now: number) {
  // Keep the request path safe when scheduled cleanup is delayed.
  const commandId = crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE ride_requests SET status=CASE WHEN status='REQUESTED' THEN 'EXPIRED' ELSE 'CANCELLED' END,version=version+1,
        updated_at=MAX(?,updated_at+1),last_command_id=?
      WHERE id=(SELECT request_id FROM active_user_locks WHERE user_id=? AND role='RIDER')
        AND ((status='REQUESTED' AND expires_at<=?) OR (status='ACCEPTED' AND EXISTS (
          SELECT 1 FROM trips WHERE id=ride_requests.trip_id AND expires_at<=?
        )))`).bind(now, commandId, userId, now, now),
    db.prepare(`DELETE FROM active_user_locks WHERE user_id=? AND role='RIDER'
      AND EXISTS (SELECT 1 FROM ride_requests r WHERE r.id=active_user_locks.request_id
        AND r.rider_id=? AND r.status='EXPIRED' AND r.expires_at<=?)`).bind(userId, userId, now),
  ]);
}

async function expireTripRequests(db: D1Database, tripId: string, now: number) {
  const commandId = crypto.randomUUID();
  await db.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,
      updated_at=MAX(?,updated_at+1),last_command_id=?
    WHERE trip_id=? AND status='REQUESTED' AND expires_at<=?`)
    .bind(now, commandId, tripId, now).run();
}

async function requireStudentMutation(c: AppContext) {
  const result = await getSession(c);
  if (!result) return { result: null, response: c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401) };
  if (!await verifyMutation(c, result.token, result.session)) return { result: null, response: c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403) };
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return { result: null, response: c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403) };
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= Date.now()) {
    return { result: null, response: c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403) };
  }
  return { result, response: null };
}

async function replayCommand(c: AppContext, userId: string, operation: string, key: string, bodyHash: string, now: number) {
  await c.env.DB.prepare('DELETE FROM idempotency_keys WHERE user_id=? AND operation=? AND key=? AND expires_at<=?')
    .bind(userId, operation, key, now).run();
  const stored = await c.env.DB.prepare(`SELECT request_hash AS requestHash,result_json AS resultJson,http_status AS httpStatus
    FROM idempotency_keys WHERE user_id=? AND operation=? AND key=? AND expires_at>?`)
    .bind(userId, operation, key, now).first<{ requestHash: string; resultJson: string; httpStatus: number }>();
  if (!stored) return null;
  if (stored.requestHash !== bodyHash) return c.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  let body: unknown;
  try { body = JSON.parse(stored.resultJson); } catch { body = null; }
  const parsed = z.object({ id: z.uuid(), status: z.string(), version: z.number().int().positive() }).safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'INVALID_TRANSITION', message: '처리 결과를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  return c.json({ data: parsed.data, meta: { requestId: c.get('requestId') } }, stored.httpStatus as 200 | 201);
}

async function rateLimit(db: D1Database, userId: string, operation: string, now: number, limit: number, windowMs: number) {
  const subject = await sha256(userId);
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare('DELETE FROM rate_limit_buckets WHERE expires_at<=?').bind(now).run();
  return db.prepare(`INSERT INTO rate_limit_buckets (subject_hash,operation,window_start,count,expires_at)
      VALUES(?,?,?,1,?) ON CONFLICT(subject_hash,operation,window_start)
      DO UPDATE SET count=count+1 WHERE count<? RETURNING count`)
    .bind(subject, operation, windowStart, windowStart + windowMs * 2, limit).first<{ count: number }>();
}

async function boardingCodeHash(env: Bindings, requestId: string, code: string) {
  const secret = env.BOARDING_HMAC_KEY ?? (env.APP_ENV === 'development' ? 'development-only-campus-ride-boarding-key' : '');
  if (secret.length < 32) throw new Error('boarding HMAC key unavailable');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`boarding-code:v1:${requestId}:${code}`)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyBoardingCode(env: Bindings, requestId: string, code: string, storedHash: string) {
  const secret = env.BOARDING_HMAC_KEY ?? (env.APP_ENV === 'development' ? 'development-only-campus-ride-boarding-key' : '');
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(storedHash.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`boarding-code:v1:${requestId}:${code}`));
}

function newBoardingCode() {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return String(value[0] % 1_000_000).padStart(6, '0');
}

async function currentConsents(db: D1Database, env: Bindings, userId: string) {
  const policies = consentPolicies(env);
  const rows = await db.prepare(`SELECT kind FROM consents WHERE user_id=? AND revoked_at IS NULL
    AND ((kind='TERMS' AND policy_version=?) OR (kind='PRIVACY' AND policy_version=?)
      OR (kind='LOCATION_COLLECTION' AND policy_version=?) OR (kind='LOCATION_SHARING' AND policy_version=?))`)
    .bind(userId, policies.TERMS.version, policies.PRIVACY.version,
      policies.LOCATION_COLLECTION.version, policies.LOCATION_SHARING.version)
    .all<{ kind: keyof ReturnType<typeof consentPolicies> }>();
  const accepted = new Set(rows.results.map((row) => row.kind));
  return {
    TERMS: { ...policies.TERMS, accepted: accepted.has('TERMS') },
    PRIVACY: { ...policies.PRIVACY, accepted: accepted.has('PRIVACY') },
    LOCATION_COLLECTION: { ...policies.LOCATION_COLLECTION, accepted: accepted.has('LOCATION_COLLECTION') },
    LOCATION_SHARING: { ...policies.LOCATION_SHARING, accepted: accepted.has('LOCATION_SHARING') },
  };
}

async function hasRequiredConsents(db: D1Database, env: Bindings, userId: string): Promise<boolean> {
  const consents = await currentConsents(db, env, userId);
  return consents.TERMS.accepted && consents.PRIVACY.accepted;
}

async function hasLocationConsents(db: D1Database, env: Bindings, userId: string): Promise<boolean> {
  const consents = await currentConsents(db, env, userId);
  return consents.LOCATION_COLLECTION.accepted && consents.LOCATION_SHARING.accepted;
}

function consentVersions(env: Bindings) {
  const policies = consentPolicies(env);
  return [policies.TERMS.version, policies.PRIVACY.version,
    policies.LOCATION_COLLECTION.version, policies.LOCATION_SHARING.version] as const;
}

const CONSENTED_USERS_SQL = `SELECT user_id FROM consents WHERE revoked_at IS NULL AND
  ((kind='TERMS' AND policy_version=?) OR (kind='PRIVACY' AND policy_version=?)
    OR (kind='LOCATION_COLLECTION' AND policy_version=?) OR (kind='LOCATION_SHARING' AND policy_version=?))
  GROUP BY user_id HAVING COUNT(DISTINCT kind)=4`;

type LocationContext = {
  role: 'DRIVER' | 'RIDER'; tripId: string; requestId: string | null;
  stopName: string; stopLat: number; stopLng: number;
};

async function currentLocationContext(db: D1Database, env: Bindings, userId: string, now: number): Promise<LocationContext | null> {
  const lock = await db.prepare(`SELECT role,trip_id AS tripId,request_id AS requestId
    FROM active_user_locks WHERE user_id=?`).bind(userId)
    .first<{ role: 'DRIVER' | 'RIDER'; tripId: string | null; requestId: string | null }>();
  if (!lock) return null;
  const versions = consentVersions(env);
  if (lock.role === 'DRIVER' && lock.tripId) {
    return db.prepare(`WITH consented_users AS (${CONSENTED_USERS_SQL})
      SELECT t.id AS tripId,origin.name AS stopName,origin.lat AS stopLat,origin.lng AS stopLng
      FROM trips t JOIN users driver ON driver.id=t.driver_id
      JOIN driver_profiles p ON p.user_id=driver.id
      JOIN active_user_locks own ON own.user_id=? AND own.role='DRIVER' AND own.trip_id=t.id
      JOIN consented_users ownerConsent ON ownerConsent.user_id=driver.id
      JOIN routes r ON r.id=t.route_id JOIN stops origin ON origin.id=r.origin_stop_id
      WHERE t.id=? AND t.status='OPEN' AND t.expires_at>? AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
        AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
        AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND EXISTS (SELECT 1 FROM ride_requests rr JOIN users rider ON rider.id=rr.rider_id
          JOIN active_user_locks riderLock ON riderLock.user_id=rider.id AND riderLock.role='RIDER' AND riderLock.request_id=rr.id
          JOIN consented_users riderConsent ON riderConsent.user_id=rider.id
          WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')
            AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
            AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
            AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
              (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id)))`)
      .bind(...versions, userId, lock.tripId, now, now, now, now)
      .first<Omit<LocationContext, 'role' | 'requestId'>>().then((context) => context
        ? { ...context, role: 'DRIVER', requestId: null } : null);
  }
  if (lock.role === 'RIDER' && lock.requestId) {
    return db.prepare(`WITH consented_users AS (${CONSENTED_USERS_SQL})
      SELECT t.id AS tripId,rr.id AS requestId,origin.name AS stopName,origin.lat AS stopLat,origin.lng AS stopLng
      FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id JOIN users driver ON driver.id=t.driver_id
      JOIN driver_profiles p ON p.user_id=driver.id
      JOIN active_user_locks own ON own.user_id=rr.rider_id AND own.role='RIDER' AND own.request_id=rr.id
      JOIN users rider ON rider.id=rr.rider_id JOIN consented_users riderConsent ON riderConsent.user_id=rider.id
      JOIN consented_users driverConsent ON driverConsent.user_id=driver.id
      JOIN routes r ON r.id=t.route_id JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN active_user_locks driverLock ON driverLock.user_id=driver.id AND driverLock.role='DRIVER' AND driverLock.trip_id=t.id
      WHERE rr.id=? AND rr.rider_id=? AND rr.status IN ('ACCEPTED','BOARDED') AND t.status='OPEN' AND t.expires_at>?
        AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
        AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
        AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
        AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))`)
      .bind(...versions, lock.requestId, userId, now, now, now, now)
      .first<Omit<LocationContext, 'role'>>().then((context) => context
        ? { ...context, role: 'RIDER' } : null);
  }
  return null;
}

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
    workerSrc: ["'self'"],
  },
  permissionsPolicy: { geolocation: ['self'] },
  referrerPolicy: 'no-referrer',
}));
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('Cache-Control', 'no-store');
  if (!environmentSchema.safeParse(c.env).success) {
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '서비스 설정을 확인 중입니다.' }, meta: { requestId: c.get('requestId') } }, 503);
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
  if (!isGoogleConfigured(c.env) || !c.env.GOOGLE_CLIENT_ID || c.env.SCHOOL_CONFIG_READY !== 'true') {
    return c.json({ error: { code: 'AUTH_PROVIDER_UNAVAILABLE', message: '학교 로그인 설정이 아직 준비되지 않았습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  try {
    const browserBinding = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
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
    const conflict = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND google_sub<>?').bind(claims.email, claims.subject).first();
    if (conflict) throw new Error('ACCOUNT_EMAIL_CONFLICT');
    const existing = await c.env.DB.prepare('SELECT id,school_id AS schoolId,campus_id AS campusId,account_status AS accountStatus FROM users WHERE google_sub=?')
      .bind(claims.subject).first<{ id: string; schoolId: string; campusId: string; accountStatus: string }>();
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
    if (schoolAssertion) {
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

app.get('/api/v1/locations/me', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const now = Date.now();
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= now) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (!await hasLocationConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'LOCATION_CONSENT_REQUIRED', message: '위치 수집과 상대 제공에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const context = await currentLocationContext(c.env.DB, c.env, result.session.userId, now);
  if (!context) return c.json({ error: { code: 'LOCATION_NOT_AVAILABLE', message: '수락된 운행에서만 위치를 확인할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  const location = await c.env.DB.prepare(`SELECT sequence,lat,lng,accuracy_m AS accuracyM,captured_at AS capturedAt,
      received_at AS receivedAt,expires_at AS expiresAt
    FROM latest_locations WHERE user_id=? AND trip_id=? AND request_id IS ?`)
    .bind(result.session.userId, context.tripId, context.requestId).first<{
      sequence: number; lat: number; lng: number; accuracyM: number; capturedAt: number; receivedAt: number; expiresAt: number;
    }>();
  const disclosures = await c.env.DB.prepare(`SELECT id,recipient_nickname AS recipientNickname,
      recipient_role AS recipientRole,purpose,provided_at AS providedAt
    FROM location_disclosure_records WHERE owner_user_id=? AND trip_id=? AND request_id IS ?
    ORDER BY provided_at DESC,id DESC LIMIT 20`)
    .bind(result.session.userId, context.tripId, context.requestId).all<{
      id: string; recipientNickname: string; recipientRole: 'DRIVER' | 'RIDER'; purpose: 'MEETING'; providedAt: number;
    }>();
  const fresh = location && location.expiresAt > now;
  return c.json({ data: {
    sequence: location?.sequence ?? 0,
    disclosures: disclosures.results,
    location: fresh ? {
      lat: location.lat, lng: location.lng, accuracyM: location.accuracyM,
      capturedAt: location.capturedAt, receivedAt: location.receivedAt, expiresAt: location.expiresAt,
    } : null,
  }, meta: { requestId: c.get('requestId') } }, { headers: { 'Cache-Control': 'no-store' } });
});

app.put('/api/v1/locations/me', async (c) => {
  const guard = await requireStudentMutation(c);
  if (guard.response) return guard.response;
  const result = guard.result!;
  const input = locationUploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: '위치 정보를 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 400);
  const now = Date.now();
  if (!await hasLocationConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'LOCATION_CONSENT_REQUIRED', message: '위치 수집과 상대 제공에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (input.data.capturedAt < now - 60_000 || input.data.capturedAt > now + 30_000) {
    return c.json({ error: { code: 'INVALID_LOCATION', message: '위치 시각이 오래되었거나 현재 시각과 맞지 않습니다.' }, meta: { requestId: c.get('requestId') } }, 400);
  }
  const context = await currentLocationContext(c.env.DB, c.env, result.session.userId, now);
  if (!context || context.tripId !== input.data.tripId || context.requestId !== input.data.requestId) {
    return c.json({ error: { code: 'LOCATION_NOT_AVAILABLE', message: '수락된 운행 관계를 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  if (!await rateLimit(c.env.DB, result.session.userId, 'LOCATION_UPDATE', now, 10, 60_000)) {
    return c.json({ error: { code: 'RATE_LIMITED', message: '위치 갱신이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }, meta: { requestId: c.get('requestId') } }, 429);
  }
  const consentedUsers = `WITH consented_users AS (${CONSENTED_USERS_SQL}), valid_activity AS (`;
  const validActivity = context.role === 'DRIVER' ? `SELECT own.user_id,t.id AS tripId
      FROM active_user_locks own JOIN trips t ON t.id=own.trip_id
      JOIN users driver ON driver.id=own.user_id JOIN driver_profiles p ON p.user_id=driver.id
      JOIN consented_users driverConsent ON driverConsent.user_id=driver.id
      WHERE own.user_id=? AND own.role='DRIVER' AND t.id=? AND t.status='OPEN' AND t.expires_at>?
        AND ? IS NULL AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
        AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
        AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND EXISTS (SELECT 1 FROM ride_requests rr JOIN users rider ON rider.id=rr.rider_id
          JOIN active_user_locks riderLock ON riderLock.user_id=rider.id AND riderLock.role='RIDER' AND riderLock.request_id=rr.id
          JOIN consented_users riderConsent ON riderConsent.user_id=rider.id
          WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')
            AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
            AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
            AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
              (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id)))` : `SELECT own.user_id,t.id AS tripId
      FROM active_user_locks own JOIN ride_requests rr ON rr.id=own.request_id AND rr.rider_id=own.user_id
      JOIN trips t ON t.id=rr.trip_id JOIN users rider ON rider.id=own.user_id
      JOIN users driver ON driver.id=t.driver_id JOIN driver_profiles p ON p.user_id=driver.id
      JOIN active_user_locks driverLock ON driverLock.user_id=driver.id AND driverLock.role='DRIVER' AND driverLock.trip_id=t.id
      JOIN consented_users riderConsent ON riderConsent.user_id=rider.id
      JOIN consented_users driverConsent ON driverConsent.user_id=driver.id
      WHERE own.user_id=? AND own.role='RIDER' AND own.request_id=? AND rr.status IN ('ACCEPTED','BOARDED')
        AND t.id=? AND t.status='OPEN' AND t.expires_at>? AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
        AND driver.role='STUDENT' AND driver.account_status='ACTIVE' AND driver.affiliation_status='VERIFIED'
        AND driver.verified_until>? AND p.verification_status='VERIFIED' AND p.verified_until>?
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))`;
  const bindings = context.role === 'DRIVER'
    ? [result.session.userId, context.tripId, now, input.data.requestId, now, now, now]
    : [result.session.userId, context.requestId, context.tripId, now, now, now, now];
  const saved = await c.env.DB.prepare(`${consentedUsers}${validActivity})
    INSERT INTO latest_locations (user_id,trip_id,request_id,lat,lng,accuracy_m,captured_at,received_at,expires_at,sequence)
    SELECT ?,tripId,?,?,?,?,?,?,?,? FROM valid_activity WHERE 1
    ON CONFLICT(user_id) DO UPDATE SET trip_id=excluded.trip_id,request_id=excluded.request_id,
      lat=excluded.lat,lng=excluded.lng,accuracy_m=excluded.accuracy_m,captured_at=excluded.captured_at,
      received_at=excluded.received_at,expires_at=excluded.expires_at,sequence=excluded.sequence
    WHERE latest_locations.trip_id=excluded.trip_id AND latest_locations.request_id IS excluded.request_id
      AND excluded.sequence>latest_locations.sequence AND latest_locations.received_at<=excluded.received_at-10000
    RETURNING sequence,received_at AS receivedAt,expires_at AS expiresAt`)
    .bind(...consentVersions(c.env), ...bindings, result.session.userId, input.data.requestId,
      input.data.lat, input.data.lng, input.data.accuracyM, input.data.capturedAt, now, now + 60_000, input.data.sequence)
    .first<{ sequence: number; receivedAt: number; expiresAt: number }>();
  if (!saved) {
    const previous = await c.env.DB.prepare(`SELECT trip_id AS tripId,request_id AS requestId,sequence,received_at AS receivedAt
      FROM latest_locations WHERE user_id=?`).bind(result.session.userId)
      .first<{ tripId: string; requestId: string | null; sequence: number; receivedAt: number }>();
    if (previous?.tripId === context.tripId && previous.requestId === context.requestId) {
      if (input.data.sequence <= previous.sequence) {
        return c.json({ error: { code: 'LOCATION_SEQUENCE_CONFLICT', message: '위치 갱신 순서가 오래되었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
      }
      if (previous.receivedAt > now - 10_000) {
        return c.json({ error: { code: 'LOCATION_RATE_LIMITED', message: '위치는 10초에 한 번만 갱신할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 429);
      }
    }
    return c.json({ error: { code: 'LOCATION_NOT_AVAILABLE', message: '위치 공유 조건이 바뀌었습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
  }
  return c.json({ data: saved }, { headers: { 'Cache-Control': 'no-store' } });
});

app.get('/api/v1/trips/:tripId/locations', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  const tripId = z.uuid().safeParse(c.req.param('tripId'));
  if (!tripId.success) return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  const now = Date.now();
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= now) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (!await hasLocationConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'LOCATION_CONSENT_REQUIRED', message: '위치 수집과 상대 제공에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  const context = await currentLocationContext(c.env.DB, c.env, result.session.userId, now);
  if (!context || context.tripId !== tripId.data) {
    return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  }
  const versions = consentVersions(c.env);
  const targetSql = context.role === 'DRIVER' ? `WITH consented_users AS (${CONSENTED_USERS_SQL})
    SELECT l.user_id AS ownerUserId,rider.nickname AS nickname,'RIDER' AS role,l.lat,l.lng,l.accuracy_m AS accuracyM,
      l.captured_at AS capturedAt,l.received_at AS receivedAt,l.expires_at AS expiresAt,l.sequence
    FROM trips t JOIN users driver ON driver.id=t.driver_id
    JOIN driver_profiles p ON p.user_id=driver.id JOIN active_user_locks ownerLock
      ON ownerLock.user_id=driver.id AND ownerLock.role='DRIVER' AND ownerLock.trip_id=t.id
    JOIN consented_users ownerConsent ON ownerConsent.user_id=driver.id
    JOIN ride_requests rr ON rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')
    JOIN users rider ON rider.id=rr.rider_id JOIN active_user_locks riderLock
      ON riderLock.user_id=rider.id AND riderLock.role='RIDER' AND riderLock.request_id=rr.id
    JOIN consented_users riderConsent ON riderConsent.user_id=rider.id
    JOIN latest_locations l ON l.user_id=rider.id AND l.trip_id=t.id AND l.request_id=rr.id
      AND l.expires_at>? AND l.received_at>?
    WHERE t.id=? AND t.driver_id=? AND t.status='OPEN' AND t.expires_at>?
      AND driver.role='STUDENT' AND driver.account_status='ACTIVE' AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
      AND p.verification_status='VERIFIED' AND p.verified_until>?
      AND rider.role='STUDENT' AND rider.account_status='ACTIVE' AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
        (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))` : `WITH consented_users AS (${CONSENTED_USERS_SQL})
    SELECT l.user_id AS ownerUserId,driver.nickname AS nickname,'DRIVER' AS role,l.lat,l.lng,l.accuracy_m AS accuracyM,
      l.captured_at AS capturedAt,l.received_at AS receivedAt,l.expires_at AS expiresAt,l.sequence
    FROM ride_requests rr JOIN trips t ON t.id=rr.trip_id JOIN users driver ON driver.id=t.driver_id
    JOIN driver_profiles p ON p.user_id=driver.id JOIN users rider ON rider.id=rr.rider_id
    JOIN active_user_locks riderLock ON riderLock.user_id=rider.id AND riderLock.role='RIDER' AND riderLock.request_id=rr.id
    JOIN active_user_locks driverLock ON driverLock.user_id=driver.id AND driverLock.role='DRIVER' AND driverLock.trip_id=t.id
    JOIN consented_users riderConsent ON riderConsent.user_id=rider.id JOIN consented_users driverConsent ON driverConsent.user_id=driver.id
    JOIN latest_locations l ON l.user_id=driver.id AND l.trip_id=t.id AND l.request_id IS NULL
      AND l.expires_at>? AND l.received_at>?
    WHERE rr.id=? AND rr.trip_id=? AND rr.rider_id=? AND rr.status IN ('ACCEPTED','BOARDED') AND t.status='OPEN' AND t.expires_at>?
      AND rider.role='STUDENT' AND rider.account_status='ACTIVE' AND rider.affiliation_status='VERIFIED' AND rider.verified_until>?
      AND driver.role='STUDENT' AND driver.account_status='ACTIVE' AND driver.affiliation_status='VERIFIED' AND driver.verified_until>?
      AND p.verification_status='VERIFIED' AND p.verified_until>?
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
        (b.blocker_id=driver.id AND b.blocked_id=rider.id) OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))`;
  const locationBindings = context.role === 'DRIVER'
    ? [...versions, now, now - 60_000, context.tripId, result.session.userId, now, now, now, now]
    : [...versions, now, now - 60_000, context.requestId, context.tripId, result.session.userId, now, now, now, now];
  const locations = await c.env.DB.prepare(targetSql).bind(...locationBindings).all<{
    ownerUserId: string; nickname: string; role: 'DRIVER' | 'RIDER'; lat: number; lng: number; accuracyM: number;
    capturedAt: number; receivedAt: number; expiresAt: number; sequence: number;
  }>();
  if (locations.results.length) {
    const providedAt = Date.now();
    // shortcut: unchanged location sequences are recorded once per recipient; log every response if legal review requires it.
    await c.env.DB.batch(locations.results.map((location) => c.env.DB.prepare(`INSERT OR IGNORE INTO location_disclosure_records
      (id,owner_user_id,recipient_user_id,recipient_nickname,recipient_role,trip_id,request_id,sequence,purpose,provided_at)
      VALUES(?,?,?,?,?,?,?,?, 'MEETING',?)`)
      .bind(crypto.randomUUID(), location.ownerUserId, result.session.userId, result.session.nickname,
        context.role, context.tripId, context.requestId, location.sequence, providedAt)));
  }
  return c.json({ data: {
    tripId: context.tripId, viewerRole: context.role,
    stop: { name: context.stopName, lat: context.stopLat, lng: context.stopLng },
    locations: locations.results.map(({ nickname, role, lat, lng, accuracyM, capturedAt, receivedAt, expiresAt, sequence }) =>
      ({ nickname, role, lat, lng, accuracyM, capturedAt, receivedAt, expiresAt, sequence })),
  }, meta: { requestId: c.get('requestId') } }, { headers: { 'Cache-Control': 'no-store' } });
});

app.get('/api/v1/routes', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  const stops = await c.env.DB.prepare(`SELECT s.id,s.name,s.kind,s.lat,s.lng,s.active
    FROM stops s JOIN users actor ON actor.id=? AND actor.school_id=s.school_id AND actor.campus_id=s.campus_id
    ORDER BY s.kind,s.name,s.id LIMIT 100`).bind(result.session.userId).all();
  return c.json({ data: stops.results }, { headers: { 'Cache-Control': 'no-store' } });
});

app.post('/api/v1/admin/stops', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
      return c.json({ error: { code: 'CONFLICT', message: '활성 교문과 목적지를 고르고 중복 노선이 아닌지 확인해 주세요.' }, meta: { requestId: c.get('requestId') } }, 409);
    }
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '노선을 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  return c.json({ data: { id, ...input.data, active: 1 } }, 201);
});

app.patch('/api/v1/admin/routes/:routeId', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
    if (/ROUTE_STOPS_INACTIVE/.test(message)) return c.json({ error: { code: 'CONFLICT', message: '활성 교문과 목적지가 있는 노선만 다시 사용할 수 있습니다.' }, meta: { requestId: c.get('requestId') } }, 409);
    return c.json({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: '노선 상태를 저장하지 못했습니다.' }, meta: { requestId: c.get('requestId') } }, 503);
  }
  return c.json({ data: { id: routeId.data, active: input.data.active ? 1 : 0 } });
});

app.get('/api/v1/trips', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
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
  const rateSubject = await sha256(result.session.userId);
  const windowStart = Math.floor(now / 60_000) * 60_000;
  await c.env.DB.prepare('DELETE FROM rate_limit_buckets WHERE expires_at<=?').bind(now).run();
  const rate = await c.env.DB.prepare(`INSERT INTO rate_limit_buckets
    (subject_hash,operation,window_start,count,expires_at) VALUES(?,'CREATE_REQUEST',?,1,?)
    ON CONFLICT(subject_hash,operation,window_start) DO UPDATE SET count=count+1 WHERE count<5
    RETURNING count`).bind(rateSubject, windowStart, windowStart + 120_000).first<{ count: number }>();
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
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

app.put('/api/v1/me/driver-profile', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await verifyMutation(c, result.token, result.session)) {
    return c.json({ error: { code: 'CSRF_FAILED', message: '요청을 확인할 수 없습니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE consents SET revoked_at=? WHERE user_id=? AND kind=? AND revoked_at IS NULL')
          .bind(now, result.session.userId, input.data.kind),
        c.env.DB.prepare(`DELETE FROM latest_locations WHERE user_id=? OR trip_id IN (
          SELECT trip_id FROM active_user_locks WHERE user_id=? AND role='DRIVER' AND trip_id IS NOT NULL
          UNION SELECT rr.trip_id FROM active_user_locks l JOIN ride_requests rr ON rr.id=l.request_id
            WHERE l.user_id=? AND l.role='RIDER')`)
          .bind(result.session.userId, result.session.userId, result.session.userId),
      ]);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) {
    return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
  const requests = await c.env.DB.prepare(`SELECT v.id,v.user_id AS userId,u.nickname,u.department_status AS departmentStatus,
    u.department_id AS departmentId,v.created_at AS createdAt
    FROM student_verifications v JOIN users u ON u.id=v.user_id
    WHERE v.outcome='PENDING' ORDER BY v.created_at,v.id LIMIT 50`).all();
  return c.json({ data: requests.results }, { headers: { 'Cache-Control': 'no-store' } });
});

app.patch('/api/v1/admin/verification-requests/:verificationId', async (c) => {
  const result = await getSession(c);
  if (!result) return c.json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 401);
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= Date.now()) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= Date.now()) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'STUDENT' || result.session.affiliationStatus !== 'VERIFIED'
    || (result.session.verifiedUntil ?? 0) <= Date.now()) {
    return c.json({ error: { code: 'STUDENT_VERIFICATION_REQUIRED', message: '유효한 학생 확인이 필요합니다.' }, meta: { requestId: c.get('requestId') } }, 403);
  }
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
  if (!await hasRequiredConsents(c.env.DB, c.env, result.session.userId)) return c.json({ error: { code: 'CONSENT_REQUIRED', message: '서비스 이용에 필요한 안내에 동의해 주세요.' }, meta: { requestId: c.get('requestId') } }, 403);
  if (result.session.role !== 'ADMIN') return c.json({ error: { code: 'NOT_FOUND', message: '요청한 자료가 없습니다.' }, meta: { requestId: c.get('requestId') } }, 404);
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
