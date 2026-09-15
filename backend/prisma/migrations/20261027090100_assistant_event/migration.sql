-- ИИ-консультант на лендинге (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md
-- §10): счётчик клиентских событий виджета (open/ask/action_click/close,
-- проактивная воронка) — POST /assistant/event. Написана руками — сеть до
-- binaries.prisma.sh недоступна в песочнице разработки (doc/CI.md).
CREATE TABLE "assistant_events" (
    "id"        TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind"      TEXT NOT NULL,
    "detail"    TEXT,

    CONSTRAINT "assistant_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_events_kind_createdAt_idx" ON "assistant_events" ("kind", "createdAt");
