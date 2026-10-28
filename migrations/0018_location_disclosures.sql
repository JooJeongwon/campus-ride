CREATE TABLE location_disclosure_records (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  recipient_nickname TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK(recipient_role IN ('DRIVER','RIDER')),
  trip_id TEXT NOT NULL,
  request_id TEXT,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  purpose TEXT NOT NULL CHECK(purpose='MEETING'),
  provided_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX location_disclosures_delivery_once
  ON location_disclosure_records(owner_user_id,recipient_user_id,trip_id,sequence);

CREATE INDEX location_disclosures_owner_activity_time
  ON location_disclosure_records(owner_user_id,trip_id,request_id,provided_at DESC);
