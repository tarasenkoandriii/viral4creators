-- Э6-бис (д) «Цепочки действий и откат» и (е) «Мемо — ядро» ИИ-помощника.
-- ТЗ помощника §5-бис.15–18 (Р-59…Р-62; решения владельца 03.10.2026
-- Р-63…Р-72, бывшие В-65…В-74); план, Приложение А «Этап 6-бис» (д), (е).
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии,
-- представления и права); CI сверяет со schema.prisma (`migrate diff
-- --exit-code`; представления движок схем не сравнивает). Предыдущие
-- миграции не трогаем. «Админка» (мемо АМ-N, компенсации через коннектор)
-- — Э8, своими таблицами `assist_admin_memo*`, не здесь (К-9).
--
-- Что здесь:
--  * assist_site_ui_plans: кто построил шаги (`planOrigin`: model/direct/
--    memo), мемо и ЗАКРЕПЛЁННАЯ версия, отпечаток слотов (хеш) для
--    «повторить?», шаг проверки цели и её итог (`goalStatus`), статус
--    цепочки (`chainStatus`), с какого шага показана карточка (`cardFrom`)
--    и отдельное «Да» перед точкой невозврата (`pnrConfirmedAt`);
--  * assist_site_ui_action_log: `pinMismatch` (отпечаток цели мемо не
--    совпал), `undoOf` (строка возврата поля — номер шага);
--  * assist_sites: счётчик номеров мемо `М-N` (не переиспользуется) и
--    версия текста рисков, которую владелец видел (баннер, Р-67);
--  * assist_site_voice_tests.memoVersionId — сухой прогон версии мемо в
--    браузере владельца (мастер Т-2, `kind = memo`);
--  * assist_site_memos / _memo_versions / _memo_changes — мемо со своими
--    версиями и историей (Р-61); assist_site_phrases — индекс фраз сайта
--    (одна нормализованная фраза — одна сущность; PK ловит гонку
--    публикаций);
--  * представления `assist_site_memo_published` (только опубликованные
--    версии мемо в статусе `published`) и `assist_site_memo_checks`
--    (версии на проверке — для сухого прогона по ссылке мастера);
--  * GRANT роли assist_public — в конце, минимальные, по колонкам.

-- AlterTable
ALTER TABLE "assist_site_ui_action_log" ADD COLUMN     "pinMismatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "undoOf" INTEGER;

-- AlterTable
ALTER TABLE "assist_site_ui_plans" ADD COLUMN     "cardFrom" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chainStatus" TEXT,
ADD COLUMN     "goalFrom" INTEGER,
ADD COLUMN     "goalStatus" TEXT,
ADD COLUMN     "memoId" TEXT,
ADD COLUMN     "memoSlotsHash" TEXT,
ADD COLUMN     "memoVersion" INTEGER,
ADD COLUMN     "planOrigin" TEXT NOT NULL DEFAULT 'model',
ADD COLUMN     "pnrConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "assist_site_voice_tests" ADD COLUMN     "memoVersionId" TEXT;

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "memoCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voiceControlRisksVersion" TEXT;

-- CreateTable
CREATE TABLE "assist_site_memos" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedVersion" INTEGER,
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "view" TEXT NOT NULL DEFAULT 'any',
    "staleViews" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" TEXT NOT NULL,
    "reviewReason" JSONB,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_memos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_memo_versions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memoId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "gateReport" JSONB,
    "checkReport" JSONB,
    "checkId" TEXT,
    "rollbackOf" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "assist_site_memo_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_memo_changes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "memoId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "op" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_memo_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_phrases" (
    "siteId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "norm" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_phrases_pkey" PRIMARY KEY ("siteId","lang","norm")
);

-- CreateIndex
CREATE INDEX "assist_site_memos_accountId_idx" ON "assist_site_memos"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_memos_siteId_number_key" ON "assist_site_memos"("siteId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_memos_siteId_key_key" ON "assist_site_memos"("siteId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_memos_id_accountId_key" ON "assist_site_memos"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_memo_versions_siteId_idx" ON "assist_site_memo_versions"("siteId");

-- CreateIndex
CREATE INDEX "assist_site_memo_versions_accountId_idx" ON "assist_site_memo_versions"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_memo_versions_memoId_number_key" ON "assist_site_memo_versions"("memoId", "number");

-- CreateIndex
CREATE INDEX "assist_site_memo_changes_siteId_createdAt_idx" ON "assist_site_memo_changes"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_memo_changes_memoId_idx" ON "assist_site_memo_changes"("memoId");

-- CreateIndex
CREATE INDEX "assist_site_memo_changes_accountId_idx" ON "assist_site_memo_changes"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_phrases_accountId_idx" ON "assist_site_phrases"("accountId");

-- CreateIndex
CREATE INDEX "assist_site_phrases_siteId_owner_idx" ON "assist_site_phrases"("siteId", "owner");

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_siteId_memoId_createdAt_idx" ON "assist_site_ui_plans"("siteId", "memoId", "createdAt");

-- AddForeignKey
ALTER TABLE "assist_site_memos" ADD CONSTRAINT "assist_site_memos_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_memo_versions" ADD CONSTRAINT "assist_site_memo_versions_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_memo_versions" ADD CONSTRAINT "assist_site_memo_versions_memoId_accountId_fkey" FOREIGN KEY ("memoId", "accountId") REFERENCES "assist_site_memos"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_memo_changes" ADD CONSTRAINT "assist_site_memo_changes_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_memo_changes" ADD CONSTRAINT "assist_site_memo_changes_memoId_accountId_fkey" FOREIGN KEY ("memoId", "accountId") REFERENCES "assist_site_memos"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assist_site_phrases" ADD CONSTRAINT "assist_site_phrases_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Представления для публичного кода (§5-бис.17 п.12) ══
-- Роль виджета не читает ни черновиков, ни истории, ни версий напрямую:
-- только опубликованную версию мемо в статусе `published` (выключенное,
-- «требует проверки», удалённое — не видно, план идёт обычным путём) и —
-- для сухого прогона мастером — версию на проверке. `security_barrier`:
-- условия представления применяются раньше условий запроса роли.
CREATE VIEW "assist_site_memo_published" WITH (security_barrier = true) AS
SELECT m."siteId", m."id" AS "memoId", m."number", m."key", m."listed",
       m."view", m."staleViews", v."number" AS "version", v."content"
  FROM "assist_site_memos" m
  JOIN "assist_site_memo_versions" v
    ON v."memoId" = m."id" AND v."number" = m."publishedVersion"
   AND v."status" = 'published'
 WHERE m."status" = 'published';

CREATE VIEW "assist_site_memo_checks" WITH (security_barrier = true) AS
SELECT v."id", v."siteId", v."memoId", v."number" AS "version",
       m."number", m."key", v."content", v."contentHash"
  FROM "assist_site_memo_versions" v
  JOIN "assist_site_memos" m ON m."id" = v."memoId"
 WHERE v."status" = 'checking' AND m."status" <> 'removed';


-- ══ Роль assist_public (виджет) — минимум для (д) и (е) ══

-- План: публичный код ставит итог цепочки и цели, номер шага карточки и
-- отметку второго «Да» (условным UPDATE своего плана, как статус).
-- Колонки мемо и источник шагов — только при создании (табличный INSERT
-- миграции _assist_voice_control покрывает их), UPDATE — нет.
GRANT UPDATE ("chainStatus", "goalStatus", "cardFrom", "pnrConfirmedAt") ON "assist_site_ui_plans" TO assist_public;

-- Журнал шагов: новые колонки покрыты табличным INSERT (только дописывается).

-- Мемо: только представления. Таблицы мемо, история и индекс фраз — роли
-- ничего (фразы опубликованного мемо — в его версии в представлении).
GRANT SELECT ON "assist_site_memo_published" TO assist_public;
GRANT SELECT ON "assist_site_memo_checks" TO assist_public;

-- Сухой прогон мемо: сессия мастера узнаёт проверяемую версию.
GRANT SELECT ("memoVersionId") ON "assist_site_voice_tests" TO assist_public;
