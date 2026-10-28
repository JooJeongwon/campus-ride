ALTER TABLE trips ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ride_requests ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE trips SET updated_at=created_at WHERE updated_at=0;
UPDATE ride_requests SET updated_at=created_at WHERE updated_at=0;

CREATE TRIGGER request_transition_guard
BEFORE UPDATE OF status ON ride_requests
BEGIN
  SELECT CASE WHEN NEW.status=OLD.status OR NEW.version<>OLD.version+1
    OR NEW.updated_at<=OLD.updated_at OR NEW.last_command_id IS NULL
    THEN RAISE(ABORT, 'REQUEST_VERSION_CONFLICT') END;
  SELECT CASE WHEN NOT (
      (OLD.status='REQUESTED' AND NEW.status IN ('ACCEPTED','REJECTED','CANCELLED','EXPIRED'))
      OR (OLD.status='ACCEPTED' AND NEW.status IN ('BOARDED','CANCELLED','NO_SHOW'))
      OR (OLD.status='BOARDED' AND NEW.status IN ('COMPLETED','ABORTED'))
    ) THEN RAISE(ABORT, 'REQUEST_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status='ACCEPTED' AND (
      NEW.accepted_at IS NOT NEW.updated_at OR NEW.boarded_at IS NOT NULL
      OR OLD.expires_at<=NEW.updated_at
      OR NOT EXISTS (
        SELECT 1 FROM trips t
        JOIN users driver ON driver.id=t.driver_id
        JOIN driver_profiles p ON p.user_id=driver.id
        JOIN users rider ON rider.id=OLD.rider_id
        JOIN routes r ON r.id=t.route_id
        JOIN stops origin ON origin.id=r.origin_stop_id
        JOIN stops destination ON destination.id=r.destination_stop_id
        WHERE t.id=OLD.trip_id AND t.status='OPEN' AND t.expires_at>NEW.updated_at
          AND t.seat_capacity>(SELECT COUNT(*) FROM ride_requests seated
            WHERE seated.trip_id=t.id AND seated.status IN ('ACCEPTED','BOARDED'))
          AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
          AND driver.affiliation_status='VERIFIED' AND driver.verified_until>NEW.updated_at
          AND p.verification_status='VERIFIED' AND p.verified_until>NEW.updated_at
          AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
          AND rider.affiliation_status='VERIFIED' AND rider.verified_until>NEW.updated_at
          AND rider.gender=OLD.gender_snapshot
          AND driver.gender=t.gender_snapshot
          AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=driver.id AND l.role='DRIVER' AND l.trip_id=t.id)
          AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=rider.id AND l.role='RIDER' AND l.request_id=OLD.id)
          AND r.active=1 AND origin.active=1 AND destination.active=1
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=driver.id AND b.blocked_id=rider.id)
            OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))
          AND (t.gender_filter='ANY'
            OR (t.gender_filter='MAN' AND OLD.gender_snapshot='MAN')
            OR (t.gender_filter='WOMAN' AND OLD.gender_snapshot='WOMAN')
            OR (t.gender_filter='SAME_AS_ME' AND t.gender_snapshot=OLD.gender_snapshot))
          AND (OLD.gender_filter='ANY'
            OR (OLD.gender_filter='MAN' AND t.gender_snapshot='MAN')
            OR (OLD.gender_filter='WOMAN' AND t.gender_snapshot='WOMAN')
            OR (OLD.gender_filter='SAME_AS_ME' AND OLD.gender_snapshot=t.gender_snapshot))
          AND NOT EXISTS (
            SELECT 1 FROM ride_requests member
            WHERE member.trip_id=t.id AND member.status IN ('ACCEPTED','BOARDED')
              AND (
                (t.gender_filter='MAN' AND member.gender_snapshot<>'MAN')
                OR (t.gender_filter='WOMAN' AND member.gender_snapshot<>'WOMAN')
                OR (t.gender_filter='SAME_AS_ME' AND member.gender_snapshot<>t.gender_snapshot)
                OR (member.gender_filter='MAN' AND t.gender_snapshot<>'MAN')
                OR (member.gender_filter='WOMAN' AND t.gender_snapshot<>'WOMAN')
                OR (member.gender_filter='SAME_AS_ME' AND t.gender_snapshot<>member.gender_snapshot)
                OR (OLD.gender_filter='MAN' AND member.gender_snapshot<>'MAN')
                OR (OLD.gender_filter='WOMAN' AND member.gender_snapshot<>'WOMAN')
                OR (OLD.gender_filter='SAME_AS_ME' AND member.gender_snapshot<>OLD.gender_snapshot)
                OR (member.gender_filter='MAN' AND OLD.gender_snapshot<>'MAN')
                OR (member.gender_filter='WOMAN' AND OLD.gender_snapshot<>'WOMAN')
                OR (member.gender_filter='SAME_AS_ME' AND OLD.gender_snapshot<>member.gender_snapshot)
                OR EXISTS (SELECT 1 FROM user_blocks b WHERE
                  (b.blocker_id=OLD.rider_id AND b.blocked_id=member.rider_id)
                  OR (b.blocker_id=member.rider_id AND b.blocked_id=OLD.rider_id))
              )
          )
        )
    ) THEN RAISE(ABORT, 'REQUEST_ACCEPT_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='EXPIRED' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id
        AND (OLD.expires_at<=NEW.updated_at OR t.expires_at<=NEW.updated_at OR t.departure_at<=NEW.updated_at)
    ) THEN RAISE(ABORT, 'REQUEST_NOT_EXPIRED') END;
  SELECT CASE WHEN NEW.status='REJECTED' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id AND t.status='OPEN' AND OLD.expires_at>NEW.updated_at
    ) THEN RAISE(ABORT, 'REQUEST_NOT_AVAILABLE') END;
  SELECT CASE WHEN NEW.status='CANCELLED' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id AND t.status='OPEN' AND NEW.boarded_at IS NULL
        AND (t.departure_at>NEW.updated_at OR t.expires_at<=NEW.updated_at
          OR t.last_command_id=NEW.last_command_id)
    ) THEN RAISE(ABORT, 'REQUEST_NOT_CANCELLABLE') END;
  SELECT CASE WHEN NEW.status='NO_SHOW' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id AND t.status='OPEN'
        AND t.departure_at+180000<=NEW.updated_at
    ) THEN RAISE(ABORT, 'REQUEST_NO_SHOW_EARLY') END;
  SELECT CASE WHEN NEW.status='BOARDED' AND (
      NEW.boarded_at IS NOT NEW.updated_at OR OLD.accepted_at IS NULL
      OR OLD.boarding_code_hash IS NULL OR OLD.boarding_code_expires_at<=NEW.updated_at
      OR OLD.boarding_attempt_count>=5
      OR NOT EXISTS (
        SELECT 1 FROM trips t
        JOIN users driver ON driver.id=t.driver_id
        JOIN driver_profiles p ON p.user_id=driver.id
        JOIN users rider ON rider.id=OLD.rider_id
        WHERE t.id=OLD.trip_id AND t.status='OPEN'
          AND driver.account_status='ACTIVE' AND driver.role='STUDENT'
          AND driver.affiliation_status='VERIFIED' AND driver.verified_until>NEW.updated_at
          AND p.verification_status='VERIFIED' AND p.verified_until>NEW.updated_at
          AND rider.account_status='ACTIVE' AND rider.role='STUDENT'
          AND rider.affiliation_status='VERIFIED' AND rider.verified_until>NEW.updated_at
          AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=driver.id AND l.role='DRIVER' AND l.trip_id=t.id)
          AND EXISTS (SELECT 1 FROM active_user_locks l WHERE l.user_id=rider.id AND l.role='RIDER' AND l.request_id=OLD.id)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
            (b.blocker_id=driver.id AND b.blocked_id=rider.id)
            OR (b.blocker_id=rider.id AND b.blocked_id=driver.id))
      )
    ) THEN RAISE(ABORT, 'REQUEST_BOARD_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='COMPLETED' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id AND t.status='IN_PROGRESS'
    ) THEN RAISE(ABORT, 'REQUEST_COMPLETE_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='ABORTED' AND NOT EXISTS (
      SELECT 1 FROM trips t WHERE t.id=OLD.trip_id AND t.status IN ('OPEN','IN_PROGRESS')
    ) THEN RAISE(ABORT, 'REQUEST_ABORT_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')
      AND (NEW.boarding_code_hash IS NOT NULL OR NEW.boarding_code_expires_at IS NOT NULL)
    THEN RAISE(ABORT, 'REQUEST_CODE_NOT_CLEARED') END;
END;

CREATE TRIGGER request_terminal_cleanup
AFTER UPDATE OF status ON ride_requests
WHEN NEW.status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')
BEGIN
  DELETE FROM active_user_locks WHERE user_id=NEW.rider_id AND role='RIDER' AND request_id=NEW.id;
  DELETE FROM latest_locations WHERE request_id=NEW.id;
END;

CREATE TRIGGER trip_transition_guard
BEFORE UPDATE OF status ON trips
BEGIN
  SELECT CASE WHEN NEW.status=OLD.status OR NEW.version<>OLD.version+1
    OR NEW.updated_at<=OLD.updated_at OR NEW.last_command_id IS NULL
    THEN RAISE(ABORT, 'TRIP_VERSION_CONFLICT') END;
  SELECT CASE WHEN NOT (
      (OLD.status='OPEN' AND NEW.status IN ('IN_PROGRESS','CANCELLED','EXPIRED','ABORTED'))
      OR (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','ABORTED'))
    ) THEN RAISE(ABORT, 'TRIP_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status='IN_PROGRESS' AND (
      NEW.started_at IS NOT NEW.updated_at OR NEW.ended_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status='BOARDED')
      OR EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status IN ('REQUESTED','ACCEPTED'))
      OR OLD.departure_at>NEW.updated_at OR OLD.expires_at<=NEW.updated_at
    ) THEN RAISE(ABORT, 'TRIP_START_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='CANCELLED' AND (
      NEW.ended_at IS NOT NEW.updated_at
      OR EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status IN ('REQUESTED','ACCEPTED','BOARDED'))
    ) THEN RAISE(ABORT, 'TRIP_CANCEL_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='EXPIRED' AND (
      NEW.ended_at IS NOT NEW.updated_at OR OLD.expires_at>NEW.updated_at
      OR EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status IN ('REQUESTED','ACCEPTED','BOARDED'))
    ) THEN RAISE(ABORT, 'TRIP_EXPIRE_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='COMPLETED' AND (
      NEW.ended_at IS NOT NEW.updated_at
      OR EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status IN ('REQUESTED','ACCEPTED','BOARDED'))
      OR NOT EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status='COMPLETED' AND last_command_id=NEW.last_command_id)
    ) THEN RAISE(ABORT, 'TRIP_COMPLETE_FORBIDDEN') END;
  SELECT CASE WHEN NEW.status='ABORTED' AND (
      NEW.ended_at IS NOT NEW.updated_at
      OR EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status IN ('REQUESTED','ACCEPTED','BOARDED'))
      OR (OLD.status='OPEN' AND NOT EXISTS (SELECT 1 FROM ride_requests WHERE trip_id=OLD.id AND status='ABORTED' AND last_command_id=NEW.last_command_id))
    ) THEN RAISE(ABORT, 'TRIP_ABORT_FORBIDDEN') END;
END;

CREATE TRIGGER trip_terminal_cleanup
AFTER UPDATE OF status ON trips
WHEN NEW.status IN ('COMPLETED','CANCELLED','EXPIRED','ABORTED')
BEGIN
  DELETE FROM active_user_locks WHERE user_id=NEW.driver_id AND role='DRIVER' AND trip_id=NEW.id;
  DELETE FROM latest_locations WHERE trip_id=NEW.id;
END;
