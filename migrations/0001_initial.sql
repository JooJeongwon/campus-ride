-- P1 데이터 구조. 상태 전이·수락 trigger는 P3/P4에서 API와 함께 추가한다.
CREATE TABLE departments (
  id TEXT NOT NULL PRIMARY KEY,
  school_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  UNIQUE(school_id, code),
  UNIQUE(id, school_id)
);

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  school_id TEXT NOT NULL,
  campus_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK(email = lower(trim(email))),
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 30),
  department_id TEXT,
  department_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(department_status IN ('VERIFIED','UNVERIFIED','UNKNOWN')),
  department_source TEXT CHECK(department_source IN ('DIRECTORY','EMAIL_LOCAL_PART','GOOGLE_NAME','SELF_REPORTED')),
  parser_version TEXT,
  gender TEXT NOT NULL DEFAULT 'UNDISCLOSED' CHECK(gender IN ('MAN','WOMAN','NON_BINARY','UNDISCLOSED')),
  affiliation_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(affiliation_status IN ('PENDING','VERIFIED','EXPIRED','REJECTED')),
  verified_until INTEGER,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_status IN ('ACTIVE','SUSPENDED','DELETED')),
  role TEXT NOT NULL DEFAULT 'STUDENT' CHECK(role IN ('STUDENT','ADMIN')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(department_id, school_id) REFERENCES departments(id, school_id),
  CHECK(department_status <> 'VERIFIED' OR department_id IS NOT NULL),
  CHECK(affiliation_status <> 'VERIFIED' OR verified_until IS NOT NULL),
  UNIQUE(id, school_id, campus_id)
);

CREATE TABLE student_verifications (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK(method IN ('SCHOOL_ASSERTION','AUTHORIZED_ROSTER','MANUAL_REVIEW')),
  outcome TEXT NOT NULL CHECK(outcome IN ('PENDING','VERIFIED','EXPIRED','REJECTED')),
  department_id TEXT REFERENCES departments(id),
  reviewed_by TEXT REFERENCES users(id),
  verified_at INTEGER,
  valid_until INTEGER,
  reference_digest TEXT,
  CHECK(outcome <> 'VERIFIED' OR (verified_at IS NOT NULL AND valid_until > verified_at))
);
CREATE INDEX student_verifications_user ON student_verifications(user_id);

CREATE TABLE stops (
  id TEXT NOT NULL PRIMARY KEY,
  school_id TEXT NOT NULL,
  campus_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('GATE','DESTINATION')),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  UNIQUE(id, school_id, campus_id)
);
CREATE TABLE routes (
  id TEXT NOT NULL PRIMARY KEY,
  school_id TEXT NOT NULL,
  campus_id TEXT NOT NULL,
  origin_stop_id TEXT NOT NULL,
  destination_stop_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  FOREIGN KEY(origin_stop_id, school_id, campus_id) REFERENCES stops(id, school_id, campus_id),
  FOREIGN KEY(destination_stop_id, school_id, campus_id) REFERENCES stops(id, school_id, campus_id),
  CHECK(origin_stop_id <> destination_stop_id),
  UNIQUE(campus_id, origin_stop_id, destination_stop_id)
);

CREATE TABLE driver_profiles (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  vehicle_model TEXT NOT NULL CHECK(length(vehicle_model) BETWEEN 1 AND 80),
  vehicle_color TEXT NOT NULL CHECK(length(vehicle_color) BETWEEN 1 AND 30),
  vehicle_identifier TEXT NOT NULL CHECK(length(vehicle_identifier) BETWEEN 1 AND 30),
  passenger_capacity INTEGER NOT NULL CHECK(passenger_capacity BETWEEN 1 AND 4),
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING','VERIFIED','EXPIRED','REJECTED')),
  verified_until INTEGER,
  checked_at INTEGER,
  CHECK(verification_status <> 'VERIFIED' OR verified_until IS NOT NULL)
);

CREATE TABLE trips (
  id TEXT NOT NULL PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES driver_profiles(user_id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  departure_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  seat_capacity INTEGER NOT NULL CHECK(seat_capacity BETWEEN 1 AND 4),
  gender_snapshot TEXT NOT NULL CHECK(gender_snapshot IN ('MAN','WOMAN','NON_BINARY','UNDISCLOSED')),
  gender_filter TEXT NOT NULL CHECK(gender_filter IN ('ANY','MAN','WOMAN','SAME_AS_ME')),
  department_id_snapshot TEXT REFERENCES departments(id),
  department_verified_snapshot INTEGER NOT NULL CHECK(department_verified_snapshot IN (0,1)),
  prefer_same_department INTEGER NOT NULL CHECK(prefer_same_department IN (0,1)),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','ABORTED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  last_command_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(expires_at > departure_at),
  CHECK(gender_snapshot <> 'UNDISCLOSED' OR gender_filter = 'ANY'),
  CHECK(department_verified_snapshot = 0 OR department_id_snapshot IS NOT NULL)
);
CREATE INDEX trips_route_status_departure ON trips(route_id, status, departure_at, id);
CREATE INDEX trips_driver_created ON trips(driver_id, created_at);
CREATE UNIQUE INDEX trips_active_driver ON trips(driver_id) WHERE status IN ('OPEN','IN_PROGRESS');

CREATE TABLE ride_requests (
  id TEXT NOT NULL PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  rider_id TEXT NOT NULL REFERENCES users(id),
  desired_departure_at INTEGER NOT NULL,
  gender_snapshot TEXT NOT NULL CHECK(gender_snapshot IN ('MAN','WOMAN','NON_BINARY','UNDISCLOSED')),
  gender_filter TEXT NOT NULL CHECK(gender_filter IN ('ANY','MAN','WOMAN','SAME_AS_ME')),
  department_id_snapshot TEXT REFERENCES departments(id),
  department_verified_snapshot INTEGER NOT NULL CHECK(department_verified_snapshot IN (0,1)),
  prefer_same_department INTEGER NOT NULL CHECK(prefer_same_department IN (0,1)),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','ACCEPTED','BOARDED','REJECTED','CANCELLED','EXPIRED','NO_SHOW','COMPLETED','ABORTED')),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  boarded_at INTEGER,
  boarding_code_hash TEXT,
  boarding_code_expires_at INTEGER,
  boarding_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(boarding_attempt_count BETWEEN 0 AND 5),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  last_command_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK(expires_at > created_at),
  CHECK(gender_snapshot <> 'UNDISCLOSED' OR gender_filter = 'ANY'),
  CHECK(department_verified_snapshot = 0 OR department_id_snapshot IS NOT NULL),
  UNIQUE(id, trip_id)
);
CREATE INDEX requests_trip_status_created ON ride_requests(trip_id, status, created_at, id);
CREATE INDEX requests_rider_created ON ride_requests(rider_id, created_at);
CREATE INDEX requests_status_expiry ON ride_requests(status, expires_at);
CREATE UNIQUE INDEX requests_active_rider ON ride_requests(rider_id) WHERE status IN ('REQUESTED','ACCEPTED','BOARDED');

CREATE TABLE active_user_locks (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('DRIVER','RIDER')),
  trip_id TEXT REFERENCES trips(id),
  request_id TEXT REFERENCES ride_requests(id),
  created_at INTEGER NOT NULL,
  CHECK((role = 'DRIVER' AND trip_id IS NOT NULL AND request_id IS NULL)
     OR (role = 'RIDER' AND trip_id IS NULL AND request_id IS NOT NULL))
);
CREATE TABLE latest_locations (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  request_id TEXT,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  accuracy_m REAL NOT NULL CHECK(accuracy_m > 0),
  captured_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  FOREIGN KEY(request_id, trip_id) REFERENCES ride_requests(id, trip_id),
  CHECK(expires_at = received_at + 60000)
);
CREATE INDEX locations_expiry ON latest_locations(expires_at);

CREATE TABLE sessions (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK(length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(expires_at > created_at)
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE oauth_states (
  state_hash TEXT NOT NULL PRIMARY KEY CHECK(length(state_hash) = 64),
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash) = 64),
  browser_binding_hash TEXT NOT NULL CHECK(length(browser_binding_hash) = 64),
  safe_return_path TEXT NOT NULL DEFAULT '/',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK(expires_at > created_at)
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE consents (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('TERMS','PRIVACY','LOCATION_COLLECTION','LOCATION_SHARING')),
  policy_version TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX consents_user_kind ON consents(user_id, kind, granted_at);
CREATE TABLE user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(blocker_id, blocked_id),
  CHECK(blocker_id <> blocked_id)
);
CREATE INDEX blocks_reverse ON user_blocks(blocked_id, blocker_id);
CREATE TABLE reports (
  id TEXT NOT NULL PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reported_user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  request_id TEXT,
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 50),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  assigned_to TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY(request_id, trip_id) REFERENCES ride_requests(id, trip_id),
  CHECK(reporter_id <> reported_user_id)
);
CREATE INDEX reports_status_created ON reports(status, created_at);
CREATE TABLE audit_events (
  id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  command_id TEXT,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(safe_metadata_json)),
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_resource_created ON audit_events(resource_type, resource_id, created_at);
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  command_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  http_status INTEGER NOT NULL CHECK(http_status BETWEEN 200 AND 599),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, operation, key),
  CHECK(expires_at > created_at)
);
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);
CREATE TABLE rate_limit_buckets (
  subject_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(subject_hash, operation, window_start),
  CHECK(expires_at > window_start)
);
CREATE INDEX rate_limits_expiry ON rate_limit_buckets(expires_at);
