/**
 * Настройки ИИ-консультанта на лендинге — `PlatformSetting`, тот же
 * приём, что `AdminGrokTransportSettingsService` (ТЗ §9): значение в
 * ключ-значение, чтение через чистый резолвер, смена действует сразу
 * (без передеплоя — карточка в админке правит эти же ключи).
 */
import { Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { GEMINI_MODEL } from '../../common/gemini-model';

export const ASSISTANT_ENABLED_KEY = 'assistant_enabled';
export const ASSISTANT_PROACTIVE_ENABLED_KEY = 'assistant_proactive_enabled';
export const ASSISTANT_DAILY_BUDGET_KEY = 'assistant_daily_budget_micro_usd';
export const ASSISTANT_MODEL_KEY = 'assistant_model';

const USD = 1_000_000;
/** $3/день — старт, предложенный в ТЗ (§7.2); меняется в админке без деплоя. */
export const DEFAULT_DAILY_BUDGET_MICRO_USD = 3 * USD;

export interface AssistantSettingsView {
  enabled: boolean;
  proactiveEnabled: boolean;
  dailyBudgetMicroUsd: number;
  model: string;
}

export interface SetAssistantSettingsInput {
  enabled?: boolean;
  proactiveEnabled?: boolean;
  dailyBudgetMicroUsd?: number;
  model?: string;
}

@Injectable()
export class AssistantSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async get(): Promise<AssistantSettingsView> {
    const [enabledRaw, proactiveRaw, budgetRaw, modelRaw] = await Promise.all([
      this.settings.get(ASSISTANT_ENABLED_KEY),
      this.settings.get(ASSISTANT_PROACTIVE_ENABLED_KEY),
      this.settings.get(ASSISTANT_DAILY_BUDGET_KEY),
      this.settings.get(ASSISTANT_MODEL_KEY),
    ]);
    const budget = budgetRaw ? Number(budgetRaw) : NaN;
    return {
      // Умолчание — ВЫКЛЮЧЕНО (§13: «запуск сначала с
      // assistant_enabled=off на проде»), в отличие от проактивного
      // рубильника ниже, который включён по умолчанию, но ничего не
      // значит, пока сам ассистент выключен.
      enabled: enabledRaw === 'true',
      proactiveEnabled: proactiveRaw === null ? true : proactiveRaw === 'true',
      dailyBudgetMicroUsd:
        Number.isFinite(budget) && budget >= 0
          ? budget
          : DEFAULT_DAILY_BUDGET_MICRO_USD,
      model: modelRaw || GEMINI_MODEL,
    };
  }

  async set(
    input: SetAssistantSettingsInput,
    updatedBy: string,
  ): Promise<AssistantSettingsView> {
    const ops: Promise<void>[] = [];
    if (input.enabled !== undefined) {
      ops.push(
        this.settings.set(
          ASSISTANT_ENABLED_KEY,
          String(input.enabled),
          updatedBy,
        ),
      );
    }
    if (input.proactiveEnabled !== undefined) {
      ops.push(
        this.settings.set(
          ASSISTANT_PROACTIVE_ENABLED_KEY,
          String(input.proactiveEnabled),
          updatedBy,
        ),
      );
    }
    if (input.dailyBudgetMicroUsd !== undefined) {
      ops.push(
        this.settings.set(
          ASSISTANT_DAILY_BUDGET_KEY,
          String(Math.max(0, Math.round(input.dailyBudgetMicroUsd))),
          updatedBy,
        ),
      );
    }
    if (input.model !== undefined && input.model.trim()) {
      ops.push(
        this.settings.set(ASSISTANT_MODEL_KEY, input.model.trim(), updatedBy),
      );
    }
    await Promise.all(ops);
    return this.get();
  }
}
