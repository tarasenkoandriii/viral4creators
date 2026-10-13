/**
 * Владение таблицами (P-A1, проектный документ §6.8, аудит P3-28): код
 * зоны `publisher/<зона>/**` пишет только таблицы своего пакета, а код ВНЕ
 * модуля publisher (весь `src/`) — ни одной `pub_*`. Ищутся
 * `.pubXxx.(create|update|upsert|delete)…(` — любой метод с этими
 * префиксами (`createManyAndReturn`, `updateManyAndReturn` Prisma 6.2+…),
 * `casUpdate(tx.pubXxx, …)` и сырые `INSERT INTO / UPDATE / DELETE FROM
 * pub_*`, в том числе со схемой через интерполяцию (`UPDATE ${S}."pub_…"`,
 * аудит P-A1 P3-12). Явные исключения:
 *  - `pub_approvals` — три пакета (тип проверяет сервис каждого);
 *  - `reports/restore.service.ts` — восстановление во все таблицы (§15.4);
 *  - `core/housekeeping.job.ts` — удаление просроченных `pub_rate_hits`
 *    (§15.1 housekeeping — задание P-A1);
 *  - `common/secrets-rotation.ts` — перешифровка `pub_lead_contacts`,
 *    `pub_prospects`, `pub_lead_decisions` (скрипт ротации ключа, §15.4);
 *  - `reports/experiments.service.ts` — `pub_campaigns.experimentId`
 *    кампании пилота (интеграция Z-1, Р-PUB-Z1-8);
 *  - `ai/eval/testing/synthetic-seed.ts` — синтетика набора 30 задач в
 *    `pub_sources`/`pub_role_grants` продукта `kind=eval` (Р-PUB-B2-1,
 *    Р-PUB-Z1-13). Файл лежит в `testing/`, но его вызывает CLI
 *    `eval:publisher --seed`, поэтому он СКАНИРУЕТСЯ (`SCANNED_TESTING`) и
 *    проходит только по этому исключению.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  TABLE_OWNERS,
  pubTableRegistry,
  type PackageId,
} from './table-registry';

/** Весь `src/` — запись в `pub_*` вне модуля publisher тоже ловится. */
const SRC = path.join(__dirname, '../../..');
const OUTSIDE = 'outside' as const;

/** Пакет по пути внутри модуля publisher. */
export function packageOf(rel: string): PackageId | null {
  if (/^(core|cron|contracts|testing)\//.test(rel)) return 'P-A1';
  if (/^content\//.test(rel)) return 'P-B1';
  if (/^ai\//.test(rel)) return 'P-B2';
  if (/^distribution\//.test(rel)) return 'P-C';
  if (/^leads\//.test(rel)) return 'P-D';
  if (/^reports\//.test(rel)) return 'P-E';
  if (/^reddit\//.test(rel)) return 'P-R';
  if (/^public\/content-public/.test(rel)) return 'P-B1';
  if (/^public\//.test(rel)) return 'P-D';
  return null;
}

/** Пути исключений — от `src/`. */
const EXCEPTIONS: Array<{ file: RegExp; table: RegExp }> = [
  {
    file: /^modules\/publisher\/reports\/restore\.service\.ts$/,
    table: /^pub_/,
  },
  {
    file: /^modules\/publisher\/core\/housekeeping\.job\.ts$/,
    table: /^pub_rate_hits$/,
  },
  {
    file: /^common\/secrets-rotation\.ts$/,
    table: /^pub_(lead_contacts|prospects|lead_decisions)$/,
  },
  {
    file: /^modules\/publisher\/reports\/experiments\.service\.ts$/,
    table: /^pub_campaigns$/,
  },
  {
    file: /^modules\/publisher\/ai\/eval\/testing\/synthetic-seed\.ts$/,
    table: /^pub_(sources|role_grants)$/,
  },
];

/** Файлы `testing/`, которые зовёт прод-код (CLI) — сканируются как код. */
const SCANNED_TESTING = [
  /^modules\/publisher\/ai\/eval\/testing\/synthetic-seed\.ts$/,
];

const WRITE_RE =
  /\.(pub[A-Z][A-Za-z]*)\s*\.\s*((?:create|update|upsert|delete)\w*)\s*\(/g;
const CAS_RE = /casUpdate\(\s*[\w.]*?\.(pub[A-Z][A-Za-z]*)\s*,/g;
const SQL_RE =
  /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:"?sites"?|\$\{\s*[\w.]+\s*\})\.)?"?(pub_[a-z_]+)"?/g;

export function writesIn(
  source: string,
  delegates: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(WRITE_RE)) {
    const t = delegates.get(m[1]);
    if (t) out.add(t);
  }
  for (const m of source.matchAll(CAS_RE)) {
    const t = delegates.get(m[1]);
    if (t) out.add(t);
  }
  for (const m of source.matchAll(SQL_RE)) out.add(m[1]);
  return [...out];
}

/** Исходники `src/` без тестов: `rel` — от `src/`, `pkg` — пакет или OUTSIDE. */
function sources(): Array<{
  rel: string;
  pkg: PackageId | typeof OUTSIDE | null;
  code: string;
}> {
  const out: Array<{
    rel: string;
    pkg: PackageId | typeof OUTSIDE | null;
    code: string;
  }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(f);
      } else if (
        /\.ts$/.test(e.name) &&
        !/\.d\.ts$/.test(e.name) &&
        !/\.(spec|testing)\.ts$/.test(e.name) &&
        (!/(^|\/)testing\//.test(path.relative(SRC, f)) ||
          SCANNED_TESTING.some((r) =>
            r.test(path.relative(SRC, f).split(path.sep).join('/')),
          ))
      ) {
        const rel = path.relative(SRC, f).split(path.sep).join('/');
        const inPub = rel.startsWith('modules/publisher/');
        out.push({
          rel,
          pkg: inPub
            ? packageOf(rel.slice('modules/publisher/'.length))
            : OUTSIDE,
          code: fs.readFileSync(f, 'utf8'),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

describe('table-ownership (§6.8)', () => {
  const registry = pubTableRegistry();
  const delegates = new Map(registry.map((t) => [t.delegate, t.table]));

  it('у каждой таблицы pub_* есть владелец', () => {
    expect(
      registry.filter((t) => t.owners.length === 0).map((t) => t.table),
    ).toEqual([]);
    expect(Object.keys(TABLE_OWNERS).sort()).toEqual(
      registry.map((t) => t.table).sort(),
    );
  });

  it('код зоны пишет только свои таблицы, вне publisher — ни одной (исключения — поимённо)', () => {
    const violations: string[] = [];
    let scanned = 0;
    let outside = 0;
    for (const { rel, pkg, code } of sources()) {
      if (!pkg) continue;
      if (pkg === OUTSIDE) outside++;
      else scanned++;
      for (const table of writesIn(code, delegates)) {
        if (pkg !== OUTSIDE && (TABLE_OWNERS[table] ?? []).includes(pkg))
          continue;
        if (EXCEPTIONS.some((x) => x.file.test(rel) && x.table.test(table)))
          continue;
        violations.push(`${rel} (${pkg}) → ${table}`);
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(outside).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  it('синтетика eval сканируется и пишет только разрешённое исключением (Р-PUB-Z1-13)', () => {
    const seed = sources().find((x) =>
      x.rel.endsWith('publisher/ai/eval/testing/synthetic-seed.ts'),
    );
    expect(seed?.pkg).toBe('P-B2');
    expect(writesIn(seed!.code, delegates).sort()).toEqual([
      'pub_role_grants',
      'pub_sources',
    ]);
  });

  it('детектор ловит запись в чужую таблицу (самопроверка на фикстуре)', () => {
    const fixture = [
      `await tx.pubLead.update({ where: { id } });`,
      `await casUpdate(tx.pubPlacement, id, 1, {});`,
      'await tx.$executeRaw`UPDATE "sites"."pub_expenses" SET x = 1`;',
      'await db.$executeRaw`DELETE FROM pub_rate_hits WHERE 1`;',
      `await tx.pubProduct.findFirst({});`,
      // аудит P3-12: новые методы Prisma и схема через интерполяцию
      `await tx.pubPayment.updateManyAndReturn({ where: {} });`,
      `await tx.pubSession.createManyAndReturn({ data: [] });`,
      'await db.$executeRawUnsafe(`UPDATE ${S}."pub_events" SET x = 1`);',
      'await db.$executeRawUnsafe(`INSERT INTO ${SCHEMA}.pub_notifications VALUES (1)`);',
    ].join('\n');
    expect(writesIn(fixture, delegates).sort()).toEqual([
      'pub_events',
      'pub_expenses',
      'pub_leads',
      'pub_notifications',
      'pub_payments',
      'pub_placements',
      'pub_rate_hits',
      'pub_sessions',
    ]);
    expect(packageOf('public/content-public.controller.ts')).toBe('P-B1');
    expect(packageOf('public/lead-intake.ts')).toBe('P-D');
    expect(packageOf('reddit/opportunities.service.ts')).toBe('P-R');
  });
});
