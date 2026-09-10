-- По итогам аудита БД (см. doc/DATABASE-AUDIT.md): admin-панель
-- (AdminPanelService.getTelemetry/listSessions) фильтрует и сортирует
-- sessions по createdAt, а индекса на этой колонке не было вообще —
-- только на lastActivityAt (для TTL-очистки) и userId. Написано вручную
-- по тем же причинам, что и предыдущие миграции (см.
-- doc/TELEGRAM-ADMIN.md, §5) — проверено применением к реальному
-- локальному Postgres 16, см. doc/DATABASE-AUDIT.md.

-- CreateIndex
CREATE INDEX "sessions_createdAt_idx" ON "sessions"("createdAt");
