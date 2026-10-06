/**
 * Пауза коннектора (§5.7, аудит Н-3): на паузу — только отказ по КЛЮЧУ
 * коннектора. 401 с вызовом Bearer/кодом ключа — сразу; неясный 401 — лишь
 * когда за окно его получили ≥ 3 РАЗНЫХ сотрудника; 403 (отказ по
 * сотруднику) — никогда. База — подделка: проверяется решение и запрос к
 * журналу (окно, коннектор, 401, разные акторы).
 */
import type { SitesDb } from '../../prisma/sites-db.service';
import type { AdminActionLogService } from './action-log.service';
import type { AdminModeService } from './admin-mode.service';
import {
  AUTH_UNCLEAR_ACTORS,
  AUTH_UNCLEAR_WINDOW_MS,
  ConnectorsService,
} from './connectors.service';

interface LogRow {
  connectorId: string;
  httpStatus: number | null;
  at: Date;
  actor: string;
}

function setup(log: LogRow[]) {
  const updates: Array<Record<string, unknown>> = [];
  const finds: Array<Record<string, unknown>> = [];
  const db = {
    forAccount: () => ({
      assistAdminActionLog: {
        findMany: async (args: {
          where: {
            connectorId: string;
            httpStatus: number;
            at: { gte: Date };
          };
          distinct: string[];
          take: number;
        }) => {
          finds.push(args as unknown as Record<string, unknown>);
          const seen = new Set<string>();
          for (const r of log) {
            if (r.connectorId !== args.where.connectorId) continue;
            if (r.httpStatus !== args.where.httpStatus) continue;
            if (r.at < args.where.at.gte) continue;
            if (args.distinct.includes('actor')) seen.add(r.actor);
          }
          return [...seen].slice(0, args.take).map((actor) => ({ actor }));
        },
      },
      assistAdminConnector: {
        updateMany: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return { count: 1 };
        },
      },
    }),
  } as unknown as SitesDb;
  const svc = new ConnectorsService(
    db,
    {} as AdminModeService,
    {} as AdminActionLogService,
  );
  return { svc, updates, finds };
}

const NOW = new Date('2026-10-06T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('ConnectorsService.markCalled — пауза только по ключу (аудит Н-3)', () => {
  it('отказ по ключу (key) — пауза сразу', async () => {
    const { svc, updates, finds } = setup([]);
    expect(await svc.markCalled('a', 'c1', 'key', NOW)).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'auth_failed' });
    expect(finds).toHaveLength(0);
  });

  it('без отказа (ok, 403 — authReject нет) — только отметка вызова', async () => {
    const { svc, updates } = setup([]);
    expect(await svc.markCalled('a', 'c1', null, NOW)).toBe(false);
    expect(await svc.markCalled('a', 'c1', undefined, NOW)).toBe(false);
    expect(updates).toEqual([{ lastCallAt: NOW }, { lastCallAt: NOW }]);
  });

  it('неясный 401 одного сотрудника (даже много раз) — без паузы', async () => {
    const log: LogRow[] = Array.from({ length: 5 }, () => ({
      connectorId: 'c1',
      httpStatus: 401,
      at: ago(1000),
      actor: 'jwt:emp-1',
    }));
    const { svc, updates } = setup(log);
    expect(await svc.markCalled('a', 'c1', 'unclear', NOW)).toBe(false);
    expect(updates[0]).not.toHaveProperty('status');
  });

  it(`неясный 401 от ${AUTH_UNCLEAR_ACTORS} разных сотрудников за окно — пауза; вне окна, другой коннектор и 403 не считаются`, async () => {
    const two: LogRow[] = [
      { connectorId: 'c1', httpStatus: 401, at: ago(1000), actor: 'jwt:a' },
      { connectorId: 'c1', httpStatus: 401, at: ago(2000), actor: 'jwt:b' },
      // Вне окна, чужой коннектор, 403 — мимо.
      {
        connectorId: 'c1',
        httpStatus: 401,
        at: ago(AUTH_UNCLEAR_WINDOW_MS + 1000),
        actor: 'jwt:old',
      },
      { connectorId: 'c2', httpStatus: 401, at: ago(1000), actor: 'jwt:x' },
      { connectorId: 'c1', httpStatus: 403, at: ago(1000), actor: 'jwt:y' },
    ];
    const first = setup(two);
    expect(await first.svc.markCalled('a', 'c1', 'unclear', NOW)).toBe(false);
    const q = first.finds[0] as {
      where: { at: { gte: Date } };
      distinct: string[];
    };
    expect(q.where.at.gte.getTime()).toBe(
      NOW.getTime() - AUTH_UNCLEAR_WINDOW_MS,
    );
    expect(q.distinct).toEqual(['actor']);
    const three = setup([
      ...two,
      { connectorId: 'c1', httpStatus: 401, at: ago(10), actor: 'jwt:c' },
    ]);
    expect(await three.svc.markCalled('a', 'c1', 'unclear', NOW)).toBe(true);
    expect(three.updates[0]).toMatchObject({ status: 'auth_failed' });
  });
});
