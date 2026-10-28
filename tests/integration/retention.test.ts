import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { cleanupExpiredData } from '../../src/worker/jobs/cleanup';

const ownerId = '20000000-0000-4000-8000-000000000001';
const recipientId = '20000000-0000-4000-8000-000000000002';
const day = 86_400_000;

it('applies location, consent, audit, and deleted-account retention cutoffs', async () => {
  const now = Date.now();
  const oldDisclosureId = crypto.randomUUID();
  const recentDisclosureId = crypto.randomUUID();
  const oldAccessId = crypto.randomUUID();
  const recentAccessId = crypto.randomUUID();
  const oldConsentId = crypto.randomUUID();
  const recentConsentId = crypto.randomUUID();
  const oldAuditId = crypto.randomUUID();
  const recentAuditId = crypto.randomUUID();
  const oldUserId = crypto.randomUUID();
  const recentUserId = crypto.randomUUID();
  const oldDeleteEventId = crypto.randomUUID();
  const recentDeleteEventId = crypto.randomUUID();
  const archivedDriverId = crypto.randomUUID();
  const archivedTripId = crypto.randomUUID();

  const addDeletedUser = async (id: string, eventId: string, createdAt: number) => {
    await env.DB.prepare(`INSERT INTO users
      (id,google_sub,school_id,campus_id,email,nickname,gender,affiliation_status,created_at,updated_at)
      VALUES(?,?,'synthetic-school','synthetic-campus',?,'Retention test','UNDISCLOSED','PENDING',?,?)`)
      .bind(id, `retention-${id}`, `${id}@retention.example.invalid`, createdAt, createdAt).run();
    await env.DB.prepare(`INSERT INTO audit_events
      (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
      VALUES(?,?,'USER_DELETED','user',?,?,'{}',?)`)
      .bind(eventId, id, id, crypto.randomUUID(), createdAt).run();
  };

  try {
    for (const [id, owner, recipient, tripId, sequence, providedAt] of [
      [oldDisclosureId, ownerId, recipientId, crypto.randomUUID(), 1, now - 200 * day],
      [recentDisclosureId, ownerId, recipientId, crypto.randomUUID(), 1, now - 100 * day],
    ] as const) {
      await env.DB.prepare(`INSERT INTO location_disclosure_records
        (id,owner_user_id,recipient_user_id,recipient_nickname,recipient_role,trip_id,request_id,sequence,purpose,provided_at)
        VALUES(?,?,?,'Synthetic recipient','RIDER',?,NULL,?,'MEETING',?)`)
        .bind(id, owner, recipient, tripId, sequence, providedAt).run();
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO location_access_records
        (id,user_id,location_owner_user_id,action,trip_id,request_id,accessed_at)
        VALUES(?,?,?,'OWNER_READ',?,NULL,?)`).bind(oldAccessId, ownerId, ownerId, crypto.randomUUID(), now - 400 * day),
      env.DB.prepare(`INSERT INTO location_access_records
        (id,user_id,location_owner_user_id,action,trip_id,request_id,accessed_at)
        VALUES(?,?,?,'OWNER_READ',?,NULL,?)`).bind(recentAccessId, ownerId, ownerId, crypto.randomUUID(), now - 300 * day),
      env.DB.prepare(`INSERT INTO consents (id,user_id,kind,policy_version,granted_at,revoked_at)
        VALUES(?,?,'LOCATION_SHARING','retention-test',?,?)`).bind(oldConsentId, ownerId, now - 401 * day, now - 400 * day),
      env.DB.prepare(`INSERT INTO consents (id,user_id,kind,policy_version,granted_at,revoked_at)
        VALUES(?,?,'LOCATION_SHARING','retention-test',?,?)`).bind(recentConsentId, ownerId, now - 301 * day, now - 300 * day),
      env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'RETENTION_TEST','test','old','{}',?)`).bind(oldAuditId, ownerId, now - 400 * day),
      env.DB.prepare(`INSERT INTO audit_events
        (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
        VALUES(?,?,'RETENTION_TEST','test','recent','{}',?)`).bind(recentAuditId, ownerId, now - 300 * day),
    ]);
    await addDeletedUser(oldUserId, oldDeleteEventId, now - 400 * day);
    await addDeletedUser(recentUserId, recentDeleteEventId, now - 300 * day);
    const oldActivityAt = now - 200 * day;
    await env.DB.prepare(`INSERT INTO users
      (id,google_sub,school_id,campus_id,email,nickname,gender,affiliation_status,verified_until,created_at,updated_at)
      VALUES(?,?,'synthetic-school','synthetic-campus',?,'Archived activity','UNDISCLOSED','VERIFIED',?,?,?)`)
      .bind(archivedDriverId, `retention-trip-${archivedDriverId}`, `${archivedDriverId}@retention.example.invalid`,
        now + day, oldActivityAt, oldActivityAt).run();
    await env.DB.prepare(`INSERT INTO driver_profiles
      (user_id,vehicle_model,vehicle_color,vehicle_identifier,passenger_capacity,verification_status,verified_until,checked_at)
      VALUES(?,'Retention test','Gray','RETENTION',1,'VERIFIED',?,?)`)
      .bind(archivedDriverId, now + day, oldActivityAt).run();
    const departureAt = oldActivityAt + 600_000;
    await env.DB.prepare(`INSERT INTO trips
      (id,driver_id,route_id,departure_at,expires_at,seat_capacity,gender_snapshot,gender_filter,
       department_verified_snapshot,prefer_same_department,created_at)
      VALUES(?,?, '40000000-0000-4000-8000-000000000001',?,?,?,?, 'ANY',0,0,?)`)
      .bind(archivedTripId, archivedDriverId, departureAt, departureAt + 900_000, 1, 'UNDISCLOSED', oldActivityAt).run();
    await env.DB.prepare(`UPDATE trips SET status='CANCELLED',version=version+1,last_command_id=?,ended_at=?,updated_at=? WHERE id=?`)
      .bind(crypto.randomUUID(), now, now, archivedTripId).run();
    await env.DB.prepare('UPDATE trips SET ended_at=?,updated_at=? WHERE id=?')
      .bind(oldActivityAt, oldActivityAt, archivedTripId).run();

    await cleanupExpiredData(env.DB, now);

    expect(await env.DB.prepare('SELECT id FROM location_disclosure_records WHERE id=?').bind(oldDisclosureId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM location_disclosure_records WHERE id=?').bind(recentDisclosureId).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM location_access_records WHERE id=?').bind(oldAccessId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM location_access_records WHERE id=?').bind(recentAccessId).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM consents WHERE id=?').bind(oldConsentId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM consents WHERE id=?').bind(recentConsentId).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(oldAuditId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(recentAuditId).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(oldUserId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(recentUserId).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM trips WHERE id=?').bind(archivedTripId).first()).toBeNull();
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM location_disclosure_records WHERE id IN (?,?)').bind(oldDisclosureId, recentDisclosureId),
      env.DB.prepare('DELETE FROM location_access_records WHERE id IN (?,?)').bind(oldAccessId, recentAccessId),
      env.DB.prepare('DELETE FROM consents WHERE id IN (?,?)').bind(oldConsentId, recentConsentId),
      env.DB.prepare('DELETE FROM audit_events WHERE id IN (?,?,?,?)').bind(oldAuditId, recentAuditId, oldDeleteEventId, recentDeleteEventId),
      env.DB.prepare('DELETE FROM trips WHERE id=?').bind(archivedTripId),
      env.DB.prepare('DELETE FROM driver_profiles WHERE user_id=?').bind(archivedDriverId),
      env.DB.prepare('DELETE FROM audit_events WHERE actor_id=?').bind(archivedDriverId),
      env.DB.prepare('DELETE FROM users WHERE id=?').bind(archivedDriverId),
      env.DB.prepare('DELETE FROM users WHERE id IN (?,?)').bind(oldUserId, recentUserId),
    ]);
  }
});
