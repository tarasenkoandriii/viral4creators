-- Заход 9, пакет C — хвосты Э7 «Админка: чтение» (doc/TODO.md, I-Э7):
--  * Р-З9-14 (Э7-хвост (5)): флаг коннектора «маскировать ПД в данных API
--    до модели» (умолчание — выкл.: сотрудник работает с заказами);
--  * Р-З9-17 (аудит Э7 (г)): флаг сайта «тестовый ключ pk_test ходит в
--    коннекторы и действия» (умолчание — выкл.: только знания).
-- Права роли assist_public на эти таблицы не выдаются (как и раньше).
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.

-- AlterTable
ALTER TABLE "assist_admin_connectors" ADD COLUMN     "maskPd" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "assist_admin_settings" ADD COLUMN     "testKeyConnectors" BOOLEAN NOT NULL DEFAULT false;
