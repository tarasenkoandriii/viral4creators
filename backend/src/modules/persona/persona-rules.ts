/**
 * Чистые правила режима «Я в кадре» (ТЗ Greeting 2.0 §4.3, §4.4, §4.9,
 * §4.10): рубильник, пути файлов, допустимые форматы, причины отказа
 * автопроверки, срок хранения источников. Без Nest и Prisma — чтобы
 * правила проверялись тестом напрямую, а сервис только склеивал их с
 * базой и хранилищем.
 */

import { NotFoundException } from '@nestjs/common';
import type { FaceCheckResult } from './face-check';
import { PERSONA_SOURCES_RETENTION_DAYS } from './persona-consent';

// ── Рубильник (§4.10) ─────────────────────────────────────────────────

/** Читается на каждом запросе, как `FREE_TIER_WALL_ENABLED`: включение без деплоя. */
export function personaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERSONA_ENABLED === 'true';
}

export const PERSONA_DISABLED_CODE = 'PERSONA_DISABLED';

/**
 * 404, а не 403: для клиента режима нет вовсе, и по коду он прячет всё
 * (контракт волны: `GET /personas/me` → 404 `PERSONA_DISABLED`).
 */
export function personaDisabledError(): NotFoundException {
  return new NotFoundException({
    code: PERSONA_DISABLED_CODE,
    message: 'Режим «Я в кадре» недоступен',
  });
}

// ── Файлы (§4.5: users/{userId}/personas/{personaId}/…) ───────────────

export function personaBlobPrefix(userId: string, personaId: string): string {
  return `users/${userId}/personas/${personaId}/`;
}

/**
 * Форматы камеры в браузере и WebView Telegram: фото — JPEG/PNG/WebP с
 * canvas, ролик — то, что даёт MediaRecorder (webm в Chrome/Android,
 * mp4 в iOS Safari/WebView). Все — в списке входа Gemini.
 */
export const PERSONA_SELFIE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const PERSONA_LIVENESS_MIME_TYPES = [
  'video/webm',
  'video/mp4',
  'video/quicktime',
] as const;
export type PersonaSelfieMime = (typeof PERSONA_SELFIE_MIME_TYPES)[number];
export type PersonaLivenessMime = (typeof PERSONA_LIVENESS_MIME_TYPES)[number];

export const PERSONA_DEFAULT_SELFIE_MIME: PersonaSelfieMime = 'image/jpeg';
export const PERSONA_DEFAULT_LIVENESS_MIME: PersonaLivenessMime = 'video/webm';

/**
 * Потолки загрузки. Вместе — ниже `FACE_CHECK_MAX_INLINE_BYTES` (14 МБ):
 * оба файла уходят в ОДИН inline-запрос, и больший файл проверка просто
 * не приняла бы. Ролик 3 с при 720p — 1–3 МБ, запас большой.
 */
export const PERSONA_SELFIE_MAX_BYTES = 5 * 1024 * 1024;
export const PERSONA_LIVENESS_MAX_BYTES = 8 * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([m, e]) => [e, m]),
);

/**
 * Хранилище публичное (`access: 'public'` у BlobService), и путь без
 * случайной части угадывался бы по двум id. Поэтому в имени файла —
 * случайный хвост (`nonce`, 24 hex): URL селфи не выводится из того,
 * что видно снаружи, а сам путь живёт только в строке персоны.
 */
export function selfiePathname(
  userId: string,
  personaId: string,
  mime: PersonaSelfieMime,
  nonce: string,
): string {
  return `${personaBlobPrefix(userId, personaId)}selfie-${nonce}.${EXT[mime]}`;
}

export function livenessPathname(
  userId: string,
  personaId: string,
  mime: PersonaLivenessMime,
  nonce: string,
): string {
  return `${personaBlobPrefix(userId, personaId)}liveness-${nonce}.${EXT[mime]}`;
}

/**
 * Путь источника, которым владеет СЕРВЕР (CONTRACT5, п.1): после
 * успешной проверки селфи и ролик копируются сюда, а клиентский путь
 * удаляется. Клиентская ссылка на загрузку живёт 15 минут и разрешает
 * перезапись — без переноса человек мог бы после проверки подменить
 * файл по той же ссылке, и образы делались бы из непроверенного лица.
 * Отдельная папка `sources/` и свой случайный хвост: этот путь клиенту
 * не выдаётся никогда.
 */
export function serverSourcePathname(
  userId: string,
  personaId: string,
  kind: 'selfie' | 'liveness',
  mime: string,
  nonce: string,
): string {
  return `${personaBlobPrefix(userId, personaId)}sources/${kind}-${nonce}.${EXT[mime] ?? 'bin'}`;
}

/** Тип файла по расширению пути — для inline-части запроса к модели. */
export function mimeOfPathname(pathname: string): string | null {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

// ── Автопроверка (§4.3, §4.4) ─────────────────────────────────────────

/** Порог допуска по нижней границе оценки возраста (В-4, временно по рекомендации ТЗ). */
export const PERSONA_MIN_AGE = 18;

export const PERSONA_REFUSALS = [
  'check-unavailable',
  'no-face',
  'multiple-faces',
  'not-frontal',
  'poor-quality',
  'screen-or-print',
  'not-same-person',
  'no-live-motion',
  'age-unknown',
  'under-18',
] as const;
export type PersonaRefusal = (typeof PERSONA_REFUSALS)[number];

/**
 * Причины отказа по результату проверки; пусто — проверка пройдена.
 *
 * Все причины сразу, а не первая: человеку проще переснять один раз,
 * зная и про свет, и про поворот. `under-18` и `age-unknown` ставятся
 * независимо от остального — это не про качество снимка.
 *
 * Возраст не определён — отказ (`age-unknown`), а не допуск: режим
 * создаёт изображения реального человека, и «не знаем, взрослый ли» —
 * ровно тот случай, который порог В-4 должен закрывать.
 */
export function personaRefusals(
  result: FaceCheckResult | null,
): PersonaRefusal[] {
  if (!result) return ['check-unavailable'];
  const out: PersonaRefusal[] = [];
  if (result.faces === 0) out.push('no-face');
  if (result.faces > 1) out.push('multiple-faces');
  if (result.faces === 1 && !result.frontal) out.push('not-frontal');
  if (result.quality !== 'good') out.push('poor-quality');
  if (result.screenOrPrint) out.push('screen-or-print');
  if (result.sameAsSelfie !== true) out.push('not-same-person');
  if (result.liveMotion !== true) out.push('no-live-motion');
  if (result.ageMin === undefined || result.ageMax === undefined) {
    out.push('age-unknown');
  } else if (result.ageMin < PERSONA_MIN_AGE) {
    out.push('under-18');
  }
  return out;
}

/**
 * Хранить ли оценку возраста в строке персоны. Приватность (§4.4):
 * оценка — данные, выведенные из лица; держим её, только когда она
 * что-то решила — проверка пройдена (показывается человеку «ИИ оценил
 * 28–34») или отказ именно по возрасту (блок режима и апелляция через
 * поддержку, В-4). При отказе за свет или поворот оценка не сохраняется.
 */
export function keepAgeEstimate(refusals: PersonaRefusal[]): boolean {
  return refusals.length === 0 || refusals.includes('under-18');
}

/**
 * Удалять ли загруженные селфи и ролик сразу после отказа. Да — кроме
 * `check-unavailable`: там дело не в снимке, и повтор проверки не должен
 * требовать новой съёмки. Отказ за возраст файлы тоже удаляет: режим
 * недоступен, и хранить лицо незачем.
 */
export function dropSourcesAfterRefusal(refusals: PersonaRefusal[]): boolean {
  return refusals.length > 0 && !refusals.includes('check-unavailable');
}

// ── Срок хранения источников (В-3) ────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Граница срока: селфи и ролик персоны, чей последний образ создан
 * раньше неё, удаляются. В-3, временно по рекомендации ТЗ: 30 дней.
 */
export function personaSourcesCutoff(now: Date): Date {
  return new Date(now.getTime() - PERSONA_SOURCES_RETENTION_DAYS * DAY_MS);
}

/**
 * Незавершённая попытка (файлы загружены, проверка не пройдена) —
 * лицо без цели хранения. Сутки — с запасом больше срока ссылки
 * (15 минут) и любой пересъёмки.
 */
export const PERSONA_ABANDONED_MAX_AGE_MS = DAY_MS;

export function personaAbandonedCutoff(now: Date): Date {
  return new Date(now.getTime() - PERSONA_ABANDONED_MAX_AGE_MS);
}

/**
 * Пора ли удалять источники проверенной персоны. Отсчёт — от создания
 * последнего образа (включая мягко удалённые: образ был создан из селфи
 * в тот момент), без образов — от прохождения проверки.
 */
export function personaSourcesDue(
  p: { livenessCheckedAt: Date | null; lastLookCreatedAt: Date | null },
  now: Date,
): boolean {
  const from = p.lastLookCreatedAt ?? p.livenessCheckedAt;
  if (!from) return false;
  return from.getTime() < personaSourcesCutoff(now).getTime();
}
