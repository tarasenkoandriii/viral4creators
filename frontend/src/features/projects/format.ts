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

/**
 * Числовые формы через `Intl.PluralRules` (этап 56/89) — тот же приём,
 * что в ManifestScreen/ManifestsListScreen, вынесенный сюда, потому что
 * «умный» алерт удаления (этап 89, ConfirmDialog в ProjectScreen)
 * собирает счётчики под-сущностей той же формулой.
 */
export function pluralForm(
  n: number,
  locale: Locale,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>
): string {
  const rule = new Intl.PluralRules(locale).select(n);
  const template = forms[rule] ?? forms.other ?? '';
  return template.replace('{{n}}', String(n));
}
