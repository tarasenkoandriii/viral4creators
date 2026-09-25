-- Ключи внешнего API (этап 144, docs-tz/TZ-Vneshnee-API.md).
--
-- Секрет НЕ хранится: в `keyHash` лежит sha-256 от него, и по этому
-- хешу идёт единственный поиск при каждом вызове — отсюда уникальный
-- индекс, он же делает сравнение секретов работой базы, а не нашего
-- кода в цикле по всем ключам. Соли нет намеренно: секрет не выбирает
-- человек (32 случайных байта), перебирать его нечем, а без соли хеш
-- детерминированный и по нему можно искать.
--
-- `hint` — открытое начало ключа (`v4c_` плюс восемь символов). Без
-- него список выдач это несколько строк «ключ от 12 марта», и отозвать
-- нужный можно только угадав.
--
-- `revokedAt`, а не удаление строки: отозванный ключ — часть истории
-- доступа, и «этого ключа никогда не было» здесь ответ хуже, чем
-- «отозван тогда-то».
CREATE TABLE "api_keys" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "hint" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
