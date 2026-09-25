-- Вебхуки внешнего API (этап 146, docs-tz/TZ-Vneshnee-API.md).
--
-- Адрес живёт на КЛЮЧЕ, а не на заявке: вебхук — свойство интеграции, а
-- не отдельного ролика, и указывать его в каждом запросе значило бы
-- дать чужой опечатке менять маршрут доставки от вызова к вызову.
--
-- Секрета подписи здесь нет и не будет: подписываем хешем ключа
-- (`api_keys.keyHash`), который чужая сторона получает из своего ключа
-- одной строкой. Отдельный секрет означал бы вторую церемонию «показан
-- один раз», второе место, где его теряют, и второе поле для
-- перевыпуска — без единого случая, где он был бы нужен.
ALTER TABLE "api_keys" ADD COLUMN "webhookUrl" TEXT;

-- Журнал доставок: одна строка на заявку. Вебхук сообщает об исходе, а
-- исход у заявки один — поэтому `jobId` уникален, и повторная попытка
-- доставки правит ту же строку, а не плодит соседнюю.
CREATE TYPE "ApiWebhookStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "api_webhook_deliveries" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "status" "ApiWebhookStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "lastStatusCode" INTEGER,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_webhook_deliveries_jobId_key"
  ON "api_webhook_deliveries"("jobId");
CREATE INDEX "api_webhook_deliveries_status_nextAttemptAt_idx"
  ON "api_webhook_deliveries"("status", "nextAttemptAt");
