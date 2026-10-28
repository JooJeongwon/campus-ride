ALTER TABLE location_disclosure_records ADD COLUMN post_notice_acknowledged_at INTEGER;
ALTER TABLE location_disclosure_records ADD COLUMN requested_at INTEGER;
ALTER TABLE location_disclosure_records ADD COLUMN notice_acknowledged_at INTEGER;
ALTER TABLE location_disclosure_records ADD COLUMN position_delivered_at INTEGER;
UPDATE location_disclosure_records SET requested_at=provided_at,
  position_delivered_at=provided_at;

CREATE TABLE location_notice_presence (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  request_id TEXT,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(request_id,trip_id) REFERENCES ride_requests(id,trip_id),
  CHECK(expires_at=last_seen_at+15000)
);
CREATE INDEX location_notice_presence_expiry ON location_notice_presence(expires_at);

CREATE TABLE location_access_records (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  location_owner_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('OWNER_READ','PEER_READ','UPLOAD')),
  trip_id TEXT NOT NULL,
  request_id TEXT,
  accessed_at INTEGER NOT NULL,
  CHECK(action='PEER_READ' OR (location_owner_user_id IS NOT NULL AND location_owner_user_id=user_id))
);
CREATE INDEX location_access_records_user_time ON location_access_records(user_id,accessed_at DESC);
CREATE INDEX location_access_records_location_owner_time ON location_access_records(location_owner_user_id,accessed_at DESC);
CREATE INDEX location_access_records_expiry ON location_access_records(accessed_at);

CREATE TRIGGER user_deletion_clear_location_data
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_DELETED'
BEGIN
  DELETE FROM location_notice_presence WHERE user_id=NEW.resource_id;
  DELETE FROM location_disclosure_records WHERE owner_user_id=NEW.resource_id;
  DELETE FROM location_access_records WHERE location_owner_user_id=NEW.resource_id;
END;
