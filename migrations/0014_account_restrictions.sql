ALTER TABLE users ADD COLUMN last_restriction_event_id TEXT;

CREATE VIEW current_user_restrictions AS
SELECT a.id AS event_id,a.command_id,a.resource_id AS user_id,a.created_at
FROM audit_events a JOIN users u ON u.id=a.resource_id AND u.last_restriction_event_id=a.id
WHERE a.event_type IN ('USER_SUSPENDED','STUDENT_ELIGIBILITY_EXPIRED');

CREATE VIEW restricted_trips_to_abort AS
SELECT r.event_id,r.user_id,t.id AS trip_id
FROM current_user_restrictions r JOIN trips t ON t.last_command_id=r.event_id
WHERE t.status IN ('OPEN','IN_PROGRESS');

CREATE VIEW restricted_driver_trips_to_cancel AS
SELECT r.event_id,r.user_id,t.id AS trip_id
FROM current_user_restrictions r JOIN trips t ON t.last_command_id=r.command_id
WHERE t.status='OPEN' AND t.driver_id=r.user_id;

CREATE VIEW restricted_requests_to_end AS
SELECT r.event_id,r.command_id,r.user_id,rr.id AS request_id,t.id AS trip_id,t.last_command_id
FROM current_user_restrictions r
JOIN trips t ON t.status IN ('OPEN','IN_PROGRESS')
JOIN ride_requests rr ON rr.trip_id=t.id AND rr.status IN ('REQUESTED','ACCEPTED','BOARDED')
WHERE t.last_command_id=r.event_id
   OR (t.last_command_id=r.command_id AND (t.driver_id=r.user_id OR rr.rider_id=r.user_id));

CREATE TRIGGER user_restriction_event_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('USER_SUSPENDED','STUDENT_ELIGIBILITY_EXPIRED')
BEGIN
  SELECT CASE WHEN NEW.resource_type<>'user' OR NEW.command_id IS NULL OR NEW.command_id=NEW.id
    OR NOT json_valid(NEW.safe_metadata_json)
    THEN RAISE(ABORT, 'USER_RESTRICTION_EVENT_INVALID') END;
  SELECT CASE WHEN NEW.event_type='USER_SUSPENDED' AND (
      NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='ADMIN' AND account_status='ACTIVE')
      OR NEW.actor_id=NEW.resource_id
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.resource_id AND role='STUDENT' AND account_status='ACTIVE')
      OR length(trim(COALESCE(json_extract(NEW.safe_metadata_json,'$.reason'),''))) NOT BETWEEN 1 AND 500
    ) THEN RAISE(ABORT, 'USER_SUSPEND_FORBIDDEN') END;
  SELECT CASE WHEN NEW.event_type='STUDENT_ELIGIBILITY_EXPIRED' AND (
      NEW.actor_id IS NOT NULL OR NEW.safe_metadata_json<>'{}'
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.resource_id AND role='STUDENT'
        AND account_status='ACTIVE' AND affiliation_status='VERIFIED' AND verified_until<=NEW.created_at)
    ) THEN RAISE(ABORT, 'STUDENT_EXPIRY_FORBIDDEN') END;
END;

CREATE TRIGGER user_restriction_event_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type IN ('USER_SUSPENDED','STUDENT_ELIGIBILITY_EXPIRED')
BEGIN
  UPDATE users SET
    account_status=CASE WHEN NEW.event_type='USER_SUSPENDED' THEN 'SUSPENDED' ELSE account_status END,
    affiliation_status=CASE WHEN NEW.event_type='STUDENT_ELIGIBILITY_EXPIRED' THEN 'EXPIRED' ELSE affiliation_status END,
    last_restriction_event_id=NEW.id,
    updated_at=NEW.created_at
  WHERE id=NEW.resource_id;

  UPDATE student_verifications SET outcome='EXPIRED'
  WHERE user_id=NEW.resource_id AND outcome='VERIFIED' AND valid_until<=NEW.created_at;

  UPDATE sessions SET revoked_at=COALESCE(revoked_at,NEW.created_at) WHERE user_id=NEW.resource_id;
  DELETE FROM latest_locations WHERE user_id=NEW.resource_id;

  UPDATE trips SET last_command_id=CASE
      WHEN status='IN_PROGRESS' OR EXISTS (
        SELECT 1 FROM ride_requests rr WHERE rr.trip_id=trips.id AND rr.status='BOARDED'
      ) THEN NEW.id ELSE NEW.command_id END
  WHERE status IN ('OPEN','IN_PROGRESS') AND (
      driver_id=NEW.resource_id
      OR EXISTS (SELECT 1 FROM ride_requests rr WHERE rr.trip_id=trips.id AND rr.rider_id=NEW.resource_id
        AND rr.status IN ('REQUESTED','ACCEPTED','BOARDED'))
    );

  UPDATE ride_requests SET status=CASE WHEN status='BOARDED' THEN 'ABORTED' ELSE 'CANCELLED' END,
      version=version+1,updated_at=MAX(
        (SELECT created_at FROM current_user_restrictions WHERE event_id=NEW.id),updated_at+1
      ),last_command_id=(SELECT last_command_id FROM restricted_requests_to_end WHERE request_id=ride_requests.id),
      boarding_code_hash=NULL,boarding_code_expires_at=NULL
  WHERE id IN (SELECT request_id FROM restricted_requests_to_end WHERE event_id=NEW.id);

  UPDATE trips SET status=CASE WHEN last_command_id=NEW.id THEN 'ABORTED' ELSE 'CANCELLED' END,
      ended_at=MAX(NEW.created_at,updated_at+1),updated_at=MAX(NEW.created_at,updated_at+1),version=version+1
  WHERE id IN (SELECT trip_id FROM restricted_trips_to_abort WHERE event_id=NEW.id
      UNION SELECT trip_id FROM restricted_driver_trips_to_cancel WHERE event_id=NEW.id);
END;

CREATE TRIGGER user_restriction_reset_on_reverification
AFTER INSERT ON audit_events
WHEN NEW.event_type='STUDENT_VERIFICATION_VERIFIED'
BEGIN
  UPDATE users SET last_restriction_event_id=NULL
  WHERE id=(SELECT user_id FROM student_verifications WHERE id=NEW.resource_id);
END;
