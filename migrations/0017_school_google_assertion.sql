CREATE TRIGGER school_google_assertion_guard
BEFORE INSERT ON student_verifications
WHEN NEW.method='SCHOOL_ASSERTION'
BEGIN
  SELECT CASE WHEN NEW.outcome<>'VERIFIED' OR NEW.verified_at IS NULL OR NEW.valid_until IS NULL
    OR NEW.valid_until<=NEW.verified_at OR NEW.reviewed_by IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id=NEW.user_id AND u.role='STUDENT'
        AND u.account_status='ACTIVE' AND u.email LIKE '%@gachon.ac.kr'
        AND u.department_id IS NEW.department_id
    ) THEN RAISE(ABORT, 'SCHOOL_GOOGLE_ASSERTION_INVALID') END;
END;

CREATE TRIGGER school_google_assertion_apply
AFTER INSERT ON student_verifications
WHEN NEW.method='SCHOOL_ASSERTION'
BEGIN
  INSERT INTO audit_events
    (id,actor_id,event_type,resource_type,resource_id,command_id,safe_metadata_json,created_at)
  SELECT NEW.id||'-expiry',NULL,'STUDENT_ELIGIBILITY_EXPIRED','user',NEW.user_id,NEW.id||'-expiry-command','{}',NEW.verified_at
  FROM users WHERE id=NEW.user_id AND affiliation_status='VERIFIED' AND verified_until<=NEW.verified_at;

  UPDATE student_verifications SET outcome='EXPIRED'
  WHERE user_id=NEW.user_id AND id<>NEW.id AND outcome='PENDING';

  UPDATE users SET affiliation_status='VERIFIED',verified_until=NEW.valid_until,
    last_restriction_event_id=NULL,updated_at=MAX(NEW.verified_at,updated_at+1)
  WHERE id=NEW.user_id AND role='STUDENT' AND account_status='ACTIVE';
END;
