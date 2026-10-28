CREATE TRIGGER request_accept_driver_block_guard
BEFORE UPDATE OF status ON ride_requests
WHEN NEW.status='ACCEPTED'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM trips t JOIN ride_requests seated ON seated.trip_id=t.id
      JOIN user_blocks b ON (b.blocker_id=t.driver_id AND b.blocked_id=seated.rider_id)
        OR (b.blocker_id=seated.rider_id AND b.blocked_id=t.driver_id)
    WHERE t.id=OLD.trip_id AND seated.status IN ('ACCEPTED','BOARDED')
  ) THEN RAISE(ABORT, 'REQUEST_ACCEPT_FORBIDDEN') END;
END;
