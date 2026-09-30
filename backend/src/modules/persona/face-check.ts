/**
 * Проверка лица одним мультимодальным вызовом Gemini (ТЗ Greeting 2.0 §4.3,
 * §4.4, §4.8 «Реальные лица в обычных референсах»).
 *
 * Два потребителя, одна функция — чтобы правило «что считается лицом» жило
 * в одном месте:
 * - персона (E): селфи + ролик живости 3 с → одно лицо, анфас, свет, не
 *   экран/распечатка, тот же человек в ролике, живое движение, возраст
 *   диапазоном;
 * - референсы поздравления (G): есть ли на фото лицо → `needsFaceConsent`.
 *
 * Файл «почти чистый»: ни Nest, ни Prisma, ни ключа — клиент модели и
 * запись расхода передаёт вызывающий. Так его можно звать из любого модуля
 * без импорта PersonaModule и тестировать подставным генератором.
 *
 * Ответу модели НЕ доверяем по форме: JSON-режим не гарантирует ни полей,
 * ни типов (строка «1» вместо числа, «true» строкой, обрезанный ответ,
 * обёртка ```json). `parseFaceCheck` приводит то, что можно привести, и
 * выбирает ОСТОРОЖНОЕ умолчание там, где поля нет: не анфас, экран/
 * распечатка «да», другой человек, нет движения. Нет числа лиц — ответа нет
 * вовсе (`null`): решать без главного поля нельзя.
 *
 * Приватность (§4.4): возраст спрашивается ТОЛЬКО при `purpose: 'persona'`
 * и только там возвращается. Для референсов вопроса о возрасте в промпте
 * нет, а если модель всё же вернула — поля отбрасываются здесь же. Оценка
 * возраста не используется ни для чего, кроме допуска к режиму персоны.
 *
 * Это заслон от «загрузил чужое фото», а не проверка личности (Т-16): ни
 * одно поле результата не означает «личность подтверждена».
 */

import type { GoogleGenAI, PartUnion } from '@google/genai';

/** Зачем проверяем: от этого зависит, спрашивать ли возраст и живость. */
export type FaceCheckPurpose = 'persona' | 'reference';

/** Медиа внутри запроса (`inlineData`) — у провайдера файл не остаётся. */
export interface FaceCheckMedia {
  data: Buffer;
  mimeType: string;
}

export interface FaceCheckInput {
  purpose: FaceCheckPurpose;
  /** Селфи (персона) или фото референса. */
  photo: FaceCheckMedia;
  /** Ролик живости 3 с — только у персоны; у референса игнорируется. */
  liveness?: FaceCheckMedia | null;
}

/**
 * Качество кадра для лица. `good` — достаточно света и резкости;
 * `unknown` — модель не ответила понятно (для персоны это отказ).
 */
export type FaceQuality =
  | 'good'
  | 'dark'
  | 'blurry'
  | 'overexposed'
  | 'unknown';
export const FACE_QUALITIES: readonly FaceQuality[] = [
  'good',
  'dark',
  'blurry',
  'overexposed',
  'unknown',
];

export interface FaceCheckResult {
  /** Сколько человеческих лиц на фото (0…MAX_FACES). */
  faces: number;
  /** Единственное/главное лицо смотрит в камеру анфас. */
  frontal: boolean;
  quality: FaceQuality;
  /** Снимок экрана, фото фотографии, распечатка, маска. */
  screenOrPrint: boolean;
  /** Только при ролике живости: тот же человек, что на фото. */
  sameAsSelfie?: boolean;
  /** Только при ролике живости: живое движение (поворот головы). */
  liveMotion?: boolean;
  /** Только при `purpose: 'persona'`: оценка возраста диапазоном. */
  ageMin?: number;
  ageMax?: number;
}

/**
 * Минимально нужная часть клиента `@google/genai` — `GoogleGenAI`
 * подходит как есть; в тестах подставляется объект с одним методом.
 * Импорт только типов: файл остаётся без зависимостей времени выполнения.
 */
export interface FaceCheckGenerator {
  models: Pick<GoogleGenAI['models'], 'generateContent'>;
}

export interface FaceCheckOptions {
  /** Модель Gemini; по умолчанию — `GEMINI_MODEL` вызывающего. */
  model: string;
  /**
   * Вызывается с сырым ответом модели ДО разбора — место для
   * `aiUsage.recordGemini(response, { operation: … })`. Сбой записи
   * расхода проверку не роняет.
   */
  onResponse?: (response: unknown) => Promise<void> | void;
}

/** Потолок inline-запроса Gemini — 20 МБ; держим запас на base64 и текст. */
export const FACE_CHECK_MAX_INLINE_BYTES = 14 * 1024 * 1024;
/** Больше — это толпа; точное число не нужно ни одному потребителю. */
export const FACE_CHECK_MAX_FACES = 20;
/** Правдоподобные границы оценки возраста; вне — ответ отбрасывается. */
const AGE_FLOOR = 1;
const AGE_CEIL = 110;

export function buildFaceCheckPrompt(
  purpose: FaceCheckPurpose,
  hasLiveness: boolean,
): string {
  const fields: string[] = [
    '"faces": integer, number of distinct real human faces visible in the PHOTO (0 if none)',
    '"frontal": boolean, true only if exactly one face looks straight into the camera (not profile, not tilted away)',
    '"quality": one of "good" | "dark" | "blurry" | "overexposed" — lighting and sharpness of the face in the PHOTO',
    '"screenOrPrint": boolean, true if the PHOTO shows a screen, a printed photo, a photo of a photo, a poster, a mask or a doll instead of a live person in front of the camera',
  ];
  if (purpose === 'persona' && hasLiveness) {
    fields.push(
      '"sameAsSelfie": boolean, true only if the person in the VIDEO is clearly the same person as in the PHOTO',
      '"liveMotion": boolean, true only if the VIDEO shows a live person turning their head (not a still image, not a screen being filmed)',
    );
  }
  if (purpose === 'persona') {
    fields.push(
      '"ageMin": integer, lower bound of the apparent age of the person in the PHOTO',
      '"ageMax": integer, upper bound of the apparent age of the person in the PHOTO (a range of 4–10 years; be conservative — if the person may be a minor, the lower bound must say so)',
    );
  }
  const media =
    purpose === 'persona' && hasLiveness
      ? 'The first attachment is the PHOTO (a selfie), the second is a short VIDEO taken right after it.'
      : 'The attachment is the PHOTO.';
  return [
    'You are an automated photo pre-check. You do NOT identify people and you do not name anyone.',
    media,
    'Answer with a single JSON object and nothing else, with exactly these fields:',
    ...fields.map((f) => `- ${f}`),
    `If you are unsure about a boolean, answer the cautious value (false for ${
      purpose === 'persona' && hasLiveness
        ? 'frontal/sameAsSelfie/liveMotion'
        : 'frontal'
    }, true for screenOrPrint).`,
  ].join('\n');
}

/**
 * Разбор ответа модели. `null` — ответа нет по существу (не JSON, нет
 * числа лиц). Никогда не бросает.
 */
export function parseFaceCheck(
  raw: string | null | undefined,
  purpose: FaceCheckPurpose,
  hasLiveness: boolean,
): FaceCheckResult | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const faces = toInt(obj.faces);
  if (faces === null || faces < 0) return null;

  const result: FaceCheckResult = {
    faces: Math.min(faces, FACE_CHECK_MAX_FACES),
    frontal: toBool(obj.frontal) ?? false,
    quality: toQuality(obj.quality),
    screenOrPrint: toBool(obj.screenOrPrint) ?? true,
  };
  if (purpose === 'persona' && hasLiveness) {
    result.sameAsSelfie = toBool(obj.sameAsSelfie) ?? false;
    result.liveMotion = toBool(obj.liveMotion) ?? false;
  }
  // Возраст — только для персоны (§4.4): у референса поле не читается,
  // даже если модель его прислала.
  if (purpose === 'persona') {
    let lo = toInt(obj.ageMin);
    let hi = toInt(obj.ageMax);
    if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
    if (lo !== null && hi !== null && lo >= AGE_FLOOR && hi <= AGE_CEIL) {
      result.ageMin = lo;
      result.ageMax = hi;
    }
  }
  return result;
}

/**
 * Проверка лица. Никогда не бросает: нет клиента, файл велик, сбой сети,
 * непонятный ответ — `null` («проверка недоступна»). Что делать с `null`,
 * решает потребитель: персона отказывает, референс считает «лицо возможно».
 */
export async function checkFaces(
  genai: FaceCheckGenerator | null,
  input: FaceCheckInput,
  opts: FaceCheckOptions,
): Promise<FaceCheckResult | null> {
  if (!genai) return null;
  const liveness =
    input.purpose === 'persona' && input.liveness ? input.liveness : null;
  const total = input.photo.data.length + (liveness?.data.length ?? 0);
  if (input.photo.data.length === 0 || total > FACE_CHECK_MAX_INLINE_BYTES) {
    return null;
  }
  const contents: PartUnion[] = [inline(input.photo)];
  if (liveness) contents.push(inline(liveness));
  contents.push({ text: buildFaceCheckPrompt(input.purpose, !!liveness) });

  let response: unknown;
  try {
    response = await genai.models.generateContent({
      model: opts.model,
      contents,
      // Ответ короткий, но модель с размышлениями тратит на них тот же
      // бюджет выхода — с малым потолком JSON приходил бы обрезанным.
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 2048,
      },
    });
  } catch {
    return null;
  }
  if (opts.onResponse) {
    try {
      await opts.onResponse(response);
    } catch {
      // Расход не записался — проверка от этого не становится неверной.
    }
  }
  let text: unknown;
  try {
    text = (response as { text?: unknown } | null)?.text;
  } catch {
    // Геттер `text` SDK бросает на ответе без кандидатов (блок безопасности).
    return null;
  }
  return parseFaceCheck(
    typeof text === 'string' ? text : null,
    input.purpose,
    !!liveness,
  );
}

/** Для референсов (G): есть ли на фото лицо. `null` проверки — «возможно». */
export function mayContainFace(result: FaceCheckResult | null): boolean {
  return result === null || result.faces > 0;
}

// ── разбор ──────────────────────────────────────────────────────────────

function inline(m: FaceCheckMedia) {
  return {
    inlineData: {
      mimeType: m.mimeType.split(';')[0].trim().toLowerCase(),
      data: m.data.toString('base64'),
    },
  };
}

function extractJsonObject(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(raw.slice(start, end + 1));
    if (Array.isArray(v)) {
      return v.length > 0 && isRecord(v[0]) ? v[0] : null;
    }
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    return Math.round(Number(v));
  }
  return null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}

function toQuality(v: unknown): FaceQuality {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim().toLowerCase() as FaceQuality;
  return FACE_QUALITIES.includes(s) ? s : 'unknown';
}
