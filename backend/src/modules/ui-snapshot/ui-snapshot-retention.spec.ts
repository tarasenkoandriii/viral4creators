/**
 * Срок хранения снимков крон-обхода интерфейса (`ui-snapshot-retention.ts`).
 *
 * Уборка удаляет публичные файлы НЕОБРАТИМО, поэтому тесты — не «работает
 * ли», а «удаляет ли ровно то, что должно, и ничего сверх»: обычные
 * снимки старше трёх дней уходят, а пара «было → стало» страницы админки
 * и база следующего сравнения остаются. База — в памяти, но с теми же
 * фильтрами, что задаёт код (Prisma-подмножество), чтобы проверялись
 * настоящие запросы, а не их пересказ в моке.
 */
import {
  planUiSnapshotPrunePage,
  pruneUiSnapshots,
  UI_SNAPSHOT_PRUNE_BATCH,
  UI_SNAPSHOT_PRUNE_MAX_PAGES,
} from './ui-snapshot-retention';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = new Date('2026-10-01T03:00:00Z');
const BASE = 'https://store.public.blob.vercel-storage.com/';

interface Row {
  id: string;
  createdAt: Date;
  routeKey: string;
  locale: string;
  theme: string;
  blobUrl: string | null;
  comparedToUrl: string | null;
  changed: boolean;
  error: string | null;
}

/* ---------- мини-Prisma по подмножеству фильтров, которое нужно коду ---------- */

type Where = Record<string, unknown>;

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date) {
    return value instanceof Date && value.getTime() === cond.getTime();
  }
  if (typeof cond === 'object') {
    const c = cond as Record<string, unknown>;
    // Строки (id) и даты сравниваются одним оператором — как в SQL.
    const v = (value instanceof Date ? value.getTime() : value) as number;
    const n = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number;
    if ('lt' in c && !(v < n(c.lt))) return false;
    if ('lte' in c && !(v <= n(c.lte))) return false;
    if ('gt' in c && !(v > n(c.gt))) return false;
    if ('gte' in c && !(v >= n(c.gte))) return false;
    if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
    if ('not' in c && c.not === null && value === null) return false;
    return true;
  }
  return value === cond;
}

function matches(row: Row, where: Where = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
    } else if (k === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
    } else if (
      !matchField((row as unknown as Record<string, unknown>)[k], cond)
    )
      return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const list = (
    Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  ) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const av = (a as unknown as Record<string, unknown>)[k];
      const bv = (b as unknown as Record<string, unknown>)[k];
      const x = av instanceof Date ? av.getTime() : (av as string);
      const y = bv instanceof Date ? bv.getTime() : (bv as string);
      if (x < y) return dir === 'asc' ? -1 : 1;
      if (x > y) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select).map((k) => [
      k,
      (row as unknown as Record<string, unknown>)[k],
    ]),
  );
}

function fakeDb(initial: Row[]) {
  let rows = [...initial];
  const log: string[] = [];
  const uiSnapshot = {
    groupBy: jest.fn(async (args: { by: string[]; where: Where }) => {
      const seen = new Map<string, Record<string, unknown>>();
      for (const r of rows.filter((x) => matches(x, args.where))) {
        const g = Object.fromEntries(
          args.by.map((k) => [k, (r as unknown as Record<string, unknown>)[k]]),
        );
        seen.set(JSON.stringify(g), g);
      }
      return [...seen.values()];
    }),
    findMany: jest.fn(
      async (args: {
        where: Where;
        orderBy?: unknown;
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        const found = sortRows(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        );
        return (args.take ? found.slice(0, args.take) : found).map((r) =>
          pick(r, args.select),
        );
      },
    ),
    findFirst: jest.fn(
      async (args: {
        where: Where;
        orderBy?: unknown;
        select?: Record<string, boolean>;
      }) => {
        const found = sortRows(
          rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        );
        return found[0] ? pick(found[0], args.select) : null;
      },
    ),
    deleteMany: jest.fn(async (args: { where: Where }) => {
      const before = rows.length;
      const gone = rows.filter((r) => matches(r, args.where));
      log.push(...gone.map((r) => `row:${r.id}`));
      rows = rows.filter((r) => !matches(r, args.where));
      return { count: before - rows.length };
    }),
  };
  const files = new Set(
    initial
      .map((r) => r.blobUrl)
      .filter((u): u is string => !!u)
      .map((u) => new URL(u).pathname.slice(1)),
  );
  const blob = {
    fail: false,
    deleteMany: jest.fn(async (paths: string[]) => {
      if (blob.fail) return 0;
      for (const p of paths) {
        files.delete(p);
        log.push(`file:${p}`);
      }
      return paths.length;
    }),
  };
  return {
    prisma: { uiSnapshot } as never,
    uiSnapshot,
    blob,
    files,
    log,
    rows: () => rows,
    ids: () => new Set(rows.map((r) => r.id)),
  };
}

/**
 * Лента одного сочетания маршрут+локаль+тема так, как её пишет раннер:
 * `comparedToUrl` — адрес последней строки без ошибки на момент снимка.
 */
function series(
  spec: Array<{ ago: number; kind: 'plain' | 'changed' | 'error'; id: string }>,
  combo = { routeKey: 'home', locale: 'ru', theme: 'light' },
  prefix = 'qa-snapshots',
): Row[] {
  const out: Row[] = [];
  let lastOk: Row | null = null;
  for (const s of [...spec].sort((a, b) => b.ago - a.ago)) {
    const createdAt = new Date(NOW.getTime() - s.ago);
    const row: Row =
      s.kind === 'error'
        ? {
            id: s.id,
            createdAt,
            ...combo,
            blobUrl: null,
            comparedToUrl: null,
            changed: false,
            error: 'навигация не удалась',
          }
        : {
            id: s.id,
            createdAt,
            ...combo,
            blobUrl: `${BASE}${prefix}/${combo.routeKey}/${combo.locale}/${combo.theme}/${createdAt.getTime()}.png`,
            comparedToUrl: lastOk?.blobUrl ?? null,
            changed: s.kind === 'changed',
            error: null,
          };
    out.push(row);
    if (row.error === null) lastOk = row;
  }
  return out;
}

/** «Было» — ровно как его ищет `UiSnapshotQueryService.list`. */
function adminPrevious(rows: Row[], r: Row): Row | null {
  return (
    sortRows(
      rows.filter(
        (x) =>
          x.routeKey === r.routeKey &&
          x.locale === r.locale &&
          x.theme === r.theme &&
          x.error === null &&
          x.createdAt.getTime() < r.createdAt.getTime(),
      ),
      [{ createdAt: 'desc' }, { id: 'desc' }],
    )[0] ?? null
  );
}

describe('pruneUiSnapshots — что удаляется', () => {
  it('обычные снимки старше трёх дней — строка и файл; свежие остаются', async () => {
    const db = fakeDb(
      series([
        { id: 'old1', ago: 5 * DAY, kind: 'plain' },
        { id: 'old2', ago: 4 * DAY, kind: 'plain' },
        { id: 'fresh', ago: 2 * DAY, kind: 'plain' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['fresh', 'last']);
    expect(res).toMatchObject({
      deleted: 2,
      deletedBlobs: 2,
      failed: 0,
      hasMore: false,
      pages: 1,
    });
    expect(db.files.size).toBe(2);
  });

  it('строка сбоя (без файла) старше трёх дней удаляется без запроса к Blob', async () => {
    const db = fakeDb(
      series([
        { id: 'err', ago: 5 * DAY, kind: 'error' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(db.ids().has('err')).toBe(false);
    expect(res.deleted).toBe(1);
    expect(res.deletedBlobs).toBe(0);
    expect(db.blob.deleteMany).not.toHaveBeenCalled();
  });

  it('«изменилось» моложе 30 дней остаётся вместе со снимком, с которым сравнивали', async () => {
    const db = fakeDb(
      series([
        { id: 'p0', ago: 10 * DAY + 4 * MIN, kind: 'plain' },
        { id: 'prev', ago: 10 * DAY + 2 * MIN, kind: 'plain' },
        { id: 'chg', ago: 10 * DAY, kind: 'changed' },
        { id: 'after', ago: 10 * DAY - 2 * MIN, kind: 'plain' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    const before = adminPrevious(db.rows(), db.rows()[2]);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['chg', 'last', 'prev']);
    const chg = db.rows().find((r) => r.id === 'chg')!;
    expect(adminPrevious(db.rows(), chg)?.id).toBe(before?.id);
    expect(chg.comparedToUrl).toBe(
      db.rows().find((r) => r.id === 'prev')!.blobUrl,
    );
    expect(db.files.has(new URL(chg.comparedToUrl!).pathname.slice(1))).toBe(
      true,
    );
  });

  it('строка по comparedToUrl не та, что найдёт страница (гонка раннера): хранятся обе', async () => {
    // Раннер записал адрес p0, а страница по своему правилу покажет p1 —
    // не удалять ни то, ни другое.
    const rows = series([
      { id: 'p0', ago: 10 * DAY + 4 * MIN, kind: 'plain' },
      { id: 'p1', ago: 10 * DAY + 2 * MIN, kind: 'plain' },
      { id: 'chg', ago: 10 * DAY, kind: 'changed' },
      { id: 'last', ago: 2 * MIN, kind: 'plain' },
    ]);
    rows[2].comparedToUrl = rows[0].blobUrl;
    const db = fakeDb(rows);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['chg', 'last', 'p0', 'p1']);
  });

  it('comparedToUrl ведёт в пустоту (строку удалили руками) — «было» страницы всё равно хранится', async () => {
    // `after` — старый обычный снимок ПОСЛЕ «стало»: «изменилось»
    // оказывается внутри страницы кандидатов, а не за её краем.
    const rows = series([
      { id: 'p0', ago: 10 * DAY + 4 * MIN, kind: 'plain' },
      { id: 'p1', ago: 10 * DAY + 2 * MIN, kind: 'plain' },
      { id: 'chg', ago: 10 * DAY, kind: 'changed' },
      { id: 'after', ago: 9 * DAY, kind: 'plain' },
      { id: 'last', ago: 2 * MIN, kind: 'plain' },
    ]);
    rows[2].comparedToUrl = `${BASE}qa-snapshots/home/ru/light/1.png`;
    const db = fakeDb(rows);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['chg', 'last', 'p1']);
  });

  it('хранимые «изменилось» не ходят в кандидаты: ночь без работы — одна страница на комбинацию', async () => {
    const spec = Array.from(
      { length: UI_SNAPSHOT_PRUNE_BATCH * 2 },
      (_, i) => ({
        id: `c${String(i).padStart(5, '0')}`,
        ago: 20 * DAY - i * MIN,
        kind: 'changed' as const,
      }),
    );
    const db = fakeDb(
      series([...spec, { id: 'last', ago: 2 * MIN, kind: 'plain' }]),
    );
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    const candidatePages = db.uiSnapshot.findMany.mock.calls.filter(
      ([a]) => a.take === UI_SNAPSHOT_PRUNE_BATCH,
    );
    expect(candidatePages).toHaveLength(1);
    expect(res.deleted).toBe(0);
    expect(db.ids().size).toBe(UI_SNAPSHOT_PRUNE_BATCH * 2 + 1);
  });

  it('между «было» и «стало» строки сбоя: они уходят, «было» остаётся', async () => {
    const db = fakeDb(
      series([
        { id: 'prev', ago: 9 * DAY, kind: 'plain' },
        { id: 'e1', ago: 8 * DAY, kind: 'error' },
        { id: 'e2', ago: 7 * DAY, kind: 'error' },
        { id: 'chg', ago: 6 * DAY, kind: 'changed' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['chg', 'last', 'prev']);
  });

  it('«изменилось» старше 30 дней уходит вместе со своей парой', async () => {
    const db = fakeDb(
      series([
        { id: 'prev', ago: 40 * DAY + 2 * MIN, kind: 'plain' },
        { id: 'chg', ago: 40 * DAY, kind: 'changed' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()]).toEqual(['last']);
    expect(res.deletedBlobs).toBe(2);
  });

  it('последний снимок без ошибки не удаляется, даже если маршрут падает неделю — это база сравнения', async () => {
    const db = fakeDb(
      series([
        { id: 'older', ago: 8 * DAY, kind: 'plain' },
        { id: 'base', ago: 7 * DAY, kind: 'plain' },
        { id: 'e1', ago: 6 * DAY, kind: 'error' },
        { id: 'e2', ago: 5 * DAY, kind: 'error' },
        { id: 'e3', ago: 4 * DAY, kind: 'error' },
      ]),
    );
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    // e3 — самая последняя строка вообще, base — последняя без ошибки.
    expect([...db.ids()].sort()).toEqual(['base', 'e3']);
  });

  it('последний снимок комбинации старше трёх дней (маршрут убран из обхода) остаётся', async () => {
    const db = fakeDb(
      series([
        { id: 'a', ago: 20 * DAY, kind: 'plain' },
        { id: 'b', ago: 19 * DAY, kind: 'plain' },
      ]),
    );
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()]).toEqual(['b']);
  });

  it('последний «изменилось» старше 30 дней остаётся базой, а его пара — нет', async () => {
    const db = fakeDb(
      series([
        { id: 'prev', ago: 40 * DAY + 2 * MIN, kind: 'plain' },
        { id: 'chg', ago: 40 * DAY, kind: 'changed' },
      ]),
    );
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()]).toEqual(['chg']);
  });

  it('комбинации не смешиваются: база другой локали не спасает чужие строки', async () => {
    const ru = series([
      { id: 'ru-old', ago: 5 * DAY, kind: 'plain' },
      { id: 'ru-last', ago: 2 * MIN, kind: 'plain' },
    ]);
    const uk = series(
      [
        { id: 'uk-old', ago: 6 * DAY, kind: 'plain' },
        { id: 'uk-base', ago: 5 * DAY, kind: 'plain' },
      ],
      { routeKey: 'home', locale: 'uk', theme: 'light' },
    );
    const db = fakeDb([...ru, ...uk]);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['ru-last', 'uk-base']);
  });
});

describe('pruneUiSnapshots — файлы', () => {
  it('файл удаляется до строки', async () => {
    const db = fakeDb(
      series([
        { id: 'old', ago: 5 * DAY, kind: 'plain' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(db.log[0]).toMatch(/^file:qa-snapshots\//);
    expect(db.log[1]).toBe('row:old');
  });

  it('файл не удалился — строка остаётся, счётчик сбоя растёт', async () => {
    const db = fakeDb(
      series([
        { id: 'old1', ago: 5 * DAY, kind: 'plain' },
        { id: 'old2', ago: 4 * DAY, kind: 'plain' },
        { id: 'err', ago: 4 * DAY - MIN, kind: 'error' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    db.blob.fail = true;
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].sort()).toEqual(['last', 'old1', 'old2']);
    expect(res).toMatchObject({
      deleted: 1,
      deletedBlobs: 0,
      failed: 2,
      hasMore: false,
    });
  });

  it('исключение из Blob тоже оставляет строку', async () => {
    const db = fakeDb(
      series([
        { id: 'old', ago: 5 * DAY, kind: 'plain' },
        { id: 'last', ago: 2 * MIN, kind: 'plain' },
      ]),
    );
    db.blob.deleteMany.mockRejectedValueOnce(new Error('Blob лежит'));
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(db.ids().has('old')).toBe(true);
    expect(res.failed).toBe(1);
  });

  it('адрес не под qa-snapshots/ (кадры лендинга и обучалки — qa-shots/): ни файл, ни строка не трогаются', async () => {
    const db = fakeDb([
      ...series(
        [{ id: 'foreign', ago: 5 * DAY, kind: 'plain' }],
        { routeKey: 'home', locale: 'ru', theme: 'light' },
        'qa-shots',
      ),
      ...series([{ id: 'last', ago: 2 * MIN, kind: 'plain' }]),
    ]);
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(db.ids().has('foreign')).toBe(true);
    expect(db.blob.deleteMany).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      deleted: 0,
      deletedBlobs: 0,
      failed: 1,
      hasMore: false,
    });
  });
});

describe('pruneUiSnapshots — потолок прогона', () => {
  function longTail(
    n: number,
    combo = { routeKey: 'home', locale: 'ru', theme: 'light' },
  ) {
    return series(
      Array.from({ length: n }, (_, i) => ({
        id: `${combo.locale}-${String(i).padStart(6, '0')}`,
        ago: 4 * DAY + (n - i) * 2 * MIN,
        kind: 'plain' as const,
      })).concat([{ id: `${combo.locale}-last`, ago: 2 * MIN, kind: 'plain' }]),
      combo,
    );
  }

  it('не больше UI_SNAPSHOT_PRUNE_MAX_PAGES страниц за прогон, остаток — hasMore', async () => {
    const n = UI_SNAPSHOT_PRUNE_BATCH * (UI_SNAPSHOT_PRUNE_MAX_PAGES + 1);
    const db = fakeDb(longTail(n));
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(res.deleted).toBe(
      UI_SNAPSHOT_PRUNE_BATCH * UI_SNAPSHOT_PRUNE_MAX_PAGES,
    );
    expect(res.hasMore).toBe(true);
    expect(res.pages).toBe(UI_SNAPSHOT_PRUNE_MAX_PAGES);
    // Следующий прогон доберёт: полная страница остатка и пустая.
    const res2 = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(res2.hasMore).toBe(false);
    expect(res2.pages).toBe(2);
    expect([...db.ids()]).toEqual(['ru-last']);
  });

  it('бюджет времени: после первой страницы вышедшее время останавливает обход', async () => {
    const db = fakeDb(longTail(UI_SNAPSHOT_PRUNE_BATCH * 3));
    let t = 0;
    const res = await pruneUiSnapshots(db.prisma, db.blob, {
      now: NOW,
      deadlineMs: 10,
      clock: () => (t += 100),
    });
    expect(res.deleted).toBe(UI_SNAPSHOT_PRUNE_BATCH);
    expect(res.hasMore).toBe(true);
    expect(res.pages).toBe(1);
  });

  it('ms — время всей уборки по своим часам, не по часам бюджета', async () => {
    const db = fakeDb(longTail(3));
    const ticks = [1_000.2, 1_250.7];
    const clock = jest.fn(() => 0);
    const res = await pruneUiSnapshots(db.prisma, db.blob, {
      now: NOW,
      clock,
      timer: () => ticks.shift() ?? NaN,
    });
    expect(res.ms).toBe(251);
    expect(res.pages).toBe(1);
    // Одна страница — бюджет не спрашивали ни разу (см. `timer`).
    expect(clock).not.toHaveBeenCalled();
  });

  it('пустая таблица: ноль страниц, ms не отрицательное', async () => {
    const db = fakeDb([]);
    const res = await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect(res.pages).toBe(0);
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it('по кругу: длинный хвост одной комбинации не съедает весь потолок', async () => {
    const n = UI_SNAPSHOT_PRUNE_BATCH * UI_SNAPSHOT_PRUNE_MAX_PAGES;
    const db = fakeDb([
      ...longTail(n),
      ...longTail(3, { routeKey: 'home', locale: 'uk', theme: 'light' }),
    ]);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    expect([...db.ids()].filter((id) => id.startsWith('uk-'))).toEqual([
      'uk-last',
    ]);
  });

  it('«было» на границе страниц остаётся', async () => {
    // Кандидатов ровно страница, «было» — последний из них, а «стало»
    // — первая строка без ошибки уже за страницей (nextOk).
    const plain = Array.from({ length: UI_SNAPSHOT_PRUNE_BATCH }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`,
      ago: 20 * DAY + (UI_SNAPSHOT_PRUNE_BATCH - i) * 2 * MIN,
      kind: 'plain' as const,
    }));
    const rows = series([
      ...plain,
      { id: 'chg', ago: 20 * DAY, kind: 'changed' },
      { id: 'last', ago: 2 * MIN, kind: 'plain' },
    ]);
    // Адрес раннера не помогает — держит только правило страницы.
    rows[UI_SNAPSHOT_PRUNE_BATCH].comparedToUrl = null;
    const db = fakeDb(rows);
    await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
    const kept = [...db.ids()].sort();
    expect(kept).toEqual([
      'chg',
      'last',
      `p${String(UI_SNAPSHOT_PRUNE_BATCH - 1).padStart(4, '0')}`,
    ]);
  });
});

describe('pruneUiSnapshots — сверка с правилами страницы админки и раннера', () => {
  /** Детерминированный ГПСЧ — сценарий воспроизводим. */
  function rng(seed: number) {
    return () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
  }

  it.each([1, 2, 3, 4, 5])(
    'случайная история #%i: инварианты хранения',
    async (seed) => {
      const rand = rng(seed);
      const combos = [
        { routeKey: 'home', locale: 'ru', theme: 'light' },
        { routeKey: 'home', locale: 'uk', theme: 'light' },
        { routeKey: 'generate', locale: 'ru', theme: 'light' },
      ];
      const all: Row[] = [];
      for (const combo of combos) {
        const spec: Array<{
          ago: number;
          kind: 'plain' | 'changed' | 'error';
          id: string;
        }> = [];
        // 40 дней истории, тик раз в ~2 часа — достаточно для всех границ.
        for (let t = 40 * DAY; t > 0; t -= 2 * 60 * MIN) {
          const x = rand();
          spec.push({
            id: `${combo.routeKey}-${combo.locale}-${t}`,
            ago: t,
            kind: x < 0.15 ? 'error' : x < 0.3 ? 'changed' : 'plain',
          });
        }
        // Хвост сбоев в конце у одной из комбинаций — база стареет.
        if (seed % 2 === 0 && combo.locale === 'uk') {
          for (const s of spec) if (s.ago < 5 * DAY) s.kind = 'error';
        }
        all.push(...series(spec, combo));
      }
      const db = fakeDb(all);
      const plainCutoff = NOW.getTime() - 3 * DAY;
      const changedCutoff = NOW.getTime() - 30 * DAY;
      const keptChanged = all.filter(
        (r) => r.changed && r.createdAt.getTime() >= changedCutoff,
      );
      const prevBefore = new Map(
        keptChanged.map((r) => [r.id, adminPrevious(all, r)?.id ?? null]),
      );

      await pruneUiSnapshots(db.prisma, db.blob, { now: NOW });
      const left = db.rows();
      const ids = db.ids();

      for (const r of keptChanged) {
        expect(ids.has(r.id)).toBe(true);
        // Страница показывает ту же пару, что и до уборки.
        expect(adminPrevious(left, r)?.id ?? null).toBe(prevBefore.get(r.id));
      }
      // Снимок по адресу раннера — тоже на месте.
      const lostCompared = keptChanged.filter(
        (r) =>
          r.comparedToUrl !== null &&
          !left.some((x) => x.blobUrl === r.comparedToUrl),
      );
      expect(lostCompared).toEqual([]);
      for (const combo of combos) {
        const mine = (rows: Row[]) =>
          sortRows(
            rows.filter(
              (r) => r.routeKey === combo.routeKey && r.locale === combo.locale,
            ),
            [{ createdAt: 'desc' }, { id: 'desc' }],
          );
        // База сравнения раннера и самая последняя строка — на месте.
        expect(mine(left)[0].id).toBe(mine(all)[0].id);
        expect(mine(left).find((r) => r.error === null)?.id).toBe(
          mine(all).find((r) => r.error === null)?.id,
        );
      }
      // Ничего моложе трёх дней не тронуто, а старое без защиты — убрано.
      const youngGone = all.filter(
        (r) => r.createdAt.getTime() >= plainCutoff && !ids.has(r.id),
      );
      expect(youngGone).toEqual([]);
      const survivorsOld = left.filter(
        (r) => r.createdAt.getTime() < plainCutoff && !r.changed,
      );
      // Выжившие старые обычные — только «было» хранимых пар и базы.
      const allowed = new Set<string>([
        ...[...prevBefore.values()].filter((x): x is string => !!x),
        ...combos.flatMap((c) => {
          const m = sortRows(
            all.filter(
              (r) => r.routeKey === c.routeKey && r.locale === c.locale,
            ),
            [{ createdAt: 'desc' }, { id: 'desc' }],
          );
          return [m[0].id, m.find((r) => r.error === null)?.id ?? ''];
        }),
      ]);
      for (const r of survivorsOld) expect(allowed.has(r.id)).toBe(true);
      // Файлы удалённых строк удалены, файлы оставшихся — на месте.
      for (const r of all) {
        if (!r.blobUrl) continue;
        const p = new URL(r.blobUrl).pathname.slice(1);
        expect(db.files.has(p)).toBe(ids.has(r.id));
      }
    },
  );
});

describe('planUiSnapshotPrunePage — страховка по сроку', () => {
  it('не удаляет строку моложе срока, даже если запрос её вернул', () => {
    const plainCutoff = new Date(NOW.getTime() - 3 * DAY);
    const changedCutoff = new Date(NOW.getTime() - 30 * DAY);
    const { remove } = planUiSnapshotPrunePage({
      candidates: [
        {
          id: 'young',
          createdAt: new Date(NOW.getTime() - DAY),
          changed: false,
          error: null,
          blobUrl: null,
        },
        {
          id: 'chg',
          createdAt: new Date(NOW.getTime() - 10 * DAY),
          changed: true,
          error: null,
          blobUrl: null,
        },
      ],
      keptChanged: [],
      nextOk: {
        id: 'n',
        createdAt: NOW,
        changed: false,
        comparedToUrl: null,
      },
      hasLaterRow: true,
      plainCutoff,
      changedCutoff,
    });
    expect(remove).toEqual([]);
  });
});
