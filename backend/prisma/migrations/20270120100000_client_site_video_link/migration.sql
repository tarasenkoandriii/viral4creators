-- Э6 ИИ-помощника «Видео-ответы» (docs-tz/TZ-AI-Pomoshchnik-TMA.md §4.11,
-- §11: «ClientSiteTutorialDraft.clientSiteId String? — новое необязательное
-- поле черновика»; план docs-tz/AI-Pomoshchnik-Plan-Etapov.md, Прил. А «Э6»).
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
--
-- `clientSiteId` — id сайта помощника в sites-backend (без FK — другая
-- база). Пишется только после проверки внутренним API (`site-link`); NULL —
-- черновик к помощнику не привязан. Без backfill: привязка — действие
-- человека (deep-link из TMA помощника или кнопка в визарде).
ALTER TABLE "client_site_tutorial_drafts" ADD COLUMN "clientSiteId" TEXT;

CREATE INDEX "client_site_tutorial_drafts_clientSiteId_idx" ON "client_site_tutorial_drafts"("clientSiteId");

-- Аудит Э6, Д1: липкий признак реального входа черновика (`loginUsedAt`,
-- см. schema.prisma и `modules/client-site-media/requires-login.ts`). До
-- него признаком «за логином» служили `secretsUsedAt`/`cookiesEnc`, которые
-- ставит КАЖДЫЙ раунд, — любой ролик был «за логином».
--
-- Backfill — консервативно, ВСЕМ существующим строкам: до флага входа
-- уверенности нет ни у одного черновика. Вход через `/step` в поле с
-- безобидным селектором (второй экран входа, код из письма) следов в
-- `steps` не оставляет, куки после входа неотличимы от кук первой стороны,
-- а у части строк крон сроков уже стёр и куки, и креды (`secretsUsedAt`
-- NULL у строк до Ш0.5). Цена — старые одобренные ролики не предлагаются
-- посетителям, пока черновик не записан заново; до Э6 они не предлагались
-- и так. Отметка — последняя запись секретов раундом, иначе `updatedAt`.
ALTER TABLE "client_site_tutorial_drafts" ADD COLUMN "loginUsedAt" TIMESTAMP(3);

UPDATE "client_site_tutorial_drafts"
   SET "loginUsedAt" = COALESCE("secretsUsedAt", "updatedAt")
 WHERE "loginUsedAt" IS NULL;
