import uk from '@/dictionaries/uk.json';

/**
 * Все тексты интерфейса — `src/dictionaries/uk.json` (язык пилота, ТЗ §2).
 * Факты (оффер, цена, FAQ, контакты, уведомление о данных) — НЕ здесь: они
 * приходят из `site-config` и контента API (§8.1: без выдуманных цен,
 * отзывов и гарантий). Полноту и отсутствие запрещённых обещаний держит
 * `scripts/dictionaries.test.ts`.
 */
export type Dictionary = typeof uk;
export const dict: Dictionary = uk;

/** Подстановка `{имя}`; неизвестное имя остаётся как есть (тест ловит). */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const dateFmt = new Intl.DateTimeFormat('uk-UA', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Kyiv',
});

/** Дата ISO → «13 жовтня 2026 р.» (Kyiv); негодная — null. */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
}
