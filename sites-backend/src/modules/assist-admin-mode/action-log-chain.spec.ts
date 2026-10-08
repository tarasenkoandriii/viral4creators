/* eslint-disable @typescript-eslint/no-explicit-any -- двойник SitesDb */
/**
 * Аудит Э8 (5), заход 9: `verifyChain` читает журнал пачками (keyset по
 * `at, id`), а не весь журнал сайта одним запросом; разрыв `prevHash` на
 * стыке пачек и подмена строки находятся с тем же индексом, что раньше.
 * Р-З9-20: голова цепочки (`chainHead`) — последняя строка по `at, id`.
 */
import {
  AdminActionLogService,
  VERIFY_CHAIN_BATCH,
  actionLogHash,
  type ActionLogEntry,
} from './action-log.service';

interface Row {
  id: string;
  accountId: string;
  siteId: string;
  at: Date;
  actor: string;
  actorRole: string | null;
  channel: string;
  conversationId: string | null;
  connectorId: string | null;
  operationRowId: string | null;
  operation: string;
  kind: string;
  outcome: string;
  httpStatus: number | null;
  durationMs: number | null;
  requestMasked: unknown;
  responseBytes: number | null;
  error: string | null;
  idempotencyKey: string;
  prevHash: string | null;
  hash: string;
}

function chain(n: number, siteId = 's1'): Row[] {
  const out: Row[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    // Две строки на одну миллисекунду — keyset обязан учитывать id.
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, Math.floor(i / 2)));
    const e: ActionLogEntry = {
      accountId: 'a1',
      siteId,
      actor: 'jwt:emp',
      actorRole: null,
      channel: 'embed',
      conversationId: null,
      connectorId: null,
      operationRowId: null,
      operation: `shop.op${i}`,
      kind: 'read',
      outcome: 'ok',
      httpStatus: 200,
      durationMs: 5,
      requestMasked: { i },
      responseBytes: 10,
      error: null,
    };
    const key = `read:${i}`;
    const hash = actionLogHash(prev, e, at, key);
    out.push({
      ...(e as Omit<ActionLogEntry, 'kind'> & { kind: string }),
      id: `r${String(i).padStart(4, '0')}`,
      at,
      requestMasked: e.requestMasked,
      idempotencyKey: key,
      prevHash: prev,
      hash,
    });
    prev = hash;
  }
  return out;
}

function fakeDb(rows: Row[]) {
  const calls: Array<{ take?: number; where: any }> = [];
  const cmp = (a: Row, b: Row) =>
    a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const match = (r: Row, w: any): boolean => {
    if (w.siteId && r.siteId !== w.siteId) return false;
    if (w.OR) {
      return w.OR.some((c: any) =>
        c.at?.gt
          ? r.at.getTime() > c.at.gt.getTime()
          : r.at.getTime() === c.at.getTime() && r.id > c.id.gt,
      );
    }
    return true;
  };
  const delegate = {
    findMany: jest.fn(async (q: any) => {
      calls.push({ take: q.take, where: q.where });
      const all = rows.filter((r) => match(r, q.where)).sort(cmp);
      return q.take === undefined ? all : all.slice(0, q.take);
    }),
    findFirst: jest.fn(async (q: any) => {
      const all = rows.filter((r) => match(r, q.where)).sort(cmp);
      return all.length ? all[all.length - 1] : null;
    }),
  };
  return {
    calls,
    db: { forAccount: () => ({ assistAdminActionLog: delegate }) },
  };
}

describe('журнал «Админки»: проверка цепочки пачками (аудит Э8 (5))', () => {
  it('целая цепочка: -1; каждый запрос — не больше пачки, пачек ceil(n/b)', async () => {
    const f = fakeDb(chain(7));
    const svc = new AdminActionLogService(f.db as any);
    svc.verifyBatch = 2;
    expect(await svc.verifyChain('a1', 's1')).toBe(-1);
    expect(f.calls.length).toBe(4);
    for (const c of f.calls) expect(c.take).toBe(2);
  });

  it('разрыв prevHash на стыке пачек — индекс первой строки второй пачки', async () => {
    const rows = chain(6);
    // Строка «пересчитана» злоумышленником: свой хеш верен, но цепь рвётся.
    const bogus = 'f'.repeat(64);
    const r2 = rows[2];
    rows[2] = {
      ...r2,
      prevHash: bogus,
      hash: actionLogHash(
        bogus,
        {
          ...(r2 as unknown as ActionLogEntry),
          channel: 'embed',
          kind: 'read',
          requestMasked: r2.requestMasked as ActionLogEntry['requestMasked'],
        },
        r2.at,
        r2.idempotencyKey,
      ),
    };
    const f = fakeDb(rows);
    const svc = new AdminActionLogService(f.db as any);
    svc.verifyBatch = 2;
    expect(await svc.verifyChain('a1', 's1')).toBe(2);
  });

  it('подмена поля строки в третьей пачке — её индекс; чужой сайт не мешает', async () => {
    const rows = [...chain(6), ...chain(3, 's2')];
    rows[4] = { ...rows[4], outcome: 'http_error' };
    const f = fakeDb(rows);
    const svc = new AdminActionLogService(f.db as any);
    svc.verifyBatch = 2;
    expect(await svc.verifyChain('a1', 's1')).toBe(4);
    expect(await svc.verifyChain('a1', 's2')).toBe(-1);
  });

  it('по умолчанию пачка — 2 000 строк, и больше не бывает', async () => {
    expect(VERIFY_CHAIN_BATCH).toBe(2_000);
    const f = fakeDb(chain(3));
    const svc = new AdminActionLogService(f.db as any);
    svc.verifyBatch = 1_000_000;
    expect(await svc.verifyChain('a1', 's1')).toBe(-1);
    expect(f.calls[0].take).toBe(2_000);
  });

  it('голова цепочки (Р-З9-20) — последняя строка по at, id; пустой журнал — null', async () => {
    const rows = chain(5);
    const svc = new AdminActionLogService(fakeDb(rows).db as any);
    expect(await svc.chainHead('a1', 's1')).toEqual({
      id: rows[4].id,
      at: rows[4].at.toISOString(),
      hash: rows[4].hash,
    });
    expect(await svc.chainHead('a1', 'nope')).toBeNull();
  });
});
