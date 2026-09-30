/**
 * Голосом — в элементы сессии поздравления (этап K5 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.1).
 *
 * Бриф голос научился заполнять в K3 (`voice-brief.ts`); здесь — всё,
 * что управляется после старта сессии: кадры, текст сценария, голос,
 * музыка, титры, наклейка, число сцен. Правило то же: голос — способ
 * ввода, а не право. Каждая карточка применяет подтверждённое ТЕМИ ЖЕ
 * обработчиками, что кнопки (`choose(n)`, `save()`, `selectGreeting…`), а
 * этот модуль только решает, ЧТО из пришедшего можно применить к
 * ТЕКУЩЕМУ состоянию карточки и почему остальное нельзя. Сервер свои
 * значения уже сверил (`SESSION_FIELD_HOOKS` и проверка в
 * `backend/src/common/greeting-voice-intent.ts`), но между разбором и
 * «Да» экран мог измениться: тему сняли, наклейку убрали, сценарий
 * пересобрали, — и экран перепроверяет сам.
 *
 * Три вида элементов (§4А.7.1):
 * - поле — строка с тем же потолком длины, что `onChange` (`slice`);
 * - список — только вариант, который СЕЙЧАС виден на экране;
 * - галочка — `false` выполнимо так же, как `true`; «включи» без
 *   названного варианта не угадывает вариант, а отказывает с перечнем
 *   доступного (неоднозначное не применяется). Уже включённое или уже
 *   выключенное — не ошибка, а спокойное «уже так»: карточка говорит
 *   правду о том, что ничего не поменялось.
 *
 * Чистый модуль без React — `scripts/voice-fields.test.ts`.
 */

import { STICKER_PLACEMENTS } from '../types/project';
import type { VoiceFieldApplyEffect } from './voice-confirm';
import type { VoiceField } from './voice-types';

/**
 * Хуки элементов сессии — имена из каталога сервера
 * (`SESSION_FIELD_HOOKS`), они же `data-qa` в разметке и ключи
 * `qa-hooks.ts`. Совпадение с каталогом сервера проверяет тест.
 */
export const SESSION_VOICE_TARGETS = {
  referenceLabel: 'greeting-references-label',
  referenceDescription: 'greeting-references-description',
  scriptText: 'greeting-script-edit',
  voicePreset: 'greeting-voice-preset',
  voiceClone: 'greeting-voice-clone',
  voiceSoniox: 'greeting-voice-soniox',
  voiceCustom: 'greeting-voice-custom',
  musicTheme: 'greeting-music-theme',
  musicEnabled: 'greeting-music-enabled',
  musicQuery: 'greeting-music-query',
  cardsTitle: 'greeting-cards-title',
  cardsClosing: 'greeting-cards-closing',
  stickerQuery: 'greeting-sticker-query',
  stickerPlacement: 'greeting-sticker-placement',
  stickerEnabled: 'greeting-sticker-enabled',
  scenesCount: 'greeting-scenes-count',
} as const;

export type SessionVoiceTarget =
  (typeof SESSION_VOICE_TARGETS)[keyof typeof SESSION_VOICE_TARGETS];

const T = SESSION_VOICE_TARGETS;

/** Потолки — те же числа, что `slice`/`maxLength` в разметке карточек. */
export const REFERENCE_LABEL_MAX = 80;
export const REFERENCE_DESCRIPTION_MAX = 2000;
export const SCRIPT_TEXT_MAX = 2000;
export const SEARCH_QUERY_MAX = 100;
/** Совпадает с `MAX_GREETING_CARD_LENGTH` (services/greeting-api.ts) — тест. */
export const CARD_TEXT_MAX = 70;

/** Почему поле не применено — одна причина на поле. */
export type SessionVoiceRefusal =
  /** Значение не того вида (не число, не галочка, пустое имя). */
  | { reason: 'invalid' }
  /** Варианта нет среди видимых на экране (тема, голос, место). */
  | { reason: 'not-on-screen' }
  /** Карточка занята запросом — кнопки сейчас погашены. */
  | { reason: 'busy' }
  /** Сцен больше, чем кнопок на экране. */
  | { reason: 'too-many'; max: number }
  /** «Включи» без варианта — назовите один из этих. */
  | { reason: 'ambiguous'; options: string[] }
  /**
   * Элемент погашен правилом экрана; `why` — какое именно, текст
   * карточки берёт ту же строку, что написана на экране.
   */
  | {
      reason: 'unavailable';
      why:
        | 'sticker-register'
        | 'no-search'
        | 'no-sticker'
        | 'no-script'
        | 'references-locked'
        | 'form-closed'
        | 'two-forms';
    }
  /** Выбрать это голосом нельзя в принципе — только руками. */
  | { reason: 'manual' }
  /** Два поля одной реплики спорят («без музыки» и «тему X»). */
  | { reason: 'conflict' }
  /** Уже так — ничего не меняется. */
  | { reason: 'already' };

export interface SessionVoiceRefused {
  target: string;
  refusal: SessionVoiceRefusal;
}

function byTarget(fields: readonly VoiceField[]): Map<string, VoiceField> {
  return new Map(fields.map((f) => [f.target, f]));
}

/** Галочка: `true`/`false` или их строки (модель иногда кавычит). */
export function toggleOf(value: string | boolean): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Все поля карточки — одной причиной (карточка занята и т. п.). */
function refuseAll(
  fields: readonly VoiceField[],
  targets: readonly string[],
  refusal: SessionVoiceRefusal
): SessionVoiceRefused[] {
  return fields
    .filter((f) => targets.includes(f.target))
    .map((f) => ({ target: f.target, refusal }));
}

// ── Сцены ────────────────────────────────────────────────────────────────

export interface ScenesVoiceState {
  sceneCount: number;
  maxScenes: number;
}

export interface ScenesVoicePlan {
  /** Число для `choose(n)`; `null` — не звать. */
  count: number | null;
  refused: SessionVoiceRefused[];
}

export function planScenesVoice(
  view: ScenesVoiceState | null,
  busy: boolean,
  fields: readonly VoiceField[]
): ScenesVoicePlan {
  const f = byTarget(fields).get(T.scenesCount);
  if (!f) return { count: null, refused: [] };
  const refuse = (refusal: SessionVoiceRefusal): ScenesVoicePlan => ({
    count: null,
    refused: [{ target: T.scenesCount, refusal }],
  });
  if (!view) return refuse({ reason: 'not-on-screen' });
  if (busy) return refuse({ reason: 'busy' });
  const raw = typeof f.value === 'string' ? f.value.trim() : '';
  if (!/^\d{1,2}$/.test(raw)) return refuse({ reason: 'invalid' });
  const n = Number(raw);
  // Кнопки — от 1 до `maxScenes`; другого числа на экране нет.
  if (n < 1) return refuse({ reason: 'invalid' });
  if (n > view.maxScenes) {
    return refuse({ reason: 'too-many', max: view.maxScenes });
  }
  if (n === view.sceneCount) return refuse({ reason: 'already' });
  return { count: n, refused: [] };
}

// ── Титры ────────────────────────────────────────────────────────────────

export interface CardsVoicePlan {
  /** Новые значения полей; `undefined` — поле не трогали. */
  title?: string;
  closing?: string;
  refused: SessionVoiceRefused[];
}

/**
 * Пустая строка — «убрать титр»: ровно то, что делает стёртое руками
 * поле и «Сохранить» (`title.trim() || null`).
 */
export function planCardsVoice(
  loaded: boolean,
  busy: boolean,
  fields: readonly VoiceField[]
): CardsVoicePlan {
  const targets = [T.cardsTitle, T.cardsClosing];
  if (!loaded) {
    return {
      refused: refuseAll(fields, targets, { reason: 'not-on-screen' }),
    };
  }
  if (busy) return { refused: refuseAll(fields, targets, { reason: 'busy' }) };
  const by = byTarget(fields);
  const plan: CardsVoicePlan = { refused: [] };
  const text = (target: string): string | undefined => {
    const f = by.get(target);
    if (!f) return undefined;
    if (typeof f.value !== 'string') {
      plan.refused.push({ target, refusal: { reason: 'invalid' } });
      return undefined;
    }
    return f.value.slice(0, CARD_TEXT_MAX);
  };
  const title = text(T.cardsTitle);
  if (title !== undefined) plan.title = title;
  const closing = text(T.cardsClosing);
  if (closing !== undefined) plan.closing = closing;
  return plan;
}

/**
 * Что сохранить по голосу (аудит волны 2): продиктованное поле — новым
 * значением, второе — СОХРАНЁННЫМ, а не набранным руками и ещё не
 * сохранённым: «Да» на «В начале: …» не должно молча отправить чужую
 * недописанную строку «В конце». `keep` — поле, которое ответ сервера не
 * перезаписывает (набранное руками остаётся в поле). `null` — нечего.
 */
export function cardsVoiceSave(
  plan: CardsVoicePlan,
  saved: { title: string | null; closing: string | null } | null
): {
  values: { title: string; closing: string };
  keep: { title: boolean; closing: boolean };
} | null {
  if (!saved) return null;
  if (plan.title === undefined && plan.closing === undefined) return null;
  return {
    values: {
      title: plan.title ?? saved.title ?? '',
      closing: plan.closing ?? saved.closing ?? '',
    },
    keep: {
      title: plan.title === undefined,
      closing: plan.closing === undefined,
    },
  };
}

// ── Музыка ───────────────────────────────────────────────────────────────

export interface MusicVoiceState {
  /** Темы каталога на экране — уже отфильтрованные поводом сессии. */
  themes: ReadonlyArray<{ id: string; title: string }>;
  /** Выбранная музыка (любого источника); `null` — без музыки. */
  selected: { id: string; source?: string } | null;
  /** Строка поиска библиотеки на экране (`libraryEnabled`). */
  libraryEnabled: boolean;
}

export interface MusicVoicePlan {
  /** Аргумент для `choose(themeId)`: id темы или `null` — снять. */
  choose?: string | null;
  /** Новая строка поиска (без запуска поиска). */
  query?: string;
  refused: SessionVoiceRefused[];
}

export function planMusicVoice(
  music: MusicVoiceState | null,
  busy: boolean,
  fields: readonly VoiceField[]
): MusicVoicePlan {
  const targets = [T.musicTheme, T.musicEnabled, T.musicQuery];
  if (!music) {
    return {
      refused: refuseAll(fields, targets, { reason: 'not-on-screen' }),
    };
  }
  if (busy) return { refused: refuseAll(fields, targets, { reason: 'busy' }) };
  const by = byTarget(fields);
  const plan: MusicVoicePlan = { refused: [] };
  const refuse = (target: string, refusal: SessionVoiceRefusal) =>
    plan.refused.push({ target, refusal });

  const themeField = by.get(T.musicTheme);
  let theme: string | null = null;
  if (themeField) {
    const v = themeField.value;
    const found =
      typeof v === 'string' ? music.themes.find((t) => t.id === v) : undefined;
    if (!found) refuse(T.musicTheme, { reason: 'not-on-screen' });
    // Та же подсветка «выбрано», что у кнопки темы: своя музыка с тем же
    // id темой каталога не считается (старые записи без `source` — да).
    else if (
      music.selected?.id === found.id &&
      (music.selected.source ?? 'catalog') === 'catalog'
    )
      refuse(T.musicTheme, { reason: 'already' });
    else theme = found.id;
  }

  const enabledField = by.get(T.musicEnabled);
  if (enabledField) {
    const on = toggleOf(enabledField.value);
    if (on === null) refuse(T.musicEnabled, { reason: 'invalid' });
    else if (!on) {
      // «Без музыки» и «тему X» в одной реплике — спор; не угадываем.
      if (themeField) {
        refuse(T.musicEnabled, { reason: 'conflict' });
        if (theme !== null) {
          theme = null;
          refuse(T.musicTheme, { reason: 'conflict' });
        }
      } else if (!music.selected) refuse(T.musicEnabled, { reason: 'already' });
      else plan.choose = null;
    } else if (themeField) {
      // «Включи музыку, тему X» — выбор темы и есть включение: галочка
      // применяется вместе с темой и отказывает вместе с ней.
      if (theme === null)
        refuse(T.musicEnabled, { reason: 'ambiguous', options: titles() });
    } else if (music.selected) refuse(T.musicEnabled, { reason: 'already' });
    else refuse(T.musicEnabled, { reason: 'ambiguous', options: titles() });
  }
  if (theme !== null) plan.choose = theme;

  const queryField = by.get(T.musicQuery);
  if (queryField) {
    const v = queryField.value;
    if (!music.libraryEnabled)
      refuse(T.musicQuery, { reason: 'unavailable', why: 'no-search' });
    else if (typeof v !== 'string' || !v.trim())
      refuse(T.musicQuery, { reason: 'invalid' });
    else plan.query = v.slice(0, SEARCH_QUERY_MAX);
  }
  return plan;

  function titles(): string[] {
    return music!.themes.map((t) => t.title);
  }
}

// ── Наклейка ─────────────────────────────────────────────────────────────

export interface StickerVoiceState {
  /** Выбранная наклейка и её место; `null` — наклейки нет. */
  selected: { placement: string } | null;
  /** Поиск настроен на стенде. */
  configured: boolean;
  /** Регистр повода разрешает наклейки (`allowed !== false`). */
  allowed: boolean;
}

export type StickerVoiceAction =
  | { kind: 'clear' }
  | { kind: 'move'; placement: (typeof STICKER_PLACEMENTS)[number] };

export interface StickerVoicePlan {
  action: StickerVoiceAction | null;
  query?: string;
  refused: SessionVoiceRefused[];
}

export function planStickerVoice(
  view: StickerVoiceState | null,
  busy: boolean,
  fields: readonly VoiceField[]
): StickerVoicePlan {
  const targets = [T.stickerQuery, T.stickerPlacement, T.stickerEnabled];
  if (!view) {
    return {
      action: null,
      refused: refuseAll(fields, targets, { reason: 'not-on-screen' }),
    };
  }
  if (busy) {
    return {
      action: null,
      refused: refuseAll(fields, targets, { reason: 'busy' }),
    };
  }
  const by = byTarget(fields);
  const plan: StickerVoicePlan = { action: null, refused: [] };
  const refuse = (target: string, refusal: SessionVoiceRefusal) =>
    plan.refused.push({ target, refusal });

  const enabledField = by.get(T.stickerEnabled);
  const placementField = by.get(T.stickerPlacement);
  let clearing = false;
  if (enabledField) {
    const on = toggleOf(enabledField.value);
    if (on === null) refuse(T.stickerEnabled, { reason: 'invalid' });
    else if (!on) {
      // Снять можно всегда, даже там, где новые наклейки запрещены:
      // карточка для того и показывает выбранную раньше (этап D).
      if (!view.selected) refuse(T.stickerEnabled, { reason: 'already' });
      else if (placementField) refuse(T.stickerEnabled, { reason: 'conflict' });
      else clearing = true;
    } else if (view.selected) refuse(T.stickerEnabled, { reason: 'already' });
    else if (!view.allowed)
      refuse(T.stickerEnabled, {
        reason: 'unavailable',
        why: 'sticker-register',
      });
    // Картинку выбирают из выдачи поиска, которой сервер разбора не
    // видит: «включи наклейку» голосом не выполнимо, только руками.
    else refuse(T.stickerEnabled, { reason: 'manual' });
  }
  if (clearing) plan.action = { kind: 'clear' };

  if (placementField) {
    const v = placementField.value;
    const placement =
      typeof v === 'string'
        ? STICKER_PLACEMENTS.find((p) => p === v)
        : undefined;
    const off = enabledField && toggleOf(enabledField.value) === false;
    if (off) refuse(T.stickerPlacement, { reason: 'conflict' });
    else if (!view.selected)
      refuse(T.stickerPlacement, { reason: 'unavailable', why: 'no-sticker' });
    else if (!placement)
      refuse(T.stickerPlacement, { reason: 'not-on-screen' });
    else if (placement === view.selected.placement)
      refuse(T.stickerPlacement, { reason: 'already' });
    else plan.action = { kind: 'move', placement };
  }

  const queryField = by.get(T.stickerQuery);
  if (queryField) {
    const v = queryField.value;
    // Та же причина, что написана на экране вместо поиска.
    if (!view.allowed)
      refuse(T.stickerQuery, {
        reason: 'unavailable',
        why: 'sticker-register',
      });
    else if (!view.configured)
      refuse(T.stickerQuery, { reason: 'unavailable', why: 'no-search' });
    else if (typeof v !== 'string' || !v.trim())
      refuse(T.stickerQuery, { reason: 'invalid' });
    else plan.query = v.slice(0, SEARCH_QUERY_MAX);
  }
  return plan;
}

// ── Голос отправителя ────────────────────────────────────────────────────

export interface VoiceChoiceState {
  /** Пресеты на экране: `voiceId` → имя. */
  presets: ReadonlyArray<{ voiceId: string; name: string }>;
  /** Готовые клоны человека: `resembleVoiceId` → подпись. */
  clones: ReadonlyArray<{ voiceId: string; label: string }>;
  presetVoiceId: string | null;
  /** `resembleVoiceId` выбранного клона. */
  cloneVoiceId: string | null;
  /**
   * Голоса каталога Soniox на экране (S2): `voiceId` → имя. Необязательное
   * — у вызывающих до S2 раздела Soniox нет, и это «на экране пусто».
   */
  soniox?: ReadonlyArray<{ voiceId: string; name: string }>;
  /** Выбран ли Soniox вовсе — в том числе голос по умолчанию. */
  sonioxSelected?: boolean;
  /** `voiceId` выбранного голоса Soniox; `null` — не выбран или по умолчанию. */
  sonioxVoiceId?: string | null;
}

export type VoiceChoiceAction =
  | { kind: 'preset'; voiceId: string }
  | { kind: 'clone'; voiceId: string }
  /**
   * Голос каталога Soniox. «Голос Soniox по умолчанию» голосом не
   * выбирается: стабильного id у него нет (S2-API), только руками.
   */
  | { kind: 'soniox'; voiceId: string }
  /** Голос по умолчанию — та же кнопка «Снять», что в заголовке. */
  | { kind: 'clear' };

export interface VoiceChoicePlan {
  action: VoiceChoiceAction | null;
  refused: SessionVoiceRefused[];
}

export function planVoiceChoice(
  state: VoiceChoiceState,
  busy: boolean,
  fields: readonly VoiceField[]
): VoiceChoicePlan {
  const targets = [T.voicePreset, T.voiceClone, T.voiceSoniox, T.voiceCustom];
  if (busy) {
    return {
      action: null,
      refused: refuseAll(fields, targets, { reason: 'busy' }),
    };
  }
  const by = byTarget(fields);
  const plan: VoiceChoicePlan = { action: null, refused: [] };
  const refuse = (target: string, refusal: SessionVoiceRefusal) =>
    plan.refused.push({ target, refusal });
  const soniox = state.soniox ?? [];
  const options = () => [
    ...state.clones.map((c) => c.label),
    ...state.presets.map((p) => p.name),
    ...soniox.map((s) => s.name),
  ];
  const chosen =
    state.presetVoiceId !== null ||
    state.cloneVoiceId !== null ||
    !!state.sonioxSelected;

  const customField = by.get(T.voiceCustom);
  const custom = customField ? toggleOf(customField.value) : undefined;

  // Три вида списка — пресет, клон, Soniox. Порядок пары важен только для
  // порядка отказов: он тот же, что до S2 (пресет, клон), Soniox — третьим.
  const kinds = [
    {
      kind: 'preset' as const,
      target: T.voicePreset,
      onScreen: (v: string) => state.presets.some((p) => p.voiceId === v),
      current: state.presetVoiceId,
    },
    {
      kind: 'clone' as const,
      target: T.voiceClone,
      onScreen: (v: string) => state.clones.some((c) => c.voiceId === v),
      current: state.cloneVoiceId,
    },
    {
      kind: 'soniox' as const,
      target: T.voiceSoniox,
      onScreen: (v: string) => soniox.some((s) => s.voiceId === v),
      // «По умолчанию» (`sonioxVoiceId: null`) — не «уже» ни для одного
      // голоса каталога: названный голос его заменяет.
      current: state.sonioxSelected ? (state.sonioxVoiceId ?? null) : null,
    },
  ];
  const named = kinds.flatMap((k) => {
    const f = by.get(k.target);
    return f ? [{ ...k, field: f }] : [];
  });

  // Занят может быть только один голос (сервер гасит остальные): два
  // названных сразу — неоднозначно, «без своего голоса» вместе с
  // названным — спор. Ни то ни другое не угадываем.
  if (named.length > 1) {
    for (const k of named) refuse(k.target, { reason: 'conflict' });
  } else if (named.length === 1) {
    const k = named[0];
    const v = typeof k.field.value === 'string' ? k.field.value : null;
    if (custom === false) refuse(k.target, { reason: 'conflict' });
    else if (!v || !k.onScreen(v))
      refuse(k.target, { reason: 'not-on-screen' });
    else if (k.current === v) refuse(k.target, { reason: 'already' });
    else plan.action = { kind: k.kind, voiceId: v };
  }

  if (customField) {
    const hasNamed = named.length > 0;
    if (custom === null) refuse(T.voiceCustom, { reason: 'invalid' });
    else if (custom === false) {
      if (hasNamed) refuse(T.voiceCustom, { reason: 'conflict' });
      else if (!chosen) refuse(T.voiceCustom, { reason: 'already' });
      else plan.action = { kind: 'clear' };
    } else if (hasNamed) {
      // «Включи свой голос, Анну» — включение и есть выбор Анны:
      // галочка применяется вместе с ним и отказывает вместе с ним.
      if (!plan.action)
        refuse(T.voiceCustom, { reason: 'ambiguous', options: options() });
    } else if (chosen) refuse(T.voiceCustom, { reason: 'already' });
    else refuse(T.voiceCustom, { reason: 'ambiguous', options: options() });
  }
  return plan;
}

// ── Текст сценария ───────────────────────────────────────────────────────

export interface ScriptVoicePlan {
  /** Новый ПОЛНЫЙ текст поля правки; сохраняет человек кнопкой. */
  text?: string;
  refused: SessionVoiceRefused[];
}

export function planScriptVoice(
  hasScript: boolean,
  busy: boolean,
  fields: readonly VoiceField[]
): ScriptVoicePlan {
  const f = byTarget(fields).get(T.scriptText);
  if (!f) return { refused: [] };
  const refuse = (refusal: SessionVoiceRefusal): ScriptVoicePlan => ({
    refused: [{ target: T.scriptText, refusal }],
  });
  if (!hasScript) return refuse({ reason: 'unavailable', why: 'no-script' });
  // Пересборка перезапишет поле ответом сервера — голос бы потерялся.
  if (busy) return refuse({ reason: 'busy' });
  if (typeof f.value !== 'string' || !f.value.trim())
    return refuse({ reason: 'invalid' });
  return { text: f.value.slice(0, SCRIPT_TEXT_MAX), refused: [] };
}

// ── Подпись и описание кадра ─────────────────────────────────────────────

/**
 * Какие формы кадра открыты: подписи и описания живут ТОЛЬКО в форме
 * добавления или правки. Две открытые разом — неоднозначно, куда.
 */
export type ReferenceFormsState = 'locked' | 'none' | 'one' | 'two';

export interface ReferenceVoicePlan {
  label?: string;
  description?: string;
  refused: SessionVoiceRefused[];
}

export function planReferenceVoice(
  forms: ReferenceFormsState,
  busy: boolean,
  fields: readonly VoiceField[]
): ReferenceVoicePlan {
  const targets = [T.referenceLabel, T.referenceDescription];
  if (forms !== 'one') {
    const why =
      forms === 'locked'
        ? 'references-locked'
        : forms === 'two'
          ? 'two-forms'
          : 'form-closed';
    return {
      refused: refuseAll(fields, targets, { reason: 'unavailable', why }),
    };
  }
  if (busy) return { refused: refuseAll(fields, targets, { reason: 'busy' }) };
  const by = byTarget(fields);
  const plan: ReferenceVoicePlan = { refused: [] };
  const label = by.get(T.referenceLabel);
  if (label) {
    // Без подписи кадр не добавить и не сохранить (кнопка гаснет).
    if (typeof label.value !== 'string' || !label.value.trim())
      plan.refused.push({
        target: T.referenceLabel,
        refusal: { reason: 'invalid' },
      });
    else plan.label = label.value.slice(0, REFERENCE_LABEL_MAX);
  }
  const description = by.get(T.referenceDescription);
  if (description) {
    if (typeof description.value !== 'string')
      plan.refused.push({
        target: T.referenceDescription,
        refusal: { reason: 'invalid' },
      });
    else
      plan.description = description.value.slice(0, REFERENCE_DESCRIPTION_MAX);
  }
  return plan;
}

// ── Строки отказа ────────────────────────────────────────────────────────

/** Раздел словаря `voiceFields` плюс причины, уже написанные на экране. */
export interface SessionVoiceTexts {
  /** «Не применил «{field}»: {reason}.» — общий с брифом. */
  refusedField: string;
  invalid: string;
  notOnScreen: string;
  busy: string;
  /** «сцен не больше {max}». */
  tooMany: string;
  /** «назовите вариант: {list}». */
  ambiguous: string;
  /** Вариантов для «включи» нет вовсе. */
  ambiguousNone: string;
  manual: string;
  conflict: string;
  already: string;
  /** Причины `unavailable` — для наклейки та же строка, что на экране. */
  unavailable: Record<
    Extract<SessionVoiceRefusal, { reason: 'unavailable' }>['why'],
    string
  >;
}

export function refusalReason(
  r: SessionVoiceRefusal,
  t: SessionVoiceTexts
): string {
  switch (r.reason) {
    case 'invalid':
      return t.invalid;
    case 'not-on-screen':
      return t.notOnScreen;
    case 'busy':
      return t.busy;
    case 'too-many':
      return t.tooMany.replace('{max}', String(r.max));
    case 'ambiguous':
      return r.options.length > 0
        ? t.ambiguous.replace('{list}', r.options.join(', '))
        : t.ambiguousNone;
    case 'unavailable':
      return t.unavailable[r.why];
    case 'manual':
      return t.manual;
    case 'conflict':
      return t.conflict;
    case 'already':
      return t.already;
  }
}

/**
 * Строки для `VoiceFieldApplier.apply` — по одной на НЕ применённое поле,
 * с подписью поля с карточки «я понял так». Хвостовую точку причины
 * срезаем: шаблон ставит свою (строки экрана — целые предложения).
 */
export function refusalLines(
  refused: readonly SessionVoiceRefused[],
  fields: readonly VoiceField[],
  t: SessionVoiceTexts
): string[] {
  return refused.map((x) =>
    t.refusedField
      .replace(
        '{field}',
        fields.find((f) => f.target === x.target)?.label ?? x.target
      )
      .replace('{reason}', refusalReason(x.refusal, t).replace(/[.。]\s*$/, ''))
  );
}

// ── Что стало с применённым (аудит волны 2) ──────────────────────────────

/**
 * Итог обработчика карточки → эффект для строки после «Да»: обработчики
 * карточек сессии возвращают строку ошибки, которую показали на экране,
 * или `null` — сохранено.
 */
export function saveEffect(error: string | null): VoiceFieldApplyEffect {
  return error === null ? { kind: 'saved' } : { kind: 'failed', reason: error };
}

/** Поле заполнено, сохраняет человек кнопкой с этим названием. */
export function needsSave(button: string): VoiceFieldApplyEffect {
  return { kind: 'needs-save', button };
}
