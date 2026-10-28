CREATE VIEW deleted_user_restrictions AS
SELECT a.id AS event_id,a.command_id,a.resource_id AS user_id,a.created_at
FROM audit_events a JOIN users u ON u.id=a.resource_id AND u.last_restriction_event_id=a.id
WHERE a.event_type='USER_DELETED';

CREATE VIEW deleted_trips_to_abort AS
SELECT r.event_id,r.user_id,t.id AS trip_id
FROM deleted_user_restrictions r JOIN trips t ON t.last_command_id=r.event_id
WHERE t.status IN ('OPEN','IN_PROGRESS');

CREATE VIEW deleted_driver_trips_to_cancel AS
SELECT r.event_id,r.user_id,t.id AS trip_id
FROM deleted_user_restrictions r JOIN trips t ON t.last_command_id=r.command_id
WHERE t.status='OPEN' AND t.driver_id=r.user_id;

CREATE VIEW deleted_requests_to_end AS
SELECT r.event_id,r.command_id,r.user_id,rr.id AS request_id,t.id AS trip_id,t.last_command_id
FROM deleted_user_restrictions r
JOIN trips t ON t.status IN ('OPEN','IN_PROGRESS')
JOIN ride_requests rr ON rr.trip_id=t.id AND rr.status IN ('REQUESTED','ACCEPTED','BOARDED')
WHERE t.last_command_id=r.event_id
   OR (t.last_command_id=r.command_id AND (t.driver_id=r.user_id OR rr.rider_id=r.user_id));

CREATE TRIGGER user_deletion_event_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type='USER_DELETED'
BEGIN
  SELECT CASE WHEN NEW.resource_type<>'user' OR NEW.actor_id<>NEW.resource_id
      OR NEW.command_id IS NULL OR NEW.command_id=NEW.id OR NEW.safe_metadata_json<>'{}'
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.resource_id AND account_status='ACTIVE')
    THEN RAISE(ABORT,'USER_DELETION_FORBIDDEN') END;
END;

CREATE TRIGGER user_deletion_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_DELETED'
BEGIN
  UPDATE users SET account_status='DELETED',google_sub='deleted:'||id,
      email='deleted+'||id||'@example.invalid',nickname='탈퇴한 사용자',gender='UNDISCLOSED',
      department_id=NULL,department_status='UNKNOWN',department_source=NULL,parser_version=NULL,
      affiliation_status='REJECTED',verified_until=NULL,last_restriction_event_id=NEW.id,updated_at=NEW.created_at
    WHERE id=NEW.resource_id;

  DELETE FROM student_verifications WHERE user_id=NEW.resource_id;
  DELETE FROM sessions WHERE user_id=NEW.resource_id;
  DELETE FROM idempotency_keys WHERE user_id=NEW.resource_id;
  UPDATE consents SET revoked_at=NEW.created_at WHERE user_id=NEW.resource_id AND revoked_at IS NULL;
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
        (SELECT created_at FROM deleted_user_restrictions WHERE event_id=NEW.id),updated_at+1
      ),last_command_id=(SELECT last_command_id FROM deleted_requests_to_end WHERE request_id=ride_requests.id),
      boarding_code_hash=NULL,boarding_code_expires_at=NULL
    WHERE id IN (SELECT request_id FROM deleted_requests_to_end WHERE event_id=NEW.id);

  UPDATE trips SET status=CASE WHEN last_command_id=NEW.id THEN 'ABORTED' ELSE 'CANCELLED' END,
      ended_at=MAX(NEW.created_at,updated_at+1),updated_at=MAX(NEW.created_at,updated_at+1),version=version+1
    WHERE id IN (SELECT trip_id FROM deleted_trips_to_abort WHERE event_id=NEW.id
      UNION SELECT trip_id FROM deleted_driver_trips_to_cancel WHERE event_id=NEW.id);

  UPDATE driver_profiles SET vehicle_model='삭제됨',vehicle_color='삭제됨',vehicle_identifier='삭제됨',
      passenger_capacity=1,verification_status='REJECTED',verified_until=NULL,checked_at=NULL
    WHERE user_id=NEW.resource_id;
END;

CREATE TRIGGER user_deletion_status_guard
BEFORE UPDATE OF account_status ON users
WHEN NEW.account_status='DELETED' AND OLD.account_status<>'DELETED'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM audit_events e WHERE e.id=NEW.last_restriction_event_id AND e.event_type='USER_DELETED'
      AND e.resource_type='user' AND e.resource_id=NEW.id AND e.actor_id=NEW.id AND e.safe_metadata_json='{}'
  ) THEN RAISE(ABORT,'USER_DELETION_AUDIT_REQUIRED') END;
END;
