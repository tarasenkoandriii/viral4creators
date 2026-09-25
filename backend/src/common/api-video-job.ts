/**
 * Заявка внешнего API на ролик (этап 145, docs-tz/TZ-Vneshnee-API.md) —
 * чистые правила: отпечаток запроса, пауза перед повтором и то, что
 * видит чужой код.
 *
 * ## Почему у заявки своя строка, а не просто сессия
 *
 * Генерация длится минуты, HTTP-запрос столько не живёт, а фона у
 * serverless нет (записано в `wizard-guide/translation.service.ts`).
 * Значит ответ — `202` и `jobId`, а работу доводит крон. Сессия для
 * этого не годится: её чистит TTL через сутки простоя, а заявка обязана
 * пережить свой же результат — по `jobId` к нам придут и завтра.
 * Та же причина, по которой не привязана к сессии заявка на публикацию.
 *
 * ## Идемпотентность: ключ плюс отпечаток, а не ключ
 *
 * `Idempotency-Key` защищает от повтора после таймаута: чужой клиент
 * не знает, дошёл ли первый запрос, и шлёт второй. Вернуть ему ту же
 * заявку — правильно. Но тот же ключ с ДРУГИМ телом — это не повтор, а
 * ошибка на его стороне (переиспользованный ключ), и молча отдать ему
 * чужой ролик значит спрятать её до момента, когда она будет стоить
 * дорого. Поэтому рядом с ключом хранится отпечаток тела, и несовпадение
 * — отказ, а не сюрприз.
 */

import { createHash } from 'crypto';

/** Что просили сгенерировать. Снимок: заявка переживает сессию. */
export interface ApiVideoRequest {
  productItemId: string;
  libraryEntryId: string;
  quality: 'fast' | 'standard';
  aspectRatio: string | null;
  locale: string | null;
}

/**
 * Отпечаток запроса. Поля перечислены ЯВНО и по порядку, а не
 * `JSON.stringify` объекта: порядок ключей в объекте зависит от того, как
 * его собрали, и одинаковые по смыслу запросы дали бы разные отпечатки.
 */
export function requestFingerprint(request: ApiVideoRequest): string {
  const parts = [
    request.productItemId,
    request.libraryEntryId,
    request.quality,
    request.aspectRatio ?? '',
    request.locale ?? '',
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Состояние заявки. То же слово увидит чужой код. */
export type ApiVideoJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

/** Заявка кончилась — ходить за ней больше незачем. */
export function isTerminal(status: ApiVideoJobStatus): boolean {
  return status === 'DONE' || status === 'FAILED';
}

/** Сколько раз пробуем, прежде чем признать заявку неудавшейся. */
export const MAX_ATTEMPTS = 3;

/**
 * Когда пробовать снова. Та же удваивающаяся пауза, что у рассылки и у
 * пакетной генерации: 2, 4, 8 минут.
 */
export function nextAttemptAt(attempts: number, now: Date): Date {
  const minutes = Math.pow(2, Math.max(attempts, 1));
  return new Date(now.getTime() + minutes * 60_000);
}

export interface ApiVideoJobView {
  jobId: string;
  status: ApiVideoJobStatus;
  /** Готовый ролик. Есть только у `DONE`. */
  videoUrl: string | null;
  /** Почему не вышло — человеческим языком. Есть только у `FAILED`. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  status: string;
  videoUrl: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toJobView(row: JobRow): ApiVideoJobView {
  const status = row.status as ApiVideoJobStatus;
  return {
    jobId: row.id,
    status,
    // Ссылку отдаём только у завершённой заявки, а причину — только у
    // неудавшейся. Недоделанный ролик по ссылке из `RUNNING` выглядел бы
    // как результат, а он ещё меняется.
    videoUrl: status === 'DONE' ? row.videoUrl : null,
    error: status === 'FAILED' ? row.error : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
