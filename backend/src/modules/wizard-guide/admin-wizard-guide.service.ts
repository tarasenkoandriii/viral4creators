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
  constructor(private readonly settings: PlatformSettingsService) {}

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
