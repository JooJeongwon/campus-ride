CREATE TRIGGER driver_profile_review_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('DRIVER_PROFILE_VERIFIED','DRIVER_PROFILE_REJECTED')
BEGIN
  SELECT CASE WHEN NEW.resource_type <> 'driver_profile'
    OR NOT EXISTS (
      SELECT 1 FROM driver_profiles p
      JOIN users actor ON actor.id = NEW.actor_id AND actor.role = 'ADMIN' AND actor.account_status = 'ACTIVE'
      WHERE p.user_id = NEW.resource_id AND p.verification_status = 'PENDING' AND p.user_id <> actor.id
    ) THEN RAISE(ABORT, 'DRIVER_PROFILE_REVIEW_FORBIDDEN') END;
  SELECT CASE WHEN NOT json_valid(NEW.safe_metadata_json)
    OR (NEW.event_type = 'DRIVER_PROFILE_VERIFIED'
        AND COALESCE(json_extract(NEW.safe_metadata_json, '$.validUntil'), 0) <= NEW.created_at)
    THEN RAISE(ABORT, 'DRIVER_PROFILE_REVIEW_INVALID') END;
END;

CREATE TRIGGER driver_profile_review_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type IN ('DRIVER_PROFILE_VERIFIED','DRIVER_PROFILE_REJECTED')
BEGIN
  UPDATE driver_profiles
     SET verification_status = CASE NEW.event_type WHEN 'DRIVER_PROFILE_VERIFIED' THEN 'VERIFIED' ELSE 'REJECTED' END,
         verified_until = CASE WHEN NEW.event_type = 'DRIVER_PROFILE_VERIFIED'
                               THEN json_extract(NEW.safe_metadata_json, '$.validUntil') ELSE NULL END,
         checked_at = NEW.created_at
   WHERE user_id = NEW.resource_id AND verification_status = 'PENDING';
END;
