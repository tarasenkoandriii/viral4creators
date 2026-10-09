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

const url = process.env.SITES_DIRECT_URL;

// Заход 12 (09.10.2026): прод `assist-api` не собирался с первого деплоя —
// в env проекта Vercel не было `SITES_DIRECT_URL`, а Prisma отвечала лишь
// «datasource.url property is required». Для `migrate` без строки — отказ
// с именем переменной и ссылкой; `prisma generate` (postinstall) строка не
// нужна, его не трогаем.
if (!url && process.argv.includes('migrate')) {
  throw new Error(
    'Не задана SITES_DIRECT_URL — прямая строка Postgres (порт 5432) с ?schema=sites; ' +
      'на Vercel: проект assist-api → Settings → Environment Variables (Production и Preview), ' +
      'см. doc/DEPLOYMENT.md §6.1-бис и §6.3',
  );
}

// Аудит P2-4: строка без `?schema=sites` (или с другой схемой) — отказ ДО
// любой команды migrate: иначе миграции сайтов молча уехали бы в `public`
// генератора. Значение строки (пароль) в сообщение не попадает. Не задана —
// как раньше: Prisma сама скажет, что строки нет.
if (url) {
  let schema: string | null = null;
  try {
    schema = new URL(url).searchParams.get('schema');
  } catch {
    throw new Error(
      'SITES_DIRECT_URL: не разбирается как URL — ожидается postgresql://…?schema=sites',
    );
  }
  if (schema !== 'sites') {
    throw new Error(
      `SITES_DIRECT_URL: нужен параметр ?schema=sites (сейчас: ${schema === null ? 'нет' : `«${schema}»`}) — иначе миграции sites-backend попадут в чужую схему (doc/DEPLOYMENT.md)`,
    );
  }
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma/schema.prisma'),
  datasource: {
    url,
  },
});
