-- Этап 2 плана docs-tz/AUDIT-Greeting-Landing-And-Upgrade-Plan.md
-- (фичи №1 и №3 компаньон-ТЗ): поводов стало 24 вместо 7, тонов 5 вместо 3.
--
-- Аддитивная миграция: существующие значения enum не трогаются и не
-- переименовываются, поэтому ни одна уже созданная запись GreetingBrief
-- не меняет смысла.
--
-- `ALTER TYPE ... ADD VALUE` в PostgreSQL 12+ работает внутри
-- транзакции, если добавленное значение в ней же не используется —
-- здесь оно и не используется: миграция только объявляет значения,
-- писать ими начнёт уже приложение.
--
-- Что означает каждый повод для генерации сценария и какие тоны у него
-- допустимы, лежит НЕ здесь, а в backend/src/common/greeting-occasions.ts:
-- база хранит код, смысл живёт в коде (та же граница, что у PlanFeature
-- в common/plans.ts).

ALTER TYPE "GreetingOccasion" ADD VALUE 'CHRISTMAS';
ALTER TYPE "GreetingOccasion" ADD VALUE 'VALENTINES_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'WOMENS_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'MOTHERS_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'FATHERS_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'DEFENDERS_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'TEACHERS_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'FIRST_SCHOOL_DAY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'NEW_BABY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'BAPTISM';
ALTER TYPE "GreetingOccasion" ADD VALUE 'HOUSEWARMING';
ALTER TYPE "GreetingOccasion" ADD VALUE 'PROMOTION';
ALTER TYPE "GreetingOccasion" ADD VALUE 'RETIREMENT';
ALTER TYPE "GreetingOccasion" ADD VALUE 'FAREWELL_COLLEAGUE';
ALTER TYPE "GreetingOccasion" ADD VALUE 'APOLOGY';
ALTER TYPE "GreetingOccasion" ADD VALUE 'GET_WELL';
ALTER TYPE "GreetingOccasion" ADD VALUE 'CONDOLENCE';

ALTER TYPE "GreetingTone" ADD VALUE 'SUPPORTIVE';
ALTER TYPE "GreetingTone" ADD VALUE 'RESPECTFUL';
