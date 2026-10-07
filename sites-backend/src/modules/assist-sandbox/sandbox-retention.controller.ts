/**
 * GET /cron/assist-retention — K3 (§4.15, `0 3 * * *` UTC — свой крон в
 * sites-backend/vercel.json). Э1: удаляет песочницы с истёкшим expiresAt
 * (каскадом страницы, фрагменты, сообщения) и сбрасывает суточные
 * счётчики старше 2 дней; чистит строки очереди обхода у прогонов,
 * завершённых больше 7 дней назад. Дальнейшие этапы добавят сюда сроки диалогов/лидов.
 * Э2 (W3): + ретенция виджета — ChatRetention (assist-site-chat/system):
 * диалоги/лиды по срокам сайта, указатели, токены предпросмотра, кэш,
 * окна лимитов, строки денег, история версий, события и черновики лендинга.
 * C4 захода 8: + уборка у Soniox файлов и транскрипций старше часа
 * (`sweepStaleSoniox`) — своего срока хранения у провайдера нет.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../common/cron-job-lock';
import { assertCronSecret } from '../../common/cron-secret';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatRetention } from '../assist-site-chat/system/chat-retention.service';
import { sweepStaleSoniox } from '../assist-site-voice/public/soniox-stt.client';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { SandboxService } from './sandbox.service';

/** Замок длиннее самой работы: два удаления не идут одновременно. */
const RETENTION_LOCK_MS = 10 * 60 * 1000;
/** Строки очереди завершённого прогона живут неделю — для разбора жалоб. */
export const CRAWL_QUEUE_RETENTION_MS = 7 * 86_400_000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistRetentionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sandbox: SandboxService,
    private readonly crawl: SiteCrawlService,
    private readonly chat: ChatRetention,
  ) {}

  @Get('assist-retention')
  async run(@Headers('authorization') authHeader?: string) {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.prisma,
      'assist-retention',
      RETENTION_LOCK_MS,
      async () => ({
        ...(await this.sandbox.retention()),
        crawlQueueDeleted: await this.crawl.purgeFinishedQueue(
          new Date(Date.now() - CRAWL_QUEUE_RETENTION_MS),
        ),
        ...(await this.chat.run()),
        ...(await sweepStaleSoniox()),
      }),
    );
    return r.ran
      ? { ran: true, ...r.result }
      : {
          ran: false,
          sandboxesDeleted: 0,
          countersDeleted: 0,
          crawlQueueDeleted: 0,
        };
  }
}
