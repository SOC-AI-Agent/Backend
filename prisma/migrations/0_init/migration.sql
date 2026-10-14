-- The socai database as the FastAPI backend (SOC AI 1.3.5) left it, read from
-- production by the inspect_db_schema job. A database that already has these
-- tables is marked as having run this (prisma migrate resolve --applied 0_init,
-- done by deploy_production) and only the migrations after it are applied.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."actortype" AS ENUM ('USER', 'API_KEY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "public"."eventtype" AS ENUM ('ANALYZE_REQUEST', 'JOB_QUEUED', 'JOB_PROCESSING', 'JOB_COMPLETED', 'JOB_FAILED', 'AUTH_LOGIN', 'AUTH_FAILED', 'AUTH_REFRESH', 'KEY_CREATED', 'KEY_REVOKED', 'USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'AUDIT_EXPORTED', 'SYSTEM_CLEANUP');

-- CreateEnum
CREATE TYPE "public"."jobstatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."ai_jobs" (
    "job_id" UUID NOT NULL,
    "alert_id" VARCHAR(100) NOT NULL,
    "alert_name" VARCHAR(255) NOT NULL,
    "raw_log" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "rendered_prompt" TEXT,
    "api_key_id" UUID,
    "status" "public"."jobstatus" NOT NULL,
    "ai_response" TEXT,
    "error_message" TEXT,
    "model_used" VARCHAR(100),
    "processing_time_ms" INTEGER,
    "tokens_prompt" INTEGER,
    "tokens_eval" INTEGER,
    "owner_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "public"."api_keys" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key_prefix" VARCHAR(15) NOT NULL,
    "hashed_key" VARCHAR(64) NOT NULL,
    "owner_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "event_type" "public"."eventtype" NOT NULL,
    "actor_type" "public"."actortype" NOT NULL,
    "actor_id" VARCHAR(100),
    "actor_label" VARCHAR(150),
    "endpoint" VARCHAR(255),
    "http_method" VARCHAR(10),
    "ip_address" VARCHAR(50),
    "user_agent" TEXT,
    "job_id" UUID,
    "prompt_snapshot" TEXT,
    "ai_response_snapshot" TEXT,
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "extra_data" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."roles" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "hashed_password" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "role_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_ai_jobs_alert_id" ON "public"."ai_jobs"("alert_id" ASC);

-- CreateIndex
CREATE INDEX "ix_ai_jobs_created_at" ON "public"."ai_jobs"("created_at" ASC);

-- CreateIndex
CREATE INDEX "ix_ai_jobs_owner_id" ON "public"."ai_jobs"("owner_id" ASC);

-- CreateIndex
CREATE INDEX "ix_ai_jobs_status" ON "public"."ai_jobs"("status" ASC);

-- CreateIndex
CREATE INDEX "ix_api_keys_key_prefix" ON "public"."api_keys"("key_prefix" ASC);

-- CreateIndex
CREATE INDEX "ix_audit_logs_event_type" ON "public"."audit_logs"("event_type" ASC);

-- CreateIndex
CREATE INDEX "ix_audit_logs_job_id" ON "public"."audit_logs"("job_id" ASC);

-- CreateIndex
CREATE INDEX "ix_audit_logs_timestamp" ON "public"."audit_logs"("timestamp" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "public"."roles"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_username" ON "public"."users"("username" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email" ASC);

-- AddForeignKey
ALTER TABLE "public"."ai_jobs" ADD CONSTRAINT "ai_jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."ai_jobs" ADD CONSTRAINT "ai_jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("job_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

