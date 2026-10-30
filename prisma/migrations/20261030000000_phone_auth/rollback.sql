BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM users WHERE email IS NULL OR password_hash IS NULL) THEN
  RAISE EXCEPTION 'Rollback blocked: phone-only users require a preservation/migration plan';
 END IF;
END $$;
DROP TABLE auth_sessions;
DROP TABLE phone_challenges;
DROP TABLE device_bindings;
ALTER TABLE users DROP COLUMN phone_number, DROP COLUMN phone_verified_at, DROP COLUMN address;
ALTER TABLE users ALTER COLUMN email SET NOT NULL, ALTER COLUMN password_hash SET NOT NULL;
COMMIT;
