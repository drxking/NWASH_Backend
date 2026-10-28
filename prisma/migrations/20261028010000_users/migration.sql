CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_full_name_length_check" CHECK (char_length(btrim("full_name")) BETWEEN 1 AND 100),
    CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower(btrim("email")))
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
