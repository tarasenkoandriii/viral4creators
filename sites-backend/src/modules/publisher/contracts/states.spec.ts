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

const MIGRATIONS = path.join(__dirname, '../../../../prisma/migrations');
const read = (name: string) =>
  fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/** Блок `CREATE [OR REPLACE] FUNCTION "<имя>"(…) … $$;`. */
const FN_BLOCK =
  /CREATE (?:OR REPLACE )?FUNCTION "([a-z_]+)"\(([^)]*)\)[\s\S]*?\$\$[\s\S]*?\$\$;/g;

/**
 * Действующий SQL закрытых списков: `…_publisher_core`, в котором функции,
 * пересозданные миграцией P-R `…_publisher_reddit` (`CREATE OR REPLACE`:
 * `pub_object_types`, `pub_parameter_keys`, `pub_audit_events_guard`),
 * заменены новыми определениями, плюс остальной SQL миграции P-R (таблицы
 * `pub_reddit_*` и их гварды). Старые определения в разбор не попадают.
 */
function effectiveSql(): string {
  const core = read('20261016090000_publisher_core');
  const reddit = read('20261020090000_publisher_reddit');
  const redefined = new Map<string, string>();
  for (const m of reddit.matchAll(FN_BLOCK))
    if (/CREATE OR REPLACE/.test(m[0]))
      redefined.set(m[1], m[0].replace('CREATE OR REPLACE', 'CREATE'));
  const patched = core.replace(
    FN_BLOCK,
    (block, name: string) => redefined.get(name) ?? block,
  );
  const rest = reddit.replace(FN_BLOCK, (block) =>
    /CREATE OR REPLACE/.test(block) ? '' : block,
  );
  return `${patched}\n${rest}`;
}

const SQL = effectiveSql();

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

describe('contracts/states.ts ≡ триггеры миграций publisher_core + publisher_reddit', () => {
  it('миграция P-R пересоздаёт три функции-списка ядра (разбор действующего SQL работает)', () => {
    const reddit = read('20261020090000_publisher_reddit');
    const names = [...reddit.matchAll(FN_BLOCK)]
      .filter((m) => /CREATE OR REPLACE/.test(m[0]))
      .map((m) => m[1])
      .sort();
    expect(names).toEqual([
      'pub_audit_events_guard',
      'pub_object_types',
      'pub_parameter_keys',
    ]);
    expect(SQL).toContain(`'reddit_rules_stale_days'`);
    expect(SQL).toContain(`'report_publication'`);
    expect(SQL.match(/CREATE FUNCTION "pub_object_types"\(\)/g)).toHaveLength(
      1,
    );
  });

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
