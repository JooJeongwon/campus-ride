ALTER TABLE user_blocks ADD COLUMN last_event_id TEXT;

CREATE VIEW block_trip_terminations AS
SELECT b.blocker_id,b.blocked_id,t.id AS trip_id
FROM user_blocks b JOIN trips t ON t.status IN ('OPEN','IN_PROGRESS')
WHERE (
    (t.driver_id=b.blocker_id AND EXISTS (
      SELECT 1 FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.rider_id=b.blocked_id
        AND rr.status IN ('REQUESTED','ACCEPTED','BOARDED')
    ))
    OR (t.driver_id=b.blocked_id AND EXISTS (
      SELECT 1 FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.rider_id=b.blocker_id
        AND rr.status IN ('REQUESTED','ACCEPTED','BOARDED')
    ))
    OR (EXISTS (
      SELECT 1 FROM ride_requests a JOIN ride_requests d ON d.trip_id=a.trip_id
      WHERE a.trip_id=t.id AND a.rider_id=b.blocker_id AND d.rider_id=b.blocked_id
        AND a.status IN ('ACCEPTED','BOARDED') AND d.status IN ('ACCEPTED','BOARDED')
        AND (t.status='IN_PROGRESS' OR a.status='BOARDED' OR d.status='BOARDED')
    ))
  );

CREATE VIEW block_affected_requests AS
SELECT DISTINCT b.blocker_id,b.blocked_id,rr.id AS request_id,rr.trip_id
FROM user_blocks b JOIN ride_requests rr ON rr.status IN ('REQUESTED','ACCEPTED','BOARDED')
WHERE EXISTS (
    SELECT 1 FROM block_trip_terminations bt
    WHERE bt.blocker_id=b.blocker_id AND bt.blocked_id=b.blocked_id AND bt.trip_id=rr.trip_id
  )
  OR (
    rr.rider_id IN (b.blocker_id,b.blocked_id)
    AND EXISTS (
      SELECT 1 FROM ride_requests peer
      WHERE peer.trip_id=rr.trip_id AND peer.status IN ('REQUESTED','ACCEPTED','BOARDED')
        AND peer.rider_id=CASE WHEN rr.rider_id=b.blocker_id THEN b.blocked_id ELSE b.blocker_id END
    )
  );

CREATE VIEW block_trips_to_end AS
SELECT b.blocker_id,b.blocked_id,t.id AS trip_id
FROM user_blocks b JOIN trips t ON t.last_command_id=b.last_event_id AND t.status IN ('OPEN','IN_PROGRESS')
WHERE EXISTS (
    SELECT 1 FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.last_command_id=b.last_event_id
      AND rr.status IN ('CANCELLED','ABORTED')
      AND ((t.driver_id=b.blocker_id AND rr.rider_id=b.blocked_id)
        OR (t.driver_id=b.blocked_id AND rr.rider_id=b.blocker_id))
  )
  OR EXISTS (
    SELECT 1 FROM ride_requests a JOIN ride_requests d ON d.trip_id=a.trip_id
    WHERE a.trip_id=t.id AND a.rider_id=b.blocker_id AND d.rider_id=b.blocked_id
      AND a.last_command_id=b.last_event_id AND d.last_command_id=b.last_event_id
      AND (t.status='IN_PROGRESS' OR a.status='ABORTED' OR d.status='ABORTED')
  );

CREATE TRIGGER user_block_event_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('USER_BLOCKED','USER_UNBLOCKED')
BEGIN
  SELECT CASE WHEN NEW.resource_type<>'user_block' OR NEW.command_id IS NULL
      OR NEW.safe_metadata_json<>'{}' OR NEW.actor_id=NEW.resource_id
    THEN RAISE(ABORT, 'BLOCK_EVENT_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id=NEW.actor_id AND u.role='STUDENT'
        AND u.account_status='ACTIVE' AND u.affiliation_status='VERIFIED'
        AND u.verified_until>NEW.created_at
    ) THEN RAISE(ABORT, 'BLOCK_ACTOR_FORBIDDEN') END;
  SELECT CASE WHEN NEW.event_type='USER_BLOCKED'
      AND EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id=NEW.actor_id AND blocked_id=NEW.resource_id)
    THEN RAISE(ABORT, 'BLOCK_EXISTS') END;
  SELECT CASE WHEN NEW.event_type='USER_BLOCKED' AND (
      NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.resource_id)
      OR (NOT EXISTS (
        SELECT 1 FROM trips t JOIN ride_requests rr ON rr.trip_id=t.id
        WHERE (t.driver_id=NEW.actor_id AND rr.rider_id=NEW.resource_id)
          OR (t.driver_id=NEW.resource_id AND rr.rider_id=NEW.actor_id)
      ) AND NOT EXISTS (
        SELECT 1 FROM ride_requests a JOIN ride_requests b ON b.trip_id=a.trip_id
        WHERE a.rider_id=NEW.actor_id AND b.rider_id=NEW.resource_id
      ))
    ) THEN RAISE(ABORT, 'BLOCK_RELATION_REQUIRED') END;
  SELECT CASE WHEN NEW.event_type='USER_UNBLOCKED'
      AND NOT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id=NEW.actor_id AND blocked_id=NEW.resource_id)
    THEN RAISE(ABORT, 'BLOCK_NOT_FOUND') END;
END;

CREATE TRIGGER user_block_insert_guard
BEFORE INSERT ON user_blocks
BEGIN
  SELECT CASE WHEN NEW.last_event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM audit_events a WHERE a.id=NEW.last_event_id AND a.event_type='USER_BLOCKED'
      AND a.actor_id=NEW.blocker_id AND a.resource_type='user_block' AND a.resource_id=NEW.blocked_id
  ) THEN RAISE(ABORT, 'BLOCK_AUDIT_REQUIRED') END;
END;

CREATE TRIGGER user_block_event_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_BLOCKED'
BEGIN
  INSERT INTO user_blocks (blocker_id,blocked_id,created_at,last_event_id)
  VALUES (NEW.actor_id,NEW.resource_id,NEW.created_at,NEW.id);
END;

CREATE TRIGGER user_unblock_event_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_UNBLOCKED'
BEGIN
  UPDATE user_blocks SET last_event_id=NEW.id
  WHERE blocker_id=NEW.actor_id AND blocked_id=NEW.resource_id;
  DELETE FROM user_blocks WHERE blocker_id=NEW.actor_id AND blocked_id=NEW.resource_id;
END;

CREATE TRIGGER user_block_event_update_guard
BEFORE UPDATE OF last_event_id ON user_blocks
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events a WHERE a.id=NEW.last_event_id AND a.event_type='USER_UNBLOCKED'
    AND a.actor_id=OLD.blocker_id AND a.resource_type='user_block' AND a.resource_id=OLD.blocked_id
)
BEGIN
  SELECT RAISE(ABORT, 'UNBLOCK_AUDIT_REQUIRED');
END;

CREATE TRIGGER user_block_delete_guard
BEFORE DELETE ON user_blocks
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events a WHERE a.id=OLD.last_event_id AND a.event_type='USER_UNBLOCKED'
    AND a.actor_id=OLD.blocker_id AND a.resource_type='user_block' AND a.resource_id=OLD.blocked_id
)
BEGIN
  SELECT RAISE(ABORT, 'UNBLOCK_AUDIT_REQUIRED');
END;

CREATE TRIGGER user_block_cleanup
AFTER INSERT ON user_blocks
BEGIN
  UPDATE trips SET last_command_id=NEW.last_event_id
  WHERE id IN (
    SELECT trip_id FROM block_affected_requests
    WHERE blocker_id=NEW.blocker_id AND blocked_id=NEW.blocked_id
  );

  UPDATE ride_requests SET
    status=CASE WHEN status='BOARDED' THEN 'ABORTED' ELSE 'CANCELLED' END,
    version=version+1,updated_at=MAX(NEW.created_at,updated_at+1),last_command_id=NEW.last_event_id,
    boarding_code_hash=NULL,boarding_code_expires_at=NULL
  WHERE id IN (
    SELECT request_id FROM block_affected_requests
    WHERE blocker_id=NEW.blocker_id AND blocked_id=NEW.blocked_id
  );

  UPDATE trips SET
    status=CASE WHEN EXISTS (
      SELECT 1 FROM ride_requests rr WHERE rr.trip_id=trips.id AND rr.status='ABORTED'
        AND rr.last_command_id=NEW.last_event_id
    ) THEN 'ABORTED' ELSE 'CANCELLED' END,
    ended_at=MAX(NEW.created_at,updated_at+1),updated_at=MAX(NEW.created_at,updated_at+1),
    version=version+1,last_command_id=NEW.last_event_id
  WHERE id IN (
    SELECT trip_id FROM block_trips_to_end
    WHERE blocker_id=NEW.blocker_id AND blocked_id=NEW.blocked_id
  );
END;
