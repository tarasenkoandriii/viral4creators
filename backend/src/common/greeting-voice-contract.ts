/**
 * Контракт голосового разбора мастера поздравления: пороги уверенности,
 * форма ответа, каталоги хуков (бриф и элементы сессии), потолки полей,
 * состояние, против которого проверяется реплика.
 *
 * Отдельный модуль — потому что это «словарь», от которого зависят все
 * остальные части разбора (`greeting-voice-phrases`, `-validate`,
 * `-prompt`, ядро `greeting-voice-intent`), а сам он не зависит ни от
 * одной из них: так зависимости идут в одну сторону и цикла импортов нет.
 * Снаружи всё это по-прежнему берут из `greeting-voice-intent.ts` —
 * он реэкспортирует каждое имя (клиентские зеркала и тесты
 * `frontend/scripts/voice-*.test.ts` импортируют именно его).
 */

import {
  GreetingBriefSnapshot,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingRegister,
  GreetingResolution,
  GreetingTone,
} from './types/greeting.types';
import { storedUserRegister } from './greeting-policy';
import {
  SUPPORTED_LOCALES,
  SupportedLocale,
  isSupportedLocale,
} from './locale';
import {
  BRIEF_FIELD_LABELS,
  SESSION_SCREEN_LABELS,
} from './greeting-voice-intent-labels';

// ── Пороги ──────────────────────────────────────────────────────────────

/**
 * Уверенность, ниже которой поле не попадает в карточку, а помощник
 * переспрашивает (§4А.7.1). Ошибка здесь стоит одного переспроса: поле
 * всё равно подтверждается «Да».
 */
export const FIELD_CONFIDENCE_MIN = 0.6;

/**
 * Порог согласия на генерацию (§4А.7.4) — выше, чем у полей: ошибка в
 * имени стоит переспроса, ошибка здесь — списанного кредита.
 */
export const CONSENT_CONFIDENCE_MIN = 0.85;

// ── Контракт ответа (зеркало — `frontend/src/lib/voice-types.ts`) ──────

/**
 * Статусы ответа — массивом, а не только союзом типов: клиентский тест
 * сверяет своё зеркало с этим списком перебором (тип при сборке
 * исчезает, массив — нет).
 */
export const VOICE_STATUSES = [
  'ok',
  'not-heard',
  'unavailable',
  'budget-exhausted',
] as const;
export type VoiceStatus = (typeof VOICE_STATUSES)[number];

/**
 * Причина отказа (изменение контракта 2 по финальному аудиту 30.09.2026).
 * `status` говорит «что делать с репликой», `reason` — «что делать с
 * микрофоном»: оператор выключил голос, нужен вход или исчерпан лимит
 * аккаунта — слушать дальше бессмысленно до нажатия; слишком длинная
 * фраза — отказ одной реплике, слушать дальше можно.
 */
export const VOICE_REASONS = [
  'operator-off',
  'login-required',
  'account-limit',
  'too-long',
] as const;
export type VoiceReason = (typeof VOICE_REASONS)[number];

/**
 * Потолок длины реплики и байт записи по типу (изменение контракта 4) —
 * живут рядом с правилами распознавания (`greeting-voice.ts`), здесь —
 * для зеркала клиента: все константы контракта из одного файла.
 */
export {
  GREETING_VOICE_MAX_BYTES,
  VOICE_UTTERANCE_MAX_MS,
  greetingVoiceMaxBytesFor,
} from './greeting-voice';

export interface VoiceField {
  /** `data-qa` хук поля. */
  target: string;
  /** Список — код варианта, дата — ISO `YYYY-MM-DD`, текст — строка. */
  value: string | boolean;
  /** Подпись поля для карточки — на языке интерфейса. */
  label: string;
}

export const VOICE_COMMANDS = [
  'tone-serious',
  'tone-lighter',
  'no-jokes',
  'shorter',
  'regenerate-script',
  'other-music',
] as const;
export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

export const VOICE_NAVIGATE_TARGETS = [
  'next',
  'back',
  'brief',
  'references',
  'script',
  'video',
] as const;
export type VoiceNavigateTarget = (typeof VOICE_NAVIGATE_TARGETS)[number];

export type VoiceIntent =
  | { kind: 'fill'; fields: VoiceField[] }
  | { kind: 'command'; command: VoiceCommand; args?: Record<string, string> }
  | { kind: 'navigate'; to: VoiceNavigateTarget }
  | { kind: 'help' }
  | { kind: 'consent'; phrase: string }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'unknown' };

export interface VoiceUnderstandResult {
  status: VoiceStatus;
  transcript: string | null;
  language: string | null;
  intent: VoiceIntent | null;
  confidence: number;
  reply: string | null;
  scriptMismatch: boolean;
  /** Причина отказа; `null` (или нет поля), когда отказа нет. */
  reason?: VoiceReason | null;
}

export const VOICE_SCREEN_STEPS = [
  'brief',
  'references',
  'script',
  'video',
] as const;
export type VoiceScreenStep = (typeof VOICE_SCREEN_STEPS)[number];

export interface VoicePending {
  kind: 'fill';
  fields: Array<{ target: string; value: string | boolean; label?: string }>;
}

// ── Поля брифа ──────────────────────────────────────────────────────────

/** Хуки полей брифа — имена фиксированы контрактом волны K. */
export const BRIEF_FIELD_HOOKS = {
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
export type BriefField = keyof typeof BRIEF_FIELD_HOOKS;

export const BRIEF_FIELDS = Object.keys(BRIEF_FIELD_HOOKS) as BriefField[];

/**
 * Порядок проверки: сначала то, от чего зависит доступность остального.
 * Тон проверяется ПОСЛЕ повода и настроения из той же реплики —
 * «повод соболезнование, тон с юмором» обязан получить отказ по тону,
 * хотя в сохранённом брифе повод ещё день рождения.
 */
export const VALIDATION_ORDER: readonly BriefField[] = [
  'occasion',
  'customOccasion',
  'mood',
  'tone',
  'recipient',
  'sender',
  'message',
  'scriptLanguage',
  'presenter',
  'resolution',
  'date',
];

/** Поле по хуку или по короткому имени — модель пишет то одно, то другое. */
export function briefFieldOf(target: unknown): BriefField | null {
  if (typeof target !== 'string') return null;
  const t = target.trim();
  for (const f of BRIEF_FIELDS) {
    if (t === f || t === BRIEF_FIELD_HOOKS[f]) return f;
  }
  return null;
}

/** Ключ подписи поля в словаре фронтенда (`greetingVideoWizard`). */
const FIELD_LABEL_KEYS: Readonly<Record<BriefField, string>> = {
  occasion: 'occasionLabel',
  customOccasion: 'customOccasionLabel',
  mood: 'moodLabel',
  recipient: 'recipientNameLabel',
  sender: 'senderNameLabel',
  tone: 'toneLabel',
  message: 'personalMessageLabel',
  scriptLanguage: 'scriptLanguageLabel',
  presenter: 'presenterProviderLabel',
  resolution: 'resolutionLabel',
  date: 'occasionDateLabel',
};

/**
 * Подпись над полем → название поля для карточки и переспроса: без
 * пометки «(необязательно)» и без знаков вопроса — «Не расслышал: От кого»,
 * а не «Не расслышал: От кого (необязательно)».
 */
export function fieldTitle(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[¿?]/g, '')
    .trim();
}

/**
 * Названия полей: подпись карточки и переспрос («не расслышал: Кому»).
 * Выводятся из ТЕХ ЖЕ подписей, что стоят над полями на экране (копия
 * словаря, сверяемая спеком), — второго набора слов, который разошёлся
 * бы с экраном, нет (аудит волны K).
 */
export const FIELD_NAMES: Readonly<
  Record<SupportedLocale, Readonly<Record<BriefField, string>>>
> = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [
    l,
    Object.fromEntries(
      BRIEF_FIELDS.map((f) => [
        f,
        fieldTitle(BRIEF_FIELD_LABELS[l][FIELD_LABEL_KEYS[f]]),
      ]),
    ),
  ]),
) as Record<SupportedLocale, Record<BriefField, string>>;

// ── Элементы сессии (K5, §4А.7.1) ───────────────────────────────────────

/**
 * Три вида элементов — три вида команд (§4А.7.1), и различает их сервер:
 *
 * - `field` — текст уходит в поле как есть (правила длины не ослабляются);
 * - `list` — значение только из ДОСТУПНЫХ вариантов текущего состояния;
 * - `toggle` — два исхода, «выключи» выполнимо так же, как «включи».
 */
export type SessionFieldKind = 'field' | 'list' | 'toggle';

export interface SessionFieldHookSpec {
  /** `data-qa` элемента — тот же, что адресуют сценарии обучалки. */
  hook: string;
  /** `data-qa` карточки, на которой элемент живёт. */
  card: string;
  kind: SessionFieldKind;
  /** Что лежит в `VoiceField.value` — для E, промпта и описаний хуков. */
  domain: string;
}

/**
 * Каталог голосовых целей мастера ПОСЛЕ старта сессии (K5). Имена —
 * `greeting-<карточка>-<элемент>`; E ставит их как `data-qa` в разметку,
 * qa-hooks объявляет их для обучалки, шов сверяет обе стороны.
 *
 * Решения, которые здесь зашиты (и почему):
 *
 * - **Текст сценария** — существующий хук `greeting-script-edit`, а не
 *   новый: у одного `<textarea>` один `data-qa`, и обучалка уже его
 *   адресует. Голос кладёт ПОЛНЫЙ текст в поле правки — не дописывает и
 *   не сохраняет: сохраняет человек той же кнопкой, и сервер проверяет
 *   текст тем же путём правки сценария (модерация, регистр, версия).
 * - **Выбор, у которого есть «снять»** (голос, музыка, наклейка), —
 *   список плюс галочка. Галочка «выключи» снимает выбор; «включи» без
 *   названного варианта НЕ угадывает вариант, а переспрашивает с
 *   перечнем доступного (неоднозначное не применяется, §4А.7.1). Уже
 *   включённое/выключенное — не ошибка, а спокойное «уже».
 * - **Поиск наклейки и музыки** — голос может заполнить ТОЛЬКО строку
 *   поиска (бесплатно, ничего не меняет в ролике); искать и выбирать
 *   картинку/трек — руками: результатов поиска сервер разбора не видит.
 * - **Подпись и описание фото** — поля ОТКРЫТОЙ формы (добавление или
 *   правка кадра). Кнопки «нарисовать кадр» и «предложить сеттинг» —
 *   платные действия, а не поля: голосом не нажимаются.
 * - **Не адресуются голосом сознательно:** галочка подтверждения прав на
 *   свою музыку и запись/согласие клона голоса — юридические заявления
 *   человека о себе (как согласие на клон, §4А.7.4 по духу), ссылка на
 *   трек (URL на слух не диктуют), выбор файла.
 */
export const SESSION_FIELD_HOOKS = {
  referenceLabel: {
    hook: 'greeting-references-label',
    card: 'greeting-references-card',
    kind: 'field',
    domain: 'подпись кадра в открытой форме (добавление/правка), 1–80 символов',
  },
  referenceDescription: {
    hook: 'greeting-references-description',
    card: 'greeting-references-card',
    kind: 'field',
    domain: 'описание кадра в открытой форме, 1–2000 символов',
  },
  scriptText: {
    hook: 'greeting-script-edit',
    card: 'greeting-script-card',
    kind: 'field',
    domain:
      'ПОЛНЫЙ текст поздравления в поле правки (замена, не дописывание), 1–2000 символов; сохраняет человек кнопкой',
  },
  voicePreset: {
    hook: 'greeting-voice-preset',
    card: 'greeting-voice-card',
    kind: 'list',
    domain: 'voiceId голоса модели из списка пресетов сессии',
  },
  voiceClone: {
    hook: 'greeting-voice-clone',
    card: 'greeting-voice-card',
    kind: 'list',
    domain: 'resembleVoiceId своего готового клона голоса',
  },
  voiceCustom: {
    hook: 'greeting-voice-custom',
    card: 'greeting-voice-card',
    kind: 'toggle',
    domain:
      'false — голос по умолчанию (снять выбранный); true без варианта — переспрос',
  },
  musicTheme: {
    hook: 'greeting-music-theme',
    card: 'greeting-music-card',
    kind: 'list',
    domain: 'id темы из каталога, доступного поводу сессии',
  },
  musicEnabled: {
    hook: 'greeting-music-enabled',
    card: 'greeting-music-card',
    kind: 'toggle',
    domain: 'false — без музыки (снять); true без темы — переспрос',
  },
  musicQuery: {
    hook: 'greeting-music-query',
    card: 'greeting-music-card',
    kind: 'field',
    domain:
      'строка поиска в библиотеке музыки, 1–100 символов (без запуска поиска)',
  },
  cardsTitle: {
    hook: 'greeting-cards-title',
    card: 'greeting-cards-card',
    kind: 'field',
    domain: 'текст титульной карточки, до 70 символов; пустая строка — убрать',
  },
  cardsClosing: {
    hook: 'greeting-cards-closing',
    card: 'greeting-cards-card',
    kind: 'field',
    domain:
      'текст закрывающей карточки, до 70 символов; пустая строка — убрать',
  },
  stickerQuery: {
    hook: 'greeting-sticker-query',
    card: 'greeting-sticker-card',
    kind: 'field',
    domain: 'строка поиска наклейки, 1–100 символов (без запуска поиска)',
  },
  stickerPlacement: {
    hook: 'greeting-sticker-placement',
    card: 'greeting-sticker-card',
    kind: 'list',
    domain:
      'top-left | top-right | bottom-left | bottom-right | center | full (только при выбранной наклейке)',
  },
  stickerEnabled: {
    hook: 'greeting-sticker-enabled',
    card: 'greeting-sticker-card',
    kind: 'toggle',
    domain: 'false — без наклейки (снять); true без картинки — переспрос',
  },
  scenesCount: {
    hook: 'greeting-scenes-count',
    card: 'greeting-scenes-card',
    kind: 'list',
    domain: "число сцен строкой '1'..'maxScenes' сессии",
  },
} as const satisfies Record<string, SessionFieldHookSpec>;

export type SessionField = keyof typeof SESSION_FIELD_HOOKS;
export const SESSION_FIELDS = Object.keys(
  SESSION_FIELD_HOOKS,
) as SessionField[];

/** Любая цель голоса: поле брифа или элемент сессии. */
export type VoiceFieldKey = BriefField | SessionField;

/** Элемент сессии по хуку или по короткому имени. */
export function sessionFieldOf(target: unknown): SessionField | null {
  if (typeof target !== 'string') return null;
  const t = target.trim();
  for (const f of SESSION_FIELDS) {
    if (t === f || t === SESSION_FIELD_HOOKS[f].hook) return f;
  }
  return null;
}

export function voiceFieldOf(target: unknown): VoiceFieldKey | null {
  return briefFieldOf(target) ?? sessionFieldOf(target);
}

export function isSessionField(key: VoiceFieldKey): key is SessionField {
  return Object.prototype.hasOwnProperty.call(SESSION_FIELD_HOOKS, key);
}

export function hookOf(key: VoiceFieldKey): string {
  return isSessionField(key)
    ? SESSION_FIELD_HOOKS[key].hook
    : BRIEF_FIELD_HOOKS[key];
}

/**
 * Названия элементов сессии — из ТЕХ ЖЕ подписей, что на экране
 * (`SESSION_SCREEN_LABELS`, копия словаря под спеком). Где у элемента
 * своей подписи нет (строка поиска, место наклейки), имя составлено из
 * заголовка карточки и надписи на кнопке рядом: «Наклейка: Найти».
 */
function sessionNamesFor(l: SupportedLocale): Record<SessionField, string> {
  const s = SESSION_SCREEN_LABELS[l];
  const title = (k: string) => fieldTitle(s[k]).replace(/[:：]\s*$/, '');
  return {
    referenceLabel: title('referenceLabelLabel'),
    referenceDescription: title('referenceDescLabel'),
    scriptText: title('editScriptLabel'),
    voicePreset: title('senderVoiceHeading'),
    voiceClone: title('senderVoiceHeading'),
    voiceCustom: title('senderVoiceHeading'),
    musicTheme: title('musicHeading'),
    musicEnabled: title('musicHeading'),
    musicQuery: `${title('musicHeading')}: ${title('musicLibrarySearch')}`,
    cardsTitle: `${title('cardsHeading')}: ${title('cardsTitleLabel')}`,
    cardsClosing: `${title('cardsHeading')}: ${title('cardsClosingLabel')}`,
    stickerQuery: `${title('stickerHeading')}: ${title('stickerSearch')}`,
    stickerPlacement: `${title('stickerHeading')}: ${title('stickerPicked')}`,
    stickerEnabled: title('stickerHeading'),
    scenesCount: title('scenesHeading'),
  };
}

export const SESSION_FIELD_NAMES: Readonly<
  Record<SupportedLocale, Readonly<Record<SessionField, string>>>
> = Object.fromEntries(
  SUPPORTED_LOCALES.map((l) => [l, sessionNamesFor(l)]),
) as Record<SupportedLocale, Record<SessionField, string>>;

/** Название любой цели — для карточки и переспроса. */
export function fieldNameOf(loc: SupportedLocale, key: VoiceFieldKey): string {
  return isSessionField(key)
    ? SESSION_FIELD_NAMES[loc][key]
    : FIELD_NAMES[loc][key];
}

/**
 * Потолки полей сессии — ТЕ ЖЕ числа, что у DTO и сервисов, которые
 * сохранят значение после «Да» (спек прогоняет границы через настоящие
 * DTO и сверяет с константами сервисов). Модуль чистый — числа названы
 * здесь, а не импортированы из `modules/`.
 */
/** `GreetingReferenceUploadRequestDto.label` / `UpdateRequestDto.label`: `@Length(1, 80)`. */
export const VOICE_REFERENCE_LABEL_MAX = 80;
/** `…description`: `@Length(1, 2000)`. */
export const VOICE_REFERENCE_DESCRIPTION_MAX = 2000;
/** `MAX_GREETING_SPEECH_LENGTH` правки сценария. */
export const VOICE_SCRIPT_MAX = 2000;
/** Строка поиска наклейки и музыки: `@MaxLength(100)` у обоих DTO. */
export const VOICE_SEARCH_QUERY_MAX = 100;

/** Поля, у которых пустое значение осмысленно: «убери подпись в начале». */
export const CLEARABLE_SESSION_FIELDS: ReadonlySet<SessionField> = new Set([
  'cardsTitle',
  'cardsClosing',
]);

// ── Состояние сессии для голоса (K5) ────────────────────────────────────

/**
 * То, что сейчас на экране у элементов сессии, — собрано сервисом из
 * ТЕХ ЖЕ представлений, что отдают экрану сервисы карточек (`get`/`view`),
 * а не пересчитано здесь: иначе у голоса и экрана были бы два мнения о
 * том, что доступно. `null` у карточки — карточки на экране нет (не
 * загрузилась, не настроена, сценария ещё нет), и голосом её элементы
 * недоступны так же, как руками.
 */
export interface VoiceSessionState {
  voice: {
    presets: ReadonlyArray<{ id: string; name: string }>;
    clones: ReadonlyArray<{ id: string; label: string }>;
    presetVoiceId: string | null;
    cloneId: string | null;
  } | null;
  music: {
    themes: ReadonlyArray<{ id: string; title: string }>;
    selectedId: string | null;
    /** Выбрано что-то (тема, своя музыка, библиотека). */
    hasSelection: boolean;
    libraryEnabled: boolean;
  } | null;
  cards: { title: string | null; closing: string | null } | null;
  sticker: {
    configured: boolean;
    allowed: boolean;
    selected: boolean;
    placement: string | null;
  } | null;
  scenes: { sceneCount: number; maxScenes: number } | null;
}

/** Та же формула, что `stickerCardHidden` экрана. */
function stickerCardShown(s: VoiceSessionState['sticker']): boolean {
  return !!s && (s.configured || s.selected);
}

/**
 * Нарисована ли карточка элемента сейчас — то же условие, что у экрана:
 * фото — всегда в сессии (после сценария — заперты), поле правки и блок
 * «Характер ролика» — только при собранном сценарии.
 */
export function sessionCardShown(
  field: SessionField,
  ctx: Pick<VoiceUnderstandContext, 'scope' | 'hasScript' | 'session'>,
): boolean {
  if (ctx.scope !== 'session') return false;
  const card = SESSION_FIELD_HOOKS[field].card;
  if (card === 'greeting-references-card') return true;
  if (!ctx.hasScript) return false;
  const s = ctx.session;
  switch (card) {
    case 'greeting-script-card':
      return true;
    case 'greeting-voice-card':
      return !!s?.voice;
    case 'greeting-music-card':
      return !!s?.music;
    case 'greeting-cards-card':
      return !!s?.cards;
    case 'greeting-sticker-card':
      return stickerCardShown(s?.sticker ?? null);
    case 'greeting-scenes-card':
      return !!s?.scenes;
    default:
      return false;
  }
}

// ── Состояние, против которого проверяется реплика ──────────────────────

/** Бриф в одной форме для обоих маршрутов: строка проекта и снимок сессии. */
export interface VoiceBriefState {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  /** Сохранённый ИТОГ регистра «Особого повода» (может быть поднят словами/классификатором). */
  occasionRegister: GreetingRegister | null;
  registerSource: string | null;
  /** Ответ человека о настроении. */
  userOccasionRegister: GreetingRegister | null;
  scriptLanguage: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  /** ISO `YYYY-MM-DD` или `null`. */
  occasionDate: string | null;
}

/** Строка `GreetingBrief` → состояние разбора. */
export function briefStateFromRow(row: {
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  occasionRegister?: GreetingRegister | null;
  registerSource?: string | null;
  userOccasionRegister?: GreetingRegister | null;
  scriptLanguage?: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  occasionDate: Date | string | null;
}): VoiceBriefState {
  const date =
    row.occasionDate instanceof Date
      ? row.occasionDate.toISOString().slice(0, 10)
      : typeof row.occasionDate === 'string'
        ? row.occasionDate.slice(0, 10)
        : null;
  return {
    occasion: row.occasion,
    customOccasionText: row.customOccasionText,
    occasionRegister: row.occasionRegister ?? null,
    registerSource: row.registerSource ?? null,
    userOccasionRegister: storedUserRegister(row),
    scriptLanguage: row.scriptLanguage ?? null,
    recipientName: row.recipientName,
    senderName: row.senderName,
    tone: row.tone,
    personalMessage: row.personalMessage,
    presenterProvider: row.presenterProvider,
    resolution: row.resolution,
    occasionDate: date,
  };
}

/**
 * Снимок сессии → состояние разбора. Провайдер и качество — ЗАПРОШЕННЫЕ,
 * как у правки брифа сессии (`baseOf`): тарифный гейт проверяет просьбу.
 */
export function briefStateFromSnapshot(
  s: GreetingBriefSnapshot,
): VoiceBriefState {
  return briefStateFromRow({
    occasion: s.occasion,
    customOccasionText: s.customOccasionText,
    occasionRegister: s.occasionRegister ?? null,
    registerSource: s.registerSource ?? null,
    userOccasionRegister: s.userOccasionRegister ?? null,
    scriptLanguage: s.scriptLanguage ?? null,
    recipientName: s.recipientName,
    senderName: s.senderName,
    tone: s.tone,
    personalMessage: s.personalMessage,
    presenterProvider: s.requestedPresenterProvider,
    resolution: s.requestedResolution,
    occasionDate: s.occasionDate,
  });
}

export interface VoiceUnderstandContext {
  brief: VoiceBriefState;
  /**
   * Что разрешает тариф — посчитано сервисом ТЕМ ЖЕ `resolveGreetingConfig`,
   * которым гейтит правка брифа, а не второй таблицей здесь.
   */
  presenters: readonly GreetingPresenterProvider[];
  maxResolution: GreetingResolution;
  /** `project` — бриф до сессии; `session` — после старта. */
  scope: 'project' | 'session';
  /** Собран ли сценарий (есть `generationPrompt` сессии). */
  hasScript: boolean;
  screen: { step: VoiceScreenStep; card?: string };
  pending: VoicePending | null;
  /** Язык интерфейса — подписи карточки. */
  uiLocale: SupportedLocale;
  /** Язык реплики помощника: язык речи, иначе интерфейса. */
  replyLocale: SupportedLocale;
  /**
   * Элементы сессии на экране (K5). Только у `scope: 'session'`; нет —
   * элементы сессии голосом недоступны (а не «доступно всё»).
   */
  session?: VoiceSessionState | null;
}

/** Язык реплики: язык речи (K2, по звуку), если он из пяти; иначе интерфейса. */
export function replyLocaleOf(
  spoken: string | null | undefined,
  uiLocale: SupportedLocale,
): SupportedLocale {
  return isSupportedLocale(spoken) ? spoken : uiLocale;
}
