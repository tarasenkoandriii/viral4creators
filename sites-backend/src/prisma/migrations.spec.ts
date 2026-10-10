/**
 * Статические проверки миграций — то, что ловится без движка Prisma и без
 * базы (в песочнице разработки нет ни того, ни другого; `migrate diff`
 * работает только в CI).
 *
 *  1. Миграции называют таблицы так, как они называются в базе (`@@map`),
 *     а не именами моделей — урок backend `20261209090000_shared_video_poster`
 *     (42P01 на проде и заблокированная очередь миграций).
 *  2. У каждой таблицы схемы есть CREATE TABLE в миграциях.
 *  3. Ни одна миграция не выдаёт роли `assist_public` прав на таблицы
 *     «Админки» (`assist_admin_*`) — слой 3 изоляции (ТЗ помощника
 *     §4.3-бис). Тест на реальной базе (assist-public-role.spec.ts) это
 *     тоже поймает, но только в CI; здесь — до пуша.
 */

import * as fs from 'fs';
import * as path from 'path';

const PRISMA_DIR = path.join(__dirname, '..', '..', 'prisma');

function mappedTables(): Set<string> {
  const schema = fs.readFileSync(
    path.join(PRISMA_DIR, 'schema.prisma'),
    'utf8',
  );
  return new Set([...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]));
}

interface Migration {
  name: string;
  /** SQL без комментариев. */
  sql: string;
}

function migrations(): Migration[] {
  const dir = path.join(PRISMA_DIR, 'migrations');
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => ({ name, file: path.join(dir, name, 'migration.sql') }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ name, file }) => ({
      name,
      sql: fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, ''),
    }));
}

/**
 * Таблицы, удалённые более поздней миграцией (DROP TABLE): старые миграции
 * их создают и меняют законно. Э4: счётчик диалогов по сайту заменён
 * счётчиком единиц подписки (…_assist_billing).
 */
const DROPPED_TABLES = new Set(['assist_site_period_usage']);

describe('миграции схемы sites', () => {
  const tables = mappedTables();
  const migs = migrations();

  it('проверка вообще что-то читает — иначе она зелёная впустую', () => {
    expect(tables.size).toBeGreaterThanOrEqual(9);
    expect(migs.length).toBeGreaterThanOrEqual(1);
  });

  it('ни одна миграция не обращается к имени МОДЕЛИ вместо таблицы', () => {
    const unknown: string[] = [];
    for (const m of migs) {
      for (const r of m.sql.matchAll(
        /(?:ALTER|CREATE) TABLE(?: IF NOT EXISTS)?\s+(?:(?:"sites"|sites)\.)?"([^"]+)"/g,
      )) {
        if (!tables.has(r[1]) && !DROPPED_TABLES.has(r[1])) {
          unknown.push(`${m.name}: "${r[1]}"`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('у каждой таблицы схемы есть CREATE TABLE', () => {
    const created = new Set<string>();
    for (const m of migs) {
      for (const r of m.sql.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:(?:"sites"|sites)\.)?"([^"]+)"/g,
      )) {
        created.add(r[1]);
      }
    }
    expect([...tables].filter((t) => !created.has(t))).toEqual([]);
  });

  it('assist_public не получает прав на assist_admin_* ни в одной миграции', () => {
    const leaks: string[] = [];
    for (const m of migs) {
      for (const g of m.sql.matchAll(/GRANT\s[\s\S]*?;/gi)) {
        const stmt = g[0];
        if (/assist_public/i.test(stmt) && /assist_admin_/i.test(stmt)) {
          leaks.push(`${m.name}: ${stmt.replace(/\s+/g, ' ')}`);
        }
        // «На все таблицы схемы» — тоже утечка: в схеме лежит и «Админка».
        if (/assist_public/i.test(stmt) && /ALL\s+TABLES/i.test(stmt)) {
          leaks.push(`${m.name}: ${stmt.replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
