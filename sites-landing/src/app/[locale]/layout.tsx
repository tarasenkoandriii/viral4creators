import { notFound } from 'next/navigation';
import { BRAND } from '../../brand';
import { HtmlDocument } from '../../components/HtmlDocument';
import { JsonLd } from '../../components/JsonLd';
import { getDictionary } from '../../lib/get-dictionary';
import { fmt } from '../../lib/format';
import { isLocale, locales } from '../../lib/i18n';
import { liveWidgetTag } from '../../lib/live-widget';
import { siteUrl } from '../../lib/site-url';

/** Все локали — статика на сборке. Неизвестная локаль — 404, не рендер. */
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}
export const dynamicParams = false;

/**
 * `alternates` здесь НЕТ намеренно (урок Ф-1): страница, задав свои,
 * заместила бы их целиком. Canonical/hreflang каждая страница получает
 * из `pageMetadata()`.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const origin = siteUrl();
  return (
    <HtmlDocument lang={locale} widget={liveWidgetTag(locale)}>
      {/* Organization + WebSite — на всех страницах (§8.3). */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'Organization', '@id': `${origin}/#org`, name: BRAND.name, url: origin },
            {
              '@type': 'WebSite',
              '@id': `${origin}/#website`,
              name: BRAND.name,
              url: `${origin}/${locale}`,
              inLanguage: locale,
              description: fmt(dict.pages.home.description),
              publisher: { '@id': `${origin}/#org` },
            },
          ],
        }}
      />
      {children}
    </HtmlDocument>
  );
}
