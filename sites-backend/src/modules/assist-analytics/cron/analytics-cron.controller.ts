/**
 * Кроны аналитики — A (ТЗ §5-тер.14):
 *   GET /cron/assist-analytics-run     — каждые 10 минут
 *   GET /cron/assist-analytics-rollup  — 04:40 UTC
 * withCronLock + CRON_SECRET, как кроны Э1–Э2.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AnalyticsRollup } from '../system/analytics-rollup.service';

/** Замок длиннее прохода: свёртка активных сайтов + до 3 выгрузок. */
const RUN_LOCK_MS = 8 * 60 * 1000;
/** Суточный проход по всем сайтам — до 15 мин. */
const DAILY_LOCK_MS = 15 * 60 * 1000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistAnalyticsCronController {
  constructor(private readonly rollup: AnalyticsRollup) {}

  @Get('assist-analytics-run')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ ran: boolean; sites?: number; exports?: number }> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.rollup.prisma,
      'assist-analytics-run',
      RUN_LOCK_MS,
      () => this.rollup.run(this.rollup.now()),
    );
    return r.ran && r.result ? { ran: true, ...r.result } : { ran: false };
  }

  @Get('assist-analytics-rollup')
  async daily(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ ran: boolean; sites?: number; staleGoals?: number }> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.rollup.prisma,
      'assist-analytics-rollup',
      DAILY_LOCK_MS,
      () => this.rollup.daily(this.rollup.now()),
    );
    return r.ran && r.result ? { ran: true, ...r.result } : { ran: false };
  }
}
