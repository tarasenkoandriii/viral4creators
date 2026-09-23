/**
 * Единственная точка, где успешная оплата аукциона превращается в
 * PortfolioItem.status → SOLD + BrandManifest.isLocked + зафиксированную
 * комиссию (ТЗ на маркетплейс §22, Этап 2 — self-serve чек-аут).
 *
 * Намеренно отдельный, узкий модуль без зависимостей от auction/billing
 * в любую сторону: и AuctionService (ручное подтверждение оператором,
 * `POST /admin/auctions/:id/confirm-payment`), и BillingService (вебхук
 * WayForPay, уже протестированный провайдер) вызывают этот ОДИН метод,
 * а не дублируют логику каждый у себя. Без этой развязки AuctionModule
 * (импортирует BillingModule для старта чекаута) и BillingModule
 * (импортировал бы AuctionModule для применения оплаты) образовали бы
 * цикл — см. AuctionPaymentModule.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { toMajorUnits } from '../../common/money';

@Injectable()
export class AuctionPaymentService {
  private readonly logger = new Logger(AuctionPaymentService.name);

  /**
   * `prisma` (не `tx`!) — только для уведомления НИЖЕ, которое намеренно
   * не await'ится (см. комментарий у sendSoldNotification): к моменту,
   * когда оно реально выполнится, `tx` вызывающего может быть уже закрыт
   * (транзакционный клиент Prisma не переживает возврат из колбэка), а
   * обычный PrismaService переживает вызов всегда.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
  ) {}

  /**
   * `tx` — клиент активной транзакции ВЫЗЫВАЮЩЕГО (тот же приём, что
   * `BillingService.applySuccessfulPayment` уже использует для
   * SUBSCRIPTION/CREDIT_PACK): статус AuctionPayment и его побочные
   * эффекты должны закоммититься вместе со статусом Payment одной
   * транзакцией — иначе возможно «оплачено, не выдано» при сбое между
   * шагами. Обычный PrismaService (вне транзакции) тоже подходит —
   * структурно шире, чем требует Prisma.TransactionClient — им
   * пользуется ручной путь оператора, оборачивая вызов в свою
   * однооперационную $transaction для того же гарантии.
   */
  async applySuccess(
    tx: Prisma.TransactionClient,
    auctionPaymentId: string,
  ): Promise<void> {
    // Аудит-фикс: раньше единственной защитой от повторного применения
    // был `if (payment.paidAt) return` НИЖЕ — под READ COMMITTED (дефолт
    // Postgres) это не защищает от двух ПАРАЛЛЕЛЬНЫХ вызовов. Этот метод
    // вызывается из двух независимых мест (вебхук WayForPay и ручной
    // `AuctionService.adminConfirmPayment`), и раньше только у вебхука
    // была своя сериализация (`pg_advisory_xact_lock` в
    // `BillingService`); `adminConfirmPayment` её не разделял. Если
    // оператор вручную подтверждал оплату в тот же момент, что вебхук
    // обрабатывал тот же платёж, обе транзакции могли прочитать
    // `paidAt: null` до того, как любая из них закоммитилась, и обе
    // применить побочные эффекты дважды — PortfolioItem.status → SOLD
    // (перезаписью soldAt/soldPrice), повторную блокировку брендбука
    // (безвредно, идемпотентно) и, конкретнее всего, ДВОЙНОЕ уведомление
    // исполнителя о продаже. Лок теперь здесь, в единственной общей
    // точке (см. доккомментарий класса) — не зависит от того, кто и
    // сколько раз вызовет applySuccess одновременно для одного и того
    // же платежа, они гарантированно сериализуются.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`auction-payment:${auctionPaymentId}`}))`;

    const payment = await tx.auctionPayment.findUnique({
      where: { id: auctionPaymentId },
      include: { listing: true },
    });
    if (!payment) {
      throw new NotFoundException(
        `auction payment not found: ${auctionPaymentId}`,
      );
    }
    if (payment.paidAt) {
      return; // идемпотентно — уже применено (например, повторная доставка вебхука)
    }

    const commissionRate = payment.listing.auctionType === 'BLITZ' ? 0.3 : 0.2;
    // Аудит-фикс (Float→Int минорные единицы, см. docs-tz/AUDIT-Auction-
    // Money-Currency.md): payment.amount теперь целое число минорных
    // единиц (копейки/центы) — Math.round(payment.amount * commissionRate)
    // округляет результат до ближайшей целой минорной единицы напрямую,
    // без промежуточного «round to major cents» (*100/100) из предыдущего
    // прохода, который был нужен только пока amount был Float в мажорных
    // единицах. Двоичная плавающая точка (0.30000000000000004 и т.п.)
    // здесь больше не может накопиться — оба операнда целые, результат
    // округляется один раз.
    const commission = Math.round(payment.amount * commissionRate);

    await tx.auctionPayment.update({
      where: { id: auctionPaymentId },
      data: { commission, paidAt: new Date() },
    });
    await tx.portfolioItem.update({
      where: { id: payment.listing.portfolioItemId },
      // PortfolioItem.soldPrice НЕ мигрирован на минорные единицы —
      // остаётся Float в МАЖОРНЫХ (read-only витринное поле карточки
      // «Продано», уже отдаётся наружу в API как есть) — конвертируем
      // здесь, на границе записи.
      data: {
        status: 'SOLD',
        soldAt: new Date(),
        soldPrice: toMajorUnits(payment.amount),
      },
    });
    if (
      payment.listing.includeBrandManifest &&
      payment.listing.brandManifestId
    ) {
      await tx.brandManifest.update({
        where: { id: payment.listing.brandManifestId },
        data: { isLocked: true },
      });
    }

    // Реальный пробел, закрытый этим фиксом: до сих пор уведомлялся
    // только победивший покупатель (AuctionService.notifyWinner) —
    // исполнитель узнавал о продаже собственной работы только заходя на
    // /my-auctions вручную. Не await — тот же приём, что у notifyWinner:
    // сеть/заблокированный бот не должны держать открытой транзакцию
    // вызывающего или ронять сам факт оплаты.
    // payment.amount — минорные единицы; sendSoldNotification форматирует сообщение для человека в мажорных.
    void this.sendSoldNotification(
      payment.listing.creatorProfileId,
      payment.listing.portfolioItemId,
      toMajorUnits(payment.amount),
    );
  }

  /** Best-effort, через отдельный PrismaService — см. доккомментарий конструктора. */
  private async sendSoldNotification(
    creatorProfileId: string,
    portfolioItemId: string,
    amount: number,
  ): Promise<void> {
    try {
      const [profile, item] = await Promise.all([
        this.prisma.creatorProfile.findUnique({
          where: { id: creatorProfileId },
          include: { user: true },
        }),
        this.prisma.portfolioItem.findUnique({
          where: { id: portfolioItemId },
        }),
      ]);
      if (!profile || !item) return;
      await this.notify.dm(
        profile.user.telegramId,
        `💰 Ваша работа «${item.title}» продана на аукционе за ${amount}. Подробности — в разделе «Мои заявки на аукцион».`,
      );
    } catch (e) {
      this.logger.warn(
        `Уведомление о продаже не удалось: ${(e as Error).message}`,
      );
    }
  }
}
