CREATE TRIGGER trip_abort_requires_request_command
BEFORE UPDATE OF status ON trips
WHEN NEW.status='ABORTED'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ride_requests
    WHERE trip_id=OLD.id AND status='ABORTED' AND last_command_id=NEW.last_command_id
  ) THEN RAISE(ABORT, 'TRIP_ABORT_REQUEST_MISMATCH') END;
END;
