/**
 * Голосовое управление «Сайтом» — числа и решение «есть ли режим» (Э6-бис
 * (а), ТЗ помощника §5-бис.2, §5-бис.5, §5-бис.9, §5-бис.11, §7.1–§7.3).
 * Чистый модуль: его читают публичный код (`public/`), кабинет (`cabinet/`),
 * конфиг виджета (assist-widget) и TMA (повтор типов).
 */
import type { AssistPlanId } from '../assist-billing/plans';
import type { VoiceAccess } from '../assist-site-voice/public/voice-access';
import { rulesOf } from '../assist-ui-core/rules';
import {
  VOICE_CONTROL_STATES,
  type VoiceControlRules,
  type VoiceControlState,
} from '../assist-ui-core/types';

export const VOICE_CONTROL_DEFAULTS = {
  /** Окно подтверждения — 60 с (§5-бис.5, CONSENT_WINDOW_MS TMA). */
  confirmWindowMs: 60_000,
  /** План живёт 10 минут (§4-бис.2 «незавершённое подтверждение»). */
  planTtlMs: 10 * 60_000,
  /** Элементов карты интерфейса страницы в промпт плана (m1…m20). */
  promptMapElements: 20,
  /** Выход модели плана (≈ 300 токенов JSON, §5-бис.9) с запасом. */
  maxOutputTokens: 800,
  /** Ответ модели плана — не дольше (задержка до первой подсветки, §5-бис.10). */
  modelTimeoutMs: 12_000,
  /** Резерв денег плана: снимок 3–5 тыс. токенов входа + ≈ 300 выхода (§5-бис.9). */
  reserveInputTokens: 8_000,
  /** Команда не длиннее вопроса чата. */
  maxUtteranceChars: 600,
  /** Планов посетителю: в минуту и в сутки; IP+сайт — втрое (как чат). */
  plansPerVisitorPerMinute: 8,
  plansPerVisitorPerDay: 60,
  plansPerIpPerMinute: 24,
  plansPerIpPerDay: 180,
  /** Отчётов шагов в минуту (шаг = два отчёта: dispatched и done). */
  stepReportsPerVisitorPerMinute: 120,
  /**
   * Суточный потолок планов САЙТА по тарифу (§5-бис.9: «у сайта — свой
   * суточный потолок планов, по образцу потолка голоса»): ≈ 1/10 месячного
   * лимита диалогов тарифа — ловит сбой, а не честных посетителей.
   * ПРОВЕРИТЬ на пилотах (вопрос владельцу).
   */
  plansPerSitePerDayByPlan: {
    trial: 0,
    start: 0,
    business: 300,
    pro: 1_000,
  } satisfies Record<AssistPlanId, number>,
  /** Тело `POST /widget/v1/ui-plan` (снимок ≤ 150 элементов) — до разбора. */
  maxBodyBytes: 96 * 1024,
} as const;

/**
 * Суточный потолок планов сайта: ручной оверрайд оператора платформы
 * (`assist_sites.voiceControlPlansPerDay`, решение владельца 03.10.2026 п.2
 * — продавать увеличение лимита) или тариф (Business 300, Pro 1000).
 */
export function plansPerSitePerDay(
  override: number | null | undefined,
  planId: AssistPlanId | null,
): number {
  if (
    typeof override === 'number' &&
    Number.isInteger(override) &&
    override >= 0
  )
    return override;
  return planId ? VOICE_CONTROL_DEFAULTS.plansPerSitePerDayByPlan[planId] : 0;
}

/** Публичный код видит режим только в этих состояниях (`test` — мастер Т-2, часть (г)). */
export function stateOf(raw: unknown): VoiceControlState {
  return (VOICE_CONTROL_STATES as readonly unknown[]).includes(raw)
    ? (raw as VoiceControlState)
    : 'off';
}

export type VoiceControlOffReason =
  | 'platform_off'
  | 'voice_off'
  | 'state_off'
  /** (г) Режим `test`: только тестовая сессия мастера Т-2 (по токену). */
  | 'state_test'
  | 'rules_invalid';

export interface VoiceControlAccess {
  /** `on` — исполняет; `degraded` — только подсветка и «нажмите здесь». */
  mode: 'on' | 'degraded' | null;
  rules: VoiceControlRules | null;
  reason: VoiceControlOffReason | null;
}

/**
 * Одно решение «есть ли голосовое управление у посетителя» (конфиг
 * виджета, маршруты плана): рубильник платформы, голос сайта доступен
 * (тариф Business+, ключ, микрофон включён владельцем — §5-бис.2: «чекбокс
 * доступен, только если включён голос»), переключатель `on`/`degraded`,
 * правила кабинета разбираются (битые запреты — режим выключен, а не
 * «без запретов»).
 *
 * (г) Тестовая сессия мастера Т-2 (`testSession`) получает полный режим
 * (`on`) в ЛЮБОМ состоянии сайта (§5-бис.11: `test` — «только участник
 * кабинета, открывший сайт по одноразовой ссылке мастера»; мастер нужен и
 * чтобы выйти из `degraded`/`off`) — но не мимо рубильника, голоса и
 * правил. Без сессии `test` — как выключено (`state_test`).
 */
export function voiceControlAccess(p: {
  platformEnabled: boolean;
  voice: Pick<VoiceAccess, 'input' | 'reason'>;
  state: unknown;
  rules: unknown;
  testSession?: boolean;
}): VoiceControlAccess {
  const off = (reason: VoiceControlOffReason): VoiceControlAccess => ({
    mode: null,
    rules: null,
    reason,
  });
  if (!p.platformEnabled) return off('platform_off');
  if (!p.voice.input) return off('voice_off');
  const state = stateOf(p.state);
  if (p.testSession) {
    const rules = rulesOf(p.rules);
    if (!rules) return off('rules_invalid');
    return { mode: 'on', rules, reason: null };
  }
  if (state === 'test') return off('state_test');
  if (state !== 'on' && state !== 'degraded') return off('state_off');
  const rules = rulesOf(p.rules);
  if (!rules) return off('rules_invalid');
  return { mode: state, rules, reason: null };
}

/** Рубильник платформы (env): `ASSIST_VOICE_CONTROL_ENABLED=false` — режим у всех выключен. */
export function voiceControlPlatformEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ASSIST_VOICE_CONTROL_ENABLED?.trim().toLowerCase() !== 'false';
}
