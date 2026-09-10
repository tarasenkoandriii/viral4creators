-- Этап 66 (TODO §III.6). A/B-варианты одного ролика: из одного уже
-- одобренного ролика собираются 3 дополнительных дубля, отличающихся
-- только хуком и CTA — раскадровка, камера, персонажи, темп и цвет
-- остаются теми же. AbTestRun — снимок одного запуска (какой разбор,
-- чей стиль, какой товар, какой пользователь), AbTestVariant — состояние
-- обработки одного варианта, с бэкоффом по строке, тот же приём, что у
-- catalog_batch_items (этап 65). В отличие от catalog_batch_items,
-- promptText/voiceoverScript уже готовы на строке в момент её создания
-- (один общий вызов GPT-5 при создании запуска, не по одному на строку).

CREATE TABLE "ab_test_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "productItemId" TEXT NOT NULL,
    "libraryEntryId" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "aspectRatio" TEXT,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ab_test_runs_projectId_idx" ON "ab_test_runs"("projectId");

ALTER TABLE "ab_test_runs" ADD CONSTRAINT "ab_test_runs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ab_test_runs" ADD CONSTRAINT "ab_test_runs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "AbTestVariantStatus" AS ENUM ('PENDING', 'GENERATING', 'DONE', 'FAILED');

CREATE TABLE "ab_test_variants" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "variantIndex" INTEGER NOT NULL,
    "hookLabel" TEXT NOT NULL,
    "ctaLabel" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "voiceoverScript" TEXT,
    "sessionId" TEXT,
    "status" "AbTestVariantStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ab_test_variants_runId_variantIndex_key" ON "ab_test_variants"("runId", "variantIndex");
CREATE INDEX "ab_test_variants_status_nextAttemptAt_idx" ON "ab_test_variants"("status", "nextAttemptAt");

ALTER TABLE "ab_test_variants" ADD CONSTRAINT "ab_test_variants_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ab_test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
