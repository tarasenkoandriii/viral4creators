/**
 * Суточный потолок расхода голосового помощника на пользователя — решение
 * В-14 ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.5.
 *
 * Модуль отдельный, чтобы его могли звать и голос советника (wizard-guide,
 * K1), и распознавание с разбором (voice, K2/K3) без циклической
 * зависимости модулей. Правила — в `voice-budget.ts` (чистые функции),
 * здесь только чтение базы.
 *
 * ## Чей расход
 *
 * Сумма строк `ai_usage` операций голоса (`VOICE_OPERATIONS`) с начала
 * суток UTC — у пользователя, а у анонимного пути (открытый маршрут
 * сессии без владельца) — у всех анонимных вместе, по флагу `anonymous`,
 * против своего потолка `voice_daily_cap_anonymous`. Его умолчание — 0:
 * голос без входа выключен (аудит волны K), см. `voice-budget.ts`. Строки распознавания
 * сессии пишутся с `sessionId` без `userId`, но `AiUsageService.record`
 * сам находит владельца сессии — поэтому считать можно по `userId`.
 *
 * ## Тариф
 *
 * `spendPlan`, а не `plan`: самостоятельно выбранный Premium даёт
 * функции, но деньги считаются по Lite (этап 54, Б-3.8). Потолок голоса
 * — доля ДЕНЕЖНОГО лимита, значит и тариф берётся денежный.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { PlanService } from '../plan/plan.service';
import { startOfDayUtc } from '../../common/spend-limits';
import {
  VOICE_BUDGET_EXHAUSTED_MESSAGE,
  VOICE_DAILY_CAP_ANONYMOUS_SETTING_KEY,
  VOICE_DAILY_CAP_SETTING_KEYS,
  VOICE_LOGIN_REQUIRED_MESSAGE,
  VOICE_OPERATIONS,
  voiceAnonymousCapMicroUsd,
  voiceCapMicroUsd,
  voiceVerdict,
} from './voice-budget';

export interface VoiceBudgetState {
  /** Потолок голоса на сегодня, USD. */
  capUsd: number;
  /** Потрачено голосом за текущие сутки (UTC), USD. */
  spentUsd: number;
  /** Потолок достигнут — голос выключен до конца суток. */
  exhausted: boolean;
  /**
   * Сессия без владельца, а голос для анонимных выключен (потолок 0 —
   * умолчание): голос появится после входа, а не завтра.
   */
  loginRequired: boolean;
}

/**
 * Отдельный класс: вызывающий (разбор реплики K3) отличает «голос на
 * сегодня кончился» — ответ `budget-exhausted`, мастер работает руками —
 * от блокировки и прочих 403. HTTP-статус тот же — 403.
 */
export class VoiceBudgetExhaustedException extends ForbiddenException {}

/**
 * Голос для сессий без владельца выключен (`voice_daily_cap_anonymous`
 * = 0, умолчание). Отдельный класс: ответ человеку другой — «войдите», а
 * не «до завтра». Тот же 403, что и у исчерпанного потолка.
 */
export class VoiceLoginRequiredException extends ForbiddenException {}

@Injectable()
export class VoiceBudgetService {
  private readonly logger = new Logger(VoiceBudgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** Состояние потолка голоса пользователя на сегодня. */
  async stateOf(
    userId: string | null | undefined,
    now: Date = new Date(),
  ): Promise<VoiceBudgetState> {
    // Настройка не прочиталась — умолчание, а не «голос выключен»: сбой
    // чтения не повод молча лишать голоса всех.
    let cap: number;
    if (userId) {
      const plan = (await this.plans.accessOf(userId)).spendPlan;
      const stored = await this.settings
        .get(VOICE_DAILY_CAP_SETTING_KEYS[plan])
        .catch(() => null);
      cap = voiceCapMicroUsd(plan, stored);
    } else {
      const stored = await this.settings
        .get(VOICE_DAILY_CAP_ANONYMOUS_SETTING_KEY)
        .catch(() => null);
      cap = voiceAnonymousCapMicroUsd(stored);
    }
    const since = startOfDayUtc(now);
    const r = (await this.prisma.aiUsage.aggregate({
      where: {
        ...(userId ? { userId } : { anonymous: true }),
        operation: { in: [...VOICE_OPERATIONS] },
        createdAt: { gte: since },
      },
      _sum: { costMicroUsd: true },
    })) as { _sum: { costMicroUsd: number | null } };
    const verdict = voiceVerdict(r._sum.costMicroUsd ?? 0, cap);
    return {
      capUsd: verdict.capMicroUsd / 1_000_000,
      spentUsd: verdict.spentMicroUsd / 1_000_000,
      exhausted: verdict.exhausted,
      loginRequired: !userId && cap === 0,
    };
  }

  /**
   * Бросает `VoiceBudgetExhaustedException` (403) с понятным текстом, если
   * потолок достигнут, и `VoiceLoginRequiredException` (403), если голос
   * для сессий без владельца выключен. Проверка — ДО платного вызова.
   *
   * Тестовые аккаунты (TODO §III п.37) здесь не особые: суточный лимит
   * аккаунта их не освобождает, а меняет потолок на тестовый — и только
   * на отмеченных сценариях. Потолок голоса ловит сбой (зависший
   * микрофон), и тестировщику он нужен так же, как всем.
   */
  async assertCanSpendVoice(userId: string | null | undefined): Promise<void> {
    const state = await this.stateOf(userId);
    if (!state.exhausted) return;
    if (state.loginRequired) {
      throw new VoiceLoginRequiredException(VOICE_LOGIN_REQUIRED_MESSAGE);
    }
    this.logger.warn(
      `потолок голоса исчерпан: ${userId ?? 'анонимные'} — ${state.spentUsd} из ${state.capUsd} USD`,
    );
    throw new VoiceBudgetExhaustedException(VOICE_BUDGET_EXHAUSTED_MESSAGE);
  }
}
