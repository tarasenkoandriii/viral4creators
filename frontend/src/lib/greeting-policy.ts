/**
 * Адаптивный интерфейс поздравления — этап D ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.5.
 *
 * ## Правила — с сервера, не из своей копии
 *
 * До этапа D набор тонов по поводу жил во фронтенде копией
 * (`allowedTonesFor` в `types/project.ts`). Две копии правила — ровно то,
 * что уже разошлось однажды (Г-11, лимит длины повода), поэтому копия
 * удалена (Т-18), а всё, что здесь решается, решается по таблице
 * `GET /greeting/policy` — той же, по которой сервер отвечает 400.
 *
 * Модуль чистый: таблица приходит аргументом. Загрузка и кэш — в
 * `services/greeting-api.ts` (`getGreetingPolicy`).
 *
 * ## Если таблицы нет
 *
 * Запрос не прошёл — интерфейс не выдумывает правила сам: все тоны
 * доступны, а проверку делает сервер, отвечая отказом с объяснением. Это
 * хуже подсказки заранее, но честнее подсказки по устаревшей копии.
 */

import type {
  GreetingOccasion,
  GreetingRegister,
  GreetingTone,
} from '../types/project';
import { GREETING_TONES } from '../types/project';

/** Ответ `GET /greeting/policy` (backend `GreetingPolicyView`). */
export interface GreetingRegisterRules {
  register: GreetingRegister;
  festive: boolean;
  stickers: boolean;
  maxScenes: number;
  catalogUniversalThemes: boolean;
  ownMusicWarning: boolean;
  otherTones: readonly GreetingTone[];
}

export interface GreetingPolicyView {
  registers: GreetingRegisterRules[];
  occasions: Array<{
    occasion: GreetingOccasion;
    register: GreetingRegister;
    tones: readonly GreetingTone[];
  }>;
}

/**
 * Пять регистров в порядке строгости — это перечисление типа, а не
 * правило (правила — в таблице). Нужно вопросу о настроении «Особого
 * повода» и тогда, когда таблица не загрузилась.
 */
export const GREETING_REGISTER_ORDER: readonly GreetingRegister[] = [
  'CELEBRATORY',
  'WARM_NEUTRAL',
  'SOLEMN',
  'SENSITIVE',
  'MOURNING',
];

export function isGreetingRegister(v: unknown): v is GreetingRegister {
  return (GREETING_REGISTER_ORDER as readonly unknown[]).includes(v);
}

/**
 * Регистр брифа для интерфейса.
 *
 * - Повод из списка — регистр каталога; поменять его нельзя.
 * - «Особый повод» — ответ на вопрос о настроении, а после сохранения —
 *   итог сервера (`serverRegister`), который мог быть поднят ключевыми
 *   словами или классификатором (§3.4). Берётся СТРОЖАЙШИЙ из двух:
 *   сервер не опускает регистр, и интерфейс не должен.
 * - «Особый повод» без ответа — итог сервера, если он поднимал регистр,
 *   иначе `null`: вопрос обязателен, и до ответа интерфейс не делает вид,
 *   что знает регистр. Поднятый регистр — знание, а не догадка: сервер
 *   применит его к любому ответу (ниже не опустит), так что тоны,
 *   недоступные при нём, гасятся сразу. Раньше без ответа здесь был
 *   `null`, все тоны горели, а строка «часть тонов недоступна» рядом
 *   врала (бриф, поднятый ключевыми словами, после перезагрузки).
 */
export function briefRegister(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  mood: GreetingRegister | null,
  serverRegister: GreetingRegister | null = null
): GreetingRegister | null {
  if (occasion === 'OTHER') {
    if (!mood) return serverRegister ?? null;
    return stricter(mood, serverRegister);
  }
  return (
    policy?.occasions.find((o) => o.occasion === occasion)?.register ?? null
  );
}

export function stricter(
  a: GreetingRegister,
  b: GreetingRegister | null | undefined
): GreetingRegister {
  if (!b) return a;
  return GREETING_REGISTER_ORDER.indexOf(b) > GREETING_REGISTER_ORDER.indexOf(a)
    ? b
    : a;
}

export function rulesOf(
  policy: GreetingPolicyView | null,
  register: GreetingRegister | null
): GreetingRegisterRules | null {
  if (!policy || !register) return null;
  return policy.registers.find((r) => r.register === register) ?? null;
}

/**
 * Допустимые тоны; первый — умолчание. `null` — не знаем (нет таблицы или
 * «Особый повод» без ответа о настроении).
 */
export function allowedTones(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null
): readonly GreetingTone[] | null {
  if (!policy) return null;
  if (occasion === 'OTHER')
    return rulesOf(policy, register)?.otherTones ?? null;
  return policy.occasions.find((o) => o.occasion === occasion)?.tones ?? null;
}

export interface ToneOption {
  tone: GreetingTone;
  /** Недоступный тон виден серым с подписью, а не пропадает (§3.5). */
  allowed: boolean;
}

/**
 * Все пять тонов — в постоянном порядке, чтобы пилюли не прыгали при
 * смене повода; недоступные помечены. Не знаем правил — доступны все.
 */
export function toneOptions(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null
): ToneOption[] {
  const allowed = allowedTones(policy, occasion, register);
  return GREETING_TONES.map((tone) => ({
    tone,
    allowed: allowed === null || allowed.includes(tone),
  }));
}

/** Умолчание регистра: первый допустимый тон. Не знаем — `null`. */
export function recommendedTone(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null
): GreetingTone | null {
  return allowedTones(policy, occasion, register)?.[0] ?? null;
}

export interface ToneChange {
  from: GreetingTone;
  to: GreetingTone;
}

/**
 * Сброс несовместимого после смены повода или настроения (§3.5).
 *
 * Тон меняется ТОЛЬКО если прежний стал недопустим: у поводов с обычным
 * набором человек выбрал тон осознанно, и сбрасывать его при каждом
 * переключении было бы навязчиво. Возвращается и новое значение, и само
 * изменение — экран называет его («Тон: с юмором → уважительный»), а не
 * меняет молча.
 */
export function reconcileTone(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null,
  tone: GreetingTone
): { tone: GreetingTone; change: ToneChange | null } {
  const allowed = allowedTones(policy, occasion, register);
  if (!allowed || allowed.includes(tone)) return { tone, change: null };
  const to = allowed[0];
  return { tone: to, change: { from: tone, to } };
}

/**
 * Выбранная в сессии подложка — ровно то, что нужно проверке темы
 * (`GreetingMusicSelection.source`/`occasions` из `GET greeting-music`).
 */
export interface SelectedMusic {
  /** Нет поля — старая запись, читается как каталожная (как у сервера). */
  source?: string;
  /**
   * Поводы каталожной темы на момент выбора: `null` — «для любого
   * повода», нет поля — выбор до этапа B, который сервер не блокирует
   * задним числом (`catalogThemeAllowed`).
   */
  occasions?: readonly GreetingOccasion[] | null;
}

export type PredictedReset = 'sticker' | 'musicTheme' | 'sceneCount';

/**
 * Подойдёт ли выбранная каталожная тема новому брифу — зеркало серверных
 * `catalogThemeAllowed` + условия источника в `evaluateGreetingPolicy`.
 * Своя музыка (`upload`/`link`/`library`) не сбрасывается никогда: для
 * неё политика только предупреждает.
 *
 * Зависит от ПОВОДА, а не только от регистра: тема «только для дня
 * рождения» слетает при переходе на свадьбу, хотя регистр у обоих
 * праздничный.
 */
function musicStillFits(
  rules: GreetingRegisterRules,
  occasion: GreetingOccasion,
  music: SelectedMusic
): boolean {
  if ((music.source ?? 'catalog') !== 'catalog') return true;
  if (music.occasions === undefined) return true;
  if (music.occasions === null) return rules.catalogUniversalThemes;
  return music.occasions.includes(occasion);
}

/**
 * Что сбросится в УЖЕ НАЧАТОЙ сессии, если сохранить бриф с новым
 * поводом и регистром, — предупреждение до сохранения. Зеркалит
 * серверный `reconcileSelections` (порядок полей — его же) по таблице, а
 * не по своей копии правил; сам сброс и окончательный список
 * (`resetFields`) — за сервером.
 *
 * Музыку раньше не смотрели вовсе, и смена дня рождения на соболезнование
 * молча снимала подложку: предупреждение называло только наклейку.
 */
export function predictedSessionResets(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null,
  selections: {
    sticker: boolean;
    sceneCount: number | null;
    music?: SelectedMusic | null;
  }
): PredictedReset[] {
  const rules = rulesOf(policy, register);
  if (!rules) return [];
  const out: PredictedReset[] = [];
  if (selections.sticker && !rules.stickers) out.push('sticker');
  if (selections.music && !musicStillFits(rules, occasion, selections.music))
    out.push('musicTheme');
  if ((selections.sceneCount ?? 1) > rules.maxScenes) out.push('sceneCount');
  return out;
}

/**
 * Ключ перечитывания выбранного в сессии; `null` — читать нечего.
 *
 * В ключе ПОВОД, а не только регистр: каталожная тема музыки привязана к
 * поводу, и день рождения → свадьба (оба праздничные) её снимает. И
 * `refresh` — счётчик сохранений брифа: сохранение само сбрасывает
 * несовместимое, и без перечитывания предупреждение «сбросится …»
 * висело бы уже после того, как сброс случился (регистр-то тот же).
 *
 * Отдельной чистой функцией — ради теста без браузера
 * (`scripts/greeting-policy.test.ts`); сам хук — `useSessionSelections`
 * в `lib/useGreetingPolicy.ts`.
 */
export function sessionSelectionsKey(
  sessionId: string | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null,
  refresh: number
): string | null {
  if (!sessionId || !register) return null;
  return `${sessionId}|${occasion}|${register}|${refresh}`;
}
