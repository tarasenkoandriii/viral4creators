-- ИИ-консультант на лендинге (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md
-- §10): журнал вопросов/ответов для ревью качества и агрегатов в
-- админке (`/assistant`). Написана руками — сеть до binaries.prisma.sh
-- недоступна в песочнице разработки (doc/CI.md), `prisma migrate diff
-- --exit-code` в CI проверит, что она не разошлась со schema.prisma.
CREATE TABLE "assistant_exchanges" (
    "id"           TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locale"       TEXT NOT NULL,
    "page"         TEXT NOT NULL,
    "stepId"       INTEGER,
    "question"     TEXT NOT NULL,
    "answer"       TEXT NOT NULL,
    "actions"      JSONB,
    "inTokens"     INTEGER NOT NULL DEFAULT 0,
    "outTokens"    INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "latencyMs"    INTEGER NOT NULL DEFAULT 0,
    "flagged"      BOOLEAN NOT NULL DEFAULT false,
    "ipHash"       TEXT NOT NULL,
    "triggeredBy"  TEXT NOT NULL DEFAULT 'user',

    CONSTRAINT "assistant_exchanges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_exchanges_createdAt_idx" ON "assistant_exchanges" ("createdAt");

CREATE INDEX "assistant_exchanges_flagged_createdAt_idx" ON "assistant_exchanges" ("flagged", "createdAt");
