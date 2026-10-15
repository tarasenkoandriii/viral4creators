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
 *  4. AI Publisher (P-A0, проектный документ §5.2, §6.5): в миграциях
 *     `*_publisher_*` нет CHECK и CONSTRAINT TRIGGER; каждая таблица `pub_*`
 *     отозвана у PUBLIC, `assist_public` и `publisher_public`; роль
 *     `publisher_public` получает права только на явный список, а
 *     `assist_public` — ни на одну `pub_*`, и `createdBy` с серверным
 *     временем ролью не вставляются; функция триггера или читающая таблицы
 *     — SECURITY DEFINER с `search_path = pg_catalog, pg_temp`, чистый
 *     помощник — без DEFINER и без SET (встраивается планировщиком) и без
 *     таблиц (аудит P3-12); EXECUTE у PUBLIC снят у функций каждой
 *     миграции. На базе то же проверяют publisher-public-role.spec.ts и
 *     publisher-triggers.db.spec.ts.
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

describe('миграции AI Publisher (pub_*)', () => {
  const tables = [...mappedTables()].filter((t) => t.startsWith('pub_'));
  const pubMigs = migrations().filter((m) => /_publisher_/.test(m.name));
  const all = migrations();
  /** Отношения, на которые роль publisher_public получает права (§6.5). */
  const PUBLISHER_PUBLIC_GRANTS = new Set([
    'pub_public_products',
    'pub_public_contents',
    'pub_leads',
    'pub_lead_contacts',
    'pub_events',
    'pub_sessions',
    'pub_lead_outbox',
    'pub_rate_hits',
  ]);

  it('проверка не пустая: 73 таблицы (66 P0 + 7 pub_reddit_* P-R) и миграции publisher_core, publisher_reddit, publisher_reddit_m2, publisher_admin_actor на месте', () => {
    expect(tables).toHaveLength(73);
    expect(pubMigs.map((m) => m.name)).toContain(
      '20261023090000_publisher_admin_actor',
    );
    expect(pubMigs.map((m) => m.name)).toContain(
      '20261021090000_publisher_reddit_m2',
    );
    expect(pubMigs.map((m) => m.name)).toContain(
      '20261020090000_publisher_reddit',
    );
    expect(pubMigs.map((m) => m.name)).toContain(
      '20261016090000_publisher_core',
    );
  });

  it('в миграциях Publisher нет CHECK и CONSTRAINT TRIGGER (§5.2: триггеры с 23514)', () => {
    const hits: string[] = [];
    for (const m of pubMigs) {
      if (/\bCHECK\s*\(/i.test(m.sql)) hits.push(`${m.name}: CHECK`);
      if (/CONSTRAINT\s+TRIGGER/i.test(m.sql)) {
        hits.push(`${m.name}: CONSTRAINT TRIGGER`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('каждая pub_* отозвана у PUBLIC, publisher_public и assist_public', () => {
    const revokes = pubMigs
      .flatMap((m) => [
        ...m.sql.matchAll(/REVOKE\s+ALL\s+ON\s+([\s\S]*?)\s+FROM\s+([^;]+);/gi),
      ])
      .filter(
        (r) =>
          /PUBLIC/.test(r[2]) &&
          /publisher_public/.test(r[2]) &&
          /assist_public/.test(r[2]),
      )
      .map((r) => r[1]);
    const missing = tables.filter(
      (t) => !revokes.some((r) => r.includes(`"${t}"`)),
    );
    expect(missing).toEqual([]);
  });

  it('assist_public не получает прав ни на одну pub_*; publisher_public — только явный список', () => {
    const leaks: string[] = [];
    for (const m of all) {
      for (const g of m.sql.matchAll(/GRANT\s[\s\S]*?;/gi)) {
        const stmt = g[0].replace(/\s+/g, ' ');
        if (/assist_public/i.test(stmt) && /"?pub_/i.test(stmt))
          leaks.push(`${m.name}: ${stmt}`);
        if (
          /\bTO\s+publisher_public\b/i.test(stmt) &&
          !/^GRANT USAGE ON SCHEMA/i.test(stmt)
        ) {
          const rels = [...stmt.matchAll(/"([a-z_]+)"(?=\s*(?:,|TO\b))/gi)].map(
            (r) => r[1],
          );
          const target = /\bON\s+([\s\S]*?)\s+TO\b/i.exec(stmt)?.[1] ?? '';
          const named = [...target.matchAll(/"([a-z_]+)"/g)].map((r) => r[1]);
          for (const t of named.length ? named : rels) {
            if (!PUBLISHER_PUBLIC_GRANTS.has(t))
              leaks.push(`${m.name}: ${t} → publisher_public`);
          }
          if (/ALL\s+TABLES/i.test(stmt))
            leaks.push(`${m.name}: ALL TABLES → publisher_public`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('функции Publisher: триггерные и читающие таблицы — SECURITY DEFINER с search_path = pg_catalog, pg_temp; чистые — без DEFINER, SET и таблиц (§5.2, аудит P3-12)', () => {
    const bad: string[] = [];
    let definer = 0;
    let pure = 0;
    for (const m of pubMigs) {
      for (const f of m.sql.matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([\w]+)"?\s*\(([\s\S]*?)\bAS\s+\$\$([\s\S]*?)\$\$/gi,
      )) {
        const [, name, head, body] = f;
        const isTrigger = /RETURNS\s+trigger/i.test(head);
        const readsTables =
          /"sites"\."(pub|site)_[a-z_]+"(?!\s*\()/.test(body) ||
          /EXECUTE\s+format/i.test(body);
        const isDefiner = /SECURITY\s+DEFINER/i.test(head);
        const hasSet = /\bSET\s+search_path/i.test(head);
        if (isTrigger || readsTables) {
          definer++;
          if (
            !/SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp/i.test(
              head,
            )
          ) {
            bad.push(`${m.name}: ${name} — нужен DEFINER + search_path`);
          }
        } else {
          pure++;
          if (isDefiner || hasSet) {
            bad.push(`${m.name}: ${name} — чистый помощник без DEFINER/SET`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // Проверка вообще что-то нашла.
    expect(definer).toBeGreaterThanOrEqual(70);
    expect(pure).toBeGreaterThanOrEqual(15);
  });

  it('каждая миграция Publisher с функциями снимает EXECUTE у PUBLIC (контракт слотов P-B…P-E)', () => {
    const missing = pubMigs
      .filter((m) => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(m.sql))
      .filter(
        (m) =>
          !/REVOKE\s+ALL\s+ON\s+FUNCTION\s+%s\s+FROM\s+PUBLIC/i.test(m.sql) &&
          !/REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+(?:ALL\s+)?FUNCTIONS?\b[\s\S]*?\bFROM\s+PUBLIC/i.test(
            m.sql,
          ),
      )
      .map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it('каждая миграция Publisher с таблицами снимает права anon/authenticated (Supabase; аудит P3-14, контракт слотов)', () => {
    const missing = pubMigs
      .filter((m) => /CREATE\s+(?:TABLE|VIEW)\s+"pub_/i.test(m.sql))
      .filter(
        (m) =>
          !m.sql.includes("'{anon,authenticated}'") &&
          !/REVOKE\s+ALL\s+ON\s[^;]*FROM\s[^;]*\banon\b[^;]*\bauthenticated\b/i.test(
            m.sql,
          ),
      )
      .map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it('publisher_public не вставляет createdBy и серверное время (аудит P1-2, P3-6)', () => {
    const leaks: string[] = [];
    for (const m of all) {
      for (const g of m.sql.matchAll(
        /GRANT\s+INSERT\s*\(([^)]*)\)[^;]*?TO\s+publisher_public/gi,
      )) {
        for (const c of [
          'createdBy',
          'receivedAt',
          'occurredAt',
          'startedAt',
          'createdAt',
        ]) {
          if (g[1].includes(`"${c}"`)) leaks.push(`${m.name}: ${c}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
