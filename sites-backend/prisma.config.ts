// Конфигурация CLI Prisma 7 для sites-backend (приложение её не читает —
// у него своё подключение через драйвер-адаптер, src/prisma/prisma.service.ts).
//
// База та же физическая, что у генератора (backend/), но схема Postgres —
// СВОЯ, `sites`: своя история миграций (`sites._prisma_migrations`), не
// пересекающаяся с миграциями генератора (решение координатора Э0, п.2).
// Поэтому строка — отдельная переменная `SITES_DIRECT_URL`, и в ней
// обязателен `?schema=sites`: по этому параметру migrate ставит
// search_path, создаёт схему и кладёт туда свою таблицу миграций. Без него
// миграции сайтов поехали бы в `public` — к таблицам генератора.
//
// Прямое (не пулерное) подключение — по той же причине, что у backend:
// миграции через пулер в transaction-режиме ненадёжны (doc/PRISMA-SUPABASE.md).
import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'prisma/schema.prisma'),
  datasource: {
    url: process.env.SITES_DIRECT_URL,
  },
});
