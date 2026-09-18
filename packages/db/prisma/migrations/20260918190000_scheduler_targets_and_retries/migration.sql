-- Target platforms for a scheduled post, plus the lease/retry bookkeeping the
-- scheduler worker needs (see packages/db/src/scheduler.ts).

-- `platforms` is non-nullable (it is a required list in the Prisma model).
-- Rows that predate this migration get an empty array rather than NULL; the
-- worker refuses to publish such a post and fails it with an explicit error
-- instead of silently marking it published with no targets.
-- AlterTable
ALTER TABLE "posts" ADD COLUMN "platforms" "Platform"[] NOT NULL DEFAULT ARRAY[]::"Platform"[];
ALTER TABLE "posts" ADD COLUMN "claim_expires_at" TIMESTAMPTZ;
ALTER TABLE "posts" ADD COLUMN "claim_token" TEXT;
ALTER TABLE "posts" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "posts" ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "posts" ADD COLUMN "next_attempt_at" TIMESTAMPTZ;
ALTER TABLE "posts" ADD COLUMN "last_error" TEXT;

-- An attempt may fail before an account can be resolved (no connected
-- account for the platform), so the attempt is still recorded without one.
-- AlterTable
ALTER TABLE "platform_publish_attempts" DROP CONSTRAINT "platform_publish_attempts_account_id_fkey";
ALTER TABLE "platform_publish_attempts" ALTER COLUMN "account_id" DROP NOT NULL;
ALTER TABLE "platform_publish_attempts" ADD CONSTRAINT "platform_publish_attempts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "posts_status_claim_expires_at_idx" ON "posts"("status", "claim_expires_at");

-- One attempt row per post/platform: retries update it in place, which makes
-- a redelivered publish idempotent per platform.
-- CreateIndex
CREATE UNIQUE INDEX "platform_publish_attempts_post_id_platform_key" ON "platform_publish_attempts"("post_id", "platform");
