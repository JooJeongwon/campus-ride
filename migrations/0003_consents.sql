CREATE UNIQUE INDEX consents_one_active_version
  ON consents(user_id, kind, policy_version)
  WHERE revoked_at IS NULL;
