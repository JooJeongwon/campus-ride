ALTER TABLE oauth_states ADD COLUMN pkce_verifier TEXT NOT NULL DEFAULT '';
ALTER TABLE student_verifications ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX student_verifications_one_pending ON student_verifications(user_id) WHERE outcome = 'PENDING';

CREATE TRIGGER verification_review_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('STUDENT_VERIFICATION_VERIFIED','STUDENT_VERIFICATION_REJECTED')
BEGIN
  SELECT CASE WHEN NEW.resource_type <> 'student_verification'
    OR NOT EXISTS (
      SELECT 1 FROM student_verifications v
      JOIN users actor ON actor.id = NEW.actor_id AND actor.role = 'ADMIN' AND actor.account_status = 'ACTIVE'
      WHERE v.id = NEW.resource_id AND v.outcome = 'PENDING' AND v.user_id <> actor.id
    ) THEN RAISE(ABORT, 'VERIFICATION_REVIEW_FORBIDDEN') END;
  SELECT CASE WHEN NOT json_valid(NEW.safe_metadata_json)
    OR (NEW.event_type = 'STUDENT_VERIFICATION_VERIFIED'
        AND COALESCE(json_extract(NEW.safe_metadata_json, '$.validUntil'), 0) <= NEW.created_at)
    THEN RAISE(ABORT, 'VERIFICATION_REVIEW_INVALID') END;
END;

CREATE TRIGGER verification_review_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type IN ('STUDENT_VERIFICATION_VERIFIED','STUDENT_VERIFICATION_REJECTED')
BEGIN
  UPDATE student_verifications
     SET outcome = CASE NEW.event_type WHEN 'STUDENT_VERIFICATION_VERIFIED' THEN 'VERIFIED' ELSE 'REJECTED' END,
         reviewed_by = NEW.actor_id,
         verified_at = NEW.created_at,
         valid_until = CASE WHEN NEW.event_type = 'STUDENT_VERIFICATION_VERIFIED'
                            THEN json_extract(NEW.safe_metadata_json, '$.validUntil') ELSE NULL END
   WHERE id = NEW.resource_id AND outcome = 'PENDING';
  UPDATE users
     SET affiliation_status = CASE NEW.event_type WHEN 'STUDENT_VERIFICATION_VERIFIED' THEN 'VERIFIED' ELSE 'REJECTED' END,
         verified_until = CASE WHEN NEW.event_type = 'STUDENT_VERIFICATION_VERIFIED'
                               THEN json_extract(NEW.safe_metadata_json, '$.validUntil') ELSE NULL END,
         updated_at = NEW.created_at
   WHERE id = (SELECT user_id FROM student_verifications WHERE id = NEW.resource_id);
END;
