/**
 * Э8-хвост (6), заход 9: статистика «Админки» по действиям и метрики
 * монитора §5-бис.15 п.12 — агрегаты предложений на лету (чистый расчёт).
 */
import {
  COMPENSATION_ALERT,
  actionStats,
  type ActionStatRow,
} from './admin-stats.service';

const NOW = new Date('2026-10-09T12:00:00Z');
const H = 60 * 60 * 1000;

function row(over: Partial<ActionStatRow>): ActionStatRow {
  return {
    operation: 'shop.updateOrderStatus',
    status: 'pending',
    attempts: 0,
    compensationOf: null,
    chainStatus: null,
    unrequested: false,
    createdAt: new Date(NOW.getTime() - 2 * H),
    executedAt: null,
    ...over,
  };
}

describe('статистика действий «Админки» (Э8-хвост (6))', () => {
  it('доля «Да», исходы, unknown, цепочки со следами, без вашей просьбы', () => {
    const s = actionStats(
      [
        row({
          status: 'done',
          attempts: 1,
          chainStatus: 'committed',
          executedAt: NOW,
        }),
        row({
          status: 'done',
          attempts: 1,
          chainStatus: 'compensated',
          executedAt: NOW,
        }),
        row({
          status: 'unknown',
          attempts: 1,
          chainStatus: 'unknown',
          executedAt: NOW,
        }),
        row({ status: 'failed', attempts: 1, executedAt: NOW }),
        row({ status: 'rejected' }),
        row({ status: 'expired' }),
        // unknown старше суток (Р-З9-21) — «Да» было, считается подтверждённым.
        row({
          status: 'expired',
          attempts: 1,
          chainStatus: 'compensation_failed',
        }),
        row({
          status: 'pending',
          unrequested: true,
          operation: 'shop.cancelOrder',
        }),
      ],
      NOW,
    );
    expect(s).toMatchObject({
      proposed: 8,
      confirmed: 5,
      rejected: 1,
      expired: 1,
      done: 2,
      failed: 1,
      // unknown + expired после «Да» (повтор закрыт по сроку) — исход неизвестен.
      unknown: 2,
      unrequested: 1,
      chainsWithTraces: 2,
    });
    expect(s.yesShare).toBeCloseTo(5 / 7);
    expect(s.unknownShare).toBeCloseTo(2 / 5);
    expect(s.byOperation[0]).toEqual({
      operation: 'shop.updateOrderStatus',
      proposed: 7,
      confirmed: 5,
      done: 2,
      unknown: 2,
    });
  });

  it('компенсации: успешность и тревога < 80% на ≥ 10 попытках за 24 ч', () => {
    const comp = (status: string, ago: number) =>
      row({
        status,
        attempts: 1,
        compensationOf: 'p0',
        executedAt: new Date(NOW.getTime() - ago),
      });
    // 10 попыток за сутки, 7 успешных — тревога.
    const recent = [
      ...Array.from({ length: 7 }, () => comp('done', H)),
      comp('failed', H),
      comp('failed', 2 * H),
      comp('unknown', 3 * H),
    ];
    const a = actionStats([...recent, row({ compensationOf: 'p0' })], NOW);
    expect(a.compensations).toMatchObject({
      proposed: 11,
      confirmed: 10,
      done: 7,
      failed: 2,
      unknown: 1,
      alert: true,
    });
    expect(a.compensations.successRate).toBeCloseTo(0.7);
    // 8 из 10 — порог не пробит; 9 попыток при 0% — мало для тревоги.
    const ok = actionStats(
      [
        ...Array.from({ length: 8 }, () => comp('done', H)),
        comp('failed', H),
        comp('failed', H),
      ],
      NOW,
    );
    expect(ok.compensations.alert).toBe(false);
    const few = actionStats(
      Array.from({ length: COMPENSATION_ALERT.minAttempts - 1 }, () =>
        comp('failed', H),
      ),
      NOW,
    );
    expect(few.compensations.alert).toBe(false);
    // Старше суток — в окно тревоги не входят.
    const old = actionStats(
      Array.from({ length: 12 }, () => comp('failed', 30 * H)),
      NOW,
    );
    expect(old.compensations.alert).toBe(false);
    expect(old.compensations.successRate).toBe(0);
  });

  it('аудит пакета C: компенсация expired после «Да» (retry_expired) — неизвестный исход и в тревоге', () => {
    const c = (status: string, attempts: number) =>
      row({
        status,
        attempts,
        compensationOf: 'p0',
        executedAt: new Date(NOW.getTime() - H),
      });
    const s = actionStats(
      [
        ...Array.from({ length: 7 }, () => c('done', 1)),
        ...Array.from({ length: 3 }, () => c('expired', 1)),
        // Истекла без «Да» — не попытка.
        c('expired', 0),
      ],
      NOW,
    );
    expect(s.compensations).toMatchObject({ unknown: 3, alert: true });
    expect(s.compensations.successRate).toBeCloseTo(0.7);
  });

  it('пусто — null вместо деления на ноль', () => {
    const s = actionStats([], NOW);
    expect(s.yesShare).toBeNull();
    expect(s.unknownShare).toBeNull();
    expect(s.compensations.successRate).toBeNull();
    expect(s.byOperation).toEqual([]);
  });
});
