/**
 * GET /cron/assist-admin-retention — сроки хранения «Админки» (Э7, ТЗ §6.3,
 * §5.7, В-5): истёкшие сессии сотрудников (сразу), диалоги сотрудников
 * старше 90 дней (вместе с сообщениями и очередью — каскадом), журнал
 * вызовов старше года (триггер пускает DELETE только с флагом чистки).
 * Своё имя замка — крон «Сайта» (`assist-retention`) «Админку» не знает
 * (граф site↛admin).
 */
import { Controller, Get, Headers } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';

export const ADMIN_RETENTION_JOB = 'assist-admin-retention';
export const ADMIN_DIALOG_RETENTION_DAYS = 90;
export const ADMIN_LOG_RETENTION_DAYS = 365;
const DAY = 86_400_000;

export interface AdminRetentionResult {
  ran: boolean;
  sessions: number;
  conversations: number;
  log: number;
}

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistAdminRetentionController {
  constructor(private readonly prisma: PrismaService) {}

  /** Тело крона — отдельно, для теста без HTTP. */
  async runOnce(now = new Date()): Promise<Omit<AdminRetentionResult, 'ran'>> {
    // Кроны идут по всем кабинетам: сырой клиент (как assist-retention).
    const sessions = await this.prisma.assistAdminSession.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const conversations = await this.prisma.assistAdminConversation.deleteMany({
      where: {
        lastActivityAt: {
          lt: new Date(now.getTime() - ADMIN_DIALOG_RETENTION_DAYS * DAY),
        },
      },
    });
    const log = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('sites.admin_action_log_purge', 'on', true)`;
      return tx.$executeRaw`DELETE FROM "sites"."assist_admin_action_log"
        WHERE "at" < ${new Date(now.getTime() - ADMIN_LOG_RETENTION_DAYS * DAY)}`;
    });
    return {
      sessions: sessions.count,
      conversations: conversations.count,
      log,
    };
  }

  @Get('assist-admin-retention')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<AdminRetentionResult> {
    assertCronSecret(authHeader);
    const lock = await withCronLock(
      this.prisma,
      ADMIN_RETENTION_JOB,
      10 * 60_000,
      () => this.runOnce(),
    );
    if (!lock.ran || !lock.result) {
      return { ran: false, sessions: 0, conversations: 0, log: 0 };
    }
    return { ran: true, ...lock.result };
  }
}
