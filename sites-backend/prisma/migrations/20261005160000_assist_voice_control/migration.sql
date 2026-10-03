-- Э6-бис ИИ-помощника «Голосовое управление интерфейсом», режим «Сайт» (а).
-- ТЗ помощника §5-бис.2–6, §5-бис.9, §5-бис.11 (переключатель), §4-бис.5
-- (`dispatched`); план, Приложение А «Этап 6-бис».
--
-- Пишется РУКАМИ (база — вывод движка схем Prisma 7.10, дальше комментарии
-- и права); CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем. «Админка» (Э6-бис (б), после Э8) —
-- своими таблицами `assist_admin_ui_plans`/`assist_admin_settings`, не здесь
-- (аудит 1.2, У-17).
--
-- Что здесь:
--  * assist_sites.voiceControlSiteState — переключатель off|test|on|degraded
--    (аудит 1.3; в (а) кабинет ставит off/on, test и авто-degraded — (г));
--  * assist_sites.voiceControlSiteRules — зоны, запреты, подтверждение
--    заполнения, лимит шагов (§5-бис.2);
--  * assist_site_ui_plans — голосовой план посетителя: проверенные кодом
--    шаги и текущий шаг на сервере (продолжение после навигации, ни один
--    `dispatched` не повторяется). Снимок страницы не хранится; значения
--    полей в `steps` — маскированные, сырые (и текст команды) — в
--    `liveValues`, только пока план живой (обнуляется вместе с переходом в
--    done/stopped/failed/expired; истёкшие без визита — крон ретенции);
--    адрес страницы — с маской ПД в пути (аудит Э6-бис, 03.10.2026);
--  * assist_site_ui_action_log — журнал шагов (только дописывается);
--  * GRANT роли assist_public — в конце, минимальные, с причиной.

-- AlterTable
ALTER TABLE "assist_sites" ADD COLUMN     "voiceControlSiteRules" JSONB,
ADD COLUMN     "voiceControlSiteState" TEXT NOT NULL DEFAULT 'off';

-- CreateTable
CREATE TABLE "assist_site_ui_plans" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "utteranceMasked" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lang" TEXT,
    "pageUrl" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "liveValues" JSONB,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "needsConfirm" BOOLEAN NOT NULL,
    "confirmedBy" TEXT,
    "confirmBefore" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assist_site_ui_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assist_site_ui_action_log" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "target" JSONB,
    "url" TEXT,
    "risk" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "valueMasked" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assist_site_ui_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_siteId_visitorId_createdAt_idx" ON "assist_site_ui_plans"("siteId", "visitorId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_conversationId_idx" ON "assist_site_ui_plans"("conversationId");

-- CreateIndex
CREATE INDEX "assist_site_ui_plans_accountId_idx" ON "assist_site_ui_plans"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "assist_site_ui_plans_id_accountId_key" ON "assist_site_ui_plans"("id", "accountId");

-- CreateIndex
CREATE INDEX "assist_site_ui_action_log_planId_idx" ON "assist_site_ui_action_log"("planId");

-- CreateIndex
CREATE INDEX "assist_site_ui_action_log_siteId_createdAt_idx" ON "assist_site_ui_action_log"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "assist_site_ui_action_log_accountId_idx" ON "assist_site_ui_action_log"("accountId");

-- План живёт и умирает с диалогом (ретенция §6.3, «удалить мой диалог»).
-- AddForeignKey
ALTER TABLE "assist_site_ui_plans" ADD CONSTRAINT "assist_site_ui_plans_conversationId_accountId_fkey" FOREIGN KEY ("conversationId", "accountId") REFERENCES "assist_site_conversations"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Журнал шагов — с планом.
-- AddForeignKey
ALTER TABLE "assist_site_ui_action_log" ADD CONSTRAINT "assist_site_ui_action_log_planId_accountId_fkey" FOREIGN KEY ("planId", "accountId") REFERENCES "assist_site_ui_plans"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ══ Роль assist_public (виджет) — минимум для голосового управления ══

-- Конфиг виджета и маршруты плана (assist-site-voice-control/public):
-- переключатель и правила кабинета — без них публичный код не решит, есть
-- ли режим и какие у него запреты. Править их роль не может.
GRANT SELECT ("voiceControlSiteState", "voiceControlSiteRules") ON "assist_sites" TO assist_public;

-- План посетителя: создать, прочитать СВОЙ (по id + siteId + visitorId),
-- условным UPDATE перевести статус/шаг (подтверждение, dispatched/done,
-- стоп, истечение; новое окно подтверждения, если после перехода шаг стал
-- «с подтверждением»). Ни DELETE (это ретенция основной ролью), ни правки
-- команды, источника, страницы и сроков — только состояние исполнения.
GRANT SELECT, INSERT ON "assist_site_ui_plans" TO assist_public;
-- `liveValues` — роль сама обнуляет при завершении (и у своих истёкших).
GRANT UPDATE ("steps", "liveValues", "currentStep", "status", "needsConfirm", "confirmedBy", "confirmBefore", "updatedAt") ON "assist_site_ui_plans" TO assist_public;

-- Журнал шагов — только дописывается (у роли нет ни SELECT, ни UPDATE,
-- ни DELETE: прочитать чужой журнал виджету незачем).
GRANT INSERT ON "assist_site_ui_action_log" TO assist_public;
