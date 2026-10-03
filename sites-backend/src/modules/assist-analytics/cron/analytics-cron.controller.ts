/**
 * Кроны аналитики — A (ТЗ §5-тер.14):
 *   GET /cron/assist-analytics-run     — каждые 10 минут (+ Э6-бис (г):
 *       проход монитора голосового управления Т-4 `assist-voice-monitor`
 *       ТЗ §5-бис.14 — отдельного крона нет, Vercel Hobby)
 *   GET /cron/assist-analytics-rollup  — 04:40 UTC
 * withCronLock + CRON_SECRET, как кроны Э1–Э2.
 */
import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AnalyticsRollup } from '../system/analytics-rollup.service';
import {
  VoiceMonitorService,
  type VoiceMonitorResult,
} from '../../assist-site-voice-control/system/voice-monitor.service';

/** Замок длиннее прохода: свёртка активных сайтов + до 3 выгрузок. */
const RUN_LOCK_MS = 8 * 60 * 1000;
/** Суточный проход по всем сайтам — до 15 мин. */
const DAILY_LOCK_MS = 15 * 60 * 1000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistAnalyticsCronController {
  private readonly logger = new Logger(AssistAnalyticsCronController.name);

  constructor(
    private readonly rollup: AnalyticsRollup,
    private readonly voice: VoiceMonitorService,
  ) {}

  @Get('assist-analytics-run')
  async run(@Headers('authorization') authHeader?: string): Promise<{
    ran: boolean;
    sites?: number;
    exports?: number;
    voice?: VoiceMonitorResult | null;
  }> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.rollup.prisma,
      'assist-analytics-run',
      RUN_LOCK_MS,
      async () => {
        const a = await this.rollup.run(this.rollup.now());
        // Монитор Т-4: сбой не роняет свёртки аналитики (и наоборот).
        let voice: VoiceMonitorResult | null = null;
        try {
          voice = await this.voice.run();
        } catch (e) {
          voice = null;
          this.logger.error(
            `монитор голосового управления: ${(e as Error).name}`,
          );
        }
        return { ...a, voice };
      },
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
