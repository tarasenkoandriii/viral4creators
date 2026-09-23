/**
 * ИИ-скетч (doc/AI-SKETCH-SPEC.md §7.1) — тонкие функции над общим `api`
 * (services/api.ts), тем же приёмом, что projects-api.ts и
 * catalog-batch-api.ts: один axios-экземпляр значит один перехватчик
 * авторизации (Telegram initData / dev-заголовок / cookie входа).
 *
 * Все маршруты требуют identity (§4, п. 12): гость получает 401, и это
 * не ошибка сети, а отдельный текст «войдите через Telegram» — поэтому
 * `isUnauthorized()` из projects-api.ts здесь переиспользуется экранами,
 * а не дублируется.
 */

import axios from 'axios';
import { api } from './api';
import type { PlanId } from '../types';
import type {
  SketchListView,
  SketchQuota,
  SketchSlotView,
  SketchStyle,
  SketchMode,
  SketchOptions,
  SketchTarget,
  SketchView,
} from '../types/sketch';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export interface GenerateSketchInput {
  target: SketchTarget;
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  /** Обязателен для `from-text`: в этом режиме модель видит только текст. */
  description?: string;
}

/**
 * Генерация кандидата. Квота приходит тем же ответом, а не отдельным
 * запросом: счётчик под превью должен показывать состояние ПОСЛЕ этой
 * попытки, иначе пользователь видит «осталось 3» сразу после того, как
 * потратил третий.
 */
export async function generateSketch(
  input: GenerateSketchInput
): Promise<{ sketch: SketchView; quota: SketchQuota }> {
  return unwrap(
    await api.post<{ sketch: SketchView; quota: SketchQuota }>(
      '/sketches',
      input
    ),
    'sketch'
  );
}

/** Лента кандидатов слота + активный вариант + квота (§3.2, п. 5). */
export async function listSketches(
  target: SketchTarget
): Promise<SketchListView> {
  const params = new URLSearchParams({ type: target.type, id: target.id });
  if (target.subId) params.set('subId', target.subId);
  return unwrap(
    await api.get<SketchListView>(`/sketches?${params.toString()}`),
    'sketches'
  );
}

export async function getSketchQuota(): Promise<SketchQuota> {
  return unwrap(await api.get<SketchQuota>('/sketches/quota'), 'sketch quota');
}

export async function applySketch(
  sketchId: string,
  sketchRendering?: SketchOptions['sketchRendering']
): Promise<SketchSlotView> {
  return unwrap(
    await api.post<{ slot: SketchSlotView }>(
      `/sketches/${sketchId}/apply`,
      sketchRendering ? { sketchRendering } : {}
    ),
    'sketch apply'
  ).slot;
}

export async function revertSketch(
  target: SketchTarget
): Promise<SketchSlotView> {
  return unwrap(
    await api.post<{ slot: SketchSlotView }>('/sketches/revert', { target }),
    'sketch revert'
  ).slot;
}

/**
 * Необратимо (§4, п. 10). `updatedRefs` — сколько чужих записей сервер
 * успел перевести на скетч до удаления блоба (сессии из товара, снимки
 * бренда, публичные страницы). Возвращается наружу целиком, хотя меню
 * карточки берёт из ответа только `slot`: без этого числа нечем будет
 * объяснить пользователю последствия удаления разделяемого оригинала,
 * когда до этого дойдут руки (§3.3).
 */
export async function deleteSketchOriginal(target: SketchTarget): Promise<{
  slot: SketchSlotView;
  updatedRefs: number;
  /** `false` — файл был общим (фото товара проекта) и остался у владельца. */
  fileDeleted: boolean;
}> {
  return unwrap(
    await api.post<{
      slot: SketchSlotView;
      updatedRefs: number;
      fileDeleted: boolean;
    }>('/sketches/delete-original', { target }),
    'sketch delete-original'
  );
}

// ── Ошибки ─────────────────────────────────────────────────────────────

/**
 * 429 — не обычная ошибка «слишком много запросов», а точка апсейла
 * (§8.4): в теле приходят остаток квоты и режим, который её поднимает.
 * Общий `errorMessage()` этих полей не видит, поэтому разбор здесь.
 *
 * Тело читается и как `{ ... }`, и как конверт `{ data: { ... } }` —
 * какой именно вид отдаст сервер на отказ, зависит от того, где сработал
 * лимит (фильтр исключений или сам обработчик), а фронтенд не должен
 * ломаться из-за этой разницы.
 */
export interface SketchQuotaRefusal {
  message: string | null;
  quota: SketchQuota | null;
  upgrade: PlanId | null;
}

/**
 * Полезная нагрузка ошибки, где бы сервер её ни положил. Фильтр
 * исключений кладёт структурные поля в `error.details` (аудит A-2), сам
 * обработчик — в корень тела, а конверт может быть завёрнут в `data`.
 * Читаем все три вида: фронтенд не должен зависеть от того, кто именно
 * сформировал ответ.
 */
function errorBody(err: unknown): Record<string, unknown> | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const raw = err.response?.data as Record<string, unknown> | undefined;
  const envelope = (
    raw && typeof raw.data === 'object' && raw.data !== null ? raw.data : raw
  ) as Record<string, unknown> | undefined;
  const error = envelope?.error as Record<string, unknown> | undefined;
  const details = error?.details as Record<string, unknown> | undefined;
  return { ...envelope, ...error, ...details };
}

export function sketchQuotaRefusal(err: unknown): SketchQuotaRefusal | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 429) return null;
  const body = errorBody(err);
  const quota = body?.quota;
  const upgrade = body?.upgrade;
  return {
    message: typeof body?.message === 'string' ? body.message : null,
    quota: quota && typeof quota === 'object' ? (quota as SketchQuota) : null,
    upgrade:
      upgrade === 'LITE' || upgrade === 'STANDARD' || upgrade === 'PREMIUM'
        ? upgrade
        : null,
  };
}

/** Модель отказалась по безопасности (§3.2, п. 6) — попытка оплачена. */
export function isSketchRefused(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 422;
}

/**
 * Причина 409 при применении. Раньше ЛЮБОЙ конфликт трактовался как
 * «фото изменилось» и вёл к платной перегенерации — даже когда скетч
 * просто уже применён и достаточно обновить экран (аудит A-13).
 */
export type SketchConflict =
  | 'source-changed'
  | 'already-applied'
  | 'sketch-gone';

export function sketchConflict(err: unknown): SketchConflict | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 409) return null;
  const reason = errorBody(err)?.reason;
  return reason === 'already-applied' || reason === 'sketch-gone'
    ? reason
    : 'source-changed';
}

/** Оригинал сменился под кандидатом — скетч нужно сделать заново. */
export function isSketchStale(err: unknown): boolean {
  return sketchConflict(err) === 'source-changed';
}
