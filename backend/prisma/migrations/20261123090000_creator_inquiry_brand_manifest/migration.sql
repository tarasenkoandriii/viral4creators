-- Закрытие §21.7 общего ТЗ: бриф может нести ссылку на брендбук.
-- Аддитивная миграция, без @relation — brand-manifest не становится
-- зависимостью модуля creator-inquiry ради одного nullable-поля.

ALTER TABLE "creator_inquiries" ADD COLUMN "brandManifestId" TEXT;
