/**
 * Оркестратор Э3-бис в существующих кронах аналитики (Vercel Hobby — без
 * новых кронов; ТЗ §5-тер.14):
 *  - `assist-analytics-run` (10 мин): эксперименты (горизонт, SRM,
 *    авто-остановка), ИИ-разметка пачкой (время и число — с запасом до
 *    maxDuration), недельная работа нескольких сайтов (находки, выводы,
 *    калибровка, «до/после»);
 *  - `assist-analytics-rollup` (сутки): свёртка поведения и уборка сырых.
 * Сбой одной части не роняет другие (и свёртки Э3, и монитор голоса Э6-бис
 * в том же кроне — каждая обёрнута отдельно в контроллере).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { CronScope } from '../../../common/cron-scope';
import { BehaviorRollup } from '../behavior/behavior-rollup.service';
import { ExperimentsService } from '../exp/experiments.service';
import { WeeklyInsights, type WeeklyTickResult } from './insights.service';
import { ConversationLabeler, type LabelTickResult } from './labeler.service';

/** Бюджет времени тика на разметку и неделю (функция Vercel — с запасом). */
export const AI_TICK_MS = 60_000;
export const LABELS_PER_TICK = 40;
export const WEEKLY_SITES_PER_TICK = 5;

export interface AiRunResult {
  labels: LabelTickResult | null;
  weekly: WeeklyTickResult | null;
  experiments: {
    done: number;
    invalid: number;
    stopped: number;
    purged: number;
  } | null;
}

@Injectable()
export class AiAnalyticsRunner {
  private readonly logger = new Logger(AiAnalyticsRunner.name);

  constructor(
    private readonly labeler: ConversationLabeler,
    private readonly weekly: WeeklyInsights,
    private readonly experiments: ExperimentsService,
    private readonly behavior: BehaviorRollup,
  ) {}

  private async part<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.logger.error(`${name}: ${(e as Error | null)?.name ?? 'Error'}`);
      return null;
    }
  }

  async run(now: Date, scope?: CronScope): Promise<AiRunResult> {
    const deadline = Date.now() + AI_TICK_MS;
    const experiments = await this.part('эксперименты', () =>
      this.experiments.tick(now, scope),
    );
    const labels = await this.part('разметка', () =>
      this.labeler.tick({ now, deadline, max: LABELS_PER_TICK, scope }),
    );
    const weekly = await this.part('неделя', () =>
      this.weekly.tick({
        now,
        deadline: Math.max(deadline, Date.now() + 15_000),
        maxSites: WEEKLY_SITES_PER_TICK,
        scope,
      }),
    );
    return { labels, weekly, experiments };
  }

  daily(now: Date, scope?: CronScope) {
    return this.part('поведение', () => this.behavior.daily(now, scope));
  }
}
