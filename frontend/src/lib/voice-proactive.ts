/**
 * Проактивный голос помощника — клиент этапа K4 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п.1, п.5.
 *
 * Помощник говорит сам по поводам: вход на шаг и простой (это подсказка
 * советника — `HintLine`), отказ сервера (тон, проверка содержания,
 * лимит, стена), готовый ролик, сводка перед согласием и ответ на вопрос
 * о шаге. Здесь — правила без React и без сети: когда повод есть, не
 * повторяется ли он, во что превращается в запросе и говорить ли голосом
 * или только строкой. Проверяются `scripts/voice-proactive.test.ts`.
 *
 * ## Текст собирает сервер
 *
 * Клиент шлёт `POST …/wizard-guide/speak` ВИД реплики и коды — никогда
 * текст (`SpeakBody`): иначе маршрут озвучки стал бы синтезатором чего
 * угодно за счёт потолка голоса человека. Сервер сам проверяет, что
 * повод настоящий (ролик готов, сценарий помечен, лимит правда
 * исчерпан), и отвечает 204, если нет.
 *
 * ## Простой: 8 секунд у строки, 20 — у голоса
 *
 * `HINT_IDLE_MS = 8000` (`hint-line.ts`) — когда СТРОКА совета
 * раскрывается сама у того, кто работает текстом («Тонкая красная
 * линия» §5.4). ТЗ голоса (§4А.2 п.1) называет другой повод — «простой
 * больше 20 секунд» — и это разные события, а не спор двух чисел:
 *
 * - у включившего «голосом» подсказка раскрывается и звучит СРАЗУ при
 *   входе на шаг (повод «вход на шаг»), восьмисекундного ожидания нет;
 * - `VOICE_IDLE_REPEAT_MS = 20 000` — если после этого человек 20 секунд
 *   ничего не делал (ни касания, ни клавиши, ни фразы), та же реплика
 *   звучит ещё ОДИН раз: из аудиокеша, без нового синтеза;
 * - у работающего текстом всё по-прежнему — 8 секунд до строки, голоса нет.
 *
 * Сдвинуть 8 до 20 значило бы на 12 секунд позже показывать совет тем,
 * кто голос не включал, — ТЗ голоса этого не просит.
 */

import type { GreetingHelpTopic } from './greeting-help';
import type { Locale } from './i18n';
import type { IntentHandler, VoiceIntentRegistry } from './voice-intents';
import { withIntentHandler } from './voice-intents';
import { replyLocale, voiceHelpTopic } from './voice-nav';
import type { VoiceQuestionTopic, VoiceRefusalCode } from './voice-types';
import { VOICE_QUESTION_TOPICS, VOICE_REFUSAL_CODES } from './voice-types';

/** Простой после реплики на шаге, после которого она звучит ещё раз. */
export const VOICE_IDLE_REPEAT_MS = 20_000;

/** Тот же отказ голосом — не чаще, чем раз в это время. */
export const REFUSAL_REPEAT_MS = 30_000;

/** Тело `POST …/wizard-guide/speak`: вид и коды, без текста. */
export type SpeakBody =
  | { kind: 'refusal'; refusal: VoiceRefusalCode; locale: Locale }
  | { kind: 'video-ready'; locale: Locale }
  | { kind: 'consent-summary'; locale: Locale }
  /** `topic: null` — «не знаю, посмотрите справку» вслух (CONTRACT5). */
  | { kind: 'answer'; topic: VoiceQuestionTopic | null; locale: Locale };

/** Повод заговорить — то, что сообщают экраны помощнику. */
export type ProactiveEvent =
  /**
   * `key` — отказ, о котором говорят ОДИН раз на ключ (помеченный
   * сценарий: `сессия:сценарий`), а не раз в 30 секунд.
   */
  | { kind: 'refusal'; refusal: VoiceRefusalCode; key?: string }
  /** Ролик сессии стал готов у человека на глазах. */
  | { kind: 'video-ready'; sessionId: string }
  /** Показана сводка перед согласием (её отпечаток). */
  | { kind: 'consent-summary'; fingerprint: string }
  /** Ответ на вопрос о шаге — на языке реплики; `null` — «не знаю». */
  | {
      kind: 'answer';
      topic: VoiceQuestionTopic | null;
      language: string | null;
    };

/**
 * Память поводов на странице: что уже звучало.
 *
 * - готовый ролик — один раз на сессию (опрос статуса приходит каждые
 *   4 секунды, а сказать «готов» нужно однажды);
 * - сводка — один раз на отпечаток: повторное «генерируй» при той же
 *   сводке запускает рендер, а не повтор цены;
 * - отказ — тот же код не чаще раза в `REFUSAL_REPEAT_MS`: три нажатия
 *   подряд на кнопку с тем же отказом — не три лекции;
 * - ответ на вопрос — всегда: человек спросил сам.
 */
export interface ProactiveMemory {
  admit(event: ProactiveEvent, now: number): boolean;
}

/**
 * Отказы с ключом (помеченный сценарий) — один раз на ключ. Отдельно от
 * окна в 30 секунд: помеченный сценарий не перестаёт быть помеченным, и
 * «раз в полминуты» превратило бы его в назойливый повтор.
 */
function keyedOnce(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export function createProactiveMemory(): ProactiveMemory {
  const ready = new Set<string>();
  const summaries = new Set<string>();
  const refusedAt = new Map<VoiceRefusalCode, number>();
  const keyed = new Set<string>();
  return {
    admit(event, now) {
      switch (event.kind) {
        case 'video-ready':
          if (ready.has(event.sessionId)) return false;
          ready.add(event.sessionId);
          return true;
        case 'consent-summary':
          if (summaries.has(event.fingerprint)) return false;
          summaries.add(event.fingerprint);
          return true;
        case 'refusal': {
          if (event.key)
            return keyedOnce(keyed, `${event.refusal}:${event.key}`);
          const last = refusedAt.get(event.refusal);
          if (last !== undefined && now - last < REFUSAL_REPEAT_MS) {
            return false;
          }
          refusedAt.set(event.refusal, now);
          return true;
        }
        case 'answer':
          return true;
      }
    },
  };
}

/**
 * Что делать с поводом сейчас (CONTRACT5).
 *
 * - `speak` — просить речь у сервера;
 * - `line` — показать строку «ролик готов» (у прочих поводов строка уже
 *   на экране их собственной карточкой);
 * - повод с ключом (помеченный сценарий) при канале «строкой» НЕ
 *   расходуется: он держится, пока верен, и прозвучит, когда откроется
 *   голос. Остальные поводы расходуются и строкой — их текст на экране,
 *   и повторять его вслух через минуту было бы не к месту.
 */
export function proactiveDecision(
  event: ProactiveEvent,
  channel: 'voice' | 'text',
  memory: ProactiveMemory,
  now: number
): { speak: boolean; line: boolean } {
  const keyed = event.kind === 'refusal' && !!event.key;
  if (keyed && channel !== 'voice') return { speak: false, line: false };
  const fresh = memory.admit(event, now);
  return {
    speak: fresh && channel === 'voice',
    line: fresh && event.kind === 'video-ready',
  };
}

/** Повод → тело запроса. Ответ — на языке реплики, как строка `reply`. */
export function speakBodyOf(event: ProactiveEvent, ui: Locale): SpeakBody {
  switch (event.kind) {
    case 'refusal':
      return { kind: 'refusal', refusal: event.refusal, locale: ui };
    case 'video-ready':
      return { kind: 'video-ready', locale: ui };
    case 'consent-summary':
      return { kind: 'consent-summary', locale: ui };
    case 'answer':
      return {
        kind: 'answer',
        topic: event.topic,
        locale: replyLocale(event.language, ui),
      };
  }
}

/**
 * Голосом или только строкой. Голос — только у включивших «голосом», с
 * включённым звуком, после первого касания (браузер без жеста звук не
 * даст) и пока не исчерпан потолок голоса (В-14). Иначе — строка, как у
 * всех: «без звука» — текстом.
 */
export function proactiveChannel(input: {
  voice: boolean;
  muted: boolean;
  gestured: boolean;
  budgetExhausted: boolean;
}): 'voice' | 'text' {
  return input.voice && !input.muted && input.gestured && !input.budgetExhausted
    ? 'voice'
    : 'text';
}

/**
 * Ролик стал готов НА ГЛАЗАХ: был виден не готовым и стал готовым.
 * Открыл страницу с уже готовым роликом — не повод: человек его видит,
 * и объявлять вслух давно случившееся незачем.
 */
export function becameReady(
  prev: string | null | undefined,
  next: string | null | undefined
): boolean {
  return prev !== undefined && prev !== 'complete' && next === 'complete';
}

/**
 * Отказ старта рендера → код, который помощник объяснит. Стена
 * (`generation-locked`) — `locked`; прочие 403 и 429 — `quota` (сервер
 * сам проверит, что это правда суточный лимит, и промолчит, если нет).
 * Остальное — не наш повод: ошибку показывает экран.
 */
export function refusalOfStartError(
  status: number | null | undefined,
  locked: boolean
): VoiceRefusalCode | null {
  if (locked) return 'locked';
  if (status === 403 || status === 429) return 'quota';
  return null;
}

/** Код отказа из ответа разбора — только из закрытого списка. */
export function refusalOf(raw: unknown): VoiceRefusalCode | null {
  return (VOICE_REFUSAL_CODES as readonly unknown[]).includes(raw)
    ? (raw as VoiceRefusalCode)
    : null;
}

/** Тема вопроса — только из закрытого списка. */
export function questionTopicOf(raw: unknown): VoiceQuestionTopic | null {
  return (VOICE_QUESTION_TOPICS as readonly unknown[]).includes(raw)
    ? (raw as VoiceQuestionTopic)
    : null;
}

export interface VoiceQuestionContext {
  /** Карточка в фокусе — та же, что ушла серверу. */
  card: string | null;
  /** Карточка текущего шага. */
  stepCard: string;
  /** Лист справки на экране есть. */
  canOpenHelp: boolean;
}

/**
 * Обработчик `question` (K4): ответ сервера строкой; без факта — та же
 * строка «не знаю, посмотрите справку» и кнопка справки темы карточки в
 * фокусе (резолвер тот же, что у (i) и у «помощь» голосом). Лист сам не
 * открывается: человек спросил, а не просил ролик.
 */
export function questionHandler(
  c: VoiceQuestionContext
): IntentHandler<'question'> {
  return (intent, ctx, result) => {
    const answered = intent.answered && !!intent.topic && !!result.reply;
    const help: GreetingHelpTopic | null =
      !answered && c.canOpenHelp ? voiceHelpTopic(c.card, c.stepCard) : null;
    return {
      kind: 'answer',
      text: result.reply || ctx.texts.unknown,
      topic: answered ? questionTopicOf(intent.topic) : null,
      answered,
      help,
    };
  };
}

/** Реестр с обработчиком вопросов о шаге. */
export function withQuestionHandler(
  registry: VoiceIntentRegistry,
  c: VoiceQuestionContext
): VoiceIntentRegistry {
  return withIntentHandler(registry, 'question', questionHandler(c));
}

/**
 * Повторить реплику шага после простоя: голос включён и звучит, реплика
 * на шаге уже прозвучала, и повтора ещё не было. Повтор — один: дальше
 * помощник ждёт человека, а не твердит одно и то же.
 */
export function idleRepeatDue(input: {
  voice: boolean;
  muted: boolean;
  spokenKey: string | null;
  repeatedKey: string | null;
}): boolean {
  return (
    input.voice &&
    !input.muted &&
    !!input.spokenKey &&
    input.spokenKey !== input.repeatedKey
  );
}

// Очередь реплик (CONTRACT5) живёт рядом с плеером (`hint-audio.ts`):
// её берёт и строка совета, которой разбор голоса не нужен.
export {
  SPEECH_STALE_MS,
  createSpeechQueue,
  type QueuePlayer,
  type QueuedSpeech,
  type SpeechQueue,
} from './hint-audio';
