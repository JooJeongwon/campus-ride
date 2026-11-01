CREATE TABLE ride_postings (
  id TEXT NOT NULL PRIMARY KEY,
  rider_id TEXT NOT NULL REFERENCES users(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  desired_departure_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  gender_snapshot TEXT NOT NULL CHECK(gender_snapshot IN ('MAN','WOMAN','NON_BINARY','UNDISCLOSED')),
  gender_filter TEXT NOT NULL CHECK(gender_filter IN ('ANY','MAN','WOMAN','SAME_AS_ME')),
  department_id_snapshot TEXT REFERENCES departments(id),
  department_verified_snapshot INTEGER NOT NULL CHECK(department_verified_snapshot IN (0,1)),
  prefer_same_department INTEGER NOT NULL CHECK(prefer_same_department IN (0,1)),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','MATCHING','MATCHED','CANCELLED','EXPIRED')),
  matched_trip_id TEXT REFERENCES trips(id),
  matched_request_id TEXT,
  matched_driver_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  last_command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(expires_at=desired_departure_at),
  CHECK(gender_snapshot<>'UNDISCLOSED' OR gender_filter='ANY'),
  CHECK(department_verified_snapshot=0 OR department_id_snapshot IS NOT NULL),
  CHECK((status='MATCHED' AND matched_trip_id IS NOT NULL AND matched_request_id IS NOT NULL AND matched_driver_id IS NOT NULL)
    OR (status<>'MATCHED' AND matched_trip_id IS NULL AND matched_request_id IS NULL AND matched_driver_id IS NULL)),
  FOREIGN KEY(matched_request_id,matched_trip_id) REFERENCES ride_requests(id,trip_id)
);
CREATE INDEX ride_postings_open_departure ON ride_postings(status,expires_at,desired_departure_at,created_at,id);
CREATE UNIQUE INDEX ride_postings_active_rider ON ride_postings(rider_id) WHERE status IN ('OPEN','MATCHING');

CREATE TRIGGER ride_posting_create_guard
BEFORE INSERT ON ride_postings
BEGIN
  SELECT CASE WHEN NEW.status<>'OPEN' OR NEW.version<>1 OR NEW.matched_trip_id IS NOT NULL
    OR NEW.matched_request_id IS NOT NULL OR NEW.matched_driver_id IS NOT NULL
    OR NEW.updated_at<>NEW.created_at OR NEW.desired_departure_at<NEW.created_at
    OR NEW.desired_departure_at>NEW.created_at+1800000 OR NEW.last_command_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM users rider JOIN routes r ON r.id=NEW.route_id
      JOIN stops origin ON origin.id=r.origin_stop_id JOIN stops destination ON destination.id=r.destination_stop_id
      WHERE rider.id=NEW.rider_id AND rider.role='STUDENT' AND rider.account_status='ACTIVE'
        AND rider.affiliation_status='VERIFIED' AND rider.verified_until>NEW.created_at
        AND rider.gender=NEW.gender_snapshot AND rider.department_id IS NEW.department_id_snapshot
        AND NEW.department_verified_snapshot=CASE WHEN rider.department_status='VERIFIED' AND rider.department_id IS NOT NULL THEN 1 ELSE 0 END
        AND r.active=1 AND r.school_id=rider.school_id AND r.campus_id=rider.campus_id
        AND origin.active=1 AND origin.kind='GATE' AND destination.active=1 AND destination.kind='DESTINATION'
        AND NOT EXISTS (SELECT 1 FROM active_user_locks WHERE user_id=rider.id)
    ) THEN RAISE(ABORT,'RIDE_POSTING_CREATE_FORBIDDEN') END;
END;

CREATE TRIGGER ride_posting_transition_guard
BEFORE UPDATE OF status ON ride_postings
BEGIN
  SELECT CASE WHEN NEW.status=OLD.status OR NEW.version<>OLD.version+1
    OR NEW.updated_at<=OLD.updated_at OR NEW.last_command_id IS NULL
    THEN RAISE(ABORT,'RIDE_POSTING_VERSION_CONFLICT') END;
  SELECT CASE WHEN NOT ((OLD.status='OPEN' AND NEW.status IN ('MATCHING','CANCELLED','EXPIRED'))
      OR (OLD.status='MATCHING' AND NEW.status='MATCHED'))
    THEN RAISE(ABORT,'RIDE_POSTING_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status='EXPIRED' AND OLD.expires_at>NEW.updated_at
    THEN RAISE(ABORT,'RIDE_POSTING_NOT_EXPIRED') END;
  SELECT CASE WHEN NEW.status='CANCELLED' AND OLD.expires_at<=NEW.updated_at
    THEN RAISE(ABORT,'RIDE_POSTING_NOT_CANCELLABLE') END;
  SELECT CASE WHEN NEW.status='MATCHED' AND NOT EXISTS (
      SELECT 1 FROM trips t JOIN ride_requests rr ON rr.id=NEW.matched_request_id AND rr.trip_id=t.id
      JOIN active_user_locks driver_lock ON driver_lock.user_id=NEW.matched_driver_id
        AND driver_lock.role='DRIVER' AND driver_lock.trip_id=t.id
      JOIN active_user_locks rider_lock ON rider_lock.user_id=OLD.rider_id
        AND rider_lock.role='RIDER' AND rider_lock.request_id=rr.id
      WHERE t.id=NEW.matched_trip_id AND t.driver_id=NEW.matched_driver_id
        AND t.route_id=OLD.route_id AND rr.rider_id=OLD.rider_id
        AND rr.desired_departure_at=OLD.desired_departure_at AND rr.status='ACCEPTED'
    ) THEN RAISE(ABORT,'RIDE_POSTING_MATCH_FORBIDDEN') END;
END;

CREATE TRIGGER active_lock_posting_guard
BEFORE INSERT ON active_user_locks
WHEN EXISTS (SELECT 1 FROM ride_postings p WHERE p.rider_id=NEW.user_id
  AND p.status='OPEN' AND p.expires_at>NEW.created_at)
BEGIN
  SELECT RAISE(ABORT,'RIDE_POSTING_ACTIVITY_CONFLICT');
END;

CREATE TRIGGER user_deletion_close_ride_postings
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_DELETED'
BEGIN
  UPDATE ride_postings SET status=CASE WHEN expires_at>NEW.created_at THEN 'CANCELLED' ELSE 'EXPIRED' END,
      version=version+1,updated_at=MAX(NEW.created_at,updated_at+1),last_command_id=NEW.id
    WHERE rider_id=NEW.resource_id AND status='OPEN';
END;
