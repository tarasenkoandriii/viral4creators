import type { Locale } from '../../lib/i18n';
import type { ProductItemView } from '../../types/project';

/**
 * Этап 56: локаль вместо жёстко зашитого 'ru-RU' — разделитель разрядов и
 * десятичных зависит от языка интерфейса (та же идея, что formatCount в
 * lib/youtube-search.ts), а не только от валюты, которая всегда своя у
 * страны продажи.
 */
export function formatPrice(
  price: number | null,
  currency: string | null,
  locale: Locale = 'ru'
): string {
  if (price === null) return '—';
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    price
  );
  return currency ? `${n} ${currency}` : n;
}

/**
 * Human label for an item row when it has no title/category yet.
 * `fallback` is `dict.projectFormat.itemFallback` (stage 56) — a
 * `{{index}}` template — supplied by the caller since this is pure logic,
 * not interface text, and cannot call hooks.
 */
export function itemLabel(
  item: ProductItemView,
  index: number,
  fallback: string
): string {
  return (
    item.title ||
    item.category ||
    fallback.replace('{{index}}', String(index + 1))
  );
}
