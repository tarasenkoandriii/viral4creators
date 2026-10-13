/**
 * Закрытые списки = триггеры миграции (P-A1; аудит этапа 0 §17.2: «каждый
 * закрытый список = триггер = contracts/states.ts»). Разбирается
 * migration.sql `…_publisher_core`:
 *  1. каждый `ARRAY['…']` миграции равен (с порядком) какому-то списку
 *     контрактов — иначе в базе список, которого нет в TS;
 *  2. список в проверке с сообщением `<таблица>.<поле>: вне списка` равен
 *     `PUB_CLOSED_LISTS['<таблица>.<поле>']`;
 *  3. каждый список `PUB_CLOSED_LISTS` есть в миграции.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GENERATOR_IDS } from './ai';
import { PARAMETER_KEYS } from './parameters';
import {
  AUDIT_META_FORBIDDEN_KEYS,
  RESPONSE_FORBIDDEN_KEYS,
} from '../core/pii-guard';
import {
  DEPENDENT_STAGES,
  LEAD_STATUSES,
  OBJECT_TYPES,
  PUB_CLOSED_LISTS,
} from './states';

const SQL = fs.readFileSync(
  path.join(
    __dirname,
    '../../../../prisma/migrations/20261016090000_publisher_core/migration.sql',
  ),
  'utf8',
);

const listsIn = (text: string): string[][] =>
  [...text.matchAll(/ARRAY\[((?:'[^']*'\s*,?\s*)+)\]/g)].map((m) =>
    [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]),
  );

const FUNCTION_LISTS: Record<string, readonly string[]> = {
  pub_parameter_keys: PARAMETER_KEYS,
  pub_object_types: OBJECT_TYPES,
  pub_generators: GENERATOR_IDS,
  pub_lead_statuses: LEAD_STATUSES,
  pub_channel_groups: PUB_CLOSED_LISTS['pub_events.channelGroup'],
};

const KNOWN: ReadonlyArray<readonly string[]> = [
  ...Object.values(PUB_CLOSED_LISTS),
  PARAMETER_KEYS,
  GENERATOR_IDS,
  AUDIT_META_FORBIDDEN_KEYS,
  RESPONSE_FORBIDDEN_KEYS,
  DEPENDENT_STAGES,
];
const key = (l: readonly string[]) => JSON.stringify(l);

describe('contracts/states.ts ≡ триггеры миграции publisher_core', () => {
  const all = listsIn(SQL);

  it('в миграции есть списки (разбор работает)', () => {
    expect(all.length).toBeGreaterThan(90);
  });

  it('каждый ARRAY[...] миграции — список контрактов (с порядком)', () => {
    const known = new Set(KNOWN.map(key));
    const unknown = [...new Set(all.map(key))].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('функции-списки миграции = контракты', () => {
    for (const [fn, list] of Object.entries(FUNCTION_LISTS)) {
      const m = new RegExp(
        `CREATE FUNCTION "${fn}"\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
      ).exec(SQL);
      expect({ fn, list: m ? listsIn(m[1])[0] : null }).toEqual({
        fn,
        list: [...list],
      });
    }
  });

  it('проверка с сообщением «<таблица>.<поле>: вне списка» — ровно список PUB_CLOSED_LISTS', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const m of SQL.matchAll(
      /pub_chk"\(([\s\S]*?)'(pub_[a-z_]+\.[A-Za-z]+): вне (?:списка|PARAMETER_KEYS)'/g,
    )) {
      const field = m[2];
      const body = m[1].slice(m[1].lastIndexOf('pub_chk"(') + 1);
      const lists = listsIn(body);
      const fn = /"(pub_[a-z_]+)"\(\)/.exec(body)?.[1];
      const actual = lists.length
        ? lists[0]
        : fn
          ? [...(FUNCTION_LISTS[fn] ?? [])]
          : null;
      if (!actual) continue;
      checked++;
      const expected = PUB_CLOSED_LISTS[field];
      if (!expected || key(expected) !== key(actual)) mismatches.push(field);
    }
    expect(checked).toBeGreaterThan(60);
    expect(mismatches).toEqual([]);
  });

  it('каждый список PUB_CLOSED_LISTS есть в миграции (массивом или функцией)', () => {
    const inSql = new Set([
      ...all.map(key),
      ...Object.values(FUNCTION_LISTS).map(key),
    ]);
    const missing = Object.entries(PUB_CLOSED_LISTS)
      .filter(([, l]) => !inSql.has(key(l)))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
