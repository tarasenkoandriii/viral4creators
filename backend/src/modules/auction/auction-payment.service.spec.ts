/**
 * AuctionPaymentService — единственная точка, где деньги за лот
 * превращаются в проданную работу, зафиксированную комиссию и
 * заблокированный брендбук. Вызывается из ДВУХ независимых мест
 * (вебхук WayForPay и ручное подтверждение оператором), поэтому
 * повторное применение — не теоретический сценарий, а штатный: вебхук
 * WayForPay переотправляется при любом сомнении в доставке.
 *
 * Что здесь проверяется и почему это стоит проверять:
 *
 *  - ставка комиссии зависит от типа аукциона (30% BLITZ / 20%
 *    STANDARD) — единственное место в проекте, где эти числа вообще
 *    записаны; перепутанные местами, они молча недоберут или переберут
 *    деньги у исполнителя, и ни один тип не подскажет;
 *  - идемпотентность по paidAt — повторная доставка вебхука не должна
 *    ни пересчитать комиссию, ни переписать soldAt, ни отправить
 *    второе уведомление о продаже;
 *  - advisory-лок берётся ДО чтения платежа: без него две параллельные
 *    транзакции под READ COMMITTED обе увидят paidAt: null (аудит-фикс,
 *    см. доккомментарий applySuccess);
 *  - брендбук блокируется только у эксклюзивного лота;
 *  - PortfolioItem.soldPrice пишется в МАЖОРНЫХ единицах, тогда как
 *    AuctionPayment.amount хранится в минорных — перепутать легко,
 *    результат виден покупателю как цена в сто раз больше.
 */

import { NotFoundException } from '@nestjs/common';
import { AuctionPaymentService } from './auction-payment.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const paymentRow = (over: Record<string, unknown> = {}) => ({
  id: 'ap1',
  listingId: 'l1',
  winningBidId: 'b1',
  amount: 500_000, // минорные единицы = 5000.00
  commission: 0,
  paidAt: null,
  paymentId: null,
  listing: {
    id: 'l1',
    auctionType: 'STANDARD',
    portfolioItemId: 'pi1',
    creatorProfileId: 'cp1',
    includeBrandManifest: false,
    brandManifestId: null,
    ...((over.listing as Record<string, unknown>) ?? {}),
  },
  ...over,
});

function build(payment: ReturnType<typeof paymentRow> | null = paymentRow()) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    auctionPayment: {
      findUnique: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockResolvedValue({}),
    },
    portfolioItem: { update: jest.fn().mockResolvedValue({}) },
    brandManifest: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    creatorProfile: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cp1',
        user: { telegramId: '777' },
      }),
    },
    portfolioItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'pi1',
        title: 'Ролик про кружку',
      }),
    },
  };
  const notify = { dm: jest.fn().mockResolvedValue(undefined) };
  const service = new AuctionPaymentService(prisma as never, notify as never);
  return { service, tx, prisma, notify };
}

/** Уведомление о продаже намеренно не await'ится — даём микрозадачам отработать. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AuctionPaymentService.applySuccess', () => {
  it('STANDARD — комиссия 20% от суммы сделки, в тех же минорных единицах', async () => {
    const { service, tx } = build(paymentRow({ amount: 500_000 }));
    await service.applySuccess(tx as never, 'ap1');

    expect(tx.auctionPayment.update).toHaveBeenCalledWith({
      where: { id: 'ap1' },
      data: { commission: 100_000, paidAt: expect.any(Date) },
    });
  });

  it('BLITZ — комиссия 30%, не та же, что у STANDARD', async () => {
    const { service, tx } = build(
      paymentRow({ amount: 500_000, listing: { auctionType: 'BLITZ' } }),
    );
    await service.applySuccess(tx as never, 'ap1');

    const { data } = tx.auctionPayment.update.mock.calls[0][0] as {
      data: { commission: number };
    };
    expect(data.commission).toBe(150_000);
  });

  it('комиссия — всегда целое число минорных единиц, без «хвоста» плавающей точки', async () => {
    // 0.3 в двоичной плавающей точке не представим точно: до перехода на
    // Int это давало суммы вида 1499.9999999999998 копейки.
    for (const amount of [1, 3, 7, 333, 1999, 123_457]) {
      const { service, tx } = build(
        paymentRow({ amount, listing: { auctionType: 'BLITZ' } }),
      );
      await service.applySuccess(tx as never, 'ap1');
      const { data } = tx.auctionPayment.update.mock.calls[0][0] as {
        data: { commission: number };
      };
      expect(Number.isInteger(data.commission)).toBe(true);
      expect(data.commission).toBeLessThanOrEqual(amount);
    }
  });

  it('PortfolioItem помечается SOLD, а цена пишется в МАЖОРНЫХ единицах', async () => {
    const { service, tx } = build(paymentRow({ amount: 500_000 }));
    await service.applySuccess(tx as never, 'ap1');

    expect(tx.portfolioItem.update).toHaveBeenCalledWith({
      where: { id: 'pi1' },
      data: { status: 'SOLD', soldAt: expect.any(Date), soldPrice: 5000 },
    });
  });

  it('advisory-лок берётся ДО чтения платежа — иначе два вебхука разойдутся', async () => {
    const { service, tx } = build();
    await service.applySuccess(tx as never, 'ap1');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const order = tx.$executeRaw.mock.invocationCallOrder[0];
    const readOrder = tx.auctionPayment.findUnique.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(readOrder);

    const [chunks] = tx.$executeRaw.mock.calls[0] as [string[]];
    expect(chunks.join('?')).toContain('pg_advisory_xact_lock');
  });

  it('повторный вызов на уже оплаченном платеже не делает ничего — идемпотентность', async () => {
    const { service, tx, notify } = build(
      paymentRow({ paidAt: new Date('2026-09-01T10:00:00Z') }),
    );
    await service.applySuccess(tx as never, 'ap1');
    await flush();

    expect(tx.auctionPayment.update).not.toHaveBeenCalled();
    expect(tx.portfolioItem.update).not.toHaveBeenCalled();
    expect(tx.brandManifest.update).not.toHaveBeenCalled();
    expect(notify.dm).not.toHaveBeenCalled(); // второго «ваша работа продана» быть не должно
  });

  it('несуществующий платёж — 404, а не тихий выход', async () => {
    const { service, tx } = build(null);
    await expect(
      service.applySuccess(tx as never, 'ap-нет'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('эксклюзивный лот — брендбук блокируется', async () => {
    const { service, tx } = build(
      paymentRow({
        listing: { includeBrandManifest: true, brandManifestId: 'bm1' },
      }),
    );
    await service.applySuccess(tx as never, 'ap1');

    expect(tx.brandManifest.update).toHaveBeenCalledWith({
      where: { id: 'bm1' },
      data: { isLocked: true },
    });
  });

  it('обычный лот — чужой брендбук не блокируется', async () => {
    const { service, tx } = build(
      // Ссылка на манифест есть, но продажа НЕ эксклюзивная: заблокировать
      // его здесь значило бы лишить исполнителя собственного брендбука.
      paymentRow({
        listing: { includeBrandManifest: false, brandManifestId: 'bm1' },
      }),
    );
    await service.applySuccess(tx as never, 'ap1');

    expect(tx.brandManifest.update).not.toHaveBeenCalled();
  });

  it('исполнитель получает уведомление о продаже с суммой в мажорных единицах', async () => {
    const { service, tx, notify } = build(paymentRow({ amount: 500_000 }));
    await service.applySuccess(tx as never, 'ap1');
    await flush();

    expect(notify.dm).toHaveBeenCalledTimes(1);
    const [telegramId, text] = notify.dm.mock.calls[0] as [string, string];
    expect(telegramId).toBe('777');
    expect(text).toContain('5000');
    expect(text).not.toContain('500000'); // минорные единицы человеку не показываем
  });

  it('заблокированный бот не роняет оплату — уведомление best-effort', async () => {
    const { service, tx, notify } = build();
    notify.dm.mockRejectedValueOnce(
      new Error('Forbidden: bot was blocked by the user'),
    );

    await expect(
      service.applySuccess(tx as never, 'ap1'),
    ).resolves.toBeUndefined();
    await flush();
    // Факт оплаты при этом зафиксирован — именно ради этого уведомление
    // отправляется вне транзакции и без await.
    expect(tx.auctionPayment.update).toHaveBeenCalled();
  });

  it('уведомление использует обычный prisma, а не транзакционный клиент вызывающего', async () => {
    // Транзакционный клиент Prisma не переживает возврат из колбэка —
    // отложенное уведомление, обратившееся к нему, упало бы уже после
    // коммита, в никуда (см. доккомментарий конструктора).
    const { service, tx, prisma } = build();
    await service.applySuccess(tx as never, 'ap1');
    await flush();

    expect(prisma.creatorProfile.findUnique).toHaveBeenCalled();
    expect(prisma.portfolioItem.findUnique).toHaveBeenCalled();
    expect(tx.portfolioItem.update).toHaveBeenCalled(); // а запись — через tx
  });
});
