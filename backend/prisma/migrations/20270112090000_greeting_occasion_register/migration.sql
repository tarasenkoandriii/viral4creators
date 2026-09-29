-- Этап B ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md (§3.2–§3.4):
-- регистр «Особого повода».
--
-- У поводов из каталога регистр задаёт код (backend/src/common/
-- greeting-occasions.ts) и в базе не хранится. У OTHER он зависит от
-- описания повода, поэтому хранится в брифе вместе с источником — кто его
-- определил: человек, ключевые слова или классификатор.
--
-- Аддитивная миграция: обе колонки NULL-допустимые, существующие брифы не
-- меняются. Бриф OTHER без регистра читается приложением как «тёплый
-- нейтральный» (registerOfBrief) — строже прежнего «праздничного по
-- умолчанию», и это намеренно.

CREATE TYPE "GreetingRegister" AS ENUM ('CELEBRATORY', 'WARM_NEUTRAL', 'SOLEMN', 'SENSITIVE', 'MOURNING');

ALTER TABLE "greeting_briefs" ADD COLUMN "occasionRegister" "GreetingRegister";
ALTER TABLE "greeting_briefs" ADD COLUMN "registerSource" TEXT;
