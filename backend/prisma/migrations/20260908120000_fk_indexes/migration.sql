-- Миграция 20 (этап 42, находка Б-1.4).
--
-- Четыре внешних ключа с `ON DELETE SET NULL` не имели индексов, и
-- Postgres проверял их полным сканом при каждом удалении родителя.
-- Измерено на 60 тыс. заявок и 60 тыс. записей библиотеки:
--
--   DELETE проекта с тремя товарами  105,4 мс → 1,8 мс   (58×)
--   DELETE пользователя              328–365 мс → 16,1 мс (21×)
--
-- Число сканов равно числу товаров плюс один: для линейки в двадцать
-- позиций это ~370 мс внутри HTTP-запроса и под транзакцией, держащей
-- соединение пулера. Цена — 3,6 МБ на таблицах, в которые пишут редко.
--
-- CREATE INDEX без CONCURRENTLY: миграции идут в транзакции, а таблицы
-- маленькие — блокировка на запись длится миллисекунды.

CREATE INDEX "publication_requests_projectId_idx" ON "publication_requests"("projectId");
CREATE INDEX "publication_requests_productItemId_idx" ON "publication_requests"("productItemId");
CREATE INDEX "publication_requests_moderatorId_idx" ON "publication_requests"("moderatorId");
CREATE INDEX "analysis_library_moderatedById_idx" ON "analysis_library"("moderatedById");
