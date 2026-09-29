/**
 * Логика блока «повод → настроение → тон» — этап D ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.4 (п. 1), §3.5.
 *
 * Блок один на два экрана — создание проекта и бриф мастера
 * (`features/projects/GreetingOccasionFields.tsx`). Раньше каждый экран
 * держал свою копию сброса тона при смене повода, и копии уже успели
 * разойтись в комментариях; здесь — единственная реализация, чистая,
 * чтобы проверяться без браузера (`scripts/greeting-occasion-fields.test.ts`).
 *
 * Правила (какие тоны, какой регистр строже) — не здесь, а в
 * `lib/greeting-policy.ts` по таблице сервера. Здесь только то, как
 * экран ими пользуется.
 */

import type {
  GreetingBriefView,
  GreetingOccasion,
  GreetingRegister,
  GreetingTone,
} from '../types/project';
import { GREETING_TONES } from '../types/project';
import {
  allowedTones,
  briefRegister,
  GREETING_REGISTER_ORDER,
  isGreetingRegister,
  reconcileTone,
  type GreetingPolicyView,
  type ToneChange,
} from './greeting-policy';

/** Состояние блока — то, чем владеет экран. */
export interface OccasionFieldsState {
  occasion: GreetingOccasion;
  customOccasionText: string;
  /** Ответ на вопрос о настроении «Особого повода»; `null` — не ответил. */
  mood: GreetingRegister | null;
  tone: GreetingTone;
}

/**
 * Ответ человека о настроении из сохранённого брифа.
 *
 * Сервер хранит ответ отдельно от итога (`userOccasionRegister`), так что
 * после подъёма регистра словами или классификатором вопрос заново не
 * задаётся. `occasionRegister` как ответ берётся, только если поля нет
 * (сервер до этой колонки) и регистр задал сам человек (`registerSource
 * === 'user'`): поднятый итог — не ответ, и подставить его значило бы
 * навсегда закрепить подъём, даже когда человек перепишет описание. У
 * старых брифов (`default`/`null`) ответа не было вовсе — вопрос задаётся
 * заново, и без ответа сохранить нельзя, как требует §3.4 (сервер
 * ответит 400).
 */
export function initialMood(
  brief: Pick<
    GreetingBriefView,
    'occasion' | 'occasionRegister' | 'registerSource' | 'userOccasionRegister'
  >
): GreetingRegister | null {
  if (brief.occasion !== 'OTHER') return null;
  if (isGreetingRegister(brief.userOccasionRegister)) {
    return brief.userOccasionRegister;
  }
  if (brief.registerSource !== 'user') return null;
  return isGreetingRegister(brief.occasionRegister)
    ? brief.occasionRegister
    : null;
}

/**
 * Регистр, поднятый проверкой сервера (ключевые слова, классификатор), —
 * или `null`, если его задал человек или он из каталога. Нужен и для
 * набора тонов (сервер не опустит регистр — интерфейс тоже), и для
 * строки «уточнено как …».
 */
export function raisedServerRegister(
  brief: Pick<
    GreetingBriefView,
    'occasion' | 'occasionRegister' | 'registerSource'
  >
): GreetingRegister | null {
  if (brief.occasion !== 'OTHER') return null;
  if (
    brief.registerSource !== 'keywords' &&
    brief.registerSource !== 'classifier'
  ) {
    return null;
  }
  return isGreetingRegister(brief.occasionRegister)
    ? brief.occasionRegister
    : null;
}

/**
 * Поднятый регистр, пока он ещё про ЭТОТ бриф: повод — «Особый», а
 * описание то же, что сохранено. Переписал человек описание — прежний
 * итог ключевых слов или классификатора уже ничего не говорит (сервер
 * пересчитает его по новому тексту), и держать по нему тоны погашенными
 * значило бы запрещать то, что сервер, возможно, примет. Раньше итог
 * применялся всегда, и «поминки» → «юбилей» оставляли тон «С юмором»
 * серым до следующего сохранения.
 */
export function effectiveServerRegister(
  brief: Pick<
    GreetingBriefView,
    'occasion' | 'occasionRegister' | 'registerSource' | 'customOccasionText'
  >,
  state: Pick<OccasionFieldsState, 'occasion' | 'customOccasionText'>
): GreetingRegister | null {
  if (state.occasion !== 'OTHER') return null;
  if (
    state.customOccasionText.trim() !== (brief.customOccasionText ?? '').trim()
  ) {
    return null;
  }
  return raisedServerRegister(brief);
}

/** Регистр, по которому строится выбор тона сейчас. */
export function fieldsRegister(
  policy: GreetingPolicyView | null,
  state: Pick<OccasionFieldsState, 'occasion' | 'mood'>,
  serverRegister: GreetingRegister | null
): GreetingRegister | null {
  return briefRegister(policy, state.occasion, state.mood, serverRegister);
}

/**
 * Смена повода или настроения: новое состояние и то, что изменилось в
 * тоне. Тон трогается, только если прежний стал недопустим
 * (`reconcileTone`); изменение возвращается, чтобы экран его назвал.
 *
 * Выбор тона сюда не ходит: его делает сам человек, и «исправлять» его
 * выбор незачем — недопустимые пилюли и так погашены.
 */
export function applyOccasionPatch(
  policy: GreetingPolicyView | null,
  state: OccasionFieldsState,
  patch: Partial<
    Pick<OccasionFieldsState, 'occasion' | 'mood' | 'customOccasionText'>
  >,
  /**
   * Поднятый сервером регистр — значением или функцией от НОВОГО
   * состояния. Функция нужна правке описания: поднятый регистр действует,
   * только пока описание прежнее (`effectiveServerRegister`), и
   * переписанный текст может и снять подъём, и вернуть его. Без пересчёта
   * по новому состоянию тон оставался бы серым без строки «Тон: … → …»
   * и получал отказ сервера (повторный аудит этапа D).
   */
  serverRegister:
    | GreetingRegister
    | null
    | ((next: OccasionFieldsState) => GreetingRegister | null)
): { patch: Partial<OccasionFieldsState>; change: ToneChange | null } {
  // Ушли с «Особого повода» — ответ о настроении забывается, как и на
  // сервере (`userOccasionRegister` у каталожного повода — null). Иначе
  // возврат к «Особому» на той же странице подставлял бы прежний ответ,
  // которого сервер уже не помнит (аудит поля 29.09.2026).
  const leftOther =
    patch.occasion !== undefined &&
    patch.occasion !== 'OTHER' &&
    state.occasion === 'OTHER' &&
    state.mood !== null;
  if (leftOther) patch = { ...patch, mood: null };
  const next = { ...state, ...patch };
  const raised =
    typeof serverRegister === 'function'
      ? serverRegister(next)
      : serverRegister;
  const register = fieldsRegister(policy, next, raised);
  const { tone, change } = reconcileTone(
    policy,
    next.occasion,
    register,
    next.tone
  );
  return { patch: change ? { ...patch, tone } : patch, change };
}

/**
 * Строка «Тон: с юмором → уважительный». Шаблон и названия тонов — из
 * словаря, чтобы строка была на языке интерфейса.
 */
export function formatToneChange(
  template: string,
  change: ToneChange,
  toneNames: Readonly<Record<GreetingTone, string>>
): string {
  return template
    .replace('{from}', toneNames[change.from])
    .replace('{to}', toneNames[change.to]);
}

/**
 * Какое настроение назвать в строке «По описанию повода настроение
 * уточнено как «…» — часть тонов недоступна», или `null` — строки нет.
 *
 * Строка нужна, когда сервер поднял регистр выше ответа человека (§3.4:
 * «экран говорит почему»), — но только если поднятый регистр ДЕЙСТВИТЕЛЬНО
 * гасит хоть один тон, который открыл бы ответ: «праздничное» →
 * «тёплое нейтральное» тонов не меняет, и строка про «недоступные» там
 * врала бы. Сравнение — по наборам, не по длине: у «торжественного» и
 * «тёплого» по три тона, но «С юмором» у первого нет.
 *
 * Нет ответа (вопрос задаётся заново) — строка тоже нужна: человек
 * видит, что проверка уже решила, и не удивляется, что мягкий ответ
 * ничего не расширит; тоны при этом гасятся по поднятому регистру
 * (`briefRegister`), так что «часть недоступна» — правда. Таблицы нет —
 * строки нет: тогда доступны все тоны, и строка соврала бы.
 */
export function raisedMoodToShow(
  policy: GreetingPolicyView | null,
  occasion: GreetingOccasion,
  mood: GreetingRegister | null,
  serverRegister: GreetingRegister | null
): GreetingRegister | null {
  if (occasion !== 'OTHER' || !serverRegister) return null;
  const raised = allowedTones(policy, 'OTHER', serverRegister);
  if (!raised) return null;
  const before = mood ? allowedTones(policy, 'OTHER', mood) : GREETING_TONES;
  if (!before) return null;
  if (
    mood &&
    GREETING_REGISTER_ORDER.indexOf(serverRegister) <=
      GREETING_REGISTER_ORDER.indexOf(mood)
  ) {
    return null;
  }
  return before.some((t) => !raised.includes(t)) ? serverRegister : null;
}

/**
 * Заполнен ли блок настолько, чтобы бриф можно было сохранить: у
 * «Особого повода» обязательны описание и ответ о настроении.
 */
export function occasionFieldsComplete(
  state: Pick<OccasionFieldsState, 'occasion' | 'customOccasionText' | 'mood'>
): boolean {
  if (state.occasion !== 'OTHER') return true;
  return state.customOccasionText.trim().length > 0 && state.mood !== null;
}

/**
 * Значение `occasionRegister` для запроса: ответ о настроении — только у
 * «Особого повода». У поводов из списка регистр задаёт каталог, и
 * присланный ответ сервер бы проигнорировал или отверг; `null` явно
 * очищает прежний ответ, если повод сменили с «Особого».
 */
export function occasionRegisterField(
  state: Pick<OccasionFieldsState, 'occasion' | 'mood'>
): GreetingRegister | null {
  return state.occasion === 'OTHER' ? state.mood : null;
}

/**
 * Тон для запроса создания проекта; `undefined` — не присылать.
 *
 * Пока таблица не пришла (медленная сеть, сбой), в форме стоит
 * временное «Тёплый» — не выбор человека, а заглушка. Отправить её
 * значило бы получить 400 на переходе с лендинга
 * `?occasion=CONDOLENCE`: у траура тёплого тона нет. Без поля сервер
 * возьмёт умолчание регистра сам (`defaultToneForRegister` в
 * `project.service.ts`) — то же, что форма поставила бы по таблице.
 *
 * Тон, выбранный человеком, уходит всегда: это его решение, и если
 * оно недопустимо — пусть сервер объяснит отказом, а не молча заменит.
 */
export function createToneField(
  tone: GreetingTone,
  opts: { policyLoaded: boolean; toneTouched: boolean }
): GreetingTone | undefined {
  if (!opts.policyLoaded && !opts.toneTouched) return undefined;
  return tone;
}
