/**
 * Платформы установки (Л5, ТЗ §3.7) — машинная часть; тексты — в словарях
 * (`platforms.<slug>`), код — `lib/install.ts`.
 *
 * Что на странице платформы — `live`, а что `soon` (§3.0 + сверка с кодом
 * продукта, задание Л4–Л5):
 *  - вставка тега загрузчика — `live` для всех страниц: это текст, а
 *    продукт принимает тег на любом сайте с подтверждённым хостом;
 *  - плагин WordPress/WooCommerce и npm-пакет — код есть, но не опубликованы
 *    (О-1, О-9 контракта Э3) → `soon`;
 *  - приложение Shopify — Э9+ → `hidden` (на странице его нет вовсе);
 *  - Wix, Webflow, OpenCart и т.п. — отдельных страниц нет (`more-platforms`, `soon`).
 *
 * `checked` — как проверена инструкция (приёмка Л5): `stand` — тег на
 * нашем стенде e2e (`scripts/built/sandbox-e2e.mjs` грузит НАСТОЯЩИЙ
 * загрузчик этим тегом), `docs` — составлено по документации платформы,
 * живой установкой на стенде платформы не проверялось (бесплатных стендов
 * у нас нет; проверка — владельцу, `doc/DEPLOYMENT.md`).
 * `publicSuffix` — хост платформы, где подтверждение только DNS (список
 * продукта `PUBLIC_PLATFORM_SUFFIXES`; сверяет `scripts/integrations.test.ts`).
 */
import type { ClaimId } from './claims';

export type InstallCode = 'embed' | 'gtm' | 'wordpress' | 'next' | 'spa' | 'goal' | 'webhook';

export interface PlatformDef {
  slug: string;
  claim: ClaimId;
  checked: 'stand' | 'docs';
  code: readonly InstallCode[];
  /** Плагин/пакет, которого ещё нет в открытом доступе. */
  extra?: ClaimId;
  publicSuffix?: string;
}

export const PLATFORMS = [
  { slug: 'html', claim: 'install-snippet', checked: 'stand', code: ['embed'] },
  { slug: 'gtm', claim: 'install-guides', checked: 'docs', code: ['gtm'] },
  { slug: 'wordpress', claim: 'install-guides', checked: 'docs', code: ['wordpress'], extra: 'wp-plugin', publicSuffix: 'wordpress.com' },
  { slug: 'woocommerce', claim: 'install-guides', checked: 'docs', code: ['wordpress', 'goal', 'webhook'], extra: 'wp-plugin' },
  { slug: 'react', claim: 'install-guides', checked: 'docs', code: ['next', 'spa'], extra: 'npm-package' },
  { slug: 'shopify', claim: 'install-guides', checked: 'docs', code: ['embed'], publicSuffix: 'myshopify.com' },
  { slug: 'horoshop', claim: 'install-guides', checked: 'docs', code: ['embed'] },
  { slug: 'tilda', claim: 'install-guides', checked: 'docs', code: ['embed'], publicSuffix: 'tilda.ws' },
] as const satisfies readonly PlatformDef[];

export type PlatformSlug = (typeof PLATFORMS)[number]['slug'];

export function platform(slug: string): PlatformDef | null {
  return (PLATFORMS as readonly PlatformDef[]).find((p) => p.slug === slug) ?? null;
}

/** Платформы без своей страницы (только названия, `more-platforms` — «скоро»). */
export const MORE_PLATFORMS = ['Wix', 'Webflow', 'OpenCart'] as const;
