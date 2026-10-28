CREATE TRIGGER trip_start_location_cleanup
AFTER UPDATE OF status ON trips
WHEN NEW.status='IN_PROGRESS'
BEGIN
  DELETE FROM latest_locations WHERE trip_id=NEW.id;
END;

CREATE TRIGGER request_location_cleanup
AFTER UPDATE OF status ON ride_requests
WHEN NEW.status IN ('REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')
BEGIN
  DELETE FROM latest_locations
  WHERE user_id=(SELECT driver_id FROM trips WHERE id=NEW.trip_id)
    AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.trip_id=NEW.trip_id AND r.status IN ('ACCEPTED','BOARDED'));
END;
