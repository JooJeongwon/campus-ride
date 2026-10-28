CREATE TRIGGER request_create_group_guard
BEFORE INSERT ON ride_requests
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ride_requests seated
    WHERE seated.trip_id=NEW.trip_id AND seated.status IN ('ACCEPTED','BOARDED')
      AND (
        (seated.gender_filter='MAN' AND NEW.gender_snapshot<>'MAN')
        OR (seated.gender_filter='WOMAN' AND NEW.gender_snapshot<>'WOMAN')
        OR (seated.gender_filter='SAME_AS_ME' AND seated.gender_snapshot<>NEW.gender_snapshot)
        OR (NEW.gender_filter='MAN' AND seated.gender_snapshot<>'MAN')
        OR (NEW.gender_filter='WOMAN' AND seated.gender_snapshot<>'WOMAN')
        OR (NEW.gender_filter='SAME_AS_ME' AND NEW.gender_snapshot<>seated.gender_snapshot)
        OR EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=seated.rider_id AND b.blocked_id=NEW.rider_id)
          OR (b.blocker_id=NEW.rider_id AND b.blocked_id=seated.rider_id))
      )
  ) THEN RAISE(ABORT, 'REQUEST_CREATE_GROUP_CONFLICT') END;
END;
