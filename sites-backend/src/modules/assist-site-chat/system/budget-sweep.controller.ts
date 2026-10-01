/**
 * GET /cron/assist-budget-sweep — W3 (ТЗ §4.15, каждые 5 минут): снимает
 * просроченные резервы бюджета (§4.5 уточнение 2) и повторяет доставку
 * недоставленных лидов. withCronLock + CRON_SECRET, как кроны Э1.
 * Основная роль (папка system/): резервы всех сайтов разом.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { SiteBudget } from '../budget';
import { LeadDelivery } from './lead-delivery.service';

/** Замок длиннее одного прохода (доставка 20 лидов по нескольким получателям). */
const SWEEP_LOCK_MS = 4 * 60 * 1000;
/** Лидов за проход: крон каждые 5 мин — с запасом по времени функции. */
export const LEADS_PER_SWEEP = 20;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistBudgetSweepController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: SiteBudget,
    private readonly leads: LeadDelivery,
  ) {}

  @Get('assist-budget-sweep')
  async run(@Headers('authorization') authHeader?: string): Promise<{
    ran: boolean;
    reservationsReleased: number;
    leadsRedelivered: number;
  }> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.prisma,
      'assist-budget-sweep',
      SWEEP_LOCK_MS,
      async () => ({
        reservationsReleased: await this.budget.sweep(this.prisma),
        leadsRedelivered: await this.leads.redeliverPending(LEADS_PER_SWEEP),
      }),
    );
    return r.ran && r.result
      ? { ran: true, ...r.result }
      : { ran: false, reservationsReleased: 0, leadsRedelivered: 0 };
  }
}
