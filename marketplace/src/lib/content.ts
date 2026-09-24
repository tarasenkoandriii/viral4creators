/**
 * Внешние адреса маркетплейса.
 *
 * Заведено ради футера (доп. запрос владельца продукта): реферальная
 * ссылка Claude стоит во ВСЕХ футерах продукта сразу — в TMA
 * (`frontend/src/App.tsx`), в общем футере лендинга
 * (`landing/src/components/Footer.tsx`), на его поддоменах и здесь.
 *
 * Почему адрес главного лендинга — отдельная переменная, а не
 * `NEXT_PUBLIC_SITE_URL`: в этом приложении та означает СОБСТВЕННЫЙ хост
 * маркетплейса (см. `sitemap-news.xml`, `item/[id]`), и переиспользовать
 * её под чужой значило бы сломать канонические адреса ради одной ссылки
 * в подвале.
 */

/** Главный лендинг: там лежат оферта и условия — одни на все хосты. */
export const LANDING_URL = (
  process.env.NEXT_PUBLIC_LANDING_URL ?? 'http://localhost:3003'
).replace(/\/+$/, '');

/** Реферальная ссылка Claude — та же, что в остальных футерах. */
export const CLAUDE_REFERRAL_URL =
  process.env.NEXT_PUBLIC_CLAUDE_REFERRAL_URL ??
  'https://claude.ai/referral/P7cQCOjbvg?s=android';
