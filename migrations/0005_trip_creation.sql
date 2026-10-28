CREATE TRIGGER trip_create_guard
BEFORE INSERT ON trips
BEGIN
  SELECT CASE WHEN NEW.status <> 'OPEN' OR NEW.version <> 1 OR NEW.started_at IS NOT NULL OR NEW.ended_at IS NOT NULL
    OR NEW.expires_at <> NEW.departure_at + 900000
    OR NEW.departure_at < NEW.created_at OR NEW.departure_at > NEW.created_at + 1800000
    OR NOT EXISTS (
      SELECT 1 FROM users u
      JOIN driver_profiles p ON p.user_id=u.id
      JOIN routes r ON r.id=NEW.route_id
      JOIN stops origin ON origin.id=r.origin_stop_id
      JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE u.id=NEW.driver_id AND u.role='STUDENT' AND u.account_status='ACTIVE'
        AND u.affiliation_status='VERIFIED' AND u.verified_until>NEW.created_at
        AND NEW.gender_snapshot=u.gender AND NEW.department_id_snapshot IS u.department_id
        AND NEW.department_verified_snapshot=CASE WHEN u.department_status='VERIFIED' AND u.department_id IS NOT NULL THEN 1 ELSE 0 END
        AND p.verification_status='VERIFIED' AND p.verified_until>NEW.created_at
        AND NEW.seat_capacity<=p.passenger_capacity
        AND r.active=1 AND r.school_id=u.school_id AND r.campus_id=u.campus_id
        AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'
        AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=u.id)
    ) THEN RAISE(ABORT, 'TRIP_CREATE_FORBIDDEN') END;
END;

CREATE TRIGGER trip_create_lock
AFTER INSERT ON trips
BEGIN
  INSERT INTO active_user_locks (user_id,role,trip_id,request_id,created_at)
  VALUES (NEW.driver_id,'DRIVER',NEW.id,NULL,NEW.created_at);
END;
