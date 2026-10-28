import { studentEligibilityExpiryStatement } from '../restrictions';

const BATCH_LIMIT = 100;
const TRIP_LIMIT = 20;
const SYSTEM_TIMEOUT_MS = 90 * 60_000;
const DAY_MS = 86_400_000;
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

async function deleteClosedReports(db: D1Database, cutoff: number) {
  const rows = await db.prepare(`SELECT id FROM reports WHERE status IN ('RESOLVED','DISMISSED')
    AND resolved_at<=? ORDER BY resolved_at,id LIMIT ${BATCH_LIMIT}`)
    .bind(cutoff).all<{ id: string }>();
  if (!rows.results.length) return;
  const ids = rows.results.map(({ id }) => id);
  const marks = ids.map(() => '?').join(',');
  await db.batch([
    db.prepare(`DELETE FROM audit_events WHERE resource_type='report' AND resource_id IN (${marks})`).bind(...ids),
    db.prepare(`DELETE FROM reports WHERE id IN (${marks}) AND resolved_at<=?`).bind(...ids, cutoff),
  ]);
}

async function deleteClosedRequests(db: D1Database, cutoff: number) {
  const rows = await db.prepare(`SELECT rr.id FROM ride_requests rr
    WHERE rr.status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED') AND rr.updated_at<=?
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.request_id=rr.id)
    ORDER BY rr.updated_at,rr.id LIMIT ${BATCH_LIMIT}`)
    .bind(cutoff).all<{ id: string }>();
  if (!rows.results.length) return;
  const ids = rows.results.map(({ id }) => id);
  await db.prepare(`DELETE FROM ride_requests WHERE id IN (${ids.map(() => '?').join(',')}) AND updated_at<=?
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.request_id=ride_requests.id)`)
    .bind(...ids, cutoff).run();
}

async function deleteClosedTrips(db: D1Database, cutoff: number) {
  const rows = await db.prepare(`SELECT t.id FROM trips t
    WHERE t.status IN ('COMPLETED','CANCELLED','EXPIRED','ABORTED') AND t.ended_at<=?
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.trip_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM ride_requests rr WHERE rr.trip_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM active_user_locks l WHERE l.trip_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM latest_locations l WHERE l.trip_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM location_notice_presence p WHERE p.trip_id=t.id)
    ORDER BY t.ended_at,t.id LIMIT ${BATCH_LIMIT}`)
    .bind(cutoff).all<{ id: string }>();
  if (!rows.results.length) return;
  const ids = rows.results.map(({ id }) => id);
  await db.prepare(`DELETE FROM trips WHERE id IN (${ids.map(() => '?').join(',')}) AND ended_at<=?
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.trip_id=trips.id)
    AND NOT EXISTS (SELECT 1 FROM ride_requests rr WHERE rr.trip_id=trips.id)
    AND NOT EXISTS (SELECT 1 FROM active_user_locks l WHERE l.trip_id=trips.id)
    AND NOT EXISTS (SELECT 1 FROM location_notice_presence p WHERE p.trip_id=trips.id)`)
    .bind(...ids, cutoff).run();
}

async function deleteExpiredAuditEvents(db: D1Database, cutoff: number) {
  const retained = `created_at<=? AND NOT EXISTS (SELECT 1 FROM users u WHERE u.last_restriction_event_id=audit_events.id)
    AND NOT EXISTS (SELECT 1 FROM stops s WHERE s.last_admin_event_id=audit_events.id)
    AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.last_admin_event_id=audit_events.id)
    AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.last_event_id=audit_events.id)
    AND NOT (resource_type='report' AND EXISTS (SELECT 1 FROM reports r WHERE r.id=audit_events.resource_id))`;
  const rows = await db.prepare(`SELECT id FROM audit_events WHERE ${retained} ORDER BY created_at,id LIMIT ${BATCH_LIMIT}`)
    .bind(cutoff).all<{ id: string }>();
  if (!rows.results.length) return;
  await db.prepare(`DELETE FROM audit_events WHERE id IN (${rows.results.map(() => '?').join(',')}) AND ${retained}`)
    .bind(...rows.results.map(({ id }) => id), cutoff).run();
}

async function deleteExpiredAccountTombstones(db: D1Database, cutoff: number) {
  const rows = await db.prepare(`SELECT u.id FROM users u JOIN audit_events d
      ON d.id=u.last_restriction_event_id AND d.event_type='USER_DELETED' AND d.created_at<=?
    WHERE u.account_status='DELETED'
      AND NOT EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM student_verifications v WHERE v.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id=u.id OR b.blocked_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM ride_requests rr WHERE rr.rider_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.reporter_id=u.id OR r.reported_user_id=u.id OR r.assigned_to=u.id)
      AND NOT EXISTS (SELECT 1 FROM latest_locations l WHERE l.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM location_disclosure_records d WHERE d.owner_user_id=u.id OR d.recipient_user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM location_access_records a WHERE a.user_id=u.id)
      AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.actor_id=u.id AND (
        EXISTS (SELECT 1 FROM stops s WHERE s.last_admin_event_id=a.id)
        OR EXISTS (SELECT 1 FROM routes r WHERE r.last_admin_event_id=a.id)
        OR EXISTS (SELECT 1 FROM user_blocks b WHERE b.last_event_id=a.id)))
      AND NOT EXISTS (SELECT 1 FROM driver_profiles p JOIN trips t ON t.driver_id=p.user_id WHERE p.user_id=u.id)
    ORDER BY u.id LIMIT ${BATCH_LIMIT}`)
    .bind(cutoff).all<{ id: string }>();
  for (const { id } of rows.results) {
    await db.batch([
      db.prepare('DELETE FROM audit_events WHERE actor_id=? OR resource_id=?').bind(id, id),
      db.prepare('DELETE FROM driver_profiles WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM trips WHERE driver_id=?)').bind(id, id),
      db.prepare(`DELETE FROM users WHERE id=? AND account_status='DELETED'
        AND NOT EXISTS (SELECT 1 FROM reports WHERE reporter_id=? OR reported_user_id=? OR assigned_to=?)
        AND NOT EXISTS (SELECT 1 FROM trips WHERE driver_id=?)
        AND NOT EXISTS (SELECT 1 FROM ride_requests WHERE rider_id=?)`)
        .bind(id, id, id, id, id, id),
    ]);
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
  const oneYearAgo = oneCalendarYearBefore(now);
  const rideCutoff = now - 180 * DAY_MS;
  const expired = await Promise.all([
    deleteExpiredRows(db, 'latest_locations', 'user_id', 'expires_at<=?', now),
    deleteExpiredRows(db, 'location_notice_presence', 'user_id', 'expires_at<=?', now),
    deleteExpiredRows(db, 'location_disclosure_records', 'id', 'COALESCE(position_delivered_at,requested_at,provided_at)<=?', sixCalendarMonthsBefore(now)),
    deleteExpiredRows(db, 'location_access_records', 'id', 'accessed_at<=?', oneYearAgo),
    deleteExpiredRows(db, 'consents', 'id', 'revoked_at IS NOT NULL AND revoked_at<=?', oneYearAgo),
    deleteExpiredRows(db, 'sessions', 'token_hash', '(expires_at<=? OR revoked_at IS NOT NULL)', now),
    deleteExpiredRows(db, 'oauth_states', 'state_hash', '(expires_at<=? OR consumed_at IS NOT NULL)', now),
    deleteExpiredRows(db, 'idempotency_keys', 'rowid', 'expires_at<=?', now),
    deleteExpiredRows(db, 'rate_limit_buckets', 'rowid', 'expires_at<=?', now),
  ]);
  const statements = expired.filter((statement): statement is D1PreparedStatement => statement !== null);
  if (statements.length) await db.batch(statements);
  await deleteClosedReports(db, oneYearAgo);
  await deleteClosedRequests(db, rideCutoff);
  await deleteClosedTrips(db, rideCutoff);
  await deleteExpiredAuditEvents(db, oneYearAgo);
  await deleteExpiredAccountTombstones(db, oneYearAgo);
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

function oneCalendarYearBefore(timestamp: number) {
  const cutoff = new Date(timestamp);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
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
