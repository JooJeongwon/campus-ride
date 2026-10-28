CREATE TRIGGER report_create_guard
BEFORE INSERT ON reports
BEGIN
  SELECT CASE WHEN NEW.status <> 'OPEN' OR NEW.assigned_to IS NOT NULL OR NEW.resolved_at IS NOT NULL
    THEN RAISE(ABORT, 'REPORT_INITIAL_STATE_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ride_requests rr
    JOIN trips t ON t.id=rr.trip_id
    JOIN users reporter ON reporter.id=NEW.reporter_id
    WHERE rr.id=NEW.request_id AND rr.trip_id=NEW.trip_id
      AND ((t.driver_id=NEW.reporter_id AND rr.rider_id=NEW.reported_user_id)
        OR (t.driver_id=NEW.reported_user_id AND rr.rider_id=NEW.reporter_id))
      AND reporter.role='STUDENT' AND reporter.account_status='ACTIVE'
      AND reporter.affiliation_status='VERIFIED' AND reporter.verified_until>NEW.created_at
  ) THEN RAISE(ABORT, 'REPORT_RELATION_REQUIRED') END;
END;

CREATE TRIGGER report_create_audit
AFTER INSERT ON reports
BEGIN
  INSERT INTO audit_events
    (id,actor_id,event_type,resource_type,resource_id,safe_metadata_json,created_at)
  VALUES(NEW.id,NEW.reporter_id,'REPORT_SUBMITTED','report',NEW.id,'{}',NEW.created_at);
END;

CREATE TRIGGER report_status_audit_guard
BEFORE INSERT ON audit_events
WHEN NEW.event_type='REPORT_STATUS_CHANGED'
BEGIN
  SELECT CASE WHEN NEW.resource_type <> 'report'
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='ADMIN' AND account_status='ACTIVE')
      OR NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE r.id=NEW.resource_id
          AND ((r.status='OPEN' AND json_extract(NEW.safe_metadata_json,'$.status') IN ('IN_REVIEW','RESOLVED','DISMISSED'))
            OR (r.status='IN_REVIEW' AND json_extract(NEW.safe_metadata_json,'$.status') IN ('RESOLVED','DISMISSED')))
      ) THEN RAISE(ABORT, 'REPORT_REVIEW_FORBIDDEN') END;
END;

CREATE TRIGGER report_status_apply
AFTER INSERT ON audit_events
WHEN NEW.event_type='REPORT_STATUS_CHANGED'
BEGIN
  UPDATE reports
  SET status=json_extract(NEW.safe_metadata_json,'$.status'),
      assigned_to=NEW.actor_id,
      resolved_at=CASE WHEN json_extract(NEW.safe_metadata_json,'$.status') IN ('RESOLVED','DISMISSED')
        THEN NEW.created_at ELSE NULL END
  WHERE id=NEW.resource_id;
END;

CREATE TRIGGER report_status_update_guard
BEFORE UPDATE OF status,assigned_to,resolved_at ON reports
WHEN NEW.status<>OLD.status OR NEW.assigned_to IS NOT OLD.assigned_to OR NEW.resolved_at IS NOT OLD.resolved_at
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.resource_type='report' AND a.resource_id=OLD.id AND a.actor_id=NEW.assigned_to
      AND a.event_type='REPORT_STATUS_CHANGED'
      AND json_extract(a.safe_metadata_json,'$.status')=NEW.status
      AND ((NEW.status='IN_REVIEW' AND NEW.resolved_at IS NULL)
        OR (NEW.status IN ('RESOLVED','DISMISSED') AND NEW.resolved_at=a.created_at))
  ) THEN RAISE(ABORT, 'REPORT_STATUS_AUDIT_REQUIRED') END;
END;
