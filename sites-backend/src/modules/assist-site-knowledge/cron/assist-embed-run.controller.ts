/**
 * GET /cron/assist-embed-run — K2 (§4.15, каждые 2 минуты — sites-backend/vercel.json).
 * assertCronSecret → withCronLock('assist-embed-run') →
 * SiteSourcesService.processPendingFiles (K3) → SiteIndexingService.tick.
 *
 * Разбор файлов и индексация делят бюджет тика: файлам — не больше трети
 * (их разбор — CPU и Blob), остальное — индексации. Сбой разбора файлов
 * не останавливает индексацию обхода — это разные источники.
 */
import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { CRAWL_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  SiteIndexingService,
  type IndexTickResult,
} from '../site-indexing.service';
import { SiteSourcesService } from '../site-sources.service';

export const EMBED_RUN_JOB = 'assist-embed-run';

export interface EmbedRunResult {
  ran: boolean;
  filesProcessed: number;
  filesError: string | null;
  index: IndexTickResult | null;
}

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistEmbedRunController {
  private readonly logger = new Logger(AssistEmbedRunController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: SiteSourcesService,
    private readonly indexing: SiteIndexingService,
  ) {}

  @Get('assist-embed-run')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<EmbedRunResult> {
    assertCronSecret(authHeader);
    const budget = CRAWL_DEFAULTS.tickBudgetMs;
    const started = Date.now();
    const lock = await withCronLock(
      this.prisma,
      EMBED_RUN_JOB,
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
            `Разбор файлов «Сайта» не удался: ${(e as Error).message}`,
          );
        }
        const left = Math.max(1_000, budget - (Date.now() - started));
        const index = await this.indexing.tick(left);
        return { filesProcessed, filesError, index };
      },
    );
    if (!lock.ran || !lock.result) {
      return { ran: false, filesProcessed: 0, filesError: null, index: null };
    }
    return { ran: true, ...lock.result };
  }
}
