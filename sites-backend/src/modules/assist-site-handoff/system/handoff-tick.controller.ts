/**
 * GET /cron/assist-handoff-tick — H (ТЗ §4.15, каждые 2 минуты): таймауты,
 * напоминания, повтор рассылки, медиана «~N минут» (HandoffDispatcher.tick).
 * withCronLock + CRON_SECRET, как кроны Э1–Э2.
 */
import { Controller, Get, Headers, Logger, Optional } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { LEARNING_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { LearnRollup } from '../../assist-site-learning/system/learn-rollup.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import {
  HandoffDispatcher,
  type HandoffTickResult,
} from './handoff-dispatcher.service';

/** Замок длиннее одного прохода (крон каждые 2 минуты). */
const TICK_LOCK_MS = 110_000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistHandoffTickController {
  private readonly logger = new Logger(AssistHandoffTickController.name);

  constructor(
    private readonly dispatcher: HandoffDispatcher,
    private readonly prisma: PrismaService,
    @Optional() private readonly learn?: LearnRollup,
  ) {}

  @Get('assist-handoff-tick')
  async run(
    @Headers('authorization') authHeader?: string,
  ): Promise<{ ran: boolean } & Partial<HandoffTickResult>> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.prisma,
      'assist-handoff-tick',
      TICK_LOCK_MS,
      async () => {
        const res = await this.dispatcher.tick(new Date());
        // Хвост forget (L) — минутная задержка вместо суточной (решение 10).
        if (this.learn) {
          res.forgetJobs = await this.learn
            .processForgetJobs(LEARNING_DEFAULTS.forgetJobsPerTick)
            .catch((e: unknown) => {
              this.logger.warn(
                `forget: сбой хвоста (${(e as Error | null)?.name ?? 'Error'})`,
              );
              return 0;
            });
        }
        return res;
      },
    );
    return r.ran && r.result ? { ran: true, ...r.result } : { ran: false };
  }
}
