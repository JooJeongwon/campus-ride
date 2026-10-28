ALTER TABLE stops ADD COLUMN last_admin_event_id TEXT;
ALTER TABLE routes ADD COLUMN last_admin_event_id TEXT;

CREATE TRIGGER stop_catalog_event_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('STOP_CREATED','STOP_UPDATED')
BEGIN
  SELECT CASE WHEN NEW.resource_type<>'stop' OR NOT json_valid(NEW.safe_metadata_json)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='ADMIN' AND account_status='ACTIVE')
    OR length(trim(COALESCE(json_extract(NEW.safe_metadata_json,'$.name'),''))) NOT BETWEEN 1 AND 80
    OR json_extract(NEW.safe_metadata_json,'$.kind') NOT IN ('GATE','DESTINATION')
    OR json_type(NEW.safe_metadata_json,'$.lat') NOT IN ('integer','real')
    OR json_extract(NEW.safe_metadata_json,'$.lat') NOT BETWEEN -90 AND 90
    OR json_type(NEW.safe_metadata_json,'$.lng') NOT IN ('integer','real')
    OR json_extract(NEW.safe_metadata_json,'$.lng') NOT BETWEEN -180 AND 180
    OR json_type(NEW.safe_metadata_json,'$.active') NOT IN ('true','false')
    THEN RAISE(ABORT,'STOP_CATALOG_EVENT_INVALID') END;
  SELECT CASE WHEN NEW.event_type='STOP_CREATED' AND EXISTS (SELECT 1 FROM stops WHERE id=NEW.resource_id)
    THEN RAISE(ABORT,'STOP_ALREADY_EXISTS') END;
  SELECT CASE WHEN NEW.event_type='STOP_UPDATED' AND NOT EXISTS (
    SELECT 1 FROM stops s JOIN users actor ON actor.id=NEW.actor_id
    WHERE s.id=NEW.resource_id AND s.school_id=actor.school_id AND s.campus_id=actor.campus_id
  ) THEN RAISE(ABORT,'STOP_NOT_FOUND') END;
  SELECT CASE WHEN NEW.event_type='STOP_UPDATED' AND EXISTS (
    SELECT 1 FROM trips t JOIN routes r ON r.id=t.route_id
    WHERE t.status IN ('OPEN','IN_PROGRESS') AND (r.origin_stop_id=NEW.resource_id OR r.destination_stop_id=NEW.resource_id)
  ) THEN RAISE(ABORT,'STOP_HAS_ACTIVE_TRIPS') END;
END;

CREATE TRIGGER stop_catalog_event_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type IN ('STOP_CREATED','STOP_UPDATED')
BEGIN
  INSERT INTO stops(id,school_id,campus_id,name,kind,lat,lng,active,last_admin_event_id)
    SELECT NEW.resource_id,u.school_id,u.campus_id,json_extract(NEW.safe_metadata_json,'$.name'),
      json_extract(NEW.safe_metadata_json,'$.kind'),json_extract(NEW.safe_metadata_json,'$.lat'),
      json_extract(NEW.safe_metadata_json,'$.lng'),json_extract(NEW.safe_metadata_json,'$.active'),NEW.id
    FROM users u WHERE NEW.event_type='STOP_CREATED' AND u.id=NEW.actor_id;
  UPDATE stops SET name=json_extract(NEW.safe_metadata_json,'$.name'),
      kind=json_extract(NEW.safe_metadata_json,'$.kind'),lat=json_extract(NEW.safe_metadata_json,'$.lat'),
      lng=json_extract(NEW.safe_metadata_json,'$.lng'),active=json_extract(NEW.safe_metadata_json,'$.active'),last_admin_event_id=NEW.id
    WHERE NEW.event_type='STOP_UPDATED' AND id=NEW.resource_id;
END;

CREATE TRIGGER route_catalog_event_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type IN ('ROUTE_CREATED','ROUTE_UPDATED')
BEGIN
  SELECT CASE WHEN NEW.resource_type<>'route' OR NOT json_valid(NEW.safe_metadata_json)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='ADMIN' AND account_status='ACTIVE')
    OR json_type(NEW.safe_metadata_json,'$.active') NOT IN ('true','false')
    THEN RAISE(ABORT,'ROUTE_CATALOG_EVENT_INVALID') END;
  SELECT CASE WHEN NEW.event_type='ROUTE_CREATED' AND (
      EXISTS (SELECT 1 FROM routes WHERE id=NEW.resource_id)
      OR json_type(NEW.safe_metadata_json,'$.originStopId')<>'text'
      OR json_type(NEW.safe_metadata_json,'$.destinationStopId')<>'text'
      OR json_extract(NEW.safe_metadata_json,'$.originStopId')=json_extract(NEW.safe_metadata_json,'$.destinationStopId')
      OR NOT EXISTS (
        SELECT 1 FROM users actor JOIN stops origin ON origin.id=json_extract(NEW.safe_metadata_json,'$.originStopId')
          AND origin.school_id=actor.school_id AND origin.campus_id=actor.campus_id AND origin.kind='GATE' AND origin.active=1
        JOIN stops destination ON destination.id=json_extract(NEW.safe_metadata_json,'$.destinationStopId')
          AND destination.school_id=actor.school_id AND destination.campus_id=actor.campus_id
          AND destination.kind='DESTINATION' AND destination.active=1
        WHERE actor.id=NEW.actor_id
      )
    ) THEN RAISE(ABORT,'ROUTE_STOPS_INVALID') END;
  SELECT CASE WHEN NEW.event_type='ROUTE_UPDATED' AND NOT EXISTS (
    SELECT 1 FROM routes r JOIN users actor ON actor.id=NEW.actor_id
    WHERE r.id=NEW.resource_id AND r.school_id=actor.school_id AND r.campus_id=actor.campus_id
  ) THEN RAISE(ABORT,'ROUTE_NOT_FOUND') END;
  SELECT CASE WHEN NEW.event_type='ROUTE_UPDATED' AND EXISTS (
    SELECT 1 FROM trips WHERE route_id=NEW.resource_id AND status IN ('OPEN','IN_PROGRESS')
  ) THEN RAISE(ABORT,'ROUTE_HAS_ACTIVE_TRIPS') END;
  SELECT CASE WHEN NEW.event_type='ROUTE_UPDATED' AND json_extract(NEW.safe_metadata_json,'$.active')=1
      AND NOT EXISTS (
        SELECT 1 FROM routes r JOIN stops origin ON origin.id=r.origin_stop_id AND origin.kind='GATE' AND origin.active=1
        JOIN stops destination ON destination.id=r.destination_stop_id AND destination.kind='DESTINATION' AND destination.active=1
        WHERE r.id=NEW.resource_id
      ) THEN RAISE(ABORT,'ROUTE_STOPS_INACTIVE') END;
END;

CREATE TRIGGER route_catalog_event_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type IN ('ROUTE_CREATED','ROUTE_UPDATED')
BEGIN
  INSERT INTO routes(id,school_id,campus_id,origin_stop_id,destination_stop_id,active,last_admin_event_id)
    SELECT NEW.resource_id,u.school_id,u.campus_id,json_extract(NEW.safe_metadata_json,'$.originStopId'),
      json_extract(NEW.safe_metadata_json,'$.destinationStopId'),json_extract(NEW.safe_metadata_json,'$.active'),NEW.id
    FROM users u WHERE NEW.event_type='ROUTE_CREATED' AND u.id=NEW.actor_id;
  UPDATE routes SET active=json_extract(NEW.safe_metadata_json,'$.active'),last_admin_event_id=NEW.id
    WHERE NEW.event_type='ROUTE_UPDATED' AND id=NEW.resource_id;
END;

CREATE TRIGGER stop_catalog_insert_guard
BEFORE INSERT ON stops
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events e JOIN users actor ON actor.id=e.actor_id
  WHERE e.id=NEW.last_admin_event_id AND e.event_type='STOP_CREATED' AND e.resource_type='stop'
    AND e.resource_id=NEW.id AND actor.school_id=NEW.school_id AND actor.campus_id=NEW.campus_id
    AND json_extract(e.safe_metadata_json,'$.name')=NEW.name
    AND json_extract(e.safe_metadata_json,'$.kind')=NEW.kind
    AND json_extract(e.safe_metadata_json,'$.lat')=NEW.lat AND json_extract(e.safe_metadata_json,'$.lng')=NEW.lng
    AND json_extract(e.safe_metadata_json,'$.active')=NEW.active
)
BEGIN SELECT RAISE(ABORT,'STOP_CATALOG_AUDIT_REQUIRED'); END;

CREATE TRIGGER stop_catalog_update_guard
BEFORE UPDATE ON stops
WHEN NEW.id<>OLD.id OR NEW.school_id<>OLD.school_id OR NEW.campus_id<>OLD.campus_id
  OR NEW.name<>OLD.name OR NEW.kind<>OLD.kind OR NEW.lat<>OLD.lat OR NEW.lng<>OLD.lng OR NEW.active<>OLD.active
  OR NEW.last_admin_event_id IS NOT OLD.last_admin_event_id
BEGIN
  SELECT CASE WHEN NEW.last_admin_event_id IS OLD.last_admin_event_id OR NOT EXISTS (
    SELECT 1 FROM audit_events e WHERE e.id=NEW.last_admin_event_id AND e.event_type='STOP_UPDATED'
      AND e.resource_type='stop' AND e.resource_id=NEW.id
      AND json_extract(e.safe_metadata_json,'$.name')=NEW.name
      AND json_extract(e.safe_metadata_json,'$.kind')=NEW.kind
      AND json_extract(e.safe_metadata_json,'$.lat')=NEW.lat AND json_extract(e.safe_metadata_json,'$.lng')=NEW.lng
      AND json_extract(e.safe_metadata_json,'$.active')=NEW.active
  ) THEN RAISE(ABORT,'STOP_CATALOG_AUDIT_REQUIRED') END;
END;
CREATE TRIGGER stop_catalog_delete_guard BEFORE DELETE ON stops
BEGIN SELECT RAISE(ABORT,'STOP_DELETE_FORBIDDEN'); END;

CREATE TRIGGER route_catalog_insert_guard
BEFORE INSERT ON routes
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events e JOIN users actor ON actor.id=e.actor_id
  WHERE e.id=NEW.last_admin_event_id AND e.event_type='ROUTE_CREATED' AND e.resource_type='route'
    AND e.resource_id=NEW.id AND actor.school_id=NEW.school_id AND actor.campus_id=NEW.campus_id
    AND json_extract(e.safe_metadata_json,'$.originStopId')=NEW.origin_stop_id
    AND json_extract(e.safe_metadata_json,'$.destinationStopId')=NEW.destination_stop_id
    AND json_extract(e.safe_metadata_json,'$.active')=NEW.active
)
BEGIN SELECT RAISE(ABORT,'ROUTE_CATALOG_AUDIT_REQUIRED'); END;

CREATE TRIGGER route_catalog_update_guard
BEFORE UPDATE ON routes
WHEN NEW.id<>OLD.id OR NEW.school_id<>OLD.school_id OR NEW.campus_id<>OLD.campus_id
  OR NEW.origin_stop_id<>OLD.origin_stop_id OR NEW.destination_stop_id<>OLD.destination_stop_id
  OR NEW.active<>OLD.active OR NEW.last_admin_event_id IS NOT OLD.last_admin_event_id
BEGIN
  SELECT CASE WHEN NEW.last_admin_event_id IS OLD.last_admin_event_id OR NOT EXISTS (
    SELECT 1 FROM audit_events e WHERE e.id=NEW.last_admin_event_id AND e.event_type='ROUTE_UPDATED'
      AND e.resource_type='route' AND e.resource_id=NEW.id
      AND json_extract(e.safe_metadata_json,'$.active')=NEW.active
  ) THEN RAISE(ABORT,'ROUTE_CATALOG_AUDIT_REQUIRED') END;
END;
CREATE TRIGGER route_catalog_delete_guard BEFORE DELETE ON routes
BEGIN SELECT RAISE(ABORT,'ROUTE_DELETE_FORBIDDEN'); END;
