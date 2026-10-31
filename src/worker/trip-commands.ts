import { z } from 'zod';
import { tripSearchCursorSchema } from '../shared/trips';
import type { Bindings } from './env';
import type { AppContext } from './types';

export type TripSummary = {
  id: string; driverNickname: string; routeId: string; originName: string; destinationName: string;
  departureAt: number; expiresAt: number; seatCapacity: number; remainingSeats: number;
  genderFilter: string; preferSameDepartment: number; status: string; version: number; createdAt: number;
};
export const tripReadSql = `SELECT t.id,d.nickname AS driverNickname,t.route_id AS routeId,
  origin.name AS originName,destination.name AS destinationName,t.departure_at AS departureAt,
  t.expires_at AS expiresAt,t.seat_capacity AS seatCapacity,
  t.seat_capacity-(SELECT COUNT(*) FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED')) AS remainingSeats,
  t.gender_filter AS genderFilter,t.prefer_same_department AS preferSameDepartment,
  t.status,t.version,t.created_at AS createdAt
  FROM trips t JOIN users d ON d.id=t.driver_id JOIN routes r ON r.id=t.route_id
  JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id`;
export const TRIP_SEARCH_RAW_LIMIT = 50;
export const TRIP_SEARCH_PAGE_SIZE = 20;

export function encodeTripCursor(cursor: z.infer<typeof tripSearchCursorSchema>) {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeTripCursor(cursor: string) {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    return tripSearchCursorSchema.safeParse(JSON.parse(atob(base64)));
  } catch {
    return null;
  }
}

export async function expireDriverTrip(db: D1Database, userId: string, now: number) {
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

export async function expireRiderRequest(db: D1Database, userId: string, now: number) {
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

export async function expireTripRequests(db: D1Database, tripId: string, now: number) {
  const commandId = crypto.randomUUID();
  await db.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,
      updated_at=MAX(?,updated_at+1),last_command_id=?
    WHERE trip_id=? AND status='REQUESTED' AND expires_at<=?`)
    .bind(now, commandId, tripId, now).run();
}

export async function replayCommand(c: AppContext, userId: string, operation: string, key: string, bodyHash: string, now: number) {
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

export async function boardingCodeHash(env: Bindings, requestId: string, code: string) {
  const secret = env.BOARDING_HMAC_KEY ?? (env.APP_ENV === 'development' ? 'development-only-campus-ride-boarding-key' : '');
  if (secret.length < 32) throw new Error('boarding HMAC key unavailable');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`boarding-code:v1:${requestId}:${code}`)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyBoardingCode(env: Bindings, requestId: string, code: string, storedHash: string) {
  const secret = env.BOARDING_HMAC_KEY ?? (env.APP_ENV === 'development' ? 'development-only-campus-ride-boarding-key' : '');
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(storedHash.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`boarding-code:v1:${requestId}:${code}`));
}

export function newBoardingCode() {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return String(value[0] % 1_000_000).padStart(6, '0');
}
