/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory ledger */
import { CreditLedgerService } from './credit-ledger.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/** Р-ST3-2: keyed multi-credit reserve/refund used by Story-Tales. */
function setup(rows: any[] = []) {
  const tx: any = {
    creditLedger: {
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          delta: rows.length
            ? rows
                .filter((r) => r.userId === where.userId)
                .reduce((s, r) => s + r.delta, 0)
            : null,
        },
      })),
      findFirst: jest.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.generatedVideoId === where.generatedVideoId &&
              r.reason === where.reason,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        rows.push({ ...data });
        return data;
      }),
    },
    $executeRaw: jest.fn(),
  };
  const service = new CreditLedgerService(tx, { alert: jest.fn() } as any);
  const balance = (u = 'u1') =>
    rows.filter((r) => r.userId === u).reduce((s, r) => s + r.delta, 0);
  return { service, tx, rows, balance };
}

describe('CreditLedgerService keyed reserve/refund (Story-Tales)', () => {
  it('reserves N credits under the user lock, once per key', async () => {
    const s = setup([{ userId: 'u1', delta: 12, reason: 'PURCHASE' }]);
    await expect(
      s.service.reserveKeyed(s.tx, 'u1', 'story:audio:g1', 5),
    ).resolves.toEqual({ reserved: true, balance: 7 });
    await expect(
      s.service.reserveKeyed(s.tx, 'u1', 'story:audio:g1', 5),
    ).resolves.toEqual({ reserved: true, balance: 7 });
    expect(s.balance()).toBe(7);
    expect(s.tx.$executeRaw).toHaveBeenCalled();
    expect(s.rows.filter((r) => r.reason === 'CONSUME')).toEqual([
      expect.objectContaining({
        delta: -5,
        generatedVideoId: 'story:audio:g1',
      }),
    ]);
  });
  it('insufficient balance: nothing written, the balance reported', async () => {
    const s = setup([{ userId: 'u1', delta: 4, reason: 'PURCHASE' }]);
    await expect(
      s.service.reserveKeyed(s.tx, 'u1', 'story:video:r1', 5),
    ).resolves.toEqual({ reserved: false, balance: 4 });
    expect(s.tx.creditLedger.create).not.toHaveBeenCalled();
    await expect(
      setup().service.reserveKeyed(setup().tx, 'u1', 'k', 1),
    ).resolves.toEqual({ reserved: false, balance: 0 });
  });
  it('rejects a non-positive amount and a key of another user', async () => {
    const s = setup([
      { userId: 'u2', delta: -1, reason: 'CONSUME', generatedVideoId: 'k' },
    ]);
    await expect(s.service.reserveKeyed(s.tx, 'u1', 'x', 0)).rejects.toThrow();
    await expect(s.service.reserveKeyed(s.tx, 'u1', 'k', 1)).rejects.toThrow(
      'another user',
    );
  });
  it('refunds exactly what was consumed, once; nothing when nothing was consumed', async () => {
    const s = setup([{ userId: 'u1', delta: 10, reason: 'PURCHASE' }]);
    await s.service.reserveKeyed(s.tx, 'u1', 'story:video:r1', 6);
    await expect(s.service.refundKeyed(s.tx, 'story:video:r1')).resolves.toBe(
      6,
    );
    await expect(s.service.refundKeyed(s.tx, 'story:video:r1')).resolves.toBe(
      0,
    );
    await expect(s.service.refundKeyed(s.tx, 'story:none')).resolves.toBe(0);
    expect(s.balance()).toBe(10);
    expect(s.rows.filter((r) => r.reason === 'REFUND')).toEqual([
      expect.objectContaining({ delta: 6, userId: 'u1' }),
    ]);
  });
});
