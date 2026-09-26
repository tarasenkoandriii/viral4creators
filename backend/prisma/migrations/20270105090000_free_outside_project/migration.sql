-- Уточнения тестового доступа (этап 159,
-- `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §4).
--
-- Операции вне проекта (клон голоса, озвучка, скетч, поиск на YouTube)
-- получают СВОЮ галочку вместо неявного правила «бесплатно, только если
-- отмечены все три сценария». Правило было верным по происхождению, но
-- тестировщику одного сценария означало, что половина его работы идёт
-- за его счёт, и узнавал он об этом в середине прогона.
ALTER TABLE "users" ADD COLUMN "freeOutsideProject" BOOLEAN NOT NULL DEFAULT false;
-- Свой потолок: общий `DAILY_SPEND_LIMIT_USD_TEST_USER` — это потолок
-- НА КАЖДОГО тестировщика, трое это втрое больше денег в сутки.
ALTER TABLE "users" ADD COLUMN "testDailyLimitUsd" INTEGER;

ALTER TABLE "tester_invites" ADD COLUMN "freeOutsideProject" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tester_invites" ADD COLUMN "dailyLimitUsd" INTEGER;

-- Перенос прежнего правила в явный вид: у кого стояли ВСЕ ТРИ сценария,
-- у того операции вне проекта и были бесплатны. Без этой строки смена
-- правила молча отняла бы доступ у живых тестировщиков — ровно у тех,
-- кому его дали шире всего.
UPDATE "users"
SET "freeOutsideProject" = true
WHERE "isTestUser" = true
  AND "freeScenarios" @> ARRAY['PRODUCT_VIDEO', 'CLIENT_SITE', 'GREETING_VIDEO']::text[];
