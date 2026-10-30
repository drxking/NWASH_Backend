-- Keep previously issued credentials/challenges for data preservation; no longer used by login.
ALTER TABLE device_bindings ALTER COLUMN credential_hash DROP NOT NULL,
ALTER COLUMN credential_expires_at DROP NOT NULL;
