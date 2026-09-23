/**
 * Настройки советника для админки («Тонкая красная линия» §3.4, §5.8,
 * §10). Тонкая обёртка над `PlatformSettingsService`, как и соседние
 * карточки вкладки настроек.
 *
 * Отдельные ключи, а не переиспользование ассистентских: лендинговый
 * ассистент и советник в мастере — разные фичи с разной экономикой, и
 * гасить их придётся по отдельности. Ровно та же причина, по которой у
 * подсказки своя строка в `ai-pricing.ts`.
 *
 * Три настройки, а не одна: рубильник отвечает на «работает ли фича»,
 * бюджет — на «сколько нам это стоит в сутки», личный лимит — на
 * «может ли один человек выбрать общий бюджет». Их приходится крутить
 * по отдельности и в разные моменты, поэтому одной галочкой они не
 * складываются.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  AI_GUIDE_BUDGET_KEY,
  AI_GUIDE_ENABLED_KEY,
  AI_GUIDE_PERSONAL_LIMIT_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_PERSONAL_LIMIT,
  numberSettingValue,
} from './guide-settings';

export interface AiGuideSettingsView {
  enabled: boolean;
  /** Общий дневной потолок расхода фичи, микродоллары. */
  dailyBudgetMicroUsd: number;
  /** Сколько подсказок в сутки положено одному человеку. */
  personalLimit: number;
}

export interface SetAiGuideSettingsInput {
  enabled?: boolean;
  dailyBudgetMicroUsd?: number;
  personalLimit?: number;
}

@Injectable()
export class AdminWizardGuideService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Первое число на экране (§10) — доля попаданий в кеш.
   *
   * По нему видно, разорит фича или нет, и оно же ловит поломку
   * дайджеста: слишком подробное состояние делает ключ уникальным на
   * каждого человека, и кеш перестаёт быть кешем, не подавая никаких
   * других признаков. ТЗ прямо называет порог: ниже примерно половины
   * через сутки после запуска — чинить классификатор, а не бюджет.
   */
  async stats(): Promise<{
    cache: { rows: number; hits: number; hitRate: number };
    hints: { total: number; flagged: number; bySource: Record<string, number> };
  }> {
    const [rows, hitsAgg, total, flagged, bySource] = await Promise.all([
      this.prisma.wizardHintCache.count(),
      this.prisma.wizardHintCache.aggregate({ _sum: { hits: true } }),
      this.prisma.wizardHint.count(),
      this.prisma.wizardHint.count({ where: { flagged: true } }),
      this.prisma.wizardHint.groupBy({
        by: ['source'],
        _count: { _all: true },
      }),
    ]);
    const hits = (hitsAgg as { _sum: { hits: number | null } })._sum.hits ?? 0;
    // Знаменатель — попадания ПЛЮС промахи, а промах — это ровно одна
    // записанная строка кеша: она появляется тогда и только тогда,
    // когда ответа в кеше не было.
    const denominator = hits + rows;
    return {
      cache: {
        rows,
        hits,
        hitRate: denominator ? hits / denominator : 0,
      },
      hints: {
        total,
        flagged,
        bySource: Object.fromEntries(
          (bySource as Array<{ source: string; _count: { _all: number } }>).map(
            (r) => [r.source, r._count._all],
          ),
        ),
      },
    };
  }

  async get(): Promise<AiGuideSettingsView> {
    const [enabledRaw, budgetRaw, limitRaw] = await Promise.all([
      this.settings.get(AI_GUIDE_ENABLED_KEY),
      this.settings.get(AI_GUIDE_BUDGET_KEY),
      this.settings.get(AI_GUIDE_PERSONAL_LIMIT_KEY),
    ]);
    return {
      // Умолчание — выключено: фича тратит деньги на каждом шаге у
      // каждого пользователя и включается сознательно.
      enabled: enabledRaw === 'true',
      dailyBudgetMicroUsd: numberSettingValue(
        budgetRaw,
        DEFAULT_DAILY_BUDGET_MICRO_USD,
      ),
      personalLimit: numberSettingValue(limitRaw, DEFAULT_PERSONAL_LIMIT),
    };
  }

  /**
   * Пишутся только переданные поля: карточка правит их по одному, и
   * сохранение бюджета не должно втихую переписывать рубильник тем
   * значением, которое лежало на экране в момент загрузки.
   */
  /**
   * Лента выданных подсказок (§10) — «почему модель посоветовала это».
   *
   * В журнале лежат ответы МОДЕЛИ (и статические, когда они появятся),
   * но не попадания в кеш: попадание не порождает нового текста, а
   * считается счётчиком `hits` на самой записи кеша. Писать строку
   * журнала на каждое попадание значило бы удвоить таблицу ради числа,
   * которое уже есть.
   */
  async hints(filter: {
    scenario?: string;
    stepId?: string;
    locale?: string;
    source?: string;
    flagged?: boolean;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      createdAt: Date;
      scenario: string;
      stepId: string;
      locale: string;
      source: string;
      hint: string;
      inTokens: number;
      outTokens: number;
      costMicroUsd: number;
      latencyMs: number;
      flagged: boolean;
    }>
  > {
    return this.prisma.wizardHint.findMany({
      where: {
        ...(filter.scenario ? { scenario: filter.scenario } : {}),
        ...(filter.stepId ? { stepId: filter.stepId } : {}),
        ...(filter.locale ? { locale: filter.locale } : {}),
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.flagged === undefined ? {} : { flagged: filter.flagged }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 200),
    });
  }

  async set(
    input: SetAiGuideSettingsInput,
    updatedBy?: string,
  ): Promise<AiGuideSettingsView> {
    const ops: Promise<void>[] = [];
    if (input.enabled !== undefined) {
      ops.push(
        this.settings.set(
          AI_GUIDE_ENABLED_KEY,
          input.enabled ? 'true' : 'false',
          updatedBy,
        ),
      );
    }
    if (input.dailyBudgetMicroUsd !== undefined) {
      ops.push(
        this.settings.set(
          AI_GUIDE_BUDGET_KEY,
          // Ноль — законное значение: «фича включена, но сегодня не
          // тратим». Отрицательное значение смысла не имеет.
          String(Math.max(0, Math.round(input.dailyBudgetMicroUsd))),
          updatedBy,
        ),
      );
    }
    if (input.personalLimit !== undefined) {
      ops.push(
        this.settings.set(
          AI_GUIDE_PERSONAL_LIMIT_KEY,
          String(Math.max(0, Math.round(input.personalLimit))),
          updatedBy,
        ),
      );
    }
    await Promise.all(ops);
    return this.get();
  }
}
