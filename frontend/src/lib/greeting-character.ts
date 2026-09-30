/**
 * Блок «Характер ролика» — этап D ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §3.3, §3.5.
 *
 * Голос, музыка, титры, наклейка и сцены на экране — одна группа, и
 * сводка над ней отвечает на вопрос «что я уже выбрал», не заставляя
 * листать пять карточек. Логика сводки и предупреждения о своей музыке
 * вынесена сюда чистой: её проверяет `scripts/greeting-character.test.ts`,
 * а компонент только собирает значения.
 */

import type {
  GreetingMusicSelection,
  GreetingOccasion,
  GreetingRegister,
} from '../types/project';
import {
  briefRegister,
  type GreetingPolicyView,
  type GreetingRegisterRules,
} from './greeting-policy';

/** Порядок частей сводки — тот же, что порядок карточек на экране. */
export const CHARACTER_PARTS = [
  'voice',
  'music',
  'cards',
  'sticker',
  'scenes',
] as const;
export type CharacterPart = (typeof CHARACTER_PARTS)[number];

/**
 * Значение части; `null` — карточки нет на экране (наклейка без ключа
 * Pixabay) или её состояние не прочитано: ещё грузится или запрос не
 * прошёл. Такая часть в сводку не попадает: «Наклейка: нет» про
 * карточку, которой не видно, — это утверждение о том, чего человек
 * проверить не может; «Голос: по умолчанию» до ответа сервера или
 * после ошибки — утверждение, которое может оказаться ложью (голос
 * выбран, мы просто его не прочитали).
 *
 * Поэтому каждая функция ниже принимает прочитанное с сервера или
 * `null`, если прочитать не удалось, и на `null` отвечает `null`.
 * Запасное состояние, которое карточка рисует после ошибки (пустая
 * витрина музыки, «голос по умолчанию»), сюда передавать нельзя: оно
 * для экрана, а не для сводки.
 */
export type CharacterSummary = Partial<Record<CharacterPart, string | null>>;

export interface CharacterLabels {
  summaryVoice: string;
  summaryMusic: string;
  summaryCards: string;
  summarySticker: string;
  summaryScenes: string;
  summaryNone: string;
  summaryDefault: string;
  summaryYes: string;
}

export function voiceSummary(
  voice: { senderLabel: string | null; presetName: string | null } | null,
  w: CharacterLabels
): string | null {
  if (!voice) return null;
  return voice.senderLabel || voice.presetName || w.summaryDefault;
}

export function musicSummary(
  music: { selected: { title: string } | null } | null,
  w: CharacterLabels
): string | null {
  if (!music) return null;
  return music.selected?.title || w.summaryNone;
}

/**
 * Число СОХРАНЁННЫХ непустых титров, а не набранных в поле: сводка
 * говорит о том, что уйдёт в ролик, а несохранённый ввод не уйдёт.
 */
export function cardsSummary(
  cards: { title: string | null; closing: string | null } | null,
  w: CharacterLabels
): string | null {
  if (!cards) return null;
  const n = [cards.title, cards.closing].filter((c) => !!c?.trim()).length;
  return n > 0 ? String(n) : w.summaryNone;
}

type StickerState = {
  selected: unknown;
  configured: boolean;
  allowed?: boolean;
};

/**
 * Карточки наклейки нет на экране: не прочитана, или нет ключа Pixabay
 * и снимать нечего (хук `greeting-sticker-card` объявляет это как
 * `absentWhen`). Одно правило и для карточки, и для сводки — иначе
 * сводка заговорила бы о карточке, которой не видно.
 */
export function stickerCardHidden(view: StickerState | null): boolean {
  return !view || (!view.configured && !view.selected);
}

/**
 * Наклейки не разрешены поводу и ничего не выбрано — «нет», а не
 * пропуск части. Сводка говорит о том, что уйдёт в ролик, и «нет»
 * здесь правда: наклейки в ролике не будет. Карточка при этом на
 * экране и сама объясняет почему («недоступна для этого повода»), так
 * что утверждение можно проверить глазами. Пропуск же был бы хуже:
 * карточка видна, а сводка о ней молчит — ровно то, что контракт
 * `null` («карточки не видно») не описывает, и человек гадал бы,
 * учтена ли она.
 */
export function stickerSummary(
  view: StickerState | null,
  w: CharacterLabels
): string | null {
  if (!view || stickerCardHidden(view)) return null;
  return view.selected ? w.summaryYes : w.summaryNone;
}

export function scenesSummary(
  scenes: { sceneCount: number } | null
): string | null {
  if (!scenes) return null;
  return String(scenes.sceneCount);
}

/** «Голос: … · Музыка: … · …» — только по частям, которые на экране. */
export function characterSummaryLine(
  summary: CharacterSummary,
  w: CharacterLabels
): string {
  const label: Record<CharacterPart, string> = {
    voice: w.summaryVoice,
    music: w.summaryMusic,
    cards: w.summaryCards,
    sticker: w.summarySticker,
    scenes: w.summaryScenes,
  };
  return CHARACTER_PARTS.flatMap((part) => {
    const value = summary[part];
    return value ? [`${label[part]}: ${value}`] : [];
  }).join(' · ');
}

/**
 * Регистр брифа для блока. «Особый повод» без итога сервера читается
 * как WARM_NEUTRAL — то же умолчание, что у сервера (`registerSource:
 * 'default'`); каталожный повод — по таблице. Таблицы нет — `null`, и
 * предупреждений нет: выдумывать правило без таблицы интерфейс не
 * должен (см. `greeting-policy.ts`).
 */
export function characterRegister(
  policy: GreetingPolicyView | null,
  brief: {
    occasion: GreetingOccasion;
    occasionRegister?: GreetingRegister | null;
  }
): GreetingRegister | null {
  if (!policy) return null;
  return briefRegister(
    policy,
    brief.occasion,
    brief.occasionRegister ?? 'WARM_NEUTRAL'
  );
}

/**
 * Предупреждение о своей музыке (§3.5: у деликатного и траурного
 * регистров своя музыка разрешена «с предупреждением»). Показывается,
 * пока человек добавляет трек, и пока выбран не каталожный: каталог
 * отфильтрован по поводу сервером, а загрузка, ссылка и библиотека —
 * нет, за уместность отвечает сам человек. Старые записи без `source`
 * — каталожные.
 */
export function showOwnMusicWarning(
  rules: Pick<GreetingRegisterRules, 'ownMusicWarning'> | null,
  state: {
    adding: boolean;
    selected: Pick<GreetingMusicSelection, 'source'> | null;
  }
): boolean {
  if (!rules?.ownMusicWarning) return false;
  if (state.adding) return true;
  return !!state.selected && (state.selected.source ?? 'catalog') !== 'catalog';
}

// ── Замок карточек после рендера (проверочный аудит CONTRACT6) ──────────

/**
 * Можно ли сейчас править карточки «Характера ролика».
 *
 * - `done` — ролик готов: правка на месте меняла бы снимок уже
 *   врученного ролика, а новый рендер той же сессии сервер не даёт
 *   (409 `GREETING_VIDEO_ALREADY_READY`). Другой ролик — через правку
 *   брифа или текста: появится новая версия сессии, где карточки снова
 *   открыты.
 * - `busy` — ролик снимается: сервер ответил бы 409
 *   `GREETING_CHANGE_DURING_RENDER`.
 */
export type CharacterLock = 'done' | 'busy';

export function characterLockOf(
  videoStatus: string | null | undefined
): CharacterLock | null {
  if (videoStatus === 'complete') return 'done';
  if (videoStatus === 'pending' || videoStatus === 'processing') return 'busy';
  return null;
}

/**
 * Голос в запертых карточках — тот же отказ, что на экране, по строке на
 * поле (формат `refusedField`: «Не применил «{field}»: {reason}.»).
 */
export function lockedFieldRefusals(
  fields: ReadonlyArray<{ target: string; label: string }>,
  refusedField: string,
  reason: string
): string[] {
  const why = reason.replace(/[.。]\s*$/, '');
  return fields.map((f) =>
    refusedField
      .replace('{field}', f.label || f.target)
      .replace('{reason}', why)
  );
}
