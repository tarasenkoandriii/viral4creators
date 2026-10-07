-- Имя пригласившего в превью приглашения (TODO I-М «Сквозной аудит
-- 06.10.2026 → Осталось после аудита»; аудит Н-1): экран «Вас приглашают в
-- чужой кабинет» показывает, КТО пригласил. Раньше имя бралось из последней
-- веб-сессии пригласившего, а без веб-входа было `null`. Теперь
-- `POST /sites/account/invites` сохраняет username и first_name из
-- проверенной личности запроса (initData бота или веб-сессия); превью
-- берёт их отсюда, прежний путь через веб-сессию — запасной (приглашения,
-- созданные до этой миграции).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
-- Роли assist_public прав НЕ выдаём: виджету site_account_invites не нужна
-- (см. 20261001130000_site_core_host_checks).

-- AlterTable
ALTER TABLE "site_account_invites" ADD COLUMN "createdByUsername" TEXT,
ADD COLUMN "createdByFirstName" TEXT;
