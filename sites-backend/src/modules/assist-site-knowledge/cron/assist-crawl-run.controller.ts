/**
 * GET /cron/assist-crawl-run — K1 (§4.15, каждые 2 минуты — sites-backend/vercel.json).
 * assertCronSecret → withCronLock('assist-crawl-run') → scheduleDue →
 * SiteCrawlService.tick(CRAWL_DEFAULTS.tickBudgetMs).
 *
 * Замок крона — поверх построчных lease прогонов и очереди: два тика
 * (расписание Vercel и ручной вызов) не делят один бюджет вежливости к
 * хосту и не запрашивают один и тот же плановый обход дважды.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { assertCronSecret } from '../../../common/cron-secret';
import { withCronLock } from '../../../common/cron-job-lock';
import { CRAWL_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CrawlTickResult } from '../../site-crawl/types';
import { SiteCrawlService } from '../../site-crawl/crawl.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  AssistCrawlScheduler,
  CrawlScheduleResult,
} from '../crawl-scheduler.service';

/** TTL замка: бюджет тика + запас на расписание и запись итогов. */
export const CRAWL_RUN_LOCK_TTL_MS =
  CRAWL_DEFAULTS.tickBudgetMs + 4 * 60 * 1000;

export interface CrawlRunCronResult {
  ran: boolean;
  schedule?: CrawlScheduleResult;
  tick?: CrawlTickResult;
}

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistCrawlRunController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: AssistCrawlScheduler,
    private readonly crawl: SiteCrawlService,
  ) {}

  @Get('assist-crawl-run')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<CrawlRunCronResult> {
    assertCronSecret(authHeader);
    const res = await withCronLock(
      this.prisma,
      'assist-crawl-run',
      CRAWL_RUN_LOCK_TTL_MS,
      async () => {
        const schedule = await this.scheduler.scheduleDue(new Date());
        const tick = await this.crawl.tick(CRAWL_DEFAULTS.tickBudgetMs);
        return { schedule, tick };
      },
    );
    return res.ran ? { ran: true, ...res.result } : { ran: false };
  }
}
