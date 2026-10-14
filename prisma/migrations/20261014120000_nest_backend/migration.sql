-- What the NestJS backend adds to the FastAPI-era database. Additive only: new
-- columns, a new enum and an enum value; the prompt column is kept and made
-- optional (new jobs have none); defaults set where the old schema had none.
-- Nothing is dropped or renamed.

-- CreateEnum
CREATE TYPE "lookupstatus" AS ENUM ('NOT_REQUESTED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "eventtype" ADD VALUE 'AUTH_KEY_FAILED';

-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "agent_run_id" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "lookup_completed_at" TIMESTAMP(3),
ADD COLUMN     "lookup_error" TEXT,
ADD COLUMN     "lookup_result" JSONB,
ADD COLUMN     "lookup_started_at" TIMESTAMP(3),
ADD COLUMN     "lookup_status" "lookupstatus" NOT NULL DEFAULT 'NOT_REQUESTED',
ADD COLUMN     "lookup_time_ms" INTEGER,
ADD COLUMN     "splunk_requirements" JSONB,
ALTER COLUMN "prompt" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PENDING',
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "is_active" SET DEFAULT true,
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "is_active" SET DEFAULT true,
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

