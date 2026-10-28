export function studentEligibilityExpiryStatement(db: D1Database, userId: string, now: number) {
  return db.prepare(`INSERT INTO audit_events
    (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
    SELECT ?,NULL,'STUDENT_ELIGIBILITY_EXPIRED','user',?,?, '{}',?
    FROM users WHERE id=? AND role='STUDENT' AND account_status='ACTIVE'
      AND affiliation_status='VERIFIED' AND verified_until<=?`)
    .bind(crypto.randomUUID(), userId, crypto.randomUUID(), now, userId, now);
}

export async function expireStudentEligibility(db: D1Database, userId: string, now: number) {
  await studentEligibilityExpiryStatement(db, userId, now).run();
}
