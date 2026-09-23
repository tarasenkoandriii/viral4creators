/**
 * Миграции обязаны называть таблицы так, как они называются В БАЗЕ.
 *
 * В схеме у каждой модели есть `@@map`: модель `SharedVideoPage` — это
 * таблица `shared_video_pages`. Миграции пишутся РУКАМИ
 * (doc/TELEGRAM-ADMIN.md §5), и перепутать одно с другим ничего не
 * мешает: SQL с именем модели синтаксически безупречен, `prisma
 * validate` его не читает вовсе, а падает он уже на проде — при
 * `migrate deploy`, кодом 42P01 «relation does not exist». Причём
 * падает дорого: неудавшаяся миграция записывается в
 * `_prisma_migrations` как failed и блокирует ВСЕ последующие, пока
 * кто-то не выполнит `prisma migrate resolve --rolled-back` руками по
 * боевой базе.
 *
 * Так и случилось с `20261209090000_shared_video_poster`. Эта проверка
 * — чтобы второй раз не случилось.
 *
 * Почему текстом, а не через Prisma: `prisma validate`/`migrate diff`
 * требуют движка, который качается с binaries.prisma.sh, а её в
 * песочнице разработки нет (doc/CI.md). Сверка имён — чистая работа со
 * строками, и она доступна всегда, в том числе до пуша.
 */

import * as fs from 'fs';
import * as path from 'path';

const PRISMA_DIR = path.join(__dirname, '..', '..', 'prisma');

/** Имена таблиц из `@@map` — единственные, которые существуют в базе. */
function mappedTables(): Set<string> {
  const schema = fs.readFileSync(
    path.join(PRISMA_DIR, 'schema.prisma'),
    'utf8',
  );
  return new Set([...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]));
}

interface Reference {
  migration: string;
  table: string;
}

/** Все таблицы, к которым обращаются миграции — без комментариев. */
function tableReferences(): Reference[] {
  const dir = path.join(PRISMA_DIR, 'migrations');
  const out: Reference[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    // Комментарии выкусываем: в них имена моделей упоминаются законно,
    // и ловить их было бы ложной тревогой.
    const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(
      /(?:ALTER|CREATE) TABLE(?: IF NOT EXISTS)?\s+"([^"]+)"/g,
    )) {
      out.push({ migration: name, table: m[1] });
    }
  }
  return out;
}

describe('миграции называют таблицы так же, как база', () => {
  const tables = mappedTables();
  const refs = tableReferences();

  it('проверка вообще что-то читает — иначе она зелёная впустую', () => {
    // Без этого сломанный разбор схемы или путь к миграциям дал бы
    // пустые множества и вечно зелёный тест.
    expect(tables.size).toBeGreaterThan(50);
    expect(refs.length).toBeGreaterThan(50);
  });

  it('ни одна миграция не обращается к имени МОДЕЛИ вместо таблицы', () => {
    const unknown = refs.filter((r) => !tables.has(r.table));
    // Сообщение называет и файл, и имя: чинить придётся именно там.
    expect(unknown.map((r) => `${r.migration}: "${r.table}"`)).toEqual([]);
  });
});
