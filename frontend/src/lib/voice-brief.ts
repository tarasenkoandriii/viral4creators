/**
 * Голосом — в поля брифа поздравления (этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п. 3–4,
 * §4А.7.1).
 *
 * Правило раздела: голос — способ ввода, а не право. Значение, пришедшее
 * голосом, проходит РОВНО те же правила, что ручной ввод на этом экране:
 * тот же потолок длины (`slice`, как у `onChange`), тот же список
 * вариантов, тот же сброс тона при смене повода (`applyOccasionPatch`),
 * те же погашенные тоны (`toneOptions`). Сервер свои значения уже сверил
 * (`greeting-voice-intent.ts`), но экран не полагается на это: карточка
 * применяется к ТЕКУЩЕМУ состоянию, которое могло измениться после
 * разбора.
 *
 * Чистый модуль — `scripts/voice-brief.test.ts`.
 */

import {
  GREETING_OCCASIONS,
  GREETING_PRESENTER_PROVIDERS,
  GREETING_RESOLUTIONS,
  GREETING_SCRIPT_LANGUAGES,
  GREETING_TONES,
  MAX_CUSTOM_OCCASION_LENGTH,
  type GreetingOccasion,
  type GreetingPresenterProvider,
  type GreetingRegister,
  type GreetingResolution,
  type GreetingScriptLanguage,
  type GreetingTone,
} from '../types/project';
import {
  GREETING_REGISTER_ORDER,
  toneOptions,
  type GreetingPolicyView,
  type ToneChange,
} from './greeting-policy';
import {
  applyOccasionPatch,
  fieldsRegister,
  type OccasionFieldsState,
} from './greeting-occasion-fields';
import type { VoiceCommand, VoiceField } from './voice-types';

/**
 * Хуки полей брифа — имена фиксированы контрактом волны и совпадают с
 * `data-qa` в разметке и с каталогом `qa-hooks.ts`.
 */
export const BRIEF_VOICE_TARGETS = {
  occasion: 'greeting-field-occasion',
  customOccasion: 'greeting-field-custom-occasion',
  mood: 'greeting-field-mood',
  recipient: 'greeting-field-recipient',
  sender: 'greeting-field-sender',
  tone: 'greeting-field-tone',
  message: 'greeting-field-message',
  scriptLanguage: 'greeting-field-script-language',
  presenter: 'greeting-field-presenter',
  resolution: 'greeting-field-resolution',
  date: 'greeting-field-date',
} as const;

export const BRIEF_VOICE_TARGET_LIST: readonly string[] =
  Object.values(BRIEF_VOICE_TARGETS);

/** Потолки текстовых полей — те же числа, что `slice` в `BriefStep`. */
export const BRIEF_NAME_MAX = 120;
export const BRIEF_MESSAGE_MAX = 2000;

/** Поля брифа вне блока повода — то, что держит сам `BriefStep`. */
export interface BriefVoicePatch {
  recipientName?: string;
  senderName?: string;
  personalMessage?: string;
  scriptLanguage?: GreetingScriptLanguage;
  presenterProvider?: GreetingPresenterProvider;
  resolution?: GreetingResolution;
  occasionDate?: string;
}

export type BriefVoiceRefusal =
  /** Значение не из списка / не того вида (дата не дата, пустое имя). */
  | 'invalid'
  /** Тон погашен регистром повода — та же причина, что на экране. */
  | 'tone-unavailable'
  /** Описание и настроение есть только у «Особого повода». */
  | 'not-other';

export interface BriefVoiceResult {
  /** Правка блока «повод → настроение → тон»; `null` — не трогали. */
  occPatch: Partial<OccasionFieldsState> | null;
  /** Строка «Тон: … → …», если смена повода сбросила тон. */
  toneChange: ToneChange | null;
  patch: BriefVoicePatch;
  refused: Array<{ target: string; reason: BriefVoiceRefusal }>;
}

function oneOf<T extends string>(
  list: readonly T[],
  value: string | boolean
): T | null {
  return typeof value === 'string' &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** ISO `YYYY-MM-DD` и настоящая дата (не 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Разобрать поля карточки против текущего состояния брифа.
 *
 * Порядок не тот, в котором поля пришли, а тот, в котором их заполнил
 * бы человек: повод → описание → настроение → тон. Иначе «Особый повод,
 * поминки, серьёзно» применился бы как «тон, потом повод», и сброс тона
 * по новому регистру стёр бы только что сказанное.
 */
export function applyBriefVoiceFields(
  policy: GreetingPolicyView | null,
  occ: OccasionFieldsState,
  fields: readonly VoiceField[],
  serverRegisterFor: (next: OccasionFieldsState) => GreetingRegister | null
): BriefVoiceResult {
  const by = new Map(fields.map((f) => [f.target, f.value]));
  const refused: BriefVoiceResult['refused'] = [];
  const patch: BriefVoicePatch = {};
  let state = occ;
  let occTouched = false;
  let toneChange: ToneChange | null = null;

  const occasionStep = (
    p: Partial<
      Pick<OccasionFieldsState, 'occasion' | 'mood' | 'customOccasionText'>
    >
  ) => {
    const r = applyOccasionPatch(policy, state, p, serverRegisterFor);
    state = { ...state, ...r.patch };
    occTouched = true;
    // Последняя смена побеждает: если повод сбросил тон, а настроение
    // потом не тронуло его, строка остаётся про повод.
    if (r.change) toneChange = r.change;
  };

  const T = BRIEF_VOICE_TARGETS;
  if (by.has(T.occasion)) {
    const v = oneOf<GreetingOccasion>(GREETING_OCCASIONS, by.get(T.occasion)!);
    if (v) occasionStep({ occasion: v });
    else refused.push({ target: T.occasion, reason: 'invalid' });
  }
  if (by.has(T.customOccasion)) {
    const v = by.get(T.customOccasion)!;
    if (state.occasion !== 'OTHER') {
      refused.push({ target: T.customOccasion, reason: 'not-other' });
    } else if (typeof v !== 'string' || !v.trim()) {
      refused.push({ target: T.customOccasion, reason: 'invalid' });
    } else {
      occasionStep({
        customOccasionText: v.slice(0, MAX_CUSTOM_OCCASION_LENGTH),
      });
    }
  }
  if (by.has(T.mood)) {
    const v = oneOf<GreetingRegister>(GREETING_REGISTER_ORDER, by.get(T.mood)!);
    if (state.occasion !== 'OTHER') {
      refused.push({ target: T.mood, reason: 'not-other' });
    } else if (!v) {
      refused.push({ target: T.mood, reason: 'invalid' });
    } else {
      occasionStep({ mood: v });
    }
  }
  if (by.has(T.tone)) {
    const v = oneOf<GreetingTone>(GREETING_TONES, by.get(T.tone)!);
    if (!v) {
      refused.push({ target: T.tone, reason: 'invalid' });
    } else {
      const register = fieldsRegister(policy, state, serverRegisterFor(state));
      const option = toneOptions(policy, state.occasion, register).find(
        (o) => o.tone === v
      );
      if (!option?.allowed) {
        refused.push({ target: T.tone, reason: 'tone-unavailable' });
      } else {
        state = { ...state, tone: v };
        occTouched = true;
        // Тон, выбранный человеком, снимает строку «Тон: … → …» — как
        // нажатие на пилюлю в `GreetingOccasionFields`.
        toneChange = null;
      }
    }
  }

  const text = (target: string, max: number, required: boolean) => {
    if (!by.has(target)) return undefined;
    const v = by.get(target)!;
    if (typeof v !== 'string' || (required && !v.trim())) {
      refused.push({ target, reason: 'invalid' });
      return undefined;
    }
    return v.slice(0, max);
  };
  const recipientName = text(T.recipient, BRIEF_NAME_MAX, true);
  if (recipientName !== undefined) patch.recipientName = recipientName;
  const senderName = text(T.sender, BRIEF_NAME_MAX, false);
  if (senderName !== undefined) patch.senderName = senderName;
  const personalMessage = text(T.message, BRIEF_MESSAGE_MAX, false);
  if (personalMessage !== undefined) patch.personalMessage = personalMessage;

  const list = <V extends string>(
    target: string,
    options: readonly V[],
    set: (v: V) => void
  ) => {
    if (!by.has(target)) return;
    const v = oneOf(options, by.get(target)!);
    if (v) set(v);
    else refused.push({ target, reason: 'invalid' });
  };
  list(T.scriptLanguage, GREETING_SCRIPT_LANGUAGES, (v) => {
    patch.scriptLanguage = v;
  });
  list(T.presenter, GREETING_PRESENTER_PROVIDERS, (v) => {
    patch.presenterProvider = v;
  });
  list(T.resolution, GREETING_RESOLUTIONS, (v) => {
    patch.resolution = v;
  });
  if (by.has(T.date)) {
    const v = by.get(T.date)!;
    if (typeof v === 'string' && isIsoDate(v)) patch.occasionDate = v;
    else refused.push({ target: T.date, reason: 'invalid' });
  }

  let occPatch: Partial<OccasionFieldsState> | null = null;
  if (occTouched) {
    occPatch = {};
    for (const k of Object.keys(state) as Array<keyof OccasionFieldsState>) {
      if (state[k] !== occ[k])
        (occPatch as Record<string, unknown>)[k] = state[k];
    }
  }
  return { occPatch, toneChange, patch, refused };
}

export type ToneCommand = Extract<
  VoiceCommand,
  'tone-serious' | 'tone-lighter' | 'no-jokes'
>;

/**
 * Команда тона → новый тон или отказ.
 *
 * Целевой тон называет ТОЛЬКО сервер (`args.tone`, `checkCommand` в
 * `greeting-voice-intent.ts`) — по своей шкале и по тому же регистру.
 * Своей шкалы здесь нет: две шкалы, решающие одно, разошлись бы (аудит
 * волны 1), а запасная шкала для старого сервера после выкладки была
 * мёртвым кодом (финальный аудит). Нет `args.tone` (или он не из списка)
 * — `manual`: «голосом этого пока нельзя, сделайте руками». Последнее
 * слово всё равно за экраном — тон сверяется с `toneOptions` на ТЕКУЩЕМ
 * состоянии брифа, которое могло измениться после разбора.
 *
 * - `already` — этот тон уже выбран;
 * - `unavailable` — регистр повода его гасит («смешнее» на
 *   соболезновании): отказ той же причиной, что серая пилюля на экране.
 */
export function toneForCommand(
  // Какая из трёх команд — решил сервер, назвав тон; параметр остаётся
  // ради подписи вызова у карточки брифа.
  _command: ToneCommand,
  current: GreetingTone,
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null,
  argsTone?: string
): { tone: GreetingTone } | { refusal: 'already' | 'unavailable' | 'manual' } {
  const named = argsTone === undefined ? null : oneOf(GREETING_TONES, argsTone);
  if (!named) return { refusal: 'manual' };
  if (named === current) return { refusal: 'already' };
  const option = toneOptions(policy, occasion, register).find(
    (o) => o.tone === named
  );
  return option?.allowed ? { tone: named } : { refusal: 'unavailable' };
}
