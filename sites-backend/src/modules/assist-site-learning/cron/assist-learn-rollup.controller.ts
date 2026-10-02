/**
 * GET /cron/assist-learn-rollup — L (ТЗ §4.15: 20 5 * * *). withCronLock +
 * CRON_SECRET, как кроны Э1–Э2. Проход по всем сайтам (scope — только у
 * сервиса и только в тестах).
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  LearnRollup,
  type LearnRollupResult,
} from '../system/learn-rollup.service';

export const LEARN_ROLLUP_JOB = 'assist-learn-rollup';
/** Аренда замка: суточный разбор + плановые eval (maxDuration Vercel — 300 с). */
export const LEARN_ROLLUP_LEASE_MS = 6 * 60 * 1000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistLearnRollupController {
  constructor(private readonly rollup: LearnRollup) {}

  @Get('assist-learn-rollup')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ ran: boolean } & Partial<LearnRollupResult>> {
    assertCronSecret(authHeader);
    const lock = await withCronLock(
      this.rollup.prisma,
      LEARN_ROLLUP_JOB,
      LEARN_ROLLUP_LEASE_MS,
      () => this.rollup.run(this.rollup.now()),
    );
    if (!lock.ran || !lock.result) return { ran: false };
    return { ran: true, ...lock.result };
  }
}
