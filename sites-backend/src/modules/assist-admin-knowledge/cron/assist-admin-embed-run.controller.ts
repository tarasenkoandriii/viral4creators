/**
 * GET /cron/assist-admin-embed-run — K2: то же, что assist-embed-run, для
 * «Админки» (свой крон: модуль «Сайта» не может импортировать «Админку»).
 * assertCronSecret → withCronLock('assist-admin-embed-run') →
 * AdminSourcesService.processPendingFiles (K3) → AdminIndexingService.tick →
 * (заход 10) аналитика «Админки» `AdminAnalyticsRunner`: выгрузки CSV каждый
 * тик; тревога компенсаций (push владельцу, Р-З10-13), свёртка, разметка и
 * неделя — не чаще раза в 10 мин. Без нового крона (Vercel Hobby).
 * Сбой аналитики не роняет индексацию и наоборот.
 */
import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { CRAWL_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  AdminAnalyticsRunner,
  type AdminAnalyticsRunResult,
} from '../../assist-admin-analytics/admin-analytics.runner';
import {
  AdminIndexingService,
  type AdminIndexTickResult,
} from '../admin-indexing.service';
import { AdminSourcesService } from '../admin-sources.service';

export const ADMIN_EMBED_RUN_JOB = 'assist-admin-embed-run';
/** Время аналитики «Админки» в тике: не меньше / не больше. */
export const ADMIN_ANALYTICS_MIN_MS = 10_000;
export const ADMIN_ANALYTICS_MAX_MS = 25_000;

export interface AdminEmbedRunResult {
  ran: boolean;
  filesProcessed: number;
  filesError: string | null;
  index: AdminIndexTickResult | null;
  analytics?: AdminAnalyticsRunResult | null;
}

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistAdminEmbedRunController {
  private readonly logger = new Logger(AssistAdminEmbedRunController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: AdminSourcesService,
    private readonly indexing: AdminIndexingService,
    private readonly analytics: AdminAnalyticsRunner,
  ) {}

  @Get('assist-admin-embed-run')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<AdminEmbedRunResult> {
    assertCronSecret(authHeader);
    const budget = CRAWL_DEFAULTS.tickBudgetMs;
    const started = Date.now();
    const lock = await withCronLock(
      this.prisma,
      ADMIN_EMBED_RUN_JOB,
      budget + 60_000,
      async () => {
        let filesProcessed = 0;
        let filesError: string | null = null;
        try {
          filesProcessed = (
            await this.sources.processPendingFiles(Math.floor(budget / 3))
          ).processed;
        } catch (e) {
          filesError = (e as Error).name;
          this.logger.error(
            `Разбор файлов «Админки» не удался: ${(e as Error).message}`,
          );
        }
        const left = Math.max(1_000, budget - (Date.now() - started));
        const index = await this.indexing.tick(left);
        let analytics: AdminAnalyticsRunResult | null = null;
        try {
          const rest = budget - (Date.now() - started);
          const ms = Math.min(
            ADMIN_ANALYTICS_MAX_MS,
            Math.max(ADMIN_ANALYTICS_MIN_MS, rest),
          );
          analytics = await this.analytics.run(new Date(), Date.now() + ms);
        } catch (e) {
          this.logger.error(
            `Аналитика «Админки» не удалась: ${(e as Error | null)?.name ?? 'Error'}`,
          );
        }
        return { filesProcessed, filesError, index, analytics };
      },
    );
    if (!lock.ran || !lock.result) {
      return { ran: false, filesProcessed: 0, filesError: null, index: null };
    }
    return { ran: true, ...lock.result };
  }
}
