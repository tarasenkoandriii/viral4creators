-- Седьмой аудит (14.09.2026), М-5.5: платежи и журнал кредитов — финансовая
-- история и не удаляются вместе с аккаунтом. CASCADE стирал providerRef/
-- rawPayload (следы для споров и идемпотентности вебхуков); теперь удаление
-- пользователя с платежами отклоняется — аккаунт анонимизируется, а не
-- стирается. Подписка (subscriptions) остаётся CASCADE: это не история,
-- а текущее состояние.
ALTER TABLE "payments" DROP CONSTRAINT "payments_userId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_userId_fkey";
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- М-5.7: индексы под реальные запросы воронки/когорты
-- (admin-panel.service.ts: GROUP BY stage в окне occurredAt; JOIN по entityId).
CREATE INDEX "workflow_stage_events_workflow_occurredAt_idx"
    ON "workflow_stage_events"("workflow", "occurredAt");
CREATE INDEX "workflow_stage_events_workflow_entityId_idx"
    ON "workflow_stage_events"("workflow", "entityId");

-- М-3.7: владелец джоб-замка — снятие замка только своим токеном.
ALTER TABLE "cron_job_locks" ADD COLUMN "ownerToken" TEXT;
