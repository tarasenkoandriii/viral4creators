/** Pure helpers for the Story‑Tales references and editions panels (WP2). */
export type StoryReferenceStatus =
  | 'running'
  | 'complete'
  | 'partial'
  | 'unavailable'
  | 'unknown';
export const REFERENCE_STATUS_LABELS: Record<StoryReferenceStatus, string> = {
  complete: 'Разбор готов',
  partial: 'Частичный разбор · проверьте таймкоды',
  running: 'Выполняется',
  unavailable: 'Видео не удалось просмотреть',
  unknown: 'Результат не подтверждён',
};
export const LEGAL_LABELS: Record<string, string> = {
  public_domain: 'Общественное достояние',
  licensed: 'Лицензия',
  own: 'Собственный текст платформы',
  unknown: 'Права не подтверждены',
};
export const EDITION_STATUS_LABELS: Record<string, string> = {
  candidate: 'Кандидат — не в мастере',
  approved: 'Утверждена',
  retired: 'Снята с каталога',
};
export function referenceStatusLabel(status: string): string {
  return REFERENCE_STATUS_LABELS[status as StoryReferenceStatus] ?? status;
}
/** m:ss, whole seconds; minutes are not wrapped into hours. */
export function storyTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** Dollars rounded UP to the cent — a reserve is never shown smaller. */
export function formatMicroUsd(micro: number): string {
  return `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`;
}
function withQuery(path: string, params: Record<string, string | undefined>) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v.trim() !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v!.trim())}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}
export function referenceListPath(query: string, status: string): string {
  return withQuery('/story-gifts/references', { query, status });
}
export function referencePlanPath(
  videoId: string,
  opts: { editionId?: string; budgetUsd?: string; preambleText?: string }
): string {
  return withQuery(
    `/story-gifts/references/${encodeURIComponent(videoId)}/plan`,
    opts
  );
}
export function referenceSearchPath(q: string, language?: string): string {
  return withQuery('/story-gifts/references/youtube', { q, language });
}
/** Explicit paid retry is offered only for unconfirmed results. */
export function canRetryReference(r: {
  status: string;
  retryAllowed?: boolean;
}): boolean {
  return r.retryAllowed ?? ['unknown', 'unavailable'].includes(r.status);
}
/**
 * Бюджет в долларах из поля ввода (S3‑4): 1..1000, не больше двух знаков
 * после запятой (центы) — как на сервере; запятая допускается.
 */
export function parseUsdBudget(value: string): {
  value: number | null;
  error: string | null;
} {
  const raw = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(raw))
    return { value: null, error: 'Бюджет — число от $1 до $1000' };
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw))
    return {
      value: null,
      error: 'Бюджет — не больше двух знаков после запятой (центы)',
    };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 1000)
    return { value: null, error: 'Бюджет — от $1 до $1000' };
  return { value: n, error: null };
}
/** Budget input → number for the plan, or null when invalid (see parseUsdBudget). */
export function planBudget(value: string): number | null {
  return parseUsdBudget(value).value;
}
export function editionOptionLabel(e: {
  title: string;
  kindLabel: string;
  locale: string;
}): string {
  return `${e.title} · ${e.kindLabel} · ${e.locale.toUpperCase()}`;
}
