CREATE TYPE "LocationStatus" AS ENUM ('none', 'unavailable', 'captured');
CREATE TYPE "LocationSource" AS ENUM ('manual');
CREATE TYPE "AttachmentKind" AS ENUM ('photo', 'audio');

CREATE TABLE "issues" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "client_issue_id" VARCHAR(128) NOT NULL,
  "client_created_at" TIMESTAMPTZ(3) NOT NULL,
  "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "description" VARCHAR(10000) NOT NULL,
  "location_status" "LocationStatus" NOT NULL,
  "location_source" "LocationSource",
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "accuracy" DOUBLE PRECISION,
  "location_timestamp" BIGINT,
  "fingerprint" CHAR(64) NOT NULL,
  CONSTRAINT "issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issues_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "issues_location_check" CHECK (
    ("location_status" = 'captured' AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "accuracy" IS NOT NULL AND "location_timestamp" IS NOT NULL AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND "accuracy" >= 0 AND "location_timestamp" >= 100000000000)
    OR ("location_status" <> 'captured' AND "latitude" IS NULL AND "longitude" IS NULL AND "accuracy" IS NULL AND "location_timestamp" IS NULL AND "location_source" IS NULL)
  )
);

CREATE TABLE "attachments" (
  "id" UUID NOT NULL,
  "issue_id" UUID NOT NULL,
  "client_attachment_id" VARCHAR(128) NOT NULL,
  "kind" "AttachmentKind" NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  "duration_ms" DOUBLE PRECISION,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attachments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attachments_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "attachments_duration_check" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);

CREATE UNIQUE INDEX "issues_owner_id_client_issue_id_key" ON "issues"("owner_id", "client_issue_id");
CREATE INDEX "issues_owner_id_client_created_at_id_idx" ON "issues"("owner_id", "client_created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "attachments_issue_id_client_attachment_id_key" ON "attachments"("issue_id", "client_attachment_id");
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");
