/**
 * Расчёт цепочки Scene Extension для роликов длиннее 8 секунд (ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md §9, этап 4 плана реализации §14).
 *
 * Чистые функции, без сети/БД — вся логика «сколько сегментов нужно
 * и сколько это будет стоить» вынесена сюда, чтобы:
 *  - посчитать её ЗАРАНЕЕ, целиком, до первого платного вызова (§9.4:
 *    «бюджет всей цепочки проверяется заранее, не по одному вызову»);
 *  - использовать тот же расчёт и в дисклеймере (§11.3), и в реальном
 *    списании — одна формула, не две, которые могут разойтись.
 *
 * Потолки — из §9.4 ТЗ, разные по провайдеру:
 *  - Veo: до 7 вызовов (база + до 6 расширений). Официальный шаг
 *    одного расширения — ближе к 7 секундам, чем к 8 (независимые
 *    источники называют «7s extension hops») — ТЗ явно допускает это
 *    расхождение (§9.4: «если хоп короче 8 секунд, потолок в
 *    секундах... уточняется на ручном тесте»); здесь считаем консерв-
 *    ативно по паспортным 8 секундам за вызов, как и решено в ТЗ.
 *  - Grok: официальный потолок Extend — 30 секунд суммарно, не число
 *    вызовов (§10.1 ТЗ) — здесь один вызов расширения по умолчанию
 *    добавляет `VIDEO_DURATION_SECONDS` секунд, пока не упрётся в этот
 *    потолок.
 */
import { VIDEO_DURATION_SECONDS } from './veo-duration';

export type ExtensionProvider = 'veo' | 'grok';

/** Veo: 7 вызовов × 8 секунд = 56 (§9.4 ТЗ). */
export const VEO_MAX_CALLS = 7;
export const VEO_MAX_SECONDS = VEO_MAX_CALLS * VIDEO_DURATION_SECONDS;

/** Grok: официальный потолок Extend — 30 секунд суммарно (§10.1 ТЗ). */
export const GROK_MAX_SECONDS = 30;

export interface ExtensionPlan {
  /** Сколько вызовов Veo/Grok нужно всего, включая базовый (>= 1). */
  totalCalls: number;
  /** Итоговая длительность ролика в секундах — может быть меньше
   * запрошенной, если запрос превышал потолок провайдера или
   * длительность референса. */
  targetDurationSeconds: number;
  /** `true`, если запрошенная длительность была урезана потолком
   * провайдера или длительностью референса — стоит показать
   * пользователю, а не молчать о разнице. */
  wasCapped: boolean;
}

/**
 * Строит план цепочки. `requestedSeconds` — то, что хочет пользователь
 * (после ввода в UI, §9.4 «длительность в секундах — явно»);
 * `referenceDurationSeconds` — потолок (б) из §9.4, `undefined` если
 * анализ референса не сообщил длительность (нет триггера §9.4 вовсе,
 * но план всё равно можно построить на явном пользовательском вводе).
 */
export function buildExtensionPlan(
  provider: ExtensionProvider,
  requestedSeconds: number,
  referenceDurationSeconds?: number,
): ExtensionPlan {
  const providerCap =
    provider === 'veo' ? VEO_MAX_SECONDS : GROK_MAX_SECONDS;
  const hardCap =
    referenceDurationSeconds !== undefined
      ? Math.min(providerCap, referenceDurationSeconds)
      : providerCap;

  const targetDurationSeconds = Math.max(
    VIDEO_DURATION_SECONDS,
    Math.min(requestedSeconds, hardCap),
  );
  const wasCapped = targetDurationSeconds < requestedSeconds;

  const totalCalls =
    targetDurationSeconds <= VIDEO_DURATION_SECONDS
      ? 1
      : Math.ceil(targetDurationSeconds / VIDEO_DURATION_SECONDS);

  return { totalCalls, targetDurationSeconds, wasCapped };
}

/**
 * Стоимость всей цепочки в микро-USD — тот же расчёт, что дисклеймер
 * (§11.3) и реальное списание должны использовать одинаково.
 * `perCallMicroUsd` — цена ОДНОГО вызова (уже посчитанная
 * `estimateCost()` из `common/ai-pricing.ts` для выбранного
 * provider/quality/resolution) — эта функция сама цену не знает,
 * только умножает на число вызовов плана.
 */
export function chainCostMicroUsd(
  plan: ExtensionPlan,
  perCallMicroUsd: number,
): number {
  return plan.totalCalls * perCallMicroUsd;
}
