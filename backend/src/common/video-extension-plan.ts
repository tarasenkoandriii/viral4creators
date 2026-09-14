/**
 * Расчёт цепочки Scene Extension для роликов длиннее 8 секунд (ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md §9, этап 4 плана реализации §14).
 * Чистые функции, без сети/БД — вся логика «сколько сегментов нужно
 * и сколько это будет стоить» вынесена сюда, чтобы:
 *  - посчитать её ЗАРАНЕЕ, целиком, до первого платного вызова (§9.4:
 *    «бюджет всей цепочки проверяется заранее, не по одному вызову»);
 *  - использовать тот же расчёт и в дисклеймере (§11.3), и в реальном
 *    списании — одна формула, не две, которые могут разойтись.
 *
 * Потолки — разные по провайдеру, и с 14.09.2026 — разная АРИФМЕТИКА:
 *  - Veo: каждый вызов — ровно `VIDEO_DURATION_SECONDS` (8 с), до 7
 *    вызовов (база + до 6 расширений). Официальный шаг одного
 *    расширения — ближе к 7 секундам, чем к 8; ТЗ §9.4 явно допускает
 *    это расхождение, считаем консервативно по паспортным 8 с.
 *  - Grok: найдено по реальному сбою («при любой длительности —
 *    8 секунд», 14.09.2026). У `grok-imagine-video` длительность —
 *    НАТИВНЫЙ параметр базового вызова, 1–15 с (docs.x.ai, Video
 *    Generation), а не фиксированные 8 — цепочка до 15 с вообще не
 *    нужна. Расширение — отдельный `POST /v1/videos/extensions`
 *    (docs.x.ai, Video Extension): вход 2–15 с, добавляет 2–10 с, на
 *    выходе не выше 720p. Поскольку вход расширения сам ограничен 15 с,
 *    расширить можно только базовый сегмент — итоговый потолок
 *    15 + 10 = 25 с, а не «30 суммарно», как считалось раньше по §10.1
 *    ТЗ (цифра из ТЗ не подтверждена документацией).
 *
 * Длительность референса (§9.4 «б») с 14.09.2026 — НЕ потолок, а
 * справка (`exceedsReference`). Причина: она выводится из
 * `scenes[last].end` разбора Gemini (analysis.service.ts) и нередко
 * короче реального ролика; как жёсткий потолок она молча резала
 * любой запрос до 8 с — второй источник того же сбоя. Пользователь
 * ввёл секунды явно (§9.4 «длительность — явно»), его слово главнее
 * оценки модели.
 */
import { VIDEO_DURATION_SECONDS } from './veo-duration';

export type ExtensionProvider = 'veo' | 'grok';

/** Veo: 7 вызовов × 8 секунд = 56 (§9.4 ТЗ). */
export const VEO_MAX_CALLS = 7;
export const VEO_MAX_SECONDS = VEO_MAX_CALLS * VIDEO_DURATION_SECONDS;

/** Grok: базовый вызов — до 15 с нативно (docs.x.ai). */
export const GROK_MAX_BASE_SECONDS = 15;
/** Grok: одно расширение добавляет 2–10 с (docs.x.ai, Video Extension). */
export const GROK_MIN_EXTEND_SECONDS = 2;
export const GROK_MAX_EXTEND_SECONDS = 10;
/** Grok: 15 (база) + 10 (единственное возможное расширение) = 25. */
export const GROK_MAX_SECONDS = GROK_MAX_BASE_SECONDS + GROK_MAX_EXTEND_SECONDS;

export interface ExtensionPlan {
  /** Сколько вызовов Veo/Grok нужно всего, включая базовый (>= 1). */
  totalCalls: number;
  /** Длительность каждого вызова по порядку, в секундах:
   * `segments[0]` — базовая генерация, дальше — расширения.
   * `segments.length === totalCalls`. У Veo все по 8; у Grok база до
   * 15 и одно расширение до 10. */
  segments: number[];
  /** Итоговая длительность ролика в секундах — может быть меньше
   * запрошенной, если запрос превышал потолок провайдера. */
  targetDurationSeconds: number;
  /** `true`, если запрошенная длительность была урезана потолком
   * провайдера — стоит показать пользователю, а не молчать о разнице. */
  wasCapped: boolean;
  /** `true`, если итог длиннее референса (по оценке разбора). Только
   * справка для интерфейса — не ограничение. */
  exceedsReference: boolean;
}

/**
 * Строит план цепочки. `requestedSeconds` — то, что хочет пользователь
 * (после ввода в UI, §9.4 «длительность в секундах — явно»);
 * `referenceDurationSeconds` — длительность референса по разбору,
 * `undefined` если анализ её не сообщил; на план не влияет, только на
 * `exceedsReference`.
 */
export function buildExtensionPlan(
  provider: ExtensionProvider,
  requestedSeconds: number,
  referenceDurationSeconds?: number,
): ExtensionPlan {
  const providerCap = provider === 'veo' ? VEO_MAX_SECONDS : GROK_MAX_SECONDS;

  const targetDurationSeconds = Math.max(
    VIDEO_DURATION_SECONDS,
    Math.min(Math.floor(requestedSeconds), providerCap),
  );
  const wasCapped = targetDurationSeconds < requestedSeconds;
  const exceedsReference =
    referenceDurationSeconds !== undefined &&
    targetDurationSeconds > referenceDurationSeconds;

  const segments =
    provider === 'veo'
      ? veoSegments(targetDurationSeconds)
      : grokSegments(targetDurationSeconds);

  return {
    totalCalls: segments.length,
    segments,
    targetDurationSeconds,
    wasCapped,
    exceedsReference,
  };
}

/** Veo: только фиксированные 8-секундные вызовы, последний — с
 * запасом (ceil): 20 с → 3 × 8. */
function veoSegments(target: number): number[] {
  const calls =
    target <= VIDEO_DURATION_SECONDS
      ? 1
      : Math.ceil(target / VIDEO_DURATION_SECONDS);
  return Array.from({ length: calls }, () => VIDEO_DURATION_SECONDS);
}

/** Grok: до 15 с — один нативный вызов; дальше база + одно расширение
 * не короче 2 с (16 с → 14 + 2, а не 15 + 1, которое API отвергнет). */
function grokSegments(target: number): number[] {
  if (target <= GROK_MAX_BASE_SECONDS) return [target];
  const extend = Math.min(
    GROK_MAX_EXTEND_SECONDS,
    Math.max(GROK_MIN_EXTEND_SECONDS, target - GROK_MAX_BASE_SECONDS),
  );
  return [target - extend, extend];
}

/** Сколько секунд реально будет отрендерено (и оплачено) — сумма
 * сегментов; у Veo из-за ceil может быть больше `targetDurationSeconds`. */
export function billableSeconds(plan: ExtensionPlan): number {
  return plan.segments.reduce((sum, s) => sum + s, 0);
}

/**
 * Стоимость всей цепочки в микро-USD — тот же расчёт, что дисклеймер
 * (§11.3) и реальное списание должны использовать одинаково.
 * `perCallMicroUsd` — цена ОДНОГО 8-секундного вызова (уже посчитанная
 * `estimateCost()` из `common/ai-pricing.ts` для выбранного
 * provider/quality/resolution, `{ seconds: VIDEO_DURATION_SECONDS }`).
 * Обе модели тарифицируются посекундно, поэтому цена цепочки — цена
 * секунды × реально рендерящиеся секунды; для Veo (все сегменты по 8)
 * это в точности «цена вызова × число вызовов», как и было.
 */
export function chainCostMicroUsd(
  plan: ExtensionPlan,
  perCallMicroUsd: number,
): number {
  return Math.round(
    (perCallMicroUsd * billableSeconds(plan)) / VIDEO_DURATION_SECONDS,
  );
}
