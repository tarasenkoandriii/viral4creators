-- Этап 54 (Б-3.7): ограничение частоты запросов живёт в базе, а не в памяти
-- экземпляра функции — иначе на Vercel каждый холодный старт обнулял бы
-- счётчик. Одна строка на «маршрут|IP», окно фиксированное; закрывшиеся
-- окна убирает крон уборки.
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- Уборка идёт по времени окна.
CREATE INDEX "rate_limits_windowStart_idx" ON "rate_limits"("windowStart");

-- Этап 54 (Б-3.8): режим, выбранный самим пользователем, пока оплаты
-- нет, не поднимает суточный потолок расхода. Существующие строки
-- считаются назначенными оператором (false) — поведение для них не
-- меняется; новые самостоятельные переключения помечаются true.
ALTER TABLE "users" ADD COLUMN "planSelfService" BOOLEAN NOT NULL DEFAULT false;

-- Этап 54 (В-4.9): поиск оператора по подстроке (`ILIKE '%…%'`) читал
-- таблицу целиком — 83,6 мс на 60 тыс. записей библиотеки и линейно
-- дальше. Триграммный GIN обслуживает подстроку индексом. pg_trgm входит
-- в стандартную поставку Postgres и доступен в Supabase.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX "analysis_library_title_trgm_idx" ON "analysis_library" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "analysis_library_category_trgm_idx" ON "analysis_library" USING GIN ("category" gin_trgm_ops);
CREATE INDEX "analysis_library_sourceKey_trgm_idx" ON "analysis_library" USING GIN ("sourceKey" gin_trgm_ops);
-- Таблица users триграммных индексов НЕ получает: на её размере (тысячи
-- строк) планировщик читает её целиком быстрее, чем через индекс, — на
-- 3 000 строк это 2,5 мс против 3,3 мс с принудительным индексом.
