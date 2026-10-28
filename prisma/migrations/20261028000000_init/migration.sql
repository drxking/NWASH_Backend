CREATE TYPE "MediaKind" AS ENUM ('photo', 'video');

CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "client_report_id" UUID NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "description" VARCHAR(5000),
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reports_client_report_id_key" ON "reports"("client_report_id");
CREATE INDEX "reports_received_at_id_idx" ON "reports"("received_at" DESC,"id" DESC);
CREATE INDEX "media_report_id_idx" ON "media"("report_id");
ALTER TABLE "media" ADD CONSTRAINT "media_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
