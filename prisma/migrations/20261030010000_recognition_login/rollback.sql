BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM device_bindings WHERE credential_hash IS NULL OR credential_expires_at IS NULL) THEN
  RAISE EXCEPTION 'Rollback blocked: recognition-only bindings have no credentials';
 END IF;
END $$;
ALTER TABLE device_bindings ALTER COLUMN credential_hash SET NOT NULL,
ALTER COLUMN credential_expires_at SET NOT NULL;
COMMIT;
