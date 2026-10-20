/**
 * Образы рассказчика Story‑Tales (TODO стр. 79, пакет WP5): одежда и
 * лёгкий makeup как ОТДЕЛЬНЫЕ производные изображения от фото персонажа
 * брендбука. Чистые правила — без Nest и Prisma, проверяются юнит-тестом.
 *
 * Инварианты, которые не должны исчезнуть ни в одной ветке:
 *  - оригинал (фото персонажа и его активный скетч) не меняется никогда:
 *    вариант — новая запись со ссылкой на исходник и его хешем;
 *  - промпт варианта всегда несёт фиксированный защитный текст: лицо,
 *    возраст, телосложение, раса/цвет кожи не меняются (Р-ST-WP5-3);
 *  - свободного текста от клиента в промпте нет: только коды пресетов;
 *  - стилизация варианта идёт ТЕМ ЖЕ промптом ИИ-скетча и с теми же
 *    правилами лица, что у слота `brand-character` (`sketchLikenessFor`):
 *    новый путь не обходит обезличивание обычного персонажа (§22,
 *    дополнение «цветной мультяшный родитель»).
 */

import { createHash } from 'node:crypto';
import { estimateCost } from '../../common/ai-pricing';
import {
  buildSketchPrompt,
  sketchLikenessFor,
} from '../../common/sketch-prompts';
import {
  isSketchStyle,
  SketchOptions,
  SketchRendering,
  SketchStyle,
} from '../../common/types/sketch.types';
import {
  LOOK_KEEP_FACE_LINE,
  LOOK_SAFETY_LINE,
} from '../persona/persona-looks.rules';

// ── Согласие на синтетический образ ─────────────────────────────────

/** Отдельно от голосового `story-parent-voice-v1` — не смешивать. */
export const STORY_PARENT_IMAGE_CONSENT_VERSION = 'story-parent-image-v1';
export const STORY_PARENT_IMAGE_CONSENT_TEXT =
  'Подтверждаю: мне есть 18 лет; на фото рассказчика — я сам(а) либо у меня есть явное разрешение изображённого взрослого. Разрешаю создавать по этому фото синтетические производные образы (одежда, лёгкий макияж, тот же стиль скетча) и использовать их только в закрытой разработке Story‑Tales и в моих собственных подарках. Понимаю: после отзыва согласия варианты недоступны для новых рендеров; уже готовые выпуски не меняются.';

export interface ImageConsentRow {
  narratorImageConsentAt: Date | null;
  narratorImageConsentVersion: string | null;
  narratorImageConsentRevokedAt: Date | null;
}

/** Действующее согласие текущей версии. */
export function imageConsentActive(row: ImageConsentRow): boolean {
  return (
    !!row.narratorImageConsentAt &&
    row.narratorImageConsentVersion === STORY_PARENT_IMAGE_CONSENT_VERSION &&
    !row.narratorImageConsentRevokedAt
  );
}

// ── Пресеты ─────────────────────────────────────────────────────────

export const NARRATOR_OUTFITS = [
  'casual',
  'cozy-home',
  'festive',
  'business',
  'winter',
] as const;
export type NarratorOutfit = (typeof NARRATOR_OUTFITS)[number];

export const NARRATOR_MAKEUPS = ['none', 'light', 'natural'] as const;
export type NarratorMakeup = (typeof NARRATOR_MAKEUPS)[number];

export function isNarratorOutfit(value: unknown): value is NarratorOutfit {
  return (NARRATOR_OUTFITS as readonly unknown[]).includes(value);
}
export function isNarratorMakeup(value: unknown): value is NarratorMakeup {
  return (NARRATOR_MAKEUPS as readonly unknown[]).includes(value);
}

const OUTFIT_FRAGMENT: Record<NarratorOutfit, string> = {
  casual:
    'Outfit: neat casual everyday clothes (a plain sweater or shirt), soft neutral colours.',
  'cozy-home':
    'Outfit: cosy home clothes (a soft knitted cardigan or warm jumper), warm calm colours, suitable for reading a bedtime story.',
  festive:
    'Outfit: a tasteful festive outfit in warm celebratory colours, modest and family-friendly.',
  business:
    'Outfit: a smart business look (a blazer over a plain top or shirt), modest and neat.',
  winter:
    'Outfit: warm winter clothes (a knitted sweater and a scarf), modest and cosy.',
};

const MAKEUP_FRAGMENT: Record<NarratorMakeup, string> = {
  none: 'Do not add, remove or change any makeup.',
  light:
    'Makeup: very light, barely visible everyday makeup only; it must not change the shape of the face, eyes, nose or lips.',
  natural:
    "Makeup: natural-looking makeup in soft natural tones that match the person's own skin colour; no contouring that reshapes the face.",
};

// ── Промпты ─────────────────────────────────────────────────────────

/**
 * Фиксированный защитный текст варианта (Р-ST-WP5-3). Тест проверяет,
 * что каждый пункт («лицо, возраст, телосложение, раса/цвет кожи») здесь
 * есть и попадает в КАЖДЫЙ промпт варианта.
 */
export const NARRATOR_IDENTITY_LINE =
  'Identity lock: this is the same real adult person and must stay instantly recognisable. Do not change the face or any facial features, face shape, eyes, nose, lips or ears. Do not change the apparent age: never make the person look younger or older. Do not change the body shape, body build, height or weight. Do not change the race, ethnicity, skin tone or skin colour. Keep the hair colour, hairstyle and any distinctive marks. Do not beautify, slim or reshape the person.';

export const NARRATOR_EDIT_SCOPE_LINE =
  'Edit only the clothing and, if requested below, the makeup. Keep the pose, head position, expression, framing and camera angle.';

export function buildNarratorLookPrompt(input: {
  outfit: NarratorOutfit;
  makeup: NarratorMakeup;
}): string {
  return [
    'Photorealistic edit of the person in the reference photo.',
    NARRATOR_EDIT_SCOPE_LINE,
    OUTFIT_FRAGMENT[input.outfit],
    MAKEUP_FRAGMENT[input.makeup],
    NARRATOR_IDENTITY_LINE,
    LOOK_KEEP_FACE_LINE,
    'Plain soft background, even soft lighting, waist-up or head-and-shoulders framing.',
    LOOK_SAFETY_LINE,
  ].join(' ');
}

/** Режим изображения рассказчика: фото или стиль ИИ-скетча. */
export type NarratorMode = 'photo' | SketchStyle;

export interface NarratorModeInfo {
  mode: NarratorMode;
  options: SketchOptions | null;
}

/**
 * Режим из применённого скетча персонажа. `cartoon` всегда цветной и
 * `stylized` — как у `image-sketch.service.ts` (apply/generate), в том
 * числе если в старой строке опции почему-то другие.
 */
export function narratorModeOf(
  sketch: { style: string; options: unknown; url: string | null } | null,
): NarratorModeInfo {
  if (!sketch || !sketch.url || !isSketchStyle(sketch.style)) {
    return { mode: 'photo', options: null };
  }
  return {
    mode: sketch.style,
    options: narratorStyleOptions(sketch.style, sketch.options),
  };
}

export function narratorStyleOptions(
  style: SketchStyle,
  raw: unknown,
): SketchOptions {
  const source = (raw && typeof raw === 'object' ? raw : {}) as SketchOptions;
  const rendering: SketchRendering =
    style === 'cartoon'
      ? 'stylized'
      : source.sketchRendering === 'stylized'
        ? 'stylized'
        : 'realistic';
  return {
    // Персонаж бренда по фото — лицо меняется всегда (§4 п.3 ТЗ скетча).
    anonymizeFace: true,
    keepColors: style === 'cartoon' ? true : source.keepColors !== false,
    sketchRendering: rendering,
  };
}

/**
 * Промпт стилизации варианта — ровно тот, что дал бы ИИ-скетч слоту
 * `brand-character` по фото (Р-ST-WP5-4). Описание клиента не идёт.
 */
export function buildNarratorStylePrompt(
  style: SketchStyle,
  options: SketchOptions,
): string {
  return buildSketchPrompt({
    slotKind: 'character',
    mode: 'from-image',
    style,
    options,
    description: null,
    likeness: sketchLikenessFor('brand-character', false),
  });
}

// ── Квота и резерв ──────────────────────────────────────────────────

/** Вызовов модели картинок на пользователя: сутки / месяц UTC. */
export const NARRATOR_LOOK_DAY_LIMIT = 6;
export const NARRATOR_LOOK_MONTH_LIMIT = 40;
/** PENDING дольше — исход неизвестен (UNKNOWN), автоповтора нет. */
export const NARRATOR_LOOK_STALE_MS = 10 * 60 * 1000;
/**
 * Потолок байтов одного изображения варианта. ST2-S-07: ровно порог кадра
 * видео (`STORY_NARRATOR_IMAGE_MAX_BYTES`, 4 000 000 — ответ маршрута
 * story-render-input под лимитом Vercel 4,5 МБ с запасом): вариант, который
 * видео не примет, не становится READY. CHECK в миграции (4 МиБ) — только
 * потолок хранения.
 */
export const NARRATOR_LOOK_MAX_BYTES = 4_000_000;
/**
 * A-S3-10: потолок изображения в JSON-превью (`{ base64, mime, hash }`).
 * base64 раздувает байты в 4/3: 3 МиБ → ≈4 МиБ JSON, под лимитом ответа
 * Vercel (4,5 МБ). Больше — только бинарный ответ (маршрут `…/image/raw`).
 */
export const NARRATOR_LOOK_JSON_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

export interface NarratorLookQuotaView {
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

/**
 * Квота по строкам вариантов: каждая строка держит число начатых вызовов
 * (`imageCalls`) — и оплаченных, и с неизвестным исходом (UNKNOWN), и
 * брони в полёте. Консервативно: сбой сети тоже тратит квоту, зато
 * неизвестный исход не открывает дорогу второму оплаченному вызову.
 */
export function narratorLookQuota(
  rows: Array<{ createdAt: Date; imageCalls: number }>,
  now: Date,
): NarratorLookQuotaView {
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let dayUsed = 0;
  let monthUsed = 0;
  for (const r of rows) {
    const t = r.createdAt.getTime();
    if (t >= month) monthUsed += r.imageCalls;
    if (t >= day) dayUsed += r.imageCalls;
  }
  return {
    dayUsed,
    dayLimit: NARRATOR_LOOK_DAY_LIMIT,
    monthUsed,
    monthLimit: NARRATOR_LOOK_MONTH_LIMIT,
  };
}

export function narratorQuotaExhausted(
  quota: NarratorLookQuotaView,
  calls: number,
): 'day' | 'month' | null {
  if (quota.dayUsed + calls > quota.dayLimit) return 'day';
  if (quota.monthUsed + calls > quota.monthLimit) return 'month';
  return null;
}

/** Ожидаемые токены одного вызова картинки (≈1300 выходных на 1K). */
export const NARRATOR_LOOK_TOKENS = {
  inputTokens: 1800,
  outputTokens: 1300,
} as const;

export interface NarratorLookPrice {
  /** Оценка по прайсу на каждый вызов — для показа. */
  perCall: Array<{ model: string; estimateMicroUsd: number }>;
  estimateMicroUsd: number;
  /** Резерв: 2× оценки на каждый вызов; не счёт провайдера. */
  reserveMicroUsd: number;
}

/**
 * Цена следующего действия: фото-проход и (если режим — скетч) проход
 * стилизации. Модель без ставки — `null`: платить вслепую не даём.
 */
export function narratorLookPrice(
  models: string[],
  env: NodeJS.ProcessEnv = process.env,
): NarratorLookPrice | null {
  const perCall: NarratorLookPrice['perCall'] = [];
  for (const model of models) {
    const cost = estimateCost(model, NARRATOR_LOOK_TOKENS, env);
    if (cost.unpriced) return null;
    perCall.push({ model, estimateMicroUsd: Math.ceil(cost.costMicroUsd) });
  }
  const estimate = perCall.reduce((s, p) => s + p.estimateMicroUsd, 0);
  return {
    perCall,
    estimateMicroUsd: estimate,
    reserveMicroUsd: perCall.reduce((s, p) => s + p.estimateMicroUsd * 2, 0),
  };
}

// ── Хеши и файлы ────────────────────────────────────────────────────

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Отпечаток запроса варианта: тот же исходник, пресеты и режим — тот же
 * хеш. По нему повтор отправки возвращает готовый вариант без оплаты.
 */
export function narratorLookConfigHash(input: {
  kind: 'create' | 'restyle';
  characterId: string;
  sourceHash: string;
  outfit: NarratorOutfit;
  makeup: NarratorMakeup;
  mode: NarratorMode;
  options: SketchOptions | null;
  parentPhotoHash?: string | null;
}): string {
  return sha256Hex(
    JSON.stringify({
      v: 1,
      kind: input.kind,
      characterId: input.characterId,
      sourceHash: input.sourceHash,
      outfit: input.outfit,
      makeup: input.makeup,
      mode: input.mode,
      keepColors: input.options?.keepColors ?? null,
      sketchRendering: input.options?.sketchRendering ?? null,
      parentPhotoHash: input.parentPhotoHash ?? null,
    }),
  );
}

/** Тип картинки по сигнатуре; неизвестный формат — `null`. */
export function imageMimeOf(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff')
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

// ── Пригодность варианта ────────────────────────────────────────────

export type NarratorLookProblem =
  | 'deleted'
  | 'not-ready'
  | 'consent'
  | 'character-changed'
  | 'source-changed'
  | 'asset-missing'
  | 'mode-mismatch';

export const NARRATOR_LOOK_PROBLEM_MESSAGE: Record<
  NarratorLookProblem,
  string
> = {
  deleted: 'Вариант удалён',
  'not-ready':
    'Вариант не готов: генерация не завершилась успешно — повторите её явно или выберите другой вариант',
  consent:
    'Согласие на синтетический образ отозвано или дано заново после создания варианта — вариант недоступен для новых рендеров',
  'character-changed':
    'Вариант сделан для другого персонажа-рассказчика — откатите к оригиналу или создайте новый',
  'source-changed':
    'Фото рассказчика заменено после создания варианта — откатите к оригиналу или создайте новый',
  'asset-missing': 'У варианта нет готового изображения для этого режима',
  'mode-mismatch':
    'Режим рассказчика сменился: вариант сделан в другом стиле — перестилизуйте его или создайте новый',
};

export interface UsableLookRow {
  /** PENDING | READY | FAILED | UNKNOWN | DELETED; применять можно только READY. */
  status: string;
  characterId: string;
  sourceUrl: string;
  consentAt: Date;
  consentVersion: string;
  deletedAt: Date | null;
  photoHash: string | null;
  style: string | null;
  styledHash: string | null;
}

export type NarratorAsset = 'photo' | 'styled';

/**
 * Можно ли использовать вариант в новом рендере (и применять его).
 * `mode` — текущий режим персонажа; `null` — не сверять (пиннинг уже
 * одобренного ассета при рендере, Р-ST-WP5-6).
 */
export function narratorLookProblem(input: {
  look: UsableLookRow;
  asset: NarratorAsset;
  consent: ImageConsentRow;
  narratorCharacterId: string | null;
  characterPhotoUrl: string | null;
  mode: NarratorMode | null;
  /**
   * A-S3-1: по умолчанию вариант годен только в статусе READY (применение,
   * рендер, карточка). `false` — лишь для перестилизации: она берёт уже
   * готовое ФОТО варианта (проверяется по `photoHash`), даже если прошлая
   * стилизация закончилась FAILED/UNKNOWN, и создаёт новую строку.
   */
  requireReady?: boolean;
}): NarratorLookProblem | null {
  const { look } = input;
  if (look.deletedAt) return 'deleted';
  if (input.requireReady !== false && look.status !== 'READY')
    return 'not-ready';
  if (
    !imageConsentActive(input.consent) ||
    look.consentVersion !== STORY_PARENT_IMAGE_CONSENT_VERSION ||
    look.consentAt.getTime() < input.consent.narratorImageConsentAt!.getTime()
  )
    return 'consent';
  if (look.characterId !== input.narratorCharacterId)
    return 'character-changed';
  if (!input.characterPhotoUrl || look.sourceUrl !== input.characterPhotoUrl)
    return 'source-changed';
  if (input.mode !== null) {
    const assetMode = input.asset === 'photo' ? 'photo' : look.style;
    if (assetMode !== input.mode) return 'mode-mismatch';
  }
  if (input.asset === 'photo' ? !look.photoHash : !look.styledHash)
    return 'asset-missing';
  return null;
}

/** Какой ассет варианта соответствует режиму персонажа. */
export function assetForMode(mode: NarratorMode): NarratorAsset {
  return mode === 'photo' ? 'photo' : 'styled';
}
