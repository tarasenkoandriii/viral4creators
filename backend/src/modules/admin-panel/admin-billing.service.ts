/**
 * AdminBillingService — список платежей и возврат средств в админке (ТЗ
 * §41, этап 62). Отдельный сервис, а не расширение `AdminPanelService`:
 * та же причина, что развела `AdminUsersService` в свой файл на этапе
 * 30 — платежи снимаются с пользователей и их сессий, но отвечают на
 * другой вопрос («что произошло с деньгами»), у него свой список,
 * фильтры и единственное действие.
 *
 * Возврат средств устроен по-разному для двух провайдеров (§41,
 * открытый вопрос 5): у Stars есть настоящий API `refundStarPayment` —
 * вызываем и, если Telegram подтвердил, ставим статус REFUNDED. У
 * WayForPay такого автоматизированного возврата в этом этапе нет —
 * оператор нажимает кнопку ТОЛЬКО чтобы пометить строку REFUNDED у
 * себя (после того как вернул деньги руками в личном кабинете
 * WayForPay); делать вид, что API вызван, когда его нет, было бы хуже,
 * чем явно сказать, что действие ручное.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramStarsService } from '../billing/telegram-stars.service';

export interface AdminPaymentRow {
  id: string;
  userId: string;
  telegramId: string;
  method: 'STARS' | 'WAYFORPAY';
  purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
  plan: string | null;
  creditsGranted: number | null;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  currency: string;
  amount: number;
  providerRef: string;
  failureReason: string | null;
  createdAt: Date;
}

export interface AdminPaymentListResult {
  items: AdminPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class AdminBillingService {
  private readonly logger = new Logger(AdminBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stars: TelegramStarsService,
  ) {}

  async listPayments(opts: {
    status?: string;
    method?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminPaymentListResult> {
    const where: Record<string, unknown> = {};
    if (
      opts.status &&
      ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'].includes(opts.status)
    ) {
      where.status = opts.status;
    }
    if (opts.method && ['STARS', 'WAYFORPAY'].includes(opts.method)) {
      where.method = opts.method;
    }
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: { user: { select: { telegramId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return {
      items: (
        rows as unknown as Array<{
          id: string;
          userId: string;
          user: { telegramId: string };
          method: 'STARS' | 'WAYFORPAY';
          purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
          plan: string | null;
          creditsGranted: number | null;
          status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
          currency: string;
          amount: number;
          providerRef: string;
          failureReason: string | null;
          createdAt: Date;
        }>
      ).map((r) => ({
        id: r.id,
        userId: r.userId,
        telegramId: r.user.telegramId,
        method: r.method,
        purpose: r.purpose,
        plan: r.plan,
        creditsGranted: r.creditsGranted,
        status: r.status,
        currency: r.currency,
        amount: r.amount,
        providerRef: r.providerRef,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
      })),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async refund(actorId: string, id: string): Promise<AdminPaymentRow> {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { user: { select: { telegramId: true } } },
    });
    if (!payment) throw new NotFoundException(`Payment ${id} not found`);
    // Возврат — операция над УСПЕШНЫМ платежом: PENDING/FAILED вернуть
    // нечего, а повторный клик по уже REFUNDED не должен второй раз
    // дёргать API Stars — идемпотентность важнее удобства кнопки.
    if (payment.status !== 'SUCCEEDED') {
      throw new BadRequestException(
        `Платёж в статусе ${payment.status} нельзя вернуть — возврат доступен только для SUCCEEDED`,
      );
    }

    if (payment.method === 'STARS') {
      const ok = await this.stars.refundStarPayment(
        payment.user.telegramId,
        payment.providerRef,
      );
      if (!ok) {
        this.logger.warn(
          `operator ${actorId}: refundStarPayment вернул отказ для платежа ${id} — статус не меняем`,
        );
        return this.rowOf(payment);
      }
    } else {
      // WayForPay: API-возврата нет в этом этапе — оператор уже вернул
      // деньги руками, здесь только фиксируем это у себя.
      this.logger.log(
        `operator ${actorId} пометил платёж WayForPay ${id} возвращённым (ручной возврат в личном кабинете WayForPay)`,
      );
    }

    const updated = await this.prisma.payment.update({
      where: { id },
      data: { status: 'REFUNDED' },
      include: { user: { select: { telegramId: true } } },
    });
    return this.rowOf(updated);
  }

  private rowOf(row: {
    id: string;
    userId: string;
    user: { telegramId: string };
    method: 'STARS' | 'WAYFORPAY';
    purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
    plan: string | null;
    creditsGranted: number | null;
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
    currency: string;
    amount: number;
    providerRef: string;
    failureReason: string | null;
    createdAt: Date;
  }): AdminPaymentRow {
    return {
      id: row.id,
      userId: row.userId,
      telegramId: row.user.telegramId,
      method: row.method,
      purpose: row.purpose,
      plan: row.plan,
      creditsGranted: row.creditsGranted,
      status: row.status,
      currency: row.currency,
      amount: row.amount,
      providerRef: row.providerRef,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
    };
  }
}
