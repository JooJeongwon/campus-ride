CREATE TRIGGER request_create_guard
BEFORE INSERT ON ride_requests
BEGIN
  SELECT CASE WHEN NEW.status <> 'REQUESTED' OR NEW.version <> 1 OR NEW.accepted_at IS NOT NULL OR NEW.boarded_at IS NOT NULL
    OR NEW.boarding_code_hash IS NOT NULL OR NEW.boarding_code_expires_at IS NOT NULL
    OR NEW.boarding_attempt_count <> 0 OR NEW.last_command_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM trips t
      JOIN users driver ON driver.id=t.driver_id
      JOIN driver_profiles p ON p.user_id=driver.id
      JOIN users rider ON rider.id=NEW.rider_id
      JOIN routes r ON r.id=t.route_id
      JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE t.id=NEW.trip_id AND t.driver_id<>NEW.rider_id
        AND t.status='OPEN' AND t.expires_at>NEW.created_at
        AND NEW.expires_at=MIN(t.expires_at,NEW.created_at+180000)
        AND NEW.desired_departure_at BETWEEN NEW.created_at AND NEW.created_at+1800000
        AND ABS(NEW.desired_departure_at-t.departure_at)<=600000
        AND t.seat_capacity>(SELECT COUNT(*) FROM ride_requests rr WHERE rr.trip_id=t.id AND rr.status IN ('ACCEPTED','BOARDED'))
        AND driver.role='STUDENT' AND driver.account_status='ACTIVE'
        AND driver.affiliation_status='VERIFIED' AND driver.verified_until>NEW.created_at
        AND p.verification_status='VERIFIED' AND p.verified_until>NEW.created_at
        AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>NEW.created_at
        AND rider.gender=NEW.gender_snapshot AND rider.department_id IS NEW.department_id_snapshot
        AND NEW.department_verified_snapshot=CASE WHEN rider.department_status='VERIFIED' AND rider.department_id IS NOT NULL THEN 1 ELSE 0 END
        AND (NEW.gender_snapshot<>'UNDISCLOSED' OR NEW.gender_filter='ANY')
        AND (t.gender_snapshot<>'UNDISCLOSED' OR t.gender_filter='ANY')
        AND (t.gender_filter='ANY'
          OR (t.gender_filter='MAN' AND NEW.gender_snapshot='MAN')
          OR (t.gender_filter='WOMAN' AND NEW.gender_snapshot='WOMAN')
          OR (t.gender_filter='SAME_AS_ME' AND t.gender_snapshot=NEW.gender_snapshot))
        AND (NEW.gender_filter='ANY'
          OR (NEW.gender_filter='MAN' AND t.gender_snapshot='MAN')
          OR (NEW.gender_filter='WOMAN' AND t.gender_snapshot='WOMAN')
          OR (NEW.gender_filter='SAME_AS_ME' AND NEW.gender_snapshot=t.gender_snapshot))
        AND r.active=1 AND r.school_id=rider.school_id AND r.campus_id=rider.campus_id
        AND r.school_id=driver.school_id AND r.campus_id=driver.campus_id
        AND origin.active=1 AND origin.kind='GATE'
        AND destination.active=1 AND destination.kind='DESTINATION'
        AND EXISTS (SELECT 1 FROM active_user_locks dl WHERE dl.user_id=driver.id AND dl.role='DRIVER' AND dl.trip_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=rider.id)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=rider.id AND b.blocked_id=driver.id)
          OR (b.blocker_id=driver.id AND b.blocked_id=rider.id))
    ) THEN RAISE(ABORT, 'REQUEST_CREATE_FORBIDDEN') END;
END;

CREATE TRIGGER request_create_lock
AFTER INSERT ON ride_requests
WHEN NEW.status = 'REQUESTED'
BEGIN
  INSERT INTO active_user_locks (user_id,role,trip_id,request_id,created_at)
  VALUES (NEW.rider_id,'RIDER',NULL,NEW.id,NEW.created_at);
END;
