DROP TRIGGER user_block_delete_guard;

CREATE TRIGGER user_block_delete_guard
BEFORE DELETE ON user_blocks
WHEN NOT EXISTS (
  SELECT 1 FROM audit_events a WHERE a.id=OLD.last_event_id AND a.event_type='USER_UNBLOCKED'
    AND a.actor_id=OLD.blocker_id AND a.resource_type='user_block' AND a.resource_id=OLD.blocked_id
) AND NOT EXISTS (
  SELECT 1 FROM audit_events a WHERE a.event_type='USER_DELETED' AND a.actor_id=a.resource_id
    AND a.resource_id IN (OLD.blocker_id,OLD.blocked_id) AND a.created_at>=OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'UNBLOCK_AUDIT_REQUIRED');
END;

CREATE TRIGGER user_deletion_related_data_cleanup
AFTER INSERT ON audit_events
WHEN NEW.event_type='USER_DELETED'
BEGIN
  DELETE FROM user_blocks WHERE blocker_id=NEW.resource_id OR blocked_id=NEW.resource_id;
  UPDATE location_disclosure_records SET recipient_nickname='탈퇴한 사용자'
    WHERE recipient_user_id=NEW.resource_id;
END;
