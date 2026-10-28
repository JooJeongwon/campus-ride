import { studentEligibilityExpiryStatement } from '../restrictions';

const BATCH_LIMIT = 100;
const TRIP_LIMIT = 20;
const SYSTEM_TIMEOUT_MS = 90 * 60_000;
export type CleanupStage = 'EXPIRE_STUDENTS' | 'EXPIRE_REQUESTS' | 'ABORT_TIMED_OUT_TRIPS' | 'EXPIRE_TRIPS' | 'DELETE_EXPIRED_ROWS';

async function deleteExpiredRows(db: D1Database, table: string, key: string, where: string, now: number) {
  const rows = await db.prepare(`SELECT ${key} AS id FROM ${table} WHERE ${where} LIMIT ${BATCH_LIMIT}`)
    .bind(now).all<{ id: string }>();
  if (!rows.results.length) return null;
  const ids = rows.results.map((row) => row.id);
  return db.prepare(`DELETE FROM ${table} WHERE ${key} IN (${ids.map(() => '?').join(',')}) AND ${where}`)
    .bind(...ids, now);
}

async function expireRequests(db: D1Database, now: number) {
  const rows = await db.prepare(`SELECT id FROM ride_requests
    WHERE status='REQUESTED' AND expires_at<=? ORDER BY expires_at,id LIMIT ${BATCH_LIMIT}`)
    .bind(now).all<{ id: string }>();
  if (!rows.results.length) return;
  const ids = rows.results.map((row) => row.id);
  await db.prepare(`UPDATE ride_requests SET status='EXPIRED',version=version+1,
      updated_at=MAX(?,updated_at+1),last_command_id=?,boarding_code_hash=NULL,boarding_code_expires_at=NULL
    WHERE status='REQUESTED' AND expires_at<=? AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(now, crypto.randomUUID(), now, ...ids).run();
}

async function expireTrips(db: D1Database, now: number) {
  const rows = await db.prepare(`SELECT id FROM trips t
    WHERE status='OPEN' AND expires_at<=?
      AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=t.id AND r.status='BOARDED')
    ORDER BY expires_at,id LIMIT ${TRIP_LIMIT}`).bind(now).all<{ id: string }>();
  for (const trip of rows.results) {
    const commandId = crypto.randomUUID();
    await db.batch([
      db.prepare(`UPDATE ride_requests SET status=CASE status WHEN 'REQUESTED' THEN 'EXPIRED' ELSE 'CANCELLED' END,
          version=version+1,updated_at=MAX(?,updated_at+1),last_command_id=?,
          boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status IN ('REQUESTED','ACCEPTED') AND EXISTS (
          SELECT 1 FROM trips t WHERE t.id=ride_requests.trip_id AND t.status='OPEN' AND t.expires_at<=?
            AND NOT EXISTS (SELECT 1 FROM ride_requests b WHERE b.trip_id=t.id AND b.status='BOARDED'))`)
        .bind(now, commandId, trip.id, now),
      db.prepare(`UPDATE trips SET status='EXPIRED',version=version+1,ended_at=MAX(?,updated_at+1),
          updated_at=MAX(?,updated_at+1),last_command_id=?
        WHERE id=? AND status='OPEN' AND expires_at<=?
          AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=trips.id AND r.status IN ('REQUESTED','ACCEPTED','BOARDED'))`)
        .bind(now, now, commandId, trip.id, now),
    ]);
  }
}

async function abortTimedOutTrips(db: D1Database, now: number) {
  const cutoff = now - SYSTEM_TIMEOUT_MS;
  const rows = await db.prepare(`SELECT id,status,version,updated_at AS updatedAt FROM trips t
    WHERE status IN ('OPEN','IN_PROGRESS') AND created_at<=?
      AND EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=t.id AND r.status='BOARDED')
    ORDER BY created_at,id LIMIT ${TRIP_LIMIT}`).bind(cutoff)
    .all<{ id: string; status: 'OPEN' | 'IN_PROGRESS'; version: number; updatedAt: number }>();
  for (const trip of rows.results) {
    const commandId = crypto.randomUUID();
    const updatedAt = Math.max(now, trip.updatedAt + 1);
    await db.batch([
      db.prepare(`UPDATE trips SET last_command_id=? WHERE id=? AND status=? AND version=? AND created_at<=?
        AND EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=trips.id AND r.status='BOARDED')`)
        .bind(commandId, trip.id, trip.status, trip.version, cutoff),
      db.prepare(`UPDATE ride_requests SET status=CASE status
          WHEN 'REQUESTED' THEN 'EXPIRED' WHEN 'ACCEPTED' THEN 'CANCELLED' ELSE 'ABORTED' END,
          version=version+1,updated_at=MAX(?,updated_at+1),last_command_id=?,
          boarding_code_hash=NULL,boarding_code_expires_at=NULL
        WHERE trip_id=? AND status IN ('REQUESTED','ACCEPTED','BOARDED') AND EXISTS (
          SELECT 1 FROM trips t WHERE t.id=ride_requests.trip_id AND t.status=? AND t.version=?
            AND t.last_command_id=? AND t.created_at<=?)`)
        .bind(updatedAt, commandId, trip.id, trip.status, trip.version, commandId, cutoff),
      db.prepare(`UPDATE trips SET status='ABORTED',version=version+1,ended_at=?,updated_at=?
        WHERE id=? AND status=? AND version=? AND last_command_id=?
          AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=trips.id AND r.status IN ('REQUESTED','ACCEPTED','BOARDED'))`)
        .bind(updatedAt, updatedAt, trip.id, trip.status, trip.version, commandId),
      db.prepare(`INSERT INTO audit_events (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
        SELECT ?,NULL,'TRIP_ABORTED','trip',id,?,'{"reasonCode":"SYSTEM_TIMEOUT"}',?
        FROM trips WHERE id=? AND status='ABORTED' AND version=? AND last_command_id=?`)
        .bind(crypto.randomUUID(), commandId, updatedAt, trip.id, trip.version + 1, commandId),
    ]);
  }
}

async function expireStudents(db: D1Database, now: number) {
  const users = await db.prepare(`SELECT id FROM users WHERE role='STUDENT' AND account_status='ACTIVE'
    AND affiliation_status='VERIFIED' AND verified_until<=? ORDER BY verified_until,id LIMIT ${BATCH_LIMIT}`)
    .bind(now).all<{ id: string }>();
  if (users.results.length) {
    await db.batch(users.results.map(({ id }) => studentEligibilityExpiryStatement(db, id, now)));
  }
}

export async function cleanupExpiredData(db: D1Database, now = Date.now(), onStage: (stage: CleanupStage) => void = () => {}) {
  onStage('EXPIRE_STUDENTS');
  await expireStudents(db, now);
  onStage('EXPIRE_REQUESTS');
  await expireRequests(db, now);
  onStage('ABORT_TIMED_OUT_TRIPS');
  await abortTimedOutTrips(db, now);
  onStage('EXPIRE_TRIPS');
  await expireTrips(db, now);
  onStage('DELETE_EXPIRED_ROWS');
  const expired = await Promise.all([
    deleteExpiredRows(db, 'latest_locations', 'user_id', 'expires_at<=?', now),
    deleteExpiredRows(db, 'location_disclosure_records', 'id', 'provided_at<=?', sixCalendarMonthsBefore(now)),
    deleteExpiredRows(db, 'sessions', 'token_hash', '(expires_at<=? OR revoked_at IS NOT NULL)', now),
    deleteExpiredRows(db, 'oauth_states', 'state_hash', '(expires_at<=? OR consumed_at IS NOT NULL)', now),
    deleteExpiredRows(db, 'idempotency_keys', 'rowid', 'expires_at<=?', now),
    deleteExpiredRows(db, 'rate_limit_buckets', 'rowid', 'expires_at<=?', now),
  ]);
  const statements = expired.filter((statement): statement is D1PreparedStatement => statement !== null);
  if (statements.length) await db.batch(statements);
}

function sixCalendarMonthsBefore(timestamp: number) {
  const cutoff = new Date(timestamp);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff.getTime();
}

export async function runScheduledCleanup(db: D1Database, scheduledTime: number) {
  const startedAt = Date.now();
  const scheduledDelayMs = Math.max(0, startedAt - scheduledTime);
  let firstFailureStage: CleanupStage | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let stage: CleanupStage = 'EXPIRE_STUDENTS';
    try {
      // Every phase is bounded and conditional, so one full rerun is safe after an ambiguous D1 failure.
      await cleanupExpiredData(db, Date.now(), (currentStage) => { stage = currentStage; });
      const result = {
        event: 'scheduled_cleanup',
        outcome: firstFailureStage ? 'RECOVERED' : 'SUCCEEDED',
        attempts: attempt,
        scheduledDelayMs,
        durationMs: Date.now() - startedAt,
        ...(firstFailureStage ? { firstFailureStage } : {}),
      } as const;
      console.log(result);
      return result;
    } catch {
      if (attempt === 1) {
        firstFailureStage = stage;
        continue;
      }
      console.error({
        event: 'scheduled_cleanup',
        outcome: 'FAILED',
        attempts: attempt,
        scheduledDelayMs,
        durationMs: Date.now() - startedAt,
        firstFailureStage,
        failureStage: stage,
      });
      throw new Error('scheduled cleanup failed');
    }
  }
  throw new Error('scheduled cleanup failed');
}
