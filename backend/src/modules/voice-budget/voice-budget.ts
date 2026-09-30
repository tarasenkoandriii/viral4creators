/**
 * Суточный потолок голоса — чистая часть (решение В-14 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.5).
 *
 * Без Nest и Prisma: разбор настроек админки, выбор потолка по тарифу и
 * вердикт проверяются перебором, не поднимая DI. Сервис рядом только
 * читает базу и складывает.
 *
 * ## Почему потолок отдельный от суточного лимита тарифа
 *
 * Суточный лимит (`common/spend-limits.ts`) — про все деньги человека, и
 * главная трата в нём — ролик. Голос — способ управления, реплик за
 * сессию десятки, и зависший микрофон или включённый рядом телевизор
 * выбрали бы весь лимит раньше, чем человек дойдёт до рендера. Потолок
 * голоса — ДОЛЯ лимита тарифа: Lite $0.50 из $2, Standard $2 из $10,
 * Premium $10 из $100. Он ловит сбой, а не честного человека: тяжёлая
 * честная сессия на 60 реплик стоит $0.25–1.80 (замер §4А.7.5).
 */

import type { PlanId } from '../../common/plans';

/** Микродолларов в долларе — та же единица, что у `ai_usage.costMicroUsd`. */
const USD = 1_000_000;

/**
 * Всё, за что платит голосовой помощник, — одним списком против одного
 * потолка. Строки расхода остаются раздельными (видно, куда ушли деньги),
 * а ограничивает их сумма: оператор настраивает «сколько в сутки стоит
 * голос», а не каждую его часть.
 *
 * Строки, а не `AiOperation[]`: операцию синтеза (`voice-assistant-tts`)
 * заводит этап K1, и потолок обязан считать её с первой же записи —
 * независимо от того, в каком порядке этапы сольются.
 */
export const VOICE_OPERATIONS: readonly string[] = [
  'voice-assistant-stt',
  'voice-assistant-understand',
  'voice-assistant-tts',
];

/** Ключи настроек админки — карточка «Голосовой помощник». */
export const VOICE_DAILY_CAP_SETTING_KEYS: Readonly<Record<PlanId, string>> = {
  LITE: 'voice_daily_cap_lite',
  STANDARD: 'voice_daily_cap_standard',
  PREMIUM: 'voice_daily_cap_premium',
};

/**
 * Потолок голоса сессий БЕЗ владельца (анонимный путь) — ОБЩИЙ на всех
 * анонимных вместе, как общий потолок анонимных §26.4: персонального у
 * них быть не может, UUID сессии минтится бесплатно.
 *
 * Умолчание — 0, то есть голос без входа выключен (решение по аудиту
 * волны K, 29.09.2026): иначе один общий Lite-потолок $0.50 делил бы весь
 * мир, и первый же зависший микрофон выключал бы голос всем гостям
 * разом. Оператор может открыть его в админке.
 */
export const VOICE_DAILY_CAP_ANONYMOUS_SETTING_KEY =
  'voice_daily_cap_anonymous';
export const VOICE_DAILY_CAP_ANONYMOUS_DEFAULT_USD = 0;

/** Потолок анонимных из строки настройки, в микродолларах (те же правила разбора). */
export function voiceAnonymousCapMicroUsd(
  stored: string | null | undefined,
): number {
  return parseCapMicroUsd(
    stored,
    Math.round(VOICE_DAILY_CAP_ANONYMOUS_DEFAULT_USD * USD),
  );
}

/** Умолчания В-14, в долларах. */
export const VOICE_DAILY_CAP_DEFAULT_USD: Readonly<Record<PlanId, number>> = {
  LITE: 0.5,
  STANDARD: 2,
  PREMIUM: 10,
};

/**
 * Потолок из строки настройки, в микродолларах.
 *
 * Тот же приём, что у `limitFrom` суточных лимитов: `0` — законное
 * значение («голос выключен для тарифа»), а мусор не должен молча
 * превратиться в ноль и выключить голос всем — тогда умолчание.
 */
export function voiceCapMicroUsd(
  plan: PlanId,
  stored: string | null | undefined,
): number {
  return parseCapMicroUsd(
    stored,
    Math.round(VOICE_DAILY_CAP_DEFAULT_USD[plan] * USD),
  );
}

function parseCapMicroUsd(
  stored: string | null | undefined,
  fallback: number,
): number {
  if (stored === null || stored === undefined || stored.trim() === '') {
    return fallback;
  }
  const dollars = Number(stored);
  if (!Number.isFinite(dollars) || dollars < 0) return fallback;
  return Math.round(dollars * USD);
}

/**
 * Значение из админки: доллары, от 0 (голос выключен для тарифа) до 1000.
 * Верхняя граница — от опечатки на лишний ноль-другой, а не бизнес-правило:
 * суточный лимит Premium — $100, и голос выше него смысла не имеет.
 */
export function isValidVoiceCapUsd(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1000
  );
}

export interface VoiceBudgetVerdict {
  capMicroUsd: number;
  spentMicroUsd: number;
  exhausted: boolean;
}

/**
 * Исчерпан ли потолок. Правило то же, что у `checkBudget`: пускать, пока
 * потолок не выбран ЦЕЛИКОМ. Цена реплики заранее неизвестна, и последняя
 * реплика может перебрать край — это дешевле, чем обрывать её на середине
 * или угадывать цену.
 */
export function voiceVerdict(
  spentMicroUsd: number,
  capMicroUsd: number,
): VoiceBudgetVerdict {
  return {
    capMicroUsd,
    spentMicroUsd,
    exhausted: spentMicroUsd >= capMicroUsd,
  };
}

/**
 * Текст отказа. Без долларов — по той же причине, что у суточного
 * лимита: человеку важно, что делать дальше. И с главным: мастер
 * работает руками, выключен только голос.
 */
export const VOICE_BUDGET_EXHAUSTED_MESSAGE =
  'Голосовой помощник на сегодня выключен: дневной лимит голоса исчерпан. Мастер работает как обычно — руками; голос вернётся завтра.';

/**
 * Отказ сессии без владельца, когда голос для анонимных выключен
 * (потолок 0 — умолчание). Не «лимит исчерпан»: завтра он не вернётся,
 * вернётся после входа.
 */
export const VOICE_LOGIN_REQUIRED_MESSAGE =
  'Голосовое управление доступно после входа через Telegram. Мастер работает как обычно — руками.';
