/**
 * Ops-скрипт: заводит/обновляет фикстурного пользователя для
 * автоматического исполнителя сценариев обучающих видео (§3.3 ТЗ
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97).
 *
 * Тело сидирования переехало этапом 105 в
 * `src/modules/tutorial-runner/fixture-seed.ts` — этот файл теперь
 * только достаёт env и открывает подключение к БД, у самой логики
 * appeared второй потребитель: `POST /admin/tutorial-runner/seed-fixture-user`
 * (`FixtureSeedAdminController`, тот же модуль) даёт запустить то же
 * самое кнопкой в админке («Настройки» → группа «Обучалка»), не имея
 * доступа к серверу/CI — полезно, когда владелец продукта не может
 * прогнать CLI-команду сам. У обоих потребителей одна и та же
 * идемпотентная логика — расхождения между «через CLI» и «через кнопку»
 * структурно невозможны.
 *
 * ## Почему НЕ часть деплоя/миграций
 *
 * Это данные одной конкретной вымышленной учётной записи, а не схема:
 * прогонять их при каждом деплое незачем. Запускать вручную:
 *   cd backend && DATABASE_URL=... FIXTURE_TELEGRAM_ID=... \
 *     npx ts-node --transpile-only scripts/seed-fixture-user.ts
 * (те же DATABASE_URL/FIXTURE_TELEGRAM_ID, что у бэкенд-деплоя — см.
 * .env.example) — или кнопкой в админке, см. выше.
 *
 * ## Идемпотентность
 *
 * Все ID фиксированы строками (не `cuid()` по умолчанию, см.
 * `fixture-seed.ts`'s `FIXTURE_IDS`) — повторный запуск обновляет те же
 * строки, а не плодит дубликаты. Безопасно перезапускать в любой
 * момент, например после ручной правки одного из полей в консоли
 * Supabase.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedFixtureUser } from '../src/modules/tutorial-runner/fixture-seed';

async function main(): Promise<void> {
  const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
  if (!telegramId) {
    throw new Error(
      'FIXTURE_TELEGRAM_ID не задан — та же переменная, что использует ' +
        'common/fixture-token.ts, см. .env.example',
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL не задан');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
  try {
    const result = await seedFixtureUser(prisma, telegramId);
    for (const line of result.log) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
