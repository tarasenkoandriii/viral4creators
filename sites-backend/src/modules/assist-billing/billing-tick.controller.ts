/**
 * GET /cron/assist-billing-tick — каждые 10 минут (vercel.json): пробные,
 * просроченные счета, продление WayForPay, истечение, автодокупка,
 * предупреждения 80/100% (AssistBillingTick). withCronLock + CRON_SECRET,
 * как остальные кроны sites-backend.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../common/cron-job-lock';
import { assertCronSecret } from '../../common/cron-secret';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  AssistBillingTick,
  type BillingTickResult,
} from './billing-tick.service';

/** Замок длиннее прохода (до 50 списаний по 15 с таймаута — с запасом). */
const TICK_LOCK_MS = 9 * 60 * 1000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistBillingTickController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tick: AssistBillingTick,
  ) {}

  @Get('assist-billing-tick')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ ran: boolean } & Partial<BillingTickResult>> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.prisma,
      'assist-billing-tick',
      TICK_LOCK_MS,
      () => this.tick.run(),
    );
    return r.ran && r.result ? { ran: true, ...r.result } : { ran: false };
  }
}
