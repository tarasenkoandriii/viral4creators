/**
 * Недоверчивое чтение ответа модели и проверка значений против
 * ДОСТУПНОГО в текущем состоянии: поля брифа, «значения на экране»,
 * элементы сессии (K5) и команды.
 *
 * Отдельный модуль — потому что это самая большая и самая строгая часть
 * разбора (правило «модели не верим ни в чём»), и её удобно читать
 * целиком, без инструкции модели и реплик вокруг. Зависит от контракта,
 * фраз и реплик; от него — инструкция модели и ядро `resolveIntent`.
 * Внешний вход — `greeting-voice-intent.ts` (реэкспорт).
 */

import {
  GREETING_OCCASIONS,
  GREETING_PRESENTER_PROVIDERS,
  GREETING_REGISTERS,
  GREETING_RESOLUTIONS,
  GREETING_TONES,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingRegister,
  GreetingTone,
  MAX_CUSTOM_OCCASION_LENGTH,
} from './types/greeting.types';
import { GREETING_OCCASION_SPECS } from './greeting-occasions';
import {
  resolveOtherRegister,
  stricterRegister,
  tonesFor,
} from './greeting-policy';
import { isSupportedLocale } from './locale';
import {
  HEDRA_PREMIUM_ONLY,
  OCCASION_LABELS,
  PRESENTER_HEDRA_LABEL,
  SESSION_SCREEN_LABELS,
  TONE_LABELS,
  TONE_UNAVAILABLE,
} from './greeting-voice-intent-labels';
import { MAX_CARD_TEXT_LENGTH } from './greeting-cards';
import { STICKER_PLACEMENTS } from './sticker-overlay';
import { findModerationFlags } from './text-moderation';
import { findCelebrityLikeness } from './celebrity-likeness';
import {
  BriefField,
  CLEARABLE_SESSION_FIELDS,
  FIELD_NAMES,
  SESSION_FIELDS,
  SESSION_FIELD_HOOKS,
  SESSION_FIELD_NAMES,
  SessionField,
  VALIDATION_ORDER,
  VOICE_COMMANDS,
  VOICE_NAVIGATE_TARGETS,
  VOICE_REFERENCE_DESCRIPTION_MAX,
  VOICE_REFERENCE_LABEL_MAX,
  VOICE_SCRIPT_MAX,
  VOICE_SEARCH_QUERY_MAX,
  VoiceBriefState,
  VoiceCommand,
  VoiceFieldKey,
  VoiceNavigateTarget,
  VoiceUnderstandContext,
  isSessionField,
  sessionCardShown,
  voiceFieldOf,
} from './greeting-voice-contract';
import { REPLIES } from './greeting-voice-replies';

// ── Ответ модели: недоверчивое чтение ───────────────────────────────────

export const MODEL_ANSWER_KINDS = [
  'fill',
  'command',
  'navigate',
  'help',
  'consent',
  'confirm',
  'cancel',
  'unknown',
] as const;
export type ModelAnswerKind = (typeof MODEL_ANSWER_KINDS)[number];

export interface ModelField {
  field: VoiceFieldKey;
  /** Строка; `boolean` — только у галочек сессии. */
  value: string | boolean;
  confidence: number;
}

/**
 * Значение из ответа модели в форме, которую ждёт цель, — или `null`
 * (поле выпадает). Бриф — только непустая строка (как в волне 1).
 * Сессия: галочка — только `boolean` («true» строкой — не наша форма),
 * число сцен — строка или целое число, поле-«убрать» — и пустая строка.
 */
function modelValueOf(
  field: VoiceFieldKey,
  v: unknown,
): string | boolean | null {
  if (isSessionField(field)) {
    if (SESSION_FIELD_HOOKS[field].kind === 'toggle') {
      return typeof v === 'boolean' ? v : null;
    }
    if (field === 'scenesCount' && typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : null;
    }
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return CLEARABLE_SESSION_FIELDS.has(field) ? '' : null;
    return t;
  }
  if (typeof v !== 'string') return null;
  return v.trim() || null;
}

export interface ModelAnswer {
  kind: ModelAnswerKind;
  fields: ModelField[];
  command: VoiceCommand | null;
  to: VoiceNavigateTarget | null;
  confidence: number;
}

const UNKNOWN_ANSWER: ModelAnswer = {
  kind: 'unknown',
  fields: [],
  command: null,
  to: null,
  confidence: 0,
};

/**
 * Уверенность — только число в [0, 1]. Строка «0.9», `NaN`, «1.5» — ноль:
 * модель, не соблюдающая форму, не должна получать кредит доверия, а ноль
 * — это переспрос, то есть безопасная сторона.
 */
export function confidenceOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
    ? v
    : 0;
}

/**
 * Ответ модели → `ModelAnswer`. Принимает сырую строку (с ограждением
 * ``` или без) или уже разобранный объект. Ничего не бросает: любая
 * неожиданность формы — `unknown` или выпавшее поле.
 *
 * Правила формы:
 * - `kind` не из списка — `unknown`;
 * - поле с неизвестной целью или не-строковым значением выпадает (все
 *   поля брифа строковые; число или объект вместо строки — не наша форма);
 * - одна цель дважды с РАЗНЫМИ значениями — неоднозначность: поле
 *   остаётся с уверенностью 0 и уйдёт в переспрос;
 * - уверенность поля не указана — берётся общая, но не выше неё.
 */
export function normalizeModelAnswer(raw: unknown): ModelAnswer {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```$/, '')
      .trim();
    try {
      obj = JSON.parse(text);
    } catch {
      return { ...UNKNOWN_ANSWER };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ...UNKNOWN_ANSWER };
  }
  const o = obj as Record<string, unknown>;
  const kind = (MODEL_ANSWER_KINDS as readonly unknown[]).includes(o.kind)
    ? (o.kind as ModelAnswerKind)
    : 'unknown';
  const confidence = confidenceOf(o.confidence);

  const byField = new Map<VoiceFieldKey, ModelField>();
  const rawFields = Array.isArray(o.fields) ? o.fields.slice(0, 20) : [];
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const field = voiceFieldOf(f.target ?? f.field);
    if (!field) continue;
    const value = modelValueOf(field, f.value);
    if (value === null) continue;
    const own =
      f.confidence === undefined ? confidence : confidenceOf(f.confidence);
    const fieldConfidence = Math.min(own, confidence);
    const prev = byField.get(field);
    if (prev && prev.value !== value) {
      byField.set(field, { field, value: prev.value, confidence: 0 });
      continue;
    }
    byField.set(field, { field, value, confidence: fieldConfidence });
  }

  const command = (VOICE_COMMANDS as readonly unknown[]).includes(o.command)
    ? (o.command as VoiceCommand)
    : null;
  const to = (VOICE_NAVIGATE_TARGETS as readonly unknown[]).includes(o.to)
    ? (o.to as VoiceNavigateTarget)
    : null;
  return { kind, fields: [...byField.values()], command, to, confidence };
}

// ── Проверка значений ───────────────────────────────────────────────────

/** Состояние, накопленное по ходу проверки реплики. */
interface Effective {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  mood: GreetingRegister | null;
  tone: GreetingTone;
}

export function effectiveOf(brief: VoiceBriefState): Effective {
  return {
    occasion: brief.occasion,
    customOccasionText: brief.customOccasionText,
    mood: brief.userOccasionRegister,
    tone: brief.tone,
  };
}

/**
 * Регистр повода в текущем (с учётом реплики) состоянии — те же сигналы,
 * что у сервиса брифа, кроме платного классификатора: выбор человека и
 * ключевые слова. Сохранённый подъём классификатором учитывается, пока
 * повод и описание прежние (тот же приём, что у экрана, этап D п. 5).
 * Классификатор может поднять регистр ещё при сохранении — тогда отказ
 * придёт от сервера брифа, и это безопасная сторона: здесь мы можем
 * пропустить лишнее, но не запретить разрешённое.
 */
export function effectiveRegister(
  brief: VoiceBriefState,
  eff: Pick<Effective, 'occasion' | 'customOccasionText' | 'mood'>,
): { register: GreetingRegister; keyword: string | null } {
  if (eff.occasion !== 'OTHER') {
    return {
      register: GREETING_OCCASION_SPECS[eff.occasion].register,
      keyword: null,
    };
  }
  const resolved = resolveOtherRegister({
    user: eff.mood,
    text: eff.customOccasionText,
  });
  const sameText =
    brief.occasion === 'OTHER' &&
    brief.customOccasionText === eff.customOccasionText;
  const register =
    sameText && brief.registerSource === 'classifier'
      ? stricterRegister(resolved.register, brief.occasionRegister)
      : resolved.register;
  return { register, keyword: resolved.keyword };
}

/**
 * Потолки текстовых полей — ТЕ ЖЕ числа, что в `UpdateGreetingBriefDto`
 * (`@Length(1, 120)`, `@Length(1, 2000)`, `MAX_CUSTOM_OCCASION_LENGTH`):
 * голос не должен принимать то, что отвергнет «Сохранить». Спек
 * прогоняет границы через настоящий DTO — разойдутся числа, упадёт он.
 * Модуль чистый (без импорта из `modules/`), поэтому числа названы здесь.
 */
export const VOICE_NAME_MAX = 120;
export const VOICE_MESSAGE_MAX = 2000;

const TEXT_MAX: Partial<Record<BriefField, number>> = {
  customOccasion: MAX_CUSTOM_OCCASION_LENGTH,
  recipient: VOICE_NAME_MAX,
  sender: VOICE_NAME_MAX,
  message: VOICE_MESSAGE_MAX,
};

function fitsText(field: BriefField, value: string): boolean {
  return value.length >= 1 && value.length <= (TEXT_MAX[field] ?? 0);
}

/** ISO-дата `YYYY-MM-DD`, существующая в календаре (не 2026-02-30). */
export function isIsoCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return (
    d.getUTCFullYear() === +m[1] &&
    d.getUTCMonth() === +m[2] - 1 &&
    d.getUTCDate() === +m[3]
  );
}

// ── Значения на экране (изменение контракта 1, аудит 30.09.2026) ────────

/**
 * Ключи тела `current` запроса разбора — значения полей брифа НА ЭКРАНЕ,
 * ещё не сохранённые. Имена — как у `UpdateGreetingBriefDto`, кроме
 * `mood` (там `occasionRegister`): это ответ человека о настроении.
 */
export const VOICE_CURRENT_FIELDS = [
  'occasion',
  'customOccasionText',
  'mood',
  'tone',
  'recipientName',
  'senderName',
  'personalMessage',
  'scriptLanguage',
  'presenterProvider',
  'resolution',
  'occasionDate',
] as const;
export type VoiceCurrentField = (typeof VOICE_CURRENT_FIELDS)[number];
export type VoiceCurrent = Partial<Record<VoiceCurrentField, string | null>>;

function inList(list: readonly string[], v: unknown): v is string {
  return typeof v === 'string' && list.includes(v);
}

/**
 * Текст в пределах `@Length(1, max)` DTO брифа — и не из одних пробелов:
 * DTO такое пропустил бы, но на экране это пустое поле, а не имя.
 */
function textWithin(v: unknown, max: number): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length >= 1 &&
    v.length >= 1 &&
    v.length <= max
  );
}

/**
 * Сохранённый бриф + значения на экране → состояние, против которого
 * проверяется реплика и которое видит модель. Ничего не сохраняется.
 *
 * Зачем: человек выбрал на экране «Особый повод» и тон «Серьёзный», но ещё
 * не сохранил — а голос проверял по сохранённому брифу: «настроение —
 * торжественное» получало отказ «только для особого повода», «веселее»
 * считалось от старого тона. Экран — то, что человек видит; сохранение —
 * отдельный шаг, и сервер брифа при нём проверит всё ещё раз.
 *
 * Правила — те же, что у `UpdateGreetingBriefDto` (списки, длины, дата):
 * клиенту здесь верить не больше, чем модели. Неверное поле
 * игнорируется, а не валит разбор: реплика важнее одного испорченного
 * значения. `null` у необязательных полей — «на экране пусто»; у
 * обязательных (повод, кому, тон, ведущий, качество) пустоты не бывает,
 * и `null` там игнорируется.
 *
 * Повод или его описание на экране другие — сохранённый подъём регистра
 * классификатором к ним не относится и сбрасывается (тот же приём, что
 * у экрана, этап D п. 5).
 */
export function overlayCurrentBrief(
  brief: VoiceBriefState,
  current: unknown,
): VoiceBriefState {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return brief;
  }
  const c = current as Record<string, unknown>;
  const has = (k: VoiceCurrentField) =>
    Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined;
  const next: VoiceBriefState = { ...brief };

  if (inList(GREETING_OCCASIONS, c.occasion)) {
    next.occasion = c.occasion as GreetingOccasion;
  }
  if (has('customOccasionText')) {
    const v = c.customOccasionText;
    if (v === null || v === '') next.customOccasionText = null;
    else if (textWithin(v, MAX_CUSTOM_OCCASION_LENGTH)) {
      next.customOccasionText = v;
    }
  }
  if (has('mood')) {
    const v = c.mood;
    if (v === null || v === '') next.userOccasionRegister = null;
    else if (inList(GREETING_REGISTERS, v)) {
      next.userOccasionRegister = v as GreetingRegister;
    }
  }
  if (inList(GREETING_TONES, c.tone)) next.tone = c.tone as GreetingTone;
  if (textWithin(c.recipientName, VOICE_NAME_MAX)) {
    next.recipientName = c.recipientName;
  }
  if (has('senderName')) {
    const v = c.senderName;
    if (v === null || v === '') next.senderName = null;
    else if (textWithin(v, VOICE_NAME_MAX)) next.senderName = v;
  }
  if (has('personalMessage')) {
    const v = c.personalMessage;
    if (v === null || v === '') next.personalMessage = null;
    else if (textWithin(v, VOICE_MESSAGE_MAX)) next.personalMessage = v;
  }
  if (has('scriptLanguage')) {
    const v = c.scriptLanguage;
    if (v === null || v === '') next.scriptLanguage = null;
    else if (typeof v === 'string' && isSupportedLocale(v)) {
      next.scriptLanguage = v;
    }
  }
  if (inList(GREETING_PRESENTER_PROVIDERS, c.presenterProvider)) {
    next.presenterProvider = c.presenterProvider;
  }
  if (inList(GREETING_RESOLUTIONS, c.resolution)) {
    next.resolution = c.resolution;
  }
  if (has('occasionDate')) {
    const v = c.occasionDate;
    if (v === null || v === '') next.occasionDate = null;
    else if (
      typeof v === 'string' &&
      /^\d{4}-\d{2}-\d{2}(T[^\s]*)?$/.test(v) &&
      isIsoCalendarDate(v.slice(0, 10))
    ) {
      next.occasionDate = v.slice(0, 10);
    }
  }

  if (
    next.occasion !== brief.occasion ||
    next.customOccasionText !== brief.customOccasionText
  ) {
    next.occasionRegister = null;
    next.registerSource = null;
  }
  return next;
}

const RESOLUTION_RANK: Readonly<Record<string, number>> = {
  '480p': 0,
  '720p': 1,
  '1080p': 2,
};

export type FieldCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Проверка одного значения против ДОСТУПНОГО в состоянии `eff`. Причина
 * отказа — на языке реплики и теми же словами, что на экране.
 */
export function validateField(
  field: BriefField,
  rawValue: string,
  ctx: VoiceUnderstandContext,
  eff: Effective,
): FieldCheck {
  const loc = ctx.replyLocale;
  const name = FIELD_NAMES[loc][field];
  const t = REPLIES[loc];
  const value = rawValue.trim();
  const listValue = value.toUpperCase();

  switch (field) {
    case 'occasion':
      return (GREETING_OCCASIONS as readonly string[]).includes(listValue)
        ? { ok: true, value: listValue }
        : { ok: false, reason: t.noSuchOption(name) };
    case 'customOccasion':
    case 'mood': {
      if (eff.occasion !== 'OTHER') {
        return {
          ok: false,
          reason: t.onlyForOther(name, OCCASION_LABELS[loc].OTHER),
        };
      }
      if (field === 'mood') {
        return (GREETING_REGISTERS as readonly string[]).includes(listValue)
          ? { ok: true, value: listValue }
          : { ok: false, reason: t.noSuchOption(name) };
      }
      return fitsText(field, value)
        ? { ok: true, value }
        : { ok: false, reason: t.tooLong(name) };
    }
    case 'tone': {
      if (!(GREETING_TONES as readonly string[]).includes(listValue)) {
        return { ok: false, reason: t.noSuchOption(name) };
      }
      const tone = listValue as GreetingTone;
      const { register } = effectiveRegister(ctx.brief, eff);
      if (!tonesFor(eff.occasion, register).includes(tone)) {
        return {
          ok: false,
          reason: `«${TONE_LABELS[loc][tone]}» — ${TONE_UNAVAILABLE[loc]}.`,
        };
      }
      return { ok: true, value: tone };
    }
    case 'recipient':
    case 'sender': {
      if (!fitsText(field, value)) {
        return { ok: false, reason: t.tooLong(name) };
      }
      // Имя в ответе сверяется с брифом и не подменяет его написание
      // (§4А.3, строка «Имена»): «марина» при «Марина» в брифе — то же
      // имя, и карточка покажет написание брифа.
      const current =
        field === 'recipient' ? ctx.brief.recipientName : ctx.brief.senderName;
      if (current && current.toLowerCase() === value.toLowerCase()) {
        return { ok: true, value: current };
      }
      return { ok: true, value };
    }
    case 'message':
      return fitsText(field, value)
        ? { ok: true, value }
        : { ok: false, reason: t.tooLong(name) };
    case 'scriptLanguage': {
      const code = value.toLowerCase();
      return isSupportedLocale(code)
        ? { ok: true, value: code }
        : { ok: false, reason: t.noSuchOption(name) };
    }
    case 'presenter': {
      const p = value.toLowerCase();
      if (!(GREETING_PRESENTER_PROVIDERS as readonly string[]).includes(p)) {
        return { ok: false, reason: t.noSuchOption(name) };
      }
      if (!ctx.presenters.includes(p as GreetingPresenterProvider)) {
        return {
          ok: false,
          reason: `${PRESENTER_HEDRA_LABEL[loc]}: ${HEDRA_PREMIUM_ONLY[loc]}.`,
        };
      }
      return { ok: true, value: p };
    }
    case 'resolution': {
      const r = value.toLowerCase();
      if (!(GREETING_RESOLUTIONS as readonly string[]).includes(r)) {
        return { ok: false, reason: t.noSuchOption(name) };
      }
      const cap = ctx.maxResolution;
      if (RESOLUTION_RANK[r] > RESOLUTION_RANK[cap]) {
        return { ok: false, reason: t.resolutionAbovePlan(r, cap) };
      }
      return { ok: true, value: r };
    }
    case 'date':
      return isIsoCalendarDate(value)
        ? { ok: true, value }
        : { ok: false, reason: t.badDate(name) };
  }
}

export function applyToEffective(
  eff: Effective,
  field: BriefField,
  value: string,
) {
  if (field === 'occasion') eff.occasion = value as GreetingOccasion;
  if (field === 'customOccasion') eff.customOccasionText = value;
  if (field === 'mood') eff.mood = value as GreetingRegister;
  if (field === 'tone') eff.tone = value as GreetingTone;
}

// ── Проверка элементов сессии (K5) ──────────────────────────────────────

export type SessionFieldCheck =
  | { ok: true; value: string | boolean }
  | { ok: false; reason: string };

/** Порядок проверки: сначала бриф (как в волне 1), затем сессия по каталогу. */
export function orderOf(field: VoiceFieldKey): number {
  return isSessionField(field)
    ? VALIDATION_ORDER.length + SESSION_FIELDS.indexOf(field)
    : VALIDATION_ORDER.indexOf(field);
}

/**
 * Противоречие внутри одной реплики — не применяется ни одна из сторон,
 * помощник называет его противоречием (§4А.7.1: неоднозначное не
 * применяется). Два вида, оба — на ОДНОЙ карточке:
 *
 * - «без музыки, тема — Вальс»: галочка «выключи» и выбор варианта;
 * - «голос Ara и мой клон»: два РАЗНЫХ списка одной карточки — выбрать
 *   можно только один (пресет гасит клон и наоборот,
 *   `GreetingVoiceService.select`/`selectPreset`).
 */
export function conflictingSessionFields(
  fields: readonly ModelField[],
): Set<VoiceFieldKey> {
  const out = new Set<VoiceFieldKey>();
  for (const a of fields) {
    if (!isSessionField(a.field)) continue;
    const specA = SESSION_FIELD_HOOKS[a.field];
    for (const b of fields) {
      if (b === a || !isSessionField(b.field) || b.field === a.field) continue;
      const specB = SESSION_FIELD_HOOKS[b.field];
      if (specB.card !== specA.card || specB.kind !== 'list') continue;
      const offAndPick = specA.kind === 'toggle' && a.value === false;
      const twoLists = specA.kind === 'list';
      if (offAndPick || twoLists) {
        out.add(a.field);
        out.add(b.field);
      }
    }
  }
  return out;
}

/**
 * Вариант списка по коду ИЛИ по названию на экране (без регистра):
 * модель слышит «Вальс», а не `theme_waltz`. Два варианта с одним
 * названием — не угадываем (`null`).
 */
function pickOption<T extends { id: string }>(
  options: readonly T[],
  value: string,
  nameOf: (o: T) => string,
): T | null {
  const v = value.trim().toLowerCase();
  const byId = options.filter((o) => o.id.toLowerCase() === v);
  if (byId.length === 1) return byId[0];
  const byName = options.filter((o) => nameOf(o).trim().toLowerCase() === v);
  return byName.length === 1 ? byName[0] : null;
}

function fitsLength(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max;
}

/**
 * Проверка элемента сессии против ТЕКУЩЕГО состояния (`ctx.session`).
 * Карточки нет на экране — элемента нет и голосом; список — только из
 * вариантов, которые экран сейчас показывает; галочка — «выключи» так же
 * выполнимо, как «включи», а «включи» без названного варианта не
 * угадывается.
 */
export function validateSessionField(
  field: SessionField,
  value: string | boolean,
  ctx: VoiceUnderstandContext,
): SessionFieldCheck {
  const loc = ctx.replyLocale;
  const t = REPLIES[loc];
  const name = SESSION_FIELD_NAMES[loc][field];
  const screen = SESSION_SCREEN_LABELS[loc];
  const spec = SESSION_FIELD_HOOKS[field];

  if (ctx.scope !== 'session') return { ok: false, reason: t.needSession };
  // Блок «Характер ролика» и поле правки появляются вместе со сценарием —
  // причина та же, что написана на экране сценария.
  if (spec.card !== 'greeting-references-card' && !ctx.hasScript) {
    return { ok: false, reason: `${name}: ${screen.scriptEmpty}` };
  }
  if (!sessionCardShown(field, ctx)) {
    return { ok: false, reason: t.notOnScreen(name) };
  }
  // Вид значения — по каталогу: галочке строка не годится, полю — `true`.
  if ((spec.kind === 'toggle') !== (typeof value === 'boolean')) {
    return { ok: false, reason: t.noSuchOption(name) };
  }
  const s = ctx.session!;
  const text = typeof value === 'string' ? value.trim() : '';

  switch (field) {
    case 'referenceLabel':
    case 'referenceDescription': {
      // После сборки сценария фото заперты — экран говорит это баннером.
      if (ctx.hasScript) {
        return { ok: false, reason: screen.referencesLockedHint };
      }
      const max =
        field === 'referenceLabel'
          ? VOICE_REFERENCE_LABEL_MAX
          : VOICE_REFERENCE_DESCRIPTION_MAX;
      return fitsLength(text, max)
        ? { ok: true, value: text }
        : { ok: false, reason: t.tooLong(name) };
    }
    case 'scriptText': {
      if (!fitsLength(text, VOICE_SCRIPT_MAX)) {
        return { ok: false, reason: t.tooLong(name) };
      }
      // Та же проверка, что у «Сохранить» (`updateScript`): чужой образ
      // отклоняется сразу — карточка, заведомо обречённая на отказ,
      // только отняла бы у человека «Да».
      const likeness = findCelebrityLikeness(text);
      if (likeness) {
        return { ok: false, reason: t.celebrity(name, likeness.fragment) };
      }
      return { ok: true, value: text };
    }
    case 'voicePreset': {
      const v = s.voice!;
      const p = pickOption(v.presets, text, (o) => o.name);
      if (!p) return { ok: false, reason: t.noSuchOption(name) };
      // Сервис хранит id в нижнем регистре (`selectPreset`), роестр
      // провайдера — как отдал; сравниваем без регистра.
      if (v.presetVoiceId?.toLowerCase() === p.id.toLowerCase()) {
        return { ok: false, reason: t.alreadySelected(name, p.name) };
      }
      return { ok: true, value: p.id };
    }
    case 'voiceClone': {
      const v = s.voice!;
      const c = pickOption(v.clones, text, (o) => o.label);
      if (!c) return { ok: false, reason: t.noSuchOption(name) };
      if (v.cloneId === c.id) {
        return { ok: false, reason: t.alreadySelected(name, c.label) };
      }
      return { ok: true, value: c.id };
    }
    case 'voiceCustom': {
      const v = s.voice!;
      const chosen = !!(v.presetVoiceId || v.cloneId);
      if (value === false) {
        return chosen
          ? { ok: true, value: false }
          : { ok: false, reason: t.alreadyOff(name) };
      }
      if (chosen) return { ok: false, reason: t.alreadyOn(name) };
      return {
        ok: false,
        reason: t.chooseVariant(name, [
          ...v.clones.map((o) => o.label),
          ...v.presets.map((o) => o.name),
        ]),
      };
    }
    case 'musicTheme': {
      const m = s.music!;
      const theme = pickOption(m.themes, text, (o) => o.title);
      if (!theme) return { ok: false, reason: t.noSuchOption(name) };
      if (m.selectedId === theme.id) {
        return { ok: false, reason: t.alreadySelected(name, theme.title) };
      }
      return { ok: true, value: theme.id };
    }
    case 'musicEnabled': {
      const m = s.music!;
      if (value === false) {
        return m.hasSelection
          ? { ok: true, value: false }
          : { ok: false, reason: t.alreadyOff(name) };
      }
      if (m.hasSelection) return { ok: false, reason: t.alreadyOn(name) };
      return {
        ok: false,
        reason: t.chooseVariant(
          name,
          m.themes.map((o) => o.title),
        ),
      };
    }
    case 'musicQuery': {
      // Поиска в библиотеке нет на экране без настроенного источника.
      if (!s.music!.libraryEnabled) {
        return { ok: false, reason: t.notOnScreen(name) };
      }
      return fitsLength(text, VOICE_SEARCH_QUERY_MAX)
        ? { ok: true, value: text }
        : { ok: false, reason: t.tooLong(name) };
    }
    case 'cardsTitle':
    case 'cardsClosing': {
      // Пустое — «убрать подпись»: так же, как стереть поле руками.
      const clean = text.replace(/\s+/g, ' ');
      if (clean.length > MAX_CARD_TEXT_LENGTH) {
        return { ok: false, reason: t.tooLong(name) };
      }
      // Тот же фильтр, что у сохранения карточек (`GreetingCardsService`).
      if (clean && findModerationFlags(clean).length) {
        return { ok: false, reason: t.moderation(name) };
      }
      const current =
        field === 'cardsTitle' ? s.cards!.title : s.cards!.closing;
      if ((current ?? '') === clean) {
        return clean
          ? { ok: false, reason: t.alreadySelected(name, clean) }
          : { ok: false, reason: t.alreadyOff(name) };
      }
      return { ok: true, value: clean };
    }
    case 'stickerQuery': {
      const st = s.sticker!;
      if (!st.allowed) {
        return { ok: false, reason: screen.stickerUnavailable };
      }
      if (!st.configured) return { ok: false, reason: t.notOnScreen(name) };
      return fitsLength(text, VOICE_SEARCH_QUERY_MAX)
        ? { ok: true, value: text }
        : { ok: false, reason: t.tooLong(name) };
    }
    case 'stickerPlacement': {
      const st = s.sticker!;
      const p = text.toLowerCase();
      if (!(STICKER_PLACEMENTS as readonly string[]).includes(p)) {
        return { ok: false, reason: t.noSuchOption(name) };
      }
      // Кнопки места есть только у выбранной наклейки.
      if (!st.selected) {
        return {
          ok: false,
          reason: t.notOnScreen(name),
        };
      }
      if (st.placement === p) {
        return { ok: false, reason: t.alreadySelected(name, p) };
      }
      return { ok: true, value: p };
    }
    case 'stickerEnabled': {
      const st = s.sticker!;
      if (value === false) {
        return st.selected
          ? { ok: true, value: false }
          : { ok: false, reason: t.alreadyOff(name) };
      }
      if (st.selected) return { ok: false, reason: t.alreadyOn(name) };
      if (!st.allowed) {
        return { ok: false, reason: screen.stickerUnavailable };
      }
      return { ok: false, reason: t.stickerByHand(name) };
    }
    case 'scenesCount': {
      const sc = s.scenes!;
      if (!/^\d{1,2}$/.test(text)) {
        return { ok: false, reason: t.noSuchOption(name) };
      }
      const n = Number(text);
      // Потолок — из представления карточки (`maxScenes` уже учитывает
      // регистр повода): экран больше кнопок не рисует.
      if (n < 1 || n > sc.maxScenes) {
        return { ok: false, reason: t.scenesMax(name, sc.maxScenes) };
      }
      if (n === sc.sceneCount) {
        return { ok: false, reason: t.alreadySelected(name, text) };
      }
      return { ok: true, value: text };
    }
  }
}

// ── Команды ─────────────────────────────────────────────────────────────

/**
 * «Лёгкость» тона: серьёзнее — вниз по шкале, легче — вверх. Два тона на
 * одной ступени (официальный и уважительный) — одинаково сдержанные.
 */
const TONE_LIGHTNESS: Readonly<Record<GreetingTone, number>> = {
  FORMAL: 0,
  RESPECTFUL: 0,
  SUPPORTIVE: 1,
  WARM: 1,
  FUNNY: 2,
};

type CommandCheck =
  | { ok: true; args?: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Команда → действие мастера, которое уже существует (§4А.2 п.4). Тоновые
 * команды сразу называют ЦЕЛЕВОЙ тон из доступных регистру; запрещённое
 * политикой («смешнее» на соболезновании) получает тот же отказ, что и
 * кнопка.
 */
export function checkCommand(
  command: VoiceCommand,
  ctx: VoiceUnderstandContext,
): CommandCheck {
  const loc = ctx.replyLocale;
  const t = REPLIES[loc];
  const eff = effectiveOf(ctx.brief);
  const { register } = effectiveRegister(ctx.brief, eff);
  const allowed = tonesFor(eff.occasion, register);
  const current = eff.tone;
  const rank = TONE_LIGHTNESS[current];

  switch (command) {
    case 'tone-serious': {
      const lower = allowed.filter((x) => TONE_LIGHTNESS[x] < rank);
      if (lower.length === 0) return { ok: false, reason: t.toneMostSerious };
      const best = Math.max(...lower.map((x) => TONE_LIGHTNESS[x]));
      return {
        ok: true,
        args: { tone: lower.find((x) => TONE_LIGHTNESS[x] === best)! },
      };
    }
    case 'tone-lighter': {
      // «Веселее» — только к тёплому или шутливому: переход от
      // уважительного к поддерживающему на соболезновании «веселее» не
      // делает, и ТЗ (§4А.2 п.4) требует здесь отказа, а не подмены.
      const higher = allowed.filter(
        (x) => TONE_LIGHTNESS[x] > rank && (x === 'WARM' || x === 'FUNNY'),
      );
      if (higher.length === 0) {
        // Легче некуда: либо уже самый лёгкий, либо лёгкий тон запрещён
        // регистром — тогда причина та же, что на экране у серой кнопки.
        return current === 'FUNNY'
          ? { ok: false, reason: t.toneMostLight }
          : {
              ok: false,
              reason: `«${TONE_LABELS[loc].FUNNY}» — ${TONE_UNAVAILABLE[loc]}.`,
            };
      }
      const best = Math.min(...higher.map((x) => TONE_LIGHTNESS[x]));
      return {
        ok: true,
        args: { tone: higher.find((x) => TONE_LIGHTNESS[x] === best)! },
      };
    }
    case 'no-jokes': {
      if (current !== 'FUNNY') return { ok: false, reason: t.noJokesAlready };
      const fallback = allowed.find((x) => x !== 'FUNNY');
      return fallback
        ? { ok: true, args: { tone: fallback } }
        : { ok: false, reason: t.noJokesAlready };
    }
    case 'shorter':
    case 'regenerate-script':
    case 'other-music': {
      if (ctx.scope !== 'session') return { ok: false, reason: t.needSession };
      if (command !== 'regenerate-script' && !ctx.hasScript) {
        return { ok: false, reason: t.needScript };
      }
      // «Короче» — честный отказ (аудит волны K, B1): кнопки «сократить»
      // в мастере нет, а обещать действие, которого клиент не выполнит,
      // хуже, чем сказать, как сделать это руками.
      if (command === 'shorter') {
        return { ok: false, reason: t.shorterByHand };
      }
      return { ok: true };
    }
  }
}
